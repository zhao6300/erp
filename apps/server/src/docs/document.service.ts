import {
  AppError,
  DOC_TYPE_LABEL,
  DocInput,
  DocType,
  DocStatus,
  ErrorDetail,
  FUND_ONLY_DOCS,
  PAID_DOCS,
  computeDocAmounts,
  dec,
  netLineAmounts,
  remainingQty,
  validateDocumentDraft,
  DOC_STATUS_LABEL,
} from '@erp/shared'
import type { CustomFieldService, FieldFilter } from '../config/customFields.service'
import type { NumberingService, SettingsService, TenantSettings } from '../config/settings.service'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import type { EventService } from '../core/events'
import { uuidv7 } from '../core/ids'
import type { PermissionService } from '../core/permission/permission.service'
import { Clock, localDateIn, todayStr } from '../core/time'
import { DOC_META, DocView, GENERATE_FROM, statusMessage, toEventPayload } from './document.model'
import { loadDoc, mustLoadDoc, overQty } from './document.repo'
import type { PostingService } from './posting.service'
import { saveAllocations } from './settlement.repo'

export interface SaveOptions {
  version?: number
  clientRequestId?: string
  /** 保存并审核(小程序一键开单) */
  autoAudit?: boolean
  confirmCredit?: boolean
}
export interface SaveResult {
  doc: DocView
  replayed: boolean
  /** 保存成功但审核失败时的原因;单据保持草稿(需求 7.8、16.12) */
  auditError?: { code: string; message: string; details?: ErrorDetail[] }
}
export type SaveInput = DocInput & { id?: string }

export interface DocDeps {
  db: Db
  settings: SettingsService
  numbering: NumberingService
  cf: CustomFieldService
  perms: PermissionService
  audit: AuditService
  events: EventService
  posting: PostingService
  clock: Clock
  tz: string
}

interface SkuInfo {
  skuId: string
  productId: string
  code: string
  name: string
  baseUnit: string
  enabled: boolean
  units: Map<string, number>
}

export class DocumentService {
  constructor(private d: DocDeps) {}

  /* ───────────────────────── 保存 ───────────────────────── */

