import { computeDocAmounts, DocInput, validateDocumentDraft } from './docs'
import { dec } from './decimal'
import { defaultValues, FieldDef, sortFieldDefs } from './customFields'
import type { ValidationIssue } from './errors'
import { resolveUnitPrice } from './pricing'
import type { DocType, PriceLevel, Scales } from './types'
import { toBaseQty } from './units'

/** 开单表单的前端状态与计算,与后端共用 @erp/shared 的纯函数,保证前后端金额一致 */
export interface FormLine {
  skuId: string
  skuLabel: string
  unitName: string | null
  ratio: number
  qty: string
  price: string
  discountRate: string
  warehouseId: string | null
  upstreamLineId?: string | null
  countedQty?: string | null
}

export interface DocFormState {
  docType: DocType
  docDate: string
  partnerId: string | null
  warehouseId: string | null
  toWarehouseId?: string | null
  fundAccountId: string | null
  fundCategoryId?: string | null
  upstreamId?: string | null
  docDiscount: string
  paidAmount: string
  amount?: string
  remark: string
  custom: Record<string, unknown>
  lines: FormLine[]
  version?: number
  id?: string
}

export const emptyForm = (docType: DocType, today: string): DocFormState => ({
  docType,
  docDate: today,
  partnerId: null,
  warehouseId: null,
  fundAccountId: null,
  docDiscount: '0',
  paidAmount: '0',
  remark: '',
  custom: {},
  lines: [],
})

export function newLine(sku: { skuId: string; label: string; unitName?: string | null; ratio?: number }, price: string, warehouseId: string | null): FormLine {
  return { skuId: sku.skuId, skuLabel: sku.label, unitName: sku.unitName ?? null, ratio: sku.ratio ?? 1, qty: '1', price, discountRate: '100', warehouseId }
}

/** 扫码/选择 SKU 时:已存在则数量 +1,否则新增一行(需求 11.7) */
export function addOrIncrement(lines: FormLine[], line: FormLine): FormLine[] {
  const i = lines.findIndex((l) => l.skuId === line.skuId && l.unitName === line.unitName && l.warehouseId === line.warehouseId)
  if (i < 0) return [...lines, line]
  return lines.map((l, idx) => (idx === i ? { ...l, qty: dec(l.qty || 0).plus(1).toString() } : l))
}

export function toInput(f: DocFormState): DocInput {
  const isFund = ['receipt', 'payment', 'other_income', 'other_expense'].includes(f.docType)
  return {
    docType: f.docType,
    docDate: f.docDate,
    partnerId: f.partnerId,
    warehouseId: f.warehouseId,
    toWarehouseId: f.toWarehouseId ?? null,
    fundAccountId: f.fundAccountId,
    fundCategoryId: f.fundCategoryId ?? null,
    upstreamId: f.upstreamId ?? null,
    docDiscount: f.docDiscount || '0',
    paidAmount: f.paidAmount || '0',
    amount: f.amount,
    remark: f.remark,
    custom: f.custom,
    lines: isFund
      ? []
      : f.lines.map((l) => ({ skuId: l.skuId, unitName: l.unitName, ratio: l.ratio, qty: l.qty, price: l.price, discountRate: l.discountRate || '100', warehouseId: l.warehouseId, upstreamLineId: l.upstreamLineId ?? null, countedQty: l.countedQty ?? null })),
  }
}

/** 实时合计:逐行四舍五入后求和,再减整单优惠 */
export function totals(f: DocFormState, scales: Scales) {
  const c = computeDocAmounts(toInput(f), scales)
  return { lines: c.lines.map((l) => ({ amount: l.amount.toFixed(scales.amountScale), baseQty: l.baseQty.toString() })), linesTotal: c.linesTotal.toFixed(scales.amountScale), total: c.total.toFixed(scales.amountScale) }
}

/** 前端预校验(与后端 validateDocumentDraft 同一份规则),返回按字段/行号索引的错误 */
export function precheck(f: DocFormState, scales: Scales): { issues: ValidationIssue[]; byKey: Record<string, string> } {
  const issues = validateDocumentDraft(toInput(f), scales)
  const byKey: Record<string, string> = {}
  for (const i of issues) byKey[i.row !== undefined ? `${i.field}@${i.row}` : i.field] ??= i.reason
  return { issues, byKey }
}

/** 选择客户后按价格等级给每行填价(用户仍可手改;需求 12.4) */
export function repriceLines(lines: FormLine[], products: Record<string, { refSalePrice: string; wholesalePrice?: string | null }>, level: PriceLevel, priceScale: number, keepEdited: Set<number> = new Set()): FormLine[] {
  return lines.map((l, i) => {
    const p = products[l.skuId]
    if (!p || keepEdited.has(i)) return l
    return { ...l, price: resolveUnitPrice(p, level, priceScale).toFixed(priceScale) }
  })
}

/** 本单已收/已付的取值范围:0 – 单据总金额(需求 16.10、17.13) */
export function paidLimit(f: DocFormState, scales: Scales): string {
  return totals(f, scales).total
}

/** 小程序/移动端:显示用基本单位数量(辅助单位换算;需求 11.6) */
export function baseQtyOf(l: FormLine): string {
  return toBaseQty(l.qty || 0, l.ratio).toString()
}

/* ───────── 自定义字段表单(需求 6.3) ───────── */

/** 渲染顺序:显示顺序升序,相同按创建时间;只含启用字段 */
export function fieldsForForm(defs: FieldDef[]): FieldDef[] {
  return sortFieldDefs(defs.filter((d) => d.enabled !== false))
}

/** 新增页预填默认值;已保存的旧记录不回填默认值(创建前保存的记录显示为空) */
export function initialCustom(defs: FieldDef[], existing: Record<string, unknown> | null): Record<string, unknown> {
  return existing ? { ...existing } : defaultValues(defs.map((d) => ({ ...d, enabled: true })))
}
