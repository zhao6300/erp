import { DOC_STATUS_LABEL, DOC_TYPE_LABEL, DocType } from '@erp/shared'

export { DOC_STATUS_LABEL, DOC_TYPE_LABEL }

export const isFundDoc = (t: DocType) => ['receipt', 'payment', 'other_income', 'other_expense'].includes(t)
export const isTradeDoc = (t: DocType) => ['purchase_order', 'purchase_in', 'purchase_return', 'sales_order', 'sales_out', 'sales_return'].includes(t)
export const hasPaid = (t: DocType) => t === 'purchase_in' || t === 'sales_out'
export const partnerKind = (t: DocType): 'customer' | 'supplier' | undefined =>
  t.startsWith('purchase') || t === 'payment' ? 'supplier' : t.startsWith('sales') || t === 'receipt' ? 'customer' : undefined

/** 可由上游单据下推生成的目标类型 */
export const PUSH_TARGETS: Partial<Record<DocType, DocType>> = {
  purchase_order: 'purchase_in',
  sales_order: 'sales_out',
  purchase_in: 'purchase_return',
  sales_out: 'sales_return',
}

export const statusTag = (s: string): 'info' | 'success' | 'danger' => (s === 'audited' ? 'success' : s === 'voided' ? 'danger' : 'info')
export const FULFILL_LABEL: Record<string, string> = { none: '未执行', partial: '部分执行', done: '已完成' }