  async save(ctx: Ctx, input: SaveInput, opts: SaveOptions = {}): Promise<SaveResult> {
    const meta = DOC_META[input.docType]
    if (!meta) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'docType', reason: '未知的单据类型' }])
    this.d.perms.require(ctx, `${input.docType}:${input.id ? 'edit' : 'create'}`)
    const settings = await this.d.settings.get(ctx.tenantId)

    // 字段级校验先于任何写入(需求 15.8、16.10、14.12、14.13、17.5、17.13)
    const issues = validateDocumentDraft(input, settings.scales)
    if (issues.length) throw new AppError('VALIDATION_FAILED', `提交的数据未通过校验:${issues.map((i) => (i.row ? `第 ${i.row} 行 ` : '') + i.reason).join(';')}`, issues.map((i) => ({ field: i.field, row: i.row, reason: i.reason })))

    // 保存前插件:在事务外同步调用,拒绝/异常/超时都中止本次保存(需求 23.2)
    const amounts = computeDocAmounts(input, settings.scales)
    await this.d.events.dispatchSync(
      toEventPayload(
        ctx.tenantId,
        'document.beforeSave',
        {
          docType: input.docType,
          docDate: input.docDate,
          partnerId: input.partnerId,
          warehouseId: input.warehouseId,
          toWarehouseId: input.toWarehouseId,
          fundAccountId: input.fundAccountId,
          docDiscount: input.docDiscount ?? '0',
          paidAmount: input.paidAmount ?? '0',
          totalAmount: amounts.total.toFixed(2),
          remark: input.remark ?? '',
          custom: input.custom ?? {},
          id: input.id,
          lines: input.lines.map((l, i) => ({
            id: '',
            lineNo: i + 1,
            skuId: l.skuId,
            unitName: l.unitName ?? null,
            ratio: l.ratio ?? 1,
            qty: l.qty,
            baseQty: amounts.lines[i]?.baseQty.toString() ?? '0',
            price: l.price,
            discountRate: l.discountRate,
            amount: amounts.lines[i]?.amount.toFixed(2) ?? '0',
            netAmount: '0',
            warehouseId: l.warehouseId ?? input.warehouseId ?? null,
            upstreamLineId: l.upstreamLineId ?? null,
            costPrice: null,
            costAmount: null,
            lineProfit: null,
            snapshotQty: null,
            countedQty: l.countedQty ?? null,
          })),
        },
        'draft',
      ),
    )

    const saved = await this.d.db.withTenant(ctx.tenantId, (tx) => this.saveTx(tx, ctx, input, opts, settings))
    let doc = saved.doc
    const needAudit = opts.autoAudit || !settings.requireAudit
    if (needAudit && doc.status === 'draft') {
      // 审核在独立事务中进行:失败时保存仍然成功,单据保持草稿(需求 7.8)
      try {
        doc = await this.d.posting.audit(ctx, doc.id, doc.version, { confirmCredit: opts.confirmCredit })
      } catch (e) {
        if (!(e instanceof AppError)) throw e
        const fresh = await this.d.db.withTenant(ctx.tenantId, (tx) => mustLoadDoc(tx, doc.id))
        return { doc: fresh, replayed: saved.replayed, auditError: { code: e.code, message: e.message, details: e.details } }
      }
    }
    return { doc, replayed: saved.replayed }
  }

  /** 事务内保存。generateDownstream 复用 */
  async saveTx(tx: Tx, ctx: Ctx, input: SaveInput, opts: SaveOptions, settings: TenantSettings): Promise<{ doc: DocView; replayed: boolean }> {
    const meta = DOC_META[input.docType]
    const scales = settings.scales

    /* 幂等:同一 clientRequestId 只保存一张单据(需求 19.8,设计 D8) */
    if (opts.clientRequestId && !input.id) {
      const n = await tx.exec('INSERT INTO idempotency_key (tenant_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ctx.tenantId, opts.clientRequestId])
      if (n === 0) {
        const k = await tx.maybeOne<{ document_id: string | null }>('SELECT document_id FROM idempotency_key WHERE key=$1', [opts.clientRequestId])
        if (k?.document_id) return { doc: await mustLoadDoc(tx, k.document_id), replayed: true }
      }
    }

    /* 既有单据:状态机、乐观锁、数据权限 */
    let existing: DocView | null = null
    if (input.id) {
      existing = await loadDoc(tx, input.id, { forUpdate: true })
      if (!existing) throw new AppError('NOT_FOUND')
      if (existing.docType !== input.docType) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'docType', reason: '不能修改单据类型' }])
      this.d.perms.assertDocVisible(ctx, this.scopeInfo(existing))
      if (existing.status !== 'draft') throw new AppError('INVALID_STATE_TRANSITION', `${statusMessage(existing.status)},不可编辑`)
      if (opts.version !== undefined && opts.version !== existing.version) throw new AppError('DOC_STATUS_CHANGED')
    }

    /* 关联记录(同租户存在性)、业务状态校验 */
    const info = await this.validateRelations(tx, input)
    this.d.perms.assertWarehouseAllowed(ctx, [input.warehouseId, input.toWarehouseId, ...input.lines.map((l) => l.warehouseId)])

    /* 行:单位换算比例保存时从 product_unit 复制,之后修改不影响历史单据 */
    const lineInputs = input.lines.map((l, i) => {
      const s = info.skus.get(l.skuId)
      let ratio = 1
      let unitName: string | null = null
      if (s && l.unitName && l.unitName !== s.baseUnit) {
        const r = s.units.get(l.unitName)
        if (r === undefined) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'unitName', row: i + 1, reason: `商品“${s.name}”没有单位“${l.unitName}”` }])
        ratio = r
        unitName = l.unitName
      } else if (s) unitName = s.baseUnit
      return { ...l, ratio, unitName }
    })
    const amounts = computeDocAmounts({ ...input, lines: lineInputs }, scales)
    const nets = FUND_ONLY_DOCS.includes(input.docType) ? [] : netLineAmounts(amounts.lines.map((l) => l.amount), input.docDiscount ?? '0', scales.amountScale)

    /* 上游单据:已审核、类型匹配、数量不超过剩余(需求 13.9、15.7、15.9、16.7) */
    if (input.upstreamId) await this.checkUpstream(tx, input, lineInputs, amounts.lines.map((l) => l.baseQty.toString()), existing?.id ?? null)

    // 自定义字段只挂载在采购/销售单据上(Business_Object);其他单据类型无自定义字段
    const customToSave = meta.objectType ? await this.d.cf.validateAndMerge(tx, meta.objectType, existing?.custom ?? {}, input.custom) : (existing?.custom ?? {})

    const paid = PAID_DOCS.includes(input.docType) ? (input.paidAmount ?? '0') : '0'
    const total = amounts.total.toFixed(2)

    /* 盘点:加入时记录账面数量快照(只读),已有行保持原快照(需求 14.8) */
    const priorSnap = new Map((existing?.lines ?? []).map((l) => [`${l.skuId}`, l.snapshotQty]))

    let docId: string
    let docNo: string
    if (existing) {
      docId = existing.id
      docNo = existing.docNo
      const n = await tx.exec(
        `UPDATE document SET doc_date=$3, partner_id=$4, warehouse_id=$5, to_warehouse_id=$6, fund_account_id=$7, fund_category_id=$8, upstream_id=$9, handler_id=$10,
           doc_discount=$11, paid_amount=$12, total_amount=$13, remark=$14, custom=$15, version=version+1, updated_at=now(), updated_by=$16
         WHERE id=$1 AND version=$2 AND status='draft'`,
        [docId, existing.version, input.docDate, input.partnerId ?? null, input.warehouseId ?? null, input.toWarehouseId ?? null, input.fundAccountId ?? null, input.fundCategoryId ?? null, input.upstreamId ?? null, input.handlerId ?? existing.handlerId ?? ctx.tenantUserId, input.docDiscount ?? '0', paid, total, input.remark ?? '', JSON.stringify(customToSave), ctx.tenantUserId],
      )
      if (n === 0) throw new AppError('DOC_STATUS_CHANGED')
      await tx.query('DELETE FROM document_line WHERE document_id=$1', [docId])
    } else {
      docId = uuidv7()
      docNo = await this.d.numbering.next(tx, ctx.tenantId, input.docType, localDateIn(this.d.tz, this.d.clock()))
      await tx.query(
        `INSERT INTO document (id, tenant_id, doc_type, doc_no, doc_date, partner_id, warehouse_id, to_warehouse_id, fund_account_id, fund_category_id, upstream_id, handler_id,
           doc_discount, paid_amount, total_amount, remark, custom, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [docId, ctx.tenantId, input.docType, docNo, input.docDate, input.partnerId ?? null, input.warehouseId ?? null, input.toWarehouseId ?? null, input.fundAccountId ?? null, input.fundCategoryId ?? null, input.upstreamId ?? null, input.handlerId ?? ctx.tenantUserId, input.docDiscount ?? '0', paid, total, input.remark ?? '', JSON.stringify(customToSave), ctx.tenantUserId],
      )
      if (opts.clientRequestId) await tx.query('UPDATE idempotency_key SET document_id=$2 WHERE key=$1', [opts.clientRequestId, docId])
    }

    for (let i = 0; i < lineInputs.length; i++) {
      const l = lineInputs[i]
      const wh = input.docType === 'transfer' || input.docType === 'stocktake' ? (input.warehouseId ?? null) : (l.warehouseId ?? input.warehouseId ?? null)
      let snapshot: string | null = null
      if (input.docType === 'stocktake') {
        const carried = priorSnap.get(l.skuId)
        const current = carried == null ? await tx.maybeOne<{ qty: string }>('SELECT qty FROM stock_balance WHERE sku_id=$1 AND warehouse_id=$2', [l.skuId, wh]) : null
        snapshot = carried ?? current?.qty ?? '0'
      }
      await tx.query(
        `INSERT INTO document_line (id, tenant_id, document_id, line_no, sku_id, unit_name, ratio, qty, base_qty, price, discount_rate, amount, net_amount, warehouse_id, upstream_line_id, snapshot_qty, counted_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          uuidv7(),
          ctx.tenantId,
          docId,
          i + 1,
          l.skuId,
          l.unitName,
          l.ratio,
          input.docType === 'stocktake' ? '0' : l.qty,
          input.docType === 'stocktake' ? '0' : amounts.lines[i].baseQty.toString(),
          l.price,
          l.discountRate === '' || l.discountRate === undefined ? '100' : l.discountRate,
          amounts.lines[i].amount.toFixed(2),
          nets[i]?.toFixed(2) ?? '0',
          wh,
          l.upstreamLineId ?? null,
          snapshot,
          input.docType === 'stocktake' ? (l.countedQty ?? null) : null,
        ],
      )
    }

    /* 收款/付款:保存时计算并落库核销分配(需求 17.4、17.5) */
    if ((input.docType === 'receipt' || input.docType === 'payment') && input.partnerId) {
      await saveAllocations(tx, ctx.tenantId, docId, input.partnerId, input.docType, total, input.allocations)
    }

    const doc = await mustLoadDoc(tx, docId)
    await this.d.audit.log(tx, ctx, existing ? 'document.update' : 'document.create', {
      type: input.docType,
      id: docId,
      no: docNo,
      before: existing ? this.auditShape(existing) : null,
      after: this.auditShape(doc),
    })
    return { doc, replayed: false }
  }

  private auditShape(d: DocView): Record<string, any> {
    return {
      docDate: d.docDate,
      partnerId: d.partnerId,
      warehouseId: d.warehouseId,
      toWarehouseId: d.toWarehouseId,
      fundAccountId: d.fundAccountId,
      docDiscount: d.docDiscount,
      paidAmount: d.paidAmount,
      totalAmount: d.totalAmount,
      remark: d.remark,
      custom: d.custom,
      lines: d.lines.map((l) => `${l.skuId}|${l.qty}|${l.price}|${l.discountRate}|${l.warehouseId}`),
    }
  }

  scopeInfo(d: Pick<DocView, 'docType' | 'createdBy' | 'handlerId' | 'warehouseId' | 'toWarehouseId' | 'lines'>) {
    return { docType: d.docType, createdBy: d.createdBy, handlerId: d.handlerId, warehouseIds: [d.warehouseId, d.toWarehouseId, ...d.lines.map((l) => l.warehouseId)] }
  }

  /* ───────────────────────── 关联校验 ───────────────────────── */

  private async validateRelations(tx: Tx, input: SaveInput): Promise<{ skus: Map<string, SkuInfo> }> {
    const meta = DOC_META[input.docType]
    const missing: ErrorDetail[] = []
    const exists = async (table: string, ids: (string | null | undefined)[], field: string) => {
      const want = [...new Set(ids.filter((x): x is string => !!x))]
      if (!want.length) return new Set<string>()
      const found = new Set((await tx.rows<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [want])).map((r) => r.id))
      for (const id of want) if (!found.has(id)) missing.push({ field, reason: '关联记录不存在', id })
      return found
    }
    const isUuid = (s?: string | null) => !s || /^[0-9a-f-]{36}$/i.test(s)
    for (const [f, v] of [['partnerId', input.partnerId], ['warehouseId', input.warehouseId], ['toWarehouseId', input.toWarehouseId], ['fundAccountId', input.fundAccountId], ['fundCategoryId', input.fundCategoryId], ['upstreamId', input.upstreamId], ['handlerId', input.handlerId]] as const) {
      if (!isUuid(v)) missing.push({ field: f, reason: '关联记录不存在', id: v })
    }
    for (const [i, l] of input.lines.entries()) {
      if (!isUuid(l.skuId) || !isUuid(l.warehouseId)) missing.push({ field: !isUuid(l.skuId) ? 'skuId' : 'warehouseId', row: i + 1, reason: '关联记录不存在' })
    }
    if (missing.length) throw new AppError('RELATION_NOT_FOUND', undefined, missing)

    await exists('partner', [input.partnerId], 'partnerId')
    await exists('warehouse', [input.warehouseId, input.toWarehouseId, ...input.lines.map((l) => l.warehouseId)], 'warehouseId')
    await exists('fund_account', [input.fundAccountId], 'fundAccountId')
    await exists('fund_category', [input.fundCategoryId], 'fundCategoryId')
    await exists('document', [input.upstreamId], 'upstreamId')
    await exists('tenant_user', [input.handlerId], 'handlerId')
    const skuIds = [...new Set(input.lines.map((l) => l.skuId).filter(Boolean))]
    const skuRows = skuIds.length
      ? await tx.rows(
          `SELECT s.id, s.code, s.enabled AS sku_enabled, p.id AS product_id, p.name, p.base_unit, p.enabled AS product_enabled
           FROM sku s JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id WHERE s.id = ANY($1::uuid[])`,
          [skuIds],
        )
      : []
    const foundSku = new Set(skuRows.map((r) => r.id))
    input.lines.forEach((l, i) => {
      if (l.skuId && !foundSku.has(l.skuId)) missing.push({ field: 'skuId', row: i + 1, reason: '关联记录不存在' })
    })
    if (missing.length) throw new AppError('RELATION_NOT_FOUND', '关联记录不存在', missing)

    /* 往来单位类型与启用状态(需求 15.1、16.1) */
    if (input.partnerId) {
      const p = await tx.one('SELECT kind, enabled, name FROM partner WHERE id=$1', [input.partnerId])
      const need: 'supplier' | 'customer' | null = meta.trade === 'purchase' || input.docType === 'payment' ? 'supplier' : meta.trade === 'sales' || input.docType === 'receipt' ? 'customer' : null
      if (need && p.kind !== need && p.kind !== 'both') throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'partnerId', reason: need === 'supplier' ? '所选往来单位不是供应商' : '所选往来单位不是客户' }])
      if (!p.enabled) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'partnerId', reason: '所选往来单位已停用' }])
    }

    /* 停用的商品或 SKU(需求 11.12):列出编码与名称 */
    const disabled = skuRows.filter((r) => !r.sku_enabled || !r.product_enabled)
    if (disabled.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `单据中包含已停用的商品:${disabled.map((r) => `${r.code} ${r.name}`).join('、')}`,
        disabled.map((r) => ({ field: 'skuId', reason: `商品已停用:${r.code} ${r.name}`, skuId: r.id })),
      )
    }

    const pids = [...new Set(skuRows.map((r) => r.product_id))]
    const unitRows = pids.length ? await tx.rows('SELECT product_id, unit_name, ratio FROM product_unit WHERE product_id = ANY($1::uuid[])', [pids]) : []
    const skus = new Map<string, SkuInfo>()
    for (const r of skuRows) {
      skus.set(r.id, {
        skuId: r.id,
        productId: r.product_id,
        code: r.code,
        name: r.name,
        baseUnit: r.base_unit,
        enabled: true,
        units: new Map(unitRows.filter((u) => u.product_id === r.product_id).map((u) => [u.unit_name, u.ratio])),
      })
    }
    return { skus }
  }

  private async checkUpstream(tx: Tx, input: SaveInput, lines: { skuId: string; upstreamLineId?: string | null }[], baseQtys: string[], selfId: string | null): Promise<void> {
    const up = await tx.one('SELECT id, doc_type, status FROM document WHERE id=$1', [input.upstreamId])
    const expect = DOC_META[input.docType].upstreamType
    if (!expect || up.doc_type !== expect) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'upstreamId', reason: `上游单据类型应为${expect ? DOC_TYPE_LABEL[expect] : '无'}` }])
    if (up.status !== 'audited') throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'upstreamId', reason: '上游单据未审核' }])
    const upLines = await tx.rows<{ id: string; sku_id: string; base_qty: string }>('SELECT id, sku_id, base_qty FROM document_line WHERE document_id=$1', [up.id])
    const upIds = new Set(upLines.map((l) => l.id))
    for (const [i, l] of lines.entries()) {
      if (l.upstreamLineId && !upIds.has(l.upstreamLineId)) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'upstreamLineId', row: i + 1, reason: '关联记录不存在' }])
    }
    const viol = await overQty(tx, up.id, upLines, selfId, lines.map((l, i) => ({ skuId: l.skuId, baseQty: baseQtys[i] })))
    if (viol.length) throw new AppError('OVER_RETURNABLE', `数量超过可退/可入库数量:${viol.map((v) => `${v.code} 剩余 ${v.remaining}`).join('、')}`, viol.map((v) => ({ field: 'qty', reason: '超过剩余数量', skuId: v.skuId, remaining: v.remaining })))
  }

  /* ───────────────────────── 查询 ───────────────────────── */

  async get(ctx: Ctx, id: string): Promise<DocView> {
    return this.d.db.withTenant(ctx.tenantId, (tx) => this.getTx(tx, ctx, id), { readOnly: true })
  }

  async getTx(tx: Tx, ctx: Ctx, id: string): Promise<DocView> {
    const doc = await mustLoadDoc(tx, id)
    this.d.perms.require(ctx, `${doc.docType}:view`)
    this.d.perms.assertDocVisible(ctx, this.scopeInfo(doc))
    return doc
  }

  async list(
    ctx: Ctx,
    f: { docType?: DocType; status?: DocStatus; partnerId?: string; warehouseId?: string; from?: string; to?: string; keyword?: string; includeInline?: boolean; cf?: Record<string, FieldFilter>; page?: number; pageSize?: number },
  ) {
    return this.d.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const params: unknown[] = []
        const where: string[] = []
        const add = (sql: string, v: unknown) => {
          params.push(v)
          where.push(sql.replaceAll('?', `$${params.length}`)) // 同一个值可被多处引用
        }
        if (f.docType) {
          this.d.perms.require(ctx, `${f.docType}:view`)
          add('d.doc_type = ?', f.docType)
        } else {
          const allowed = (Object.keys(DOC_META) as DocType[]).filter((t) => this.d.perms.can(ctx, `${t}:view`))
          add('d.doc_type = ANY(?::text[])', allowed)
        }
        if (f.status) add('d.status = ?', f.status)
        if (f.partnerId) add('d.partner_id = ?', f.partnerId)
        if (f.warehouseId) add('(d.warehouse_id = ? OR d.to_warehouse_id = ?)', f.warehouseId)
        if (f.from) add('d.doc_date >= ?', f.from)
        if (f.to) add('d.doc_date <= ?', f.to)
        if (f.keyword) add('d.doc_no ILIKE ?', `%${f.keyword.replace(/[\\%_]/g, '\\$&')}%`)
        if (!f.includeInline) where.push('NOT d.is_inline')
        where.push(this.d.perms.documentFilter(ctx, 'd', params))
        if (f.cf && f.docType && DOC_META[f.docType].objectType) where.push(...(await this.d.cf.buildFilters(tx, DOC_META[f.docType].objectType!, f.cf, 'd', params)))
        const pageSize = Math.min(f.pageSize ?? 20, 100)
        const page = Math.max(f.page ?? 1, 1)
        const w = 'WHERE ' + where.join(' AND ')
        const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM document d ${w}`, params)).n
        const rows = await tx.rows(
          `SELECT d.id, d.doc_type, d.doc_no, d.doc_date, d.status, d.partner_id, p.name AS partner_name, d.warehouse_id, d.total_amount, d.paid_amount, d.settled_amount, d.gross_profit, d.fulfillment, d.version, d.created_by, d.custom, d.is_inline
           FROM document d LEFT JOIN partner p ON p.tenant_id = d.tenant_id AND p.id = d.partner_id ${w} ORDER BY d.doc_date DESC, d.created_at DESC, d.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
          params,
        )
        return {
          items: rows.map((r) => ({
            id: r.id,
            docType: r.doc_type as DocType,
            docNo: r.doc_no,
            docDate: r.doc_date,
            status: r.status as DocStatus,
            partnerId: r.partner_id,
            partnerName: r.partner_name,
            warehouseId: r.warehouse_id,
            totalAmount: r.total_amount,
            paidAmount: r.paid_amount,
            settledAmount: r.settled_amount,
            grossProfit: r.gross_profit,
            fulfillment: r.fulfillment,
            version: r.version,
            isInline: r.is_inline,
            custom: r.custom,
          })),
          total,
          page,
          pageSize,
        }
      },
      { readOnly: true },
    )
  }

  /* ───────────────────────── 作废 ───────────────────────── */

  async void(ctx: Ctx, id: string, version: number): Promise<DocView> {
    return this.d.db.withTenant(ctx.tenantId, async (tx) => {
      const doc = await mustLoadDoc(tx, id, { forUpdate: true })
      this.d.perms.require(ctx, `${doc.docType}:void`)
      this.d.perms.assertDocVisible(ctx, this.scopeInfo(doc))
      if (doc.version !== version) throw new AppError('DOC_STATUS_CHANGED')
      if (doc.status !== 'draft') throw new AppError('INVALID_STATE_TRANSITION', `${statusMessage(doc.status)},只有草稿可作废`)
      await tx.query(`UPDATE document SET status='voided', version=version+1, updated_at=now(), updated_by=$2 WHERE id=$1`, [id, ctx.tenantUserId])
      await tx.query('DELETE FROM settlement WHERE document_id=$1 AND NOT applied', [id]) // 已作废的收付款单不再占用核销
      const after = await mustLoadDoc(tx, id)
      await this.d.audit.log(tx, ctx, 'document.void', { type: doc.docType, id, no: doc.docNo, before: { status: 'draft' }, after: { status: 'voided' } })
      return after
    })
  }

  /* ───────────────────────── 下推 ───────────────────────── */

  /** 由已审核的上游单据生成草稿下游单据,数量默认为剩余数量(需求 13.9、13.12) */
  async generateDownstream(ctx: Ctx, upstreamId: string, targetType: DocType): Promise<DocView> {
    const expectUp = GENERATE_FROM[targetType]
    if (!expectUp) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'targetType', reason: '该单据类型不能由上游单据生成' }])
    this.d.perms.require(ctx, `${targetType}:create`)
    const settings = await this.d.settings.get(ctx.tenantId)
    return this.d.db.withTenant(ctx.tenantId, async (tx) => {
      const up = await mustLoadDoc(tx, upstreamId)
      this.d.perms.assertDocVisible(ctx, this.scopeInfo(up))
      if (up.docType !== expectUp) throw new AppError('VALIDATION_FAILED', `${DOC_TYPE_LABEL[targetType]}应由${DOC_TYPE_LABEL[expectUp]}生成`, [{ field: 'upstreamId', reason: '上游单据类型不符' }])
      if (up.status !== 'audited') throw new AppError('VALIDATION_FAILED', `上游单据状态不符:${DOC_STATUS_LABEL[up.status]}`, [{ field: 'upstreamId', reason: '上游单据未审核' }])
      const used = await tx.rows(
        `SELECT dl.upstream_line_id, dl.sku_id, dl.base_qty FROM document_line dl JOIN document d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
         WHERE d.upstream_id=$1 AND d.status='audited'`,
        [upstreamId],
      )
      const remain = remainingQty(
        up.lines.map((l) => ({ id: l.id, skuId: l.skuId, baseQty: l.baseQty })),
        used.map((u) => ({ upstreamLineId: u.upstream_line_id, skuId: u.sku_id, baseQty: u.base_qty })),
      )
      const lines = up.lines
        .filter((l) => remain.get(l.id)!.gt(0))
        .map((l) => {
          const baseLeft = remain.get(l.id)!
          // 剩余数量能整除换算比例时用原单位,否则退回基本单位,保证数量精确
          const perUnit = baseLeft.div(l.ratio)
          const clean = perUnit.decimalPlaces() <= settings.scales.qtyScale
          return {
            skuId: l.skuId,
            unitName: clean ? l.unitName : null,
            ratio: clean ? l.ratio : 1,
            qty: (clean ? perUnit : baseLeft).toString(),
            price: clean ? l.price : dec(l.price).div(l.ratio).toFixed(settings.scales.priceScale),
            discountRate: l.discountRate,
            warehouseId: l.warehouseId,
            upstreamLineId: l.id,
          }
        })
      if (lines.length === 0) throw new AppError('VALIDATION_FAILED', '上游单据无剩余可执行数量', [{ field: 'upstreamId', reason: '无剩余可执行数量' }])
      const input: SaveInput = {
        docType: targetType,
        docDate: todayStr(this.d.tz, this.d.clock()),
        partnerId: up.partnerId,
        warehouseId: up.warehouseId,
        upstreamId: up.id,
        docDiscount: '0',
        paidAmount: '0',
        remark: '',
        lines,
      }
      return (await this.saveTx(tx, ctx, input, {}, settings)).doc
    })
  }

  /** 订单详情:按 SKU 显示订购/已执行/未执行数量,未执行最小为 0(需求 15.5、16.6) */
  async progress(ctx: Ctx, orderId: string) {
    return this.d.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const order = await this.getTx(tx, ctx, orderId)
        if (order.docType !== 'purchase_order' && order.docType !== 'sales_order') throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'id', reason: '仅订单支持进度查询' }])
        return this.d.posting.progressOf(tx, order)
      },
      { readOnly: true },
    )
  }
}
