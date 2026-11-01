import { AppError, Allocation, OpenItem, allocateSettlement, dec, isAllocationError } from '@erp/shared'
import type { Tx } from '../core/db'
import { uuidv7 } from '../core/ids'

/**
 * Partner 的未核销项(设计 D7):期初应收/应付作为日期最早的虚拟项;
 * 已审核销售出库单(采购入库单)的 total_amount − settled_amount。
 */
export async function loadOpenItems(tx: Tx, partnerId: string, direction: 'AR' | 'AP'): Promise<OpenItem[]> {
  const items: OpenItem[] = []
  const p = await tx.maybeOne(
    `SELECT (p.opening_ar - b.opening_ar_settled)::text AS ar, (p.opening_ap - b.opening_ap_settled)::text AS ap
     FROM partner p JOIN partner_balance b ON b.tenant_id = p.tenant_id AND b.partner_id = p.id WHERE p.id=$1`,
    [partnerId],
  )
  if (!p) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'partnerId', reason: '关联记录不存在' }])
  const opening: string = direction === 'AR' ? p.ar : p.ap
  if (dec(opening).gt(0)) items.push({ key: 'opening', type: 'opening', date: '0000-00-00', docNo: '', unsettled: opening })
  const type = direction === 'AR' ? 'sales_out' : 'purchase_in'
  const docs = await tx.rows(
    `SELECT id, doc_no, doc_date, (total_amount - settled_amount)::text AS unsettled FROM document
     WHERE partner_id=$1 AND doc_type=$2 AND status='audited' AND total_amount - settled_amount > 0`,
    [partnerId, type],
  )
  for (const d of docs) items.push({ key: d.id, type: 'document', date: d.doc_date, docNo: d.doc_no, unsettled: d.unsettled })
  return items
}

/** 保存收款/付款单时计算并落库核销分配(未生效,审核时才更新 settled_amount 与往来余额) */
export async function saveAllocations(
  tx: Tx,
  tenantId: string,
  docId: string,
  partnerId: string,
  kind: 'receipt' | 'payment',
  amount: string,
  explicit: { key: string; amount: string }[] | undefined,
): Promise<Allocation[]> {
  const items = await loadOpenItems(tx, partnerId, kind === 'receipt' ? 'AR' : 'AP')
  const r = allocateSettlement(amount, explicit ?? [], items)
  if (isAllocationError(r)) {
    throw new AppError(
      'VALIDATION_FAILED',
      r.issues.map((i) => `${i.reason}${i.available !== undefined ? `(可核销 ${i.available.toFixed(2)})` : ''}`).join(';'),
      r.issues.map((i) => ({ field: 'allocations', reason: i.reason, key: i.key ?? null, available: i.available?.toFixed(2) ?? null })),
    )
  }
  await tx.query('DELETE FROM settlement WHERE document_id=$1 AND NOT applied', [docId])
  for (const a of r) {
    await tx.query(
      `INSERT INTO settlement (id, tenant_id, document_id, kind, target_type, target_doc_id, amount, applied) VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [uuidv7(), tenantId, docId, a.kind, a.targetType, a.targetType === 'document' ? a.key : null, a.amount.toFixed(2)],
    )
  }
  return r
}
