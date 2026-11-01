import { ApiClient, ApiError, DraftStore, LocalDraft, SaveDocumentResponse, newClientRequestId } from '@erp/api-client'
import { DEFAULT_SCALES, DocFormState, FormLine, PriceLevel, Scales, addOrIncrement, emptyForm, newLine, precheck, resolveUnitPrice, toInput, totals } from '@erp/shared'

/**
 * 单页销售开单(需求 16.9):选择客户、扫码或搜索添加 SKU、改数量与单价、录入本单已收、一键保存并审核,
 * 全部在同一页面内完成(仅扫码相机与 SKU 搜索弹层是例外)。本类承载该页的全部状态与规则,与 uni-app 页面解耦。
 */

export interface SkuInfo {
  skuId: string
  skuCode: string
  name: string
  barcode?: string
  baseUnit: string
  refSalePrice: string
  wholesalePrice?: string | null
}

/** 本地 SKU 条码索引:首次进入开单页时拉取并缓存,10 分钟过期(需求 11.7) */
export const BARCODE_INDEX_TTL_MS = 10 * 60_000
/** 扫码结果返回到明细行出现的时限(需求 11.7) */
export const SCAN_DEADLINE_MS = 2000

export type ScanResult = { kind: 'added'; line: FormLine } | { kind: 'not_found'; message: string } | { kind: 'cancelled' }

export interface SalesSessionDeps {
  api: Pick<ApiClient, 'get' | 'saveDocument'>
  drafts: DraftStore
  now?: () => number
  scales?: Scales
}

export class SalesSession {
  form: DocFormState
  priceLevel: PriceLevel = { type: 'retail' }
  /** 价格被用户手工修改过的行,换客户时不覆盖(需求 12.4) */
  edited = new Set<number>()
  private index: { at: number; byBarcode: Map<string, SkuInfo> } | null = null
  /** 同一张单据的所有重复提交共用同一个 clientRequestId(需求 19.8) */
  readonly clientRequestId: string
  skuCache = new Map<string, SkuInfo>()

  constructor(
    private d: SalesSessionDeps,
    today: string,
    warehouseId: string | null,
    draft?: LocalDraft,
  ) {
    this.form = emptyForm('sales_out', today)
    this.form.warehouseId = warehouseId
    this.clientRequestId = draft?.clientRequestId ?? newClientRequestId()
    if (draft) this.restore(draft)
  }

  private get scales(): Scales {
    return this.d.scales ?? DEFAULT_SCALES
  }
  private now() {
    return (this.d.now ?? Date.now)()
  }

  /* ───────── 客户与取价 ───────── */

  setCustomer(id: string, level: PriceLevel) {
    this.form.partnerId = id
    this.priceLevel = level
    // 已选客户后重新按价格等级取价;手工改过的行保持不变
    this.form.lines = this.form.lines.map((l, i) => {
      const sku = this.skuCache.get(l.skuId)
      return sku && !this.edited.has(i) ? { ...l, price: resolveUnitPrice(sku, level, this.scales.priceScale).toFixed(this.scales.priceScale) } : l
    })
  }

  private priceFor(sku: SkuInfo): string {
    return resolveUnitPrice(sku, this.priceLevel, this.scales.priceScale).toFixed(this.scales.priceScale)
  }

  /* ───────── 添加 SKU:搜索弹层与扫码 ───────── */

  addSku(sku: SkuInfo) {
    this.skuCache.set(sku.skuId, sku)
    this.form.lines = addOrIncrement(this.form.lines, newLine({ skuId: sku.skuId, label: `${sku.skuCode} ${sku.name}` }, this.priceFor(sku), this.form.warehouseId))
  }

  async searchSkus(keyword: string): Promise<SkuInfo[]> {
    if (!keyword.trim()) return []
    return (await this.d.api.get<Array<SkuInfo & { skuId: string }>>('/api/products/search', { keyword })).map((s) => s)
  }

  /** 首次进入开单页时拉取启用 SKU 的条码索引并缓存;过期后重新拉取 */
  private async barcodeIndex(): Promise<Map<string, SkuInfo>> {
    if (this.index && this.now() - this.index.at < BARCODE_INDEX_TTL_MS) return this.index.byBarcode
    const rows = await this.d.api.get<Array<{ barcode: string; skuId: string; skuCode: string; name: string; baseUnit: string; refSalePrice: string }>>('/api/products/barcode-index')
    this.index = { at: this.now(), byBarcode: new Map(rows.map((r) => [r.barcode, { skuId: r.skuId, skuCode: r.skuCode, name: r.name, baseUnit: r.baseUnit, refSalePrice: r.refSalePrice, barcode: r.barcode }])) }
    return this.index.byBarcode
  }

