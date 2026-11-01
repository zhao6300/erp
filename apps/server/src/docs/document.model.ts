import { DOC_STATUS_LABEL, DocStatus, DocType, ModuleCode, ObjectType } from '@erp/shared'
import type { DocumentPayload, EventPayload, EventType } from '@erp/plugin-sdk'

export interface DocLineView {
  id: string
  lineNo: number
  skuId: string
  skuCode?: string
  productName?: string
  spec?: string
  unitName: string | null
  ratio: number
  qty: string
  baseQty: string
  price: string
  discountRate: string
  amount: string
  netAmount: string
  warehouseId: string | null
  upstreamLineId: string | null
  costPrice: string | null
  costAmount: string | null
  lineProfit: string | null
  snapshotQty: string | null
  countedQty: string | null
}

export interface DocView {
  id: string
  docType: DocType
  docNo: string
  docDate: string
  status: DocStatus
  partnerId: string | null
  warehouseId: string | null
  toWarehouseId: string | null
  fundAccountId: string | null
  fundCategoryId: string | null
  upstreamId: string | null
  originDocId: string | null
  isInline: boolean
  handlerId: string | null
  docDiscount: string
  paidAmount: string
  totalAmount: string
  settledAmount: string
  grossProfit: string | null
  fulfillment: string | null
  remark: string
  custom: Record<string, unknown>
  version: number
  auditedAt: string | null
  createdBy: string | null
  createdAt: string
  lines: DocLineView[]
}

export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null))

export function rowToLine(r: any): DocLineView {
  return {
    id: r.id,
    lineNo: r.line_no,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    productName: r.product_name,
    spec: r.spec,
    unitName: r.unit_name,
    ratio: r.ratio,
    qty: r.qty,
    baseQty: r.base_qty,
    price: r.price,
    discountRate: r.discount_rate,
    amount: r.amount,
    netAmount: r.net_amount,
    warehouseId: r.warehouse_id,
    upstreamLineId: r.upstream_line_id,
    costPrice: r.cost_price,
    costAmount: r.cost_amount,
    lineProfit: r.line_profit,
    snapshotQty: r.snapshot_qty,
    countedQty: r.counted_qty,
  }
}

export function rowToDoc(r: any, lines: any[]): DocView {
  return {
    id: r.id,
    docType: r.doc_type,
    docNo: r.doc_no,
    docDate: r.doc_date,
    status: r.status,
    partnerId: r.partner_id,
    warehouseId: r.warehouse_id,
    toWarehouseId: r.to_warehouse_id,
    fundAccountId: r.fund_account_id,
    fundCategoryId: r.fund_category_id,
    upstreamId: r.upstream_id,
    originDocId: r.origin_doc_id,
    isInline: r.is_inline,
    handlerId: r.handler_id,
    docDiscount: r.doc_discount,
    paidAmount: r.paid_amount,
    totalAmount: r.total_amount,
    settledAmount: r.settled_amount,
    grossProfit: r.gross_profit,
    fulfillment: r.fulfillment,
    remark: r.remark,
    custom: r.custom,
    version: r.version,
    auditedAt: iso(r.audited_at),
    createdBy: r.created_by,
    createdAt: iso(r.created_at) as string,
    lines: lines.map(rowToLine),
  }
}

/** 单据类型元数据 */
export interface DocMeta {
  module: ModuleCode
  objectType?: ObjectType
  trade?: 'purchase' | 'sales'
  /** 要求的上游单据类型 */
  upstreamType?: DocType
  fundOnly?: boolean
  /** 是否按 SKU 处理库存 */
  stock?: boolean
}

export const DOC_META: Record<DocType, DocMeta> = {
  purchase_order: { module: 'purchase', objectType: 'purchase_doc', trade: 'purchase' },
  purchase_in: { module: 'purchase', objectType: 'purchase_doc', trade: 'purchase', upstreamType: 'purchase_order', stock: true },
  purchase_return: { module: 'purchase', objectType: 'purchase_doc', trade: 'purchase', upstreamType: 'purchase_in', stock: true },
  sales_order: { module: 'sales', objectType: 'sales_doc', trade: 'sales' },
  sales_out: { module: 'sales', objectType: 'sales_doc', trade: 'sales', upstreamType: 'sales_order', stock: true },
  sales_return: { module: 'sales', objectType: 'sales_doc', trade: 'sales', upstreamType: 'sales_out', stock: true },
  transfer: { module: 'inventory', stock: true },
  stocktake: { module: 'inventory', stock: true },
  receipt: { module: 'finance', fundOnly: true },
  payment: { module: 'finance', fundOnly: true },
  other_income: { module: 'finance', fundOnly: true },
  other_expense: { module: 'finance', fundOnly: true },
}

/** 下游单据类型 → 其上游类型 */
export const GENERATE_FROM: Partial<Record<DocType, DocType>> = {
  purchase_in: 'purchase_order',
  sales_out: 'sales_order',
  purchase_return: 'purchase_in',
  sales_return: 'sales_out',
}

export const statusMessage = (s: DocStatus) => `单据当前状态为“${DOC_STATUS_LABEL[s]}”`

export function toEventPayload(tenantId: string, eventType: EventType, d: Partial<DocView> & Pick<DocView, 'docType' | 'docDate' | 'lines'>, status: DocStatus): EventPayload {
  const document: DocumentPayload = {
    id: d.id ?? null,
    docType: d.docType,
    docNo: d.docNo ?? null,
    docDate: d.docDate,
    status,
    partnerId: d.partnerId ?? null,
    warehouseId: d.warehouseId ?? null,
    toWarehouseId: d.toWarehouseId ?? null,
    fundAccountId: d.fundAccountId ?? null,
    docDiscount: d.docDiscount ?? '0',
    paidAmount: d.paidAmount ?? '0',
    totalAmount: d.totalAmount ?? '0',
    remark: d.remark ?? '',
    custom: d.custom ?? {},
    lines: d.lines.map((l) => ({
      lineNo: l.lineNo,
      skuId: l.skuId,
      unitName: l.unitName,
      ratio: l.ratio,
      qty: l.qty,
      baseQty: l.baseQty,
      price: l.price,
      discountRate: l.discountRate,
      amount: l.amount,
      warehouseId: l.warehouseId,
    })),
  }
  return { version: 1, eventType, tenantId, docType: d.docType, docNo: d.docNo ?? null, status, occurredAt: new Date().toISOString(), document }
}
