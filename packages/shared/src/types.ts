/** 领域公共类型与常量 */

export const DOC_TYPES = [
  'purchase_order',
  'purchase_in',
  'purchase_return',
  'sales_order',
  'sales_out',
  'sales_return',
  'transfer',
  'stocktake',
  'receipt',
  'payment',
  'other_income',
  'other_expense',
] as const
export type DocType = (typeof DOC_TYPES)[number]

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  purchase_order: '采购订单',
  purchase_in: '采购入库单',
  purchase_return: '采购退货单',
  sales_order: '销售订单',
  sales_out: '销售出库单',
  sales_return: '销售退货单',
  transfer: '调拨单',
  stocktake: '盘点单',
  receipt: '收款单',
  payment: '付款单',
  other_income: '其他收入单',
  other_expense: '其他支出单',
}

/** 单据编号默认前缀 */
export const DOC_TYPE_PREFIX: Record<DocType, string> = {
  purchase_order: 'CGDD',
  purchase_in: 'CGRK',
  purchase_return: 'CGTH',
  sales_order: 'XSDD',
  sales_out: 'XSCK',
  sales_return: 'XSTH',
  transfer: 'DB',
  stocktake: 'PD',
  receipt: 'SK',
  payment: 'FK',
  other_income: 'QTSR',
  other_expense: 'QTZC',
}

export type DocStatus = 'draft' | 'audited' | 'voided'
export const DOC_STATUS_LABEL: Record<DocStatus, string> = { draft: '草稿', audited: '已审核', voided: '已作废' }

export const MODULE_CODES = ['product', 'inventory', 'purchase', 'sales', 'finance', 'report'] as const
export type ModuleCode = (typeof MODULE_CODES)[number]
export const MODULE_LABEL: Record<ModuleCode, string> = {
  product: '商品',
  inventory: '库存',
  purchase: '采购',
  sales: '销售',
  finance: '财务',
  report: '报表',
}

/** 单据类型所属模块 */
export const DOC_TYPE_MODULE: Record<DocType, ModuleCode> = {
  purchase_order: 'purchase',
  purchase_in: 'purchase',
  purchase_return: 'purchase',
  sales_order: 'sales',
  sales_out: 'sales',
  sales_return: 'sales',
  transfer: 'inventory',
  stocktake: 'inventory',
  receipt: 'finance',
  payment: 'finance',
  other_income: 'finance',
  other_expense: 'finance',
}

export type Direction = 'AR' | 'AP'
export type FundSource = 'receipt' | 'payment' | 'other_in' | 'other_out' | 'transfer_in' | 'transfer_out'

export type PriceLevel = { type: 'retail' } | { type: 'wholesale' } | { type: 'discount'; rate: string }

/** 租户精度参数 */
export interface Scales {
  qtyScale: number
  priceScale: number
  amountScale: number
}
export const DEFAULT_SCALES: Scales = { qtyScale: 2, priceScale: 4, amountScale: 2 }

/** 存储精度上限(设计 D10) */
export const STORAGE_SCALES: Scales = { qtyScale: 4, priceScale: 6, amountScale: 2 }

/** 日历日期(无时区) */
export interface LocalDate {
  y: number
  m: number
  d: number
}

export function toLocalDate(s: string): LocalDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw new Error(`invalid date: ${s}`)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

export function isValidCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const y = Number(m[1]),
    mo = Number(m[2]),
    d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d <= dim[mo - 1]
}

export function formatLocalDate(d: LocalDate): string {
  return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
}
