import { AppError, checkOverQty } from '@erp/shared'
import type { Tx } from '../core/db'
import { DocView, rowToDoc } from './document.model'

export async function loadDoc(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<DocView | null> {
  const r = await tx.maybeOne(`SELECT * FROM document WHERE id=$1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`, [id])
  if (!r) return null
  const lines = await tx.rows(
    `SELECT dl.*, s.code AS sku_code, p.name AS product_name, p.spec
     FROM document_line dl JOIN sku s ON s.tenant_id = dl.tenant_id AND s.id = dl.sku_id JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
     WHERE dl.document_id=$1 ORDER BY dl.line_no`,
    [id],
  )
  return rowToDoc(r, lines)
}

export async function mustLoadDoc(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<DocView> {
  const d = await loadDoc(tx, id, opts)
  if (!d) throw new AppError('NOT_FOUND')
  return d
}

/** 其他已审核下游单据已用数量 + 本单数量 与上游比较,返回超量的 SKU(需求 15.7、15.9、16.7) */
export async function overQty(
  tx: Tx,
  upstreamId: string,
  upLines: { id: string; sku_id: string; base_qty: string }[],
  selfId: string | null,
  mine: { skuId: string; baseQty: string }[],
): Promise<{ skuId: string; code: string; remaining: string }[]> {
  const used = await tx.rows(
    `SELECT dl.upstream_line_id, dl.sku_id, dl.base_qty FROM document_line dl JOIN document d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
     WHERE d.upstream_id=$1 AND d.status='audited' AND d.id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`,
    [upstreamId, selfId],
  )
  const v = checkOverQty(
    upLines.map((l) => ({ id: l.id, skuId: l.sku_id, baseQty: l.base_qty })),
    used.map((u) => ({ upstreamLineId: u.upstream_line_id, skuId: u.sku_id, baseQty: u.base_qty })),
    mine,
  )
  if (!v.length) return []
  const codes = new Map((await tx.rows('SELECT id, code FROM sku WHERE id = ANY($1::uuid[])', [v.map((x) => x.skuId)])).map((r) => [r.id, r.code]))
  return v.map((x) => ({ skuId: x.skuId, code: codes.get(x.skuId) ?? x.skuId, remaining: x.remaining.toString() }))
}

/** 该单据被后续单据引用的编号列表(需求 13.5):下游单据 + 核销其金额的收付款单;不含本单自身的内联收付款与已作废单据 */
export async function findReferences(tx: Tx, docId: string): Promise<string[]> {
  const rows = await tx.rows<{ doc_no: string }>(
    `SELECT doc_no FROM document WHERE upstream_id=$1 AND status <> 'voided'
     UNION
     SELECT d.doc_no FROM settlement s JOIN document d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
      WHERE s.target_doc_id=$1 AND d.status <> 'voided' AND NOT d.is_inline AND s.kind IN ('manual','fifo')
     ORDER BY 1`,
    [docId],
  )
  return rows.map((r) => r.doc_no)
}
