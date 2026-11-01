import { calcDocTotal, calcLineAmount } from './amount'
import { Dec, assertScale, dec, isDecimalString, sum } from './decimal'
import type { ValidationIssue } from './errors'
import { toBaseQty } from './units'
import { DocType, Scales, isValidCalendarDate } from './types'

export interface DocLineInput {
  skuId: string
  unitName?: string | null
  /** 保存时从 product_unit 复制的换算比例,基本单位为 1 */
  ratio?: number
  qty: string
  price: string
  discountRate: string
  warehouseId?: string | null
  upstreamLineId?: string | null
  /** 盘点 */
  countedQty?: string | null
}

export interface DocInput {
  docType: DocType
  docDate: string
  partnerId?: string | null
  warehouseId?: string | null
  toWarehouseId?: string | null
  fundAccountId?: string | null
  fundCategoryId?: string | null
  upstreamId?: string | null
  handlerId?: string | null
  docDiscount?: string
  paidAmount?: string
  /** 收款单、付款单、其他收支单的单据金额 */
  amount?: string
  remark?: string | null
  custom?: Record<string, unknown>
  lines: DocLineInput[]
  /** 收款/付款单用户指定的核销 */
  allocations?: { key: string; amount: string }[]
}

export const MAX_DOC_LINES = 500
export const MAX_MONEY = '999999999.99'

export const TRADE_DOCS: DocType[] = ['purchase_order', 'purchase_in', 'purchase_return', 'sales_order', 'sales_out', 'sales_return']
export const PAID_DOCS: DocType[] = ['purchase_in', 'sales_out']
export const FUND_ONLY_DOCS: DocType[] = ['receipt', 'payment', 'other_income', 'other_expense']

export interface ComputedLine {
  amount: Dec
  baseQty: Dec
}
export interface ComputedDoc {
  lines: ComputedLine[]
  linesTotal: Dec
  total: Dec
}

/** 汇总行金额(逐行四舍五入)、基本单位数量与单据总金额(需求 15.2、16.2) */
export function computeDocAmounts(doc: Pick<DocInput, 'lines' | 'docDiscount' | 'docType' | 'amount'>, scales: Scales): ComputedDoc {
  if (FUND_ONLY_DOCS.includes(doc.docType)) {
    const t = dec(doc.amount ?? 0)
    return { lines: [], linesTotal: t, total: t }
  }
  const lines = doc.lines.map((l) => ({
    amount: calcLineAmount(l.qty || 0, l.price || 0, l.discountRate === undefined || l.discountRate === '' ? 100 : l.discountRate, scales.amountScale),
    baseQty: toBaseQty(l.qty || 0, l.ratio ?? 1),
  }))
  const linesTotal = sum(lines.map((l) => l.amount))
  return { lines, linesTotal, total: calcDocTotal(lines.map((l) => l.amount), doc.docDiscount ?? 0) }
}

const num = (s: unknown) => isDecimalString(s)

/**
 * 保存前的字段级校验,返回全部问题(含行号)。
 * 覆盖需求 14.12、14.13、15.8、16.10、17.5、17.7、17.13、7.9。
 */