  /**
   * 扫码加行:命中本地索引的启用 SKU 以数量 1 加入,已有该 SKU 的行数量 +1;
   * 未命中则调用一次后端条码查询兜底;仍未命中提示"未找到该条码对应的商品",明细不变(需求 11.7、11.8)。
   */
  async scan(code: string | null): Promise<ScanResult> {
    if (code === null || code === '') return { kind: 'cancelled' }
    const sku = (await this.barcodeIndex()).get(code) ?? (await this.d.api.get<{ item: SkuInfo | null }>('/api/products/by-barcode', { barcode: code }).catch(() => ({ item: null }))).item
    if (!sku) return { kind: 'not_found', message: '未找到该条码对应的商品' }
    this.addSku(sku)
    // 返回命中的明细行(新增的行,或数量 +1 的已有行)
    return { kind: 'added', line: this.form.lines.find((l) => l.skuId === sku.skuId)! }
  }

  /* ───────── 行编辑 ───────── */

  setQty(i: number, qty: string) {
    this.form.lines[i] = { ...this.form.lines[i], qty }
  }
  setPrice(i: number, price: string) {
    this.form.lines[i] = { ...this.form.lines[i], price }
    this.edited.add(i)
  }
  removeLine(i: number) {
    this.form.lines.splice(i, 1)
    // 删除后行号整体前移,手改标记同步前移
    this.edited = new Set([...this.edited].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)))
  }

  /** 实时合计;本单已收的上限为单据总金额(需求 16.10) */
  get sum() {
    return totals(this.form, this.scales)
  }
  setPaid(amount: string, fundAccountId: string | null) {
    this.form.paidAmount = amount
    this.form.fundAccountId = fundAccountId
  }
  get paidMax(): string {
    return this.sum.total
  }

  /** 前端预校验,与后端同一份规则;错误带行号 */
  validate() {
    return precheck(this.form, this.scales)
  }

  /* ───────── 保存并审核 ───────── */

  private asDraft(autoAudit: boolean, error?: string): LocalDraft {
    return { clientRequestId: this.clientRequestId, savedAt: this.now(), input: toInput(this.form) as unknown as Record<string, unknown>, form: structuredClone(this.form), autoAudit, error }
  }
  private restore(d: LocalDraft) {
    if (d.form) this.form = d.form as DocFormState
  }

  /**
   * 保存并审核。审核失败(库存不足、信用额度未确认等)时单据已保存为草稿,保留全部内容并返回原因,不离开当前页面(需求 16.12)。
   * 网络中断或 15 秒无响应时保留本地草稿并提示重新提交(需求 19.7、19.9)。
   */
  async submit(opts: { confirmCredit?: boolean } = {}): Promise<
    | { status: 'ok'; docNo: string; audited: boolean }
    | { status: 'audit_failed'; docNo: string; reason: string; needsCreditConfirm: boolean }
    | { status: 'invalid'; errors: Record<string, string> }
    | { status: 'offline'; message: string }
    | { status: 'rejected'; message: string; errors: Record<string, string> }
  > {
    const pre = this.validate()
    if (pre.issues.length) return { status: 'invalid', errors: pre.byKey }
    const r = await this.d.drafts.submit(this.d.api as ApiClient, this.asDraft(true), opts)
    if (!r.ok) {
      const e: ApiError = r.error
      if (e.code === 'NETWORK' || e.code === 'TIMEOUT') {
        // 草稿(含表单快照)已由 DraftStore.submit 保留,这里只负责提示
        return { status: 'offline', message: `提交失败:${e.message}。单据内容已保存在本机,可重新提交。` }
      }
      return { status: 'rejected', message: e.message, errors: e.fieldErrors() }
    }
    const res: SaveDocumentResponse = r.response
    if (res.auditError) {
      // 已保存为草稿:不再作为"待提交"保留,避免重复保存;页面继续显示全部内容与原因
      return { status: 'audit_failed', docNo: res.doc.docNo, reason: res.auditError.message, needsCreditConfirm: res.auditError.code === 'CREDIT_CONFIRM_REQUIRED' }
    }
    return { status: 'ok', docNo: res.doc.docNo, audited: res.doc.status === 'audited' }
  }
}