export function validateDocumentDraft(doc: DocInput, scales: Scales): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (field: string, reason: string, row?: number) => issues.push({ field, reason, ...(row !== undefined ? { row } : {}) })

  if (!isValidCalendarDate(doc.docDate)) add('docDate', '单据日期不合法')
  if (doc.remark && Array.from(doc.remark).length > 500) add('remark', '备注不超过 500 个字符')

  /* 资金类单据 */
  if (FUND_ONLY_DOCS.includes(doc.docType)) {
    if (!doc.fundAccountId) add('fundAccountId', '请选择资金账户')
    if ((doc.docType === 'receipt' || doc.docType === 'payment') && !doc.partnerId) add('partnerId', '请选择往来单位')
    if ((doc.docType === 'other_income' || doc.docType === 'other_expense') && !doc.fundCategoryId) add('fundCategoryId', '请选择收支类别')
    const a = doc.amount
    if (!num(a) || dec(a).lt('0.01') || dec(a).gt(MAX_MONEY)) add('amount', '金额须为 0.01 至 999,999,999.99')
    else if (!assertScale(a!, 2)) add('amount', '金额最多 2 位小数')
    if ((doc.docType === 'other_income' || doc.docType === 'other_expense') && doc.remark && Array.from(doc.remark).length > 200) add('remark', '备注不超过 200 个字符')
    return issues
  }

  /* 明细通用 */
  if (doc.lines.length < 1 || doc.lines.length > MAX_DOC_LINES) add('lines', `明细行数须为 1 至 ${MAX_DOC_LINES} 行`)

  if (doc.docType === 'stocktake') {
    if (!doc.warehouseId) add('warehouseId', '请选择盘点仓库')
    doc.lines.forEach((l, i) => {
      if (!l.skuId) add('skuId', '请选择商品', i + 1)
      if (l.countedQty === null || l.countedQty === undefined || l.countedQty === '' || !num(l.countedQty) || dec(l.countedQty).isNegative()) add('countedQty', '盘点数量不能为空或小于 0', i + 1)
      else if (!assertScale(l.countedQty, scales.qtyScale)) add('countedQty', `数量最多 ${scales.qtyScale} 位小数`, i + 1)
    })
    return issues
  }

  if (doc.docType === 'transfer') {
    if (!doc.warehouseId) add('warehouseId', '请选择调出仓库')
    if (!doc.toWarehouseId) add('toWarehouseId', '请选择调入仓库')
    if (doc.warehouseId && doc.toWarehouseId && doc.warehouseId === doc.toWarehouseId) add('toWarehouseId', '调出与调入仓库不能相同')
    doc.lines.forEach((l, i) => {
      if (!l.skuId) add('skuId', '请选择商品', i + 1)
      if (!num(l.qty) || !dec(l.qty).gt(0)) add('qty', '数量必须大于 0', i + 1)
      else if (!assertScale(l.qty, scales.qtyScale)) add('qty', `数量最多 ${scales.qtyScale} 位小数`, i + 1)
    })
    return issues
  }

  /* 采购 / 销售 */
  if (!doc.partnerId) add('partnerId', doc.docType.startsWith('purchase') ? '请选择供应商' : '请选择客户')
  doc.lines.forEach((l, i) => {
    const row = i + 1
    if (!l.skuId) add('skuId', '请选择商品', row)
    if (!(l.warehouseId || doc.warehouseId)) add('warehouseId', '请选择仓库', row)
    if (!num(l.qty) || !dec(l.qty).gt(0)) add('qty', '数量必须大于 0', row)
    else if (!assertScale(l.qty, scales.qtyScale)) add('qty', `数量最多 ${scales.qtyScale} 位小数`, row)
    if (!num(l.price) || dec(l.price).isNegative()) add('price', '单价不能小于 0', row)
    else if (!assertScale(l.price, scales.priceScale)) add('price', `单价最多 ${scales.priceScale} 位小数`, row)
    const dr = l.discountRate === undefined || l.discountRate === '' ? '100' : l.discountRate
    if (!num(dr) || dec(dr).lt(0) || dec(dr).gt(100)) add('discountRate', '折扣率须为 0% 至 100%', row)
  })

  const discount = doc.docDiscount ?? '0'
  const linesBad = issues.some((i) => i.row !== undefined)
  if (!num(discount) || dec(discount).isNegative()) add('docDiscount', '整单优惠不能小于 0')
  else if (!assertScale(discount, scales.amountScale)) add('docDiscount', `金额最多 ${scales.amountScale} 位小数`)
  else if (!linesBad && doc.lines.length > 0) {
    const c = computeDocAmounts(doc, scales)
    if (dec(discount).gt(c.linesTotal)) add('docDiscount', '整单优惠不能大于明细行金额之和')
    const paid = doc.paidAmount ?? '0'
    if (PAID_DOCS.includes(doc.docType)) {
      if (!num(paid) || dec(paid).isNegative() || dec(paid).gt(c.total)) add('paidAmount', `本单${doc.docType === 'sales_out' ? '已收' : '已付'}金额须在 0 至单据总金额之间`)
      else if (dec(paid).gt(0) && !doc.fundAccountId) add('fundAccountId', '请选择资金账户')
    }
  }
  if (!PAID_DOCS.includes(doc.docType) && doc.paidAmount && dec(doc.paidAmount).gt(0)) add('paidAmount', '该单据类型不支持本单收付款')
  return issues
}
