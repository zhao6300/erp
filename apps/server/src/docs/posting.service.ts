import {
  AppError,
  CostBalance,
  D,
  Dec,
  DocType,
  DocumentSnapshot,
  FundState,
  PostedEntries,
  PostingPlan,
  balanceOf,
  dec,
  fulfillmentStatus,
  isRejection,
  max0,
  planPosting,
  planReversal,
  stockKey,
} from '@erp/shared'
import type { NumberingService, SettingsService } from '../config/settings.service'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import type { EventService } from '../core/events'
import { uuidv7 } from '../core/ids'
import type { PermissionService } from '../core/permission/permission.service'
import { Clock, localDateIn } from '../core/time'
import { DOC_META, DocView, statusMessage, toEventPayload } from './document.model'
import { findReferences, loadDoc, mustLoadDoc, overQty } from './document.repo'
import { saveAllocations } from './settlement.repo'

export interface PostingDeps {
  db: Db
  settings: SettingsService
  numbering: NumberingService
  perms: PermissionService
  audit: AuditService
  events: EventService
  clock: Clock
  tz: string
}

const RETURN_DOCS: DocType[] = ['purchase_return', 'sales_return']
const ORDER_FULFILL_DOCS: DocType[] = ['purchase_in', 'sales_out']

/**
 * 过账引擎(设计 D3):规划(shared/planPosting 纯函数)→ 执行(本类,事务内加锁、校验、写流水、更新余额、改状态、写审计)。
 * 锁顺序固定:Document → 上游单据 → stock_balance(sku、仓库升序)→ partner_balance → fund_account(id 升序),避免死锁。
 */
export class PostingService {
  constructor(private d: PostingDeps) {}

  /* ═══════════════════════ 审核 ═══════════════════════ */

  async audit(ctx: Ctx, id: string, version: number, opts: { confirmCredit?: boolean } = {}): Promise<DocView> {
    // 事务外预读:权限、数据范围、状态/版本的快速失败,并供审核前插件使用(插件调用不持有行锁)
    const pre = await this.d.db.withTenant(ctx.tenantId, (tx) => loadDoc(tx, id), { readOnly: true })
    if (!pre) throw new AppError('NOT_FOUND')
    this.d.perms.require(ctx, `${pre.docType}:audit`)
    this.d.perms.assertDocVisible(ctx, this.scopeInfo(pre))
    if (pre.version !== version) throw new AppError('DOC_STATUS_CHANGED')
    if (pre.status !== 'draft') throw new AppError('INVALID_STATE_TRANSITION', `${statusMessage(pre.status)},无法审核`)

    await this.d.events.dispatchSync(toEventPayload(ctx.tenantId, 'document.beforeAudit', pre, 'draft'))

    return this.d.db.withTenant(ctx.tenantId, (tx) => this.auditTx(tx, ctx, id, version, opts))
  }

  private scopeInfo(d: DocView) {
    return { docType: d.docType, createdBy: d.createdBy, handlerId: d.handlerId, warehouseIds: [d.warehouseId, d.toWarehouseId, ...d.lines.map((l) => l.warehouseId)] }
  }

  async auditTx(tx: Tx, ctx: Ctx, id: string, version: number, opts: { confirmCredit?: boolean }): Promise<DocView> {
    const doc = await mustLoadDoc(tx, id, { forUpdate: true })
    // 事务内重新校验:插件调用期间单据可能已被他人修改(需求 13.8)
    if (doc.version !== version) throw new AppError('DOC_STATUS_CHANGED')
    if (doc.status !== 'draft') throw new AppError('INVALID_STATE_TRANSITION', `${statusMessage(doc.status)},无法审核`)
    const settings = await this.d.settings.read(tx)
    const meta = DOC_META[doc.docType]

    /* 停用的商品/SKU(需求 11.12) */
    await this.assertSkusEnabled(tx, doc)

    /* 上游单据:加行锁串行化,逐张核对可退/可入库数量(需求 15.7、15.9、16.7) */
    let upstream: any = null
    let upLines: any[] = []
    if (doc.upstreamId) {
      upstream = await tx.one('SELECT id, doc_type, total_amount, settled_amount FROM document WHERE id=$1 FOR UPDATE', [doc.upstreamId])
      upLines = await tx.rows('SELECT id, sku_id, base_qty, cost_price FROM document_line WHERE document_id=$1', [doc.upstreamId])
      if (meta.stock) {
        const viol = await overQty(tx, doc.upstreamId, upLines, doc.id, doc.lines.map((l) => ({ skuId: l.skuId, baseQty: l.baseQty })))
        if (viol.length) throw new AppError('OVER_RETURNABLE', `数量超过可退/可入库数量:${viol.map((v) => `${v.code} 剩余 ${v.remaining}`).join('、')}`, viol.map((v) => ({ field: 'qty', reason: '超过剩余数量', skuId: v.skuId, remaining: v.remaining })))
      }
    }

    /* 加锁:stock_balance → partner_balance → fund_account */
    const stockKeys = this.stockKeys(doc)
    const stock = await this.lockStock(tx, stockKeys)
    const funds = await this.lockFunds(tx, doc.fundAccountId ? [doc.fundAccountId] : [])
    let partner: any = null
    let pbal: any = null
    if (doc.partnerId) {
      partner = await tx.one('SELECT credit_limit, kind FROM partner WHERE id=$1', [doc.partnerId])
      pbal = await tx.one('SELECT * FROM partner_balance WHERE partner_id=$1 FOR UPDATE', [doc.partnerId])
    }

    /* 收款/付款:按当前未核销项重算核销分配,保留用户指定的部分 */
    let allocations: DocumentSnapshot['allocations']
    if ((doc.docType === 'receipt' || doc.docType === 'payment') && doc.partnerId) {
      const explicit = (await tx.rows('SELECT target_doc_id, amount FROM settlement WHERE document_id=$1 AND kind=\'manual\' AND NOT applied', [doc.id])).map((r) => ({ key: r.target_doc_id ?? 'opening', amount: r.amount as string }))
      const allocs = await saveAllocations(tx, ctx.tenantId, doc.id, doc.partnerId, doc.docType, doc.totalAmount, explicit)
      allocations = allocs.map((a) => ({ targetType: a.targetType, targetDocId: a.targetType === 'document' ? a.key : null, amount: a.amount }))
    }

    const upCost = new Map(upLines.map((l) => [l.id, l.cost_price as string | null]))
    const snapshot: DocumentSnapshot = {
      id: doc.id,
      docType: doc.docType,
      docNo: doc.docNo,
      docDate: doc.docDate,
      partnerId: doc.partnerId,
      warehouseId: doc.warehouseId,
      toWarehouseId: doc.toWarehouseId,
      fundAccountId: doc.fundAccountId,
      docDiscount: doc.docDiscount,
      paidAmount: doc.paidAmount,
      totalAmount: doc.totalAmount,
      allocations,
      lines: doc.lines.map((l) => ({
        id: l.id,
        skuId: l.skuId,
        warehouseId: (l.warehouseId ?? doc.warehouseId) as string,
        baseQty: l.baseQty,
        amount: l.amount,
        countedQty: doc.docType === 'stocktake' ? l.countedQty : null,
        returnUnitCost: doc.docType === 'sales_return' && l.upstreamLineId ? (upCost.get(l.upstreamLineId) ?? null) : null,
      })),
    }

    const plan = planPosting(snapshot, {
      scales: settings.scales,
      allowNegativeStock: settings.allowNegativeStock,
      stock,
      funds,
      credit: doc.docType === 'sales_out' && partner ? { limit: partner.credit_limit, arBalance: pbal.ar_balance, confirmed: !!opts.confirmCredit } : undefined,
      upstreamUnsettled: RETURN_DOCS.includes(doc.docType) && upstream ? dec(upstream.total_amount).minus(upstream.settled_amount).toString() : null,
    })
    if (isRejection(plan)) throw await this.reject(tx, plan)

    await this.persist(tx, ctx, doc, plan)

    /* 状态、版本、成本/毛利 */
    const inlinePaid = plan.inline ? plan.inline.amount : new D(0)
    const n = await tx.exec(
      `UPDATE document SET status='audited', version=version+1, audited_at=now(), audited_by=$3, gross_profit=$4, settled_amount = settled_amount + $5,
         fulfillment = CASE WHEN doc_type IN ('purchase_order','sales_order') AND fulfillment IS NULL THEN 'none' ELSE fulfillment END, updated_at=now()
       WHERE id=$1 AND version=$2 AND status='draft'`,
      [doc.id, version, ctx.tenantUserId, plan.grossProfit ? plan.grossProfit.toFixed(2) : null, inlinePaid.toFixed(2)],
    )
    if (n === 0) throw new AppError('DOC_STATUS_CHANGED')

    if (doc.upstreamId && ORDER_FULFILL_DOCS.includes(doc.docType)) await this.recomputeFulfillment(tx, doc.upstreamId)

    const after = await mustLoadDoc(tx, doc.id)
    await this.d.audit.log(tx, ctx, 'document.audit', { type: doc.docType, id: doc.id, no: doc.docNo, before: { status: 'draft' }, after: { status: 'audited', totalAmount: after.totalAmount } })
    await this.outbox(tx, ctx.tenantId, 'document.afterAudit', after)
    return after
  }

  /* ═══════════════════════ 反审核 ═══════════════════════ */

  async unaudit(ctx: Ctx, id: string, version: number): Promise<DocView> {
    return this.d.db.withTenant(ctx.tenantId, (tx) => this.unauditTx(tx, ctx, id, version))
  }

  async unauditTx(tx: Tx, ctx: Ctx, id: string, version: number): Promise<DocView> {
    const doc = await mustLoadDoc(tx, id, { forUpdate: true })
    this.d.perms.require(ctx, `${doc.docType}:unaudit`)
    this.d.perms.assertDocVisible(ctx, this.scopeInfo(doc))
    if (doc.version !== version) throw new AppError('DOC_STATUS_CHANGED')
    if (doc.status !== 'audited') throw new AppError('INVALID_STATE_TRANSITION', `${statusMessage(doc.status)},无法反审核`)
    if (doc.isInline) throw new AppError('INVALID_STATE_TRANSITION', '本单收付款记录随原单据反审核而变化,不可单独反审核')

    /* 被后续单据引用时拒绝,并列出全部引用单据编号(需求 13.5) */
    const refs = await findReferences(tx, doc.id)
    if (refs.length) throw new AppError('REFERENCED_BY_DOWNSTREAM', `该单据已被后续单据引用:${refs.join('、')}`, refs.map((no) => ({ field: 'docNo', reason: '已被引用', docNo: no })))

    const settings = await this.d.settings.read(tx)
    const upstream = doc.upstreamId ? await tx.maybeOne('SELECT id FROM document WHERE id=$1 FOR UPDATE', [doc.upstreamId]) : null

    /* 取出审核时写入且尚未冲回的流水 */
    const posted = await this.loadPosted(tx, doc.id)
    const keys = [...new Set(posted.stock.map((s) => stockKey(s.skuId, s.warehouseId)))].map((k) => k.split('|') as [string, string])
    const stock = await this.lockStock(tx, keys)
    const fundIds = [...new Set(posted.fund.map((f) => f.fundAccountId))]
    await this.lockFunds(tx, fundIds)
    if (doc.partnerId) await tx.one('SELECT 1 FROM partner_balance WHERE partner_id=$1 FOR UPDATE', [doc.partnerId])

    const plan = planReversal(posted, { scales: settings.scales, allowNegativeStock: settings.allowNegativeStock, stock })
    if (isRejection(plan)) throw await this.reject(tx, plan)

    await this.persist(tx, ctx, doc, plan)

    /* 核销反向:收付款单、本单收付款、退货冲抵 */
    let inlinePaid = new D(0)
    if (doc.docType === 'receipt' || doc.docType === 'payment') {
      const applied = await tx.rows('SELECT id, target_type, target_doc_id, amount FROM settlement WHERE document_id=$1 AND applied', [doc.id])
      for (const s of applied) {
        if (s.target_type === 'document') await tx.query('UPDATE document SET settled_amount = settled_amount - $2 WHERE id=$1', [s.target_doc_id, s.amount])
        else await tx.query(`UPDATE partner_balance SET ${doc.docType === 'receipt' ? 'opening_ar_settled' : 'opening_ap_settled'} = ${doc.docType === 'receipt' ? 'opening_ar_settled' : 'opening_ap_settled'} - $2 WHERE partner_id=$1`, [doc.partnerId, s.amount])
      }
      await tx.query('UPDATE settlement SET applied=false WHERE document_id=$1', [doc.id]) // 保留分配,草稿仍可见
    }
    const inline = await tx.maybeOne('SELECT id, total_amount FROM document WHERE origin_doc_id=$1 AND is_inline FOR UPDATE', [doc.id])
    if (inline) {
      inlinePaid = dec(inline.total_amount)
      await tx.query(`UPDATE document SET status='draft', version=version+1, audited_at=NULL WHERE id=$1`, [inline.id])
      await tx.query(`DELETE FROM settlement WHERE document_id=$1 AND kind='inline'`, [inline.id])
    }
    const offsets = await tx.rows(`SELECT id, target_doc_id, amount FROM settlement WHERE document_id=$1 AND kind='return_offset'`, [doc.id])
    for (const o of offsets) {
      await tx.query('UPDATE document SET settled_amount = settled_amount - $2 WHERE id=$1', [o.target_doc_id, o.amount])
      await tx.query('DELETE FROM settlement WHERE id=$1', [o.id])
    }

    await tx.query('UPDATE document_line SET cost_price=NULL, cost_amount=NULL, line_profit=NULL WHERE document_id=$1', [doc.id])
    const n = await tx.exec(
      `UPDATE document SET status='draft', version=version+1, audited_at=NULL, audited_by=NULL, gross_profit=NULL, settled_amount = settled_amount - $3, updated_at=now()
       WHERE id=$1 AND version=$2 AND status='audited'`,
      [doc.id, version, inlinePaid.toFixed(2)],
    )
    if (n === 0) throw new AppError('DOC_STATUS_CHANGED')
    if (upstream && ORDER_FULFILL_DOCS.includes(doc.docType)) await this.recomputeFulfillment(tx, doc.upstreamId as string)

    const after = await mustLoadDoc(tx, doc.id)
    await this.d.audit.log(tx, ctx, 'document.unaudit', { type: doc.docType, id: doc.id, no: doc.docNo, before: { status: 'audited' }, after: { status: 'draft' } })
    await this.outbox(tx, ctx.tenantId, 'document.afterUnaudit', after)
    return after
  }

  /* ═══════════════════════ 内部:加锁与载入 ═══════════════════════ */

  private stockKeys(doc: DocView): [string, string][] {
    const meta = DOC_META[doc.docType]
    if (!meta.stock) return []
    const set = new Map<string, [string, string]>()
    for (const l of doc.lines) {
      const wh = (l.warehouseId ?? doc.warehouseId) as string
      set.set(stockKey(l.skuId, wh), [l.skuId, wh])
      if (doc.docType === 'transfer' && doc.toWarehouseId) set.set(stockKey(l.skuId, doc.toWarehouseId), [l.skuId, doc.toWarehouseId])
    }
    return [...set.values()]
  }

  /** 确保余额行存在后,按 (sku、仓库) 升序加行锁,返回成本结存快照 */
  private async lockStock(tx: Tx, keys: [string, string][]): Promise<Map<string, CostBalance>> {
    const out = new Map<string, CostBalance>()
    if (!keys.length) return out
    const skus = keys.map((k) => k[0])
    const whs = keys.map((k) => k[1])
    await tx.query(
      `INSERT INTO stock_balance (tenant_id, sku_id, warehouse_id) SELECT $1, s, w FROM unnest($2::uuid[], $3::uuid[]) AS t(s, w) ON CONFLICT DO NOTHING`,
      [tx.tenantId, skus, whs],
    )
    const rows = await tx.rows(
      `SELECT sku_id, warehouse_id, qty, amount, avg_cost FROM stock_balance WHERE (sku_id, warehouse_id) IN (SELECT s, w FROM unnest($1::uuid[], $2::uuid[]) AS t(s, w)) ORDER BY sku_id, warehouse_id FOR UPDATE`,
      [skus, whs],
    )
    for (const r of rows) out.set(stockKey(r.sku_id, r.warehouse_id), balanceOf(r.qty, r.amount, r.avg_cost))
    return out
  }

  private async lockFunds(tx: Tx, ids: string[]): Promise<Map<string, FundState>> {
    const out = new Map<string, FundState>()
    if (!ids.length) return out
    const rows = await tx.rows('SELECT id, balance, enabled FROM fund_account WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
    for (const r of rows) out.set(r.id, { balance: r.balance, enabled: r.enabled })
    return out
  }

  private async assertSkusEnabled(tx: Tx, doc: DocView) {
    if (!doc.lines.length) return
    const rows = await tx.rows(
      `SELECT s.id, s.code, p.name FROM sku s JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id WHERE s.id = ANY($1::uuid[]) AND (NOT s.enabled OR NOT p.enabled)`,
      [doc.lines.map((l) => l.skuId)],
    )
    if (rows.length) {
      throw new AppError('VALIDATION_FAILED', `单据中包含已停用的商品:${rows.map((r) => `${r.code} ${r.name}`).join('、')}`, rows.map((r) => ({ field: 'skuId', reason: `商品已停用:${r.code} ${r.name}`, skuId: r.id })))
    }
  }

  /** 审核时写入、尚未被冲回的流水,按写入顺序 */
  private async loadPosted(tx: Tx, docId: string): Promise<PostedEntries> {
    const stock = await tx.rows(
      `SELECT l.id, l.line_id, l.sku_id, l.warehouse_id, l.qty_delta, l.unit_cost, l.amount_delta FROM stock_ledger l
       WHERE l.doc_id=$1 AND l.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.tenant_id = l.tenant_id AND r.reversal_of = l.id) ORDER BY l.seq`,
      [docId],
    )
    const partner = await tx.rows(
      `SELECT l.id, l.partner_id, l.direction, l.amount_delta, l.role FROM partner_ledger l
       WHERE l.doc_id=$1 AND l.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM partner_ledger r WHERE r.tenant_id = l.tenant_id AND r.reversal_of = l.id) ORDER BY l.occurred_at, l.id`,
      [docId],
    )
    const fund = await tx.rows(
      `SELECT l.id, l.fund_account_id, l.source, l.amount_delta, l.role FROM fund_ledger l
       WHERE l.source_id=$1 AND l.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM fund_ledger r WHERE r.tenant_id = l.tenant_id AND r.reversal_of = l.id) ORDER BY l.occurred_at, l.id`,
      [docId],
    )
    return {
      stock: stock.map((r) => ({ id: r.id, lineId: r.line_id ?? undefined, skuId: r.sku_id, warehouseId: r.warehouse_id, qtyDelta: r.qty_delta, unitCost: r.unit_cost, amountDelta: r.amount_delta })),
      partner: partner.map((r) => ({ id: r.id, partnerId: r.partner_id, direction: r.direction, amountDelta: r.amount_delta, role: r.role })),
      fund: fund.map((r) => ({ id: r.id, fundAccountId: r.fund_account_id, source: r.source, amountDelta: r.amount_delta, role: r.role })),
    }
  }

  /** 把规划结果落库:只追加流水 + 同事务更新余额缓存(设计 D2) */
  private async persist(tx: Tx, ctx: Ctx, doc: DocView, plan: PostingPlan): Promise<void> {
    const tenantId = ctx.tenantId
    const reversing = plan.stockEntries.some((e) => e.reversalOf) || plan.partnerEntries.some((e) => e.reversalOf) || plan.fundEntries.some((e) => e.reversalOf)

    for (const e of plan.stockEntries) {
      await tx.query(
        `INSERT INTO stock_ledger (id, tenant_id, doc_type, doc_id, doc_no, line_id, sku_id, warehouse_id, qty_delta, balance_after, unit_cost, amount_delta, reversal_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [uuidv7(), tenantId, doc.docType, doc.id, doc.docNo, e.lineId ?? null, e.skuId, e.warehouseId, e.qtyDelta.toFixed(4), e.balanceAfter.toFixed(4), e.unitCost.toFixed(6), e.amountDelta.toFixed(2), e.reversalOf ?? null],
      )
    }
    for (const [k, b] of plan.stockBalances) {
      const [sku, wh] = k.split('|')
      await tx.query('UPDATE stock_balance SET qty=$3, amount=$4, avg_cost=$5 WHERE sku_id=$1 AND warehouse_id=$2', [sku, wh, b.qty.toFixed(4), b.amount.toFixed(2), b.avgCost.toFixed(6)])
    }

    const arDelta = new Map<string, Dec>()
    const apDelta = new Map<string, Dec>()
    for (const e of plan.partnerEntries) {
      await tx.query('INSERT INTO partner_ledger (id, tenant_id, partner_id, direction, doc_id, role, amount_delta, reversal_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuidv7(), tenantId, e.partnerId, e.direction, doc.id, e.role, e.amountDelta.toFixed(2), e.reversalOf ?? null])
      const m = e.direction === 'AR' ? arDelta : apDelta
      m.set(e.partnerId, (m.get(e.partnerId) ?? new D(0)).plus(e.amountDelta))
    }
    for (const [pid, d] of arDelta) await tx.query('UPDATE partner_balance SET ar_balance = ar_balance + $2 WHERE partner_id=$1', [pid, d.toFixed(2)])
    for (const [pid, d] of apDelta) await tx.query('UPDATE partner_balance SET ap_balance = ap_balance + $2 WHERE partner_id=$1', [pid, d.toFixed(2)])

    const fundDelta = new Map<string, Dec>()
    for (const e of plan.fundEntries) {
      await tx.query('INSERT INTO fund_ledger (id, tenant_id, fund_account_id, source, source_id, role, amount_delta, reversal_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuidv7(), tenantId, e.fundAccountId, e.source, doc.id, e.role, e.amountDelta.toFixed(2), e.reversalOf ?? null])
      fundDelta.set(e.fundAccountId, (fundDelta.get(e.fundAccountId) ?? new D(0)).plus(e.amountDelta))
    }
    for (const [fid, d] of fundDelta) await tx.query('UPDATE fund_account SET balance = balance + $2 WHERE id=$1', [fid, d.toFixed(2)])

    if (reversing) return

    /* 以下仅审核方向 */
    for (const c of plan.lineCosts) {
      await tx.query('UPDATE document_line SET cost_price=$2, cost_amount=$3, line_profit=$4 WHERE id=$1', [c.lineId, c.costPrice.toFixed(6), c.costAmount.toFixed(2), c.lineProfit ? c.lineProfit.toFixed(2) : null])
    }

    // 收款/付款单:核销生效
    if (plan.settlementApply.length > 0) {
      await tx.query('UPDATE settlement SET applied=true WHERE document_id=$1', [doc.id])
      for (const a of plan.settlementApply) {
        if (a.targetType === 'document') await tx.query('UPDATE document SET settled_amount = settled_amount + $2 WHERE id=$1', [a.targetDocId, dec(a.amount).toFixed(2)])
        else await tx.query(`UPDATE partner_balance SET ${doc.docType === 'receipt' ? 'opening_ar_settled' : 'opening_ap_settled'} = ${doc.docType === 'receipt' ? 'opening_ar_settled' : 'opening_ap_settled'} + $2 WHERE partner_id=$1`, [doc.partnerId, dec(a.amount).toFixed(2)])
      }
    }

    // 本单收付款:同事务生成/恢复一张内联收款/付款单,全额核销本单(需求 17.6)
    if (plan.inline) {
      const inl = plan.inline
      const existing = await tx.maybeOne('SELECT id FROM document WHERE origin_doc_id=$1 AND is_inline FOR UPDATE', [doc.id])
      let inlineId: string
      if (existing) {
        inlineId = existing.id
        await tx.query(`UPDATE document SET status='audited', total_amount=$2, fund_account_id=$3, audited_at=now(), audited_by=$4, version=version+1 WHERE id=$1`, [inlineId, inl.amount.toFixed(2), inl.fundAccountId, ctx.tenantUserId])
      } else {
        inlineId = uuidv7()
        const no = await this.d.numbering.next(tx, tenantId, inl.kind, localDateIn(this.d.tz, this.d.clock()))
        await tx.query(
          `INSERT INTO document (id, tenant_id, doc_type, doc_no, doc_date, status, partner_id, fund_account_id, origin_doc_id, is_inline, handler_id, total_amount, remark, audited_at, audited_by, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,'audited',$6,$7,$8,true,$9,$10,$11,now(),$12,$12,$12)`,
          [inlineId, tenantId, inl.kind, no, doc.docDate, inl.partnerId, inl.fundAccountId, doc.id, doc.handlerId, inl.amount.toFixed(2), `本单${inl.kind === 'receipt' ? '收款' : '付款'}(${doc.docNo})`, ctx.tenantUserId],
        )
      }
      await tx.query(`INSERT INTO settlement (id, tenant_id, document_id, kind, target_type, target_doc_id, amount, applied) VALUES ($1,$2,$3,'inline','document',$4,$5,true)`, [uuidv7(), tenantId, inlineId, doc.id, inl.amount.toFixed(2)])
    }

    // 退货冲抵原单未核销金额(设计 D7)
    if (plan.returnOffset.gt(0) && doc.upstreamId) {
      await tx.query(`INSERT INTO settlement (id, tenant_id, document_id, kind, target_type, target_doc_id, amount, applied) VALUES ($1,$2,$3,'return_offset','document',$4,$5,true)`, [uuidv7(), tenantId, doc.id, doc.upstreamId, plan.returnOffset.toFixed(2)])
      await tx.query('UPDATE document SET settled_amount = settled_amount + $2 WHERE id=$1', [doc.upstreamId, plan.returnOffset.toFixed(2)])
    }
  }

  /** 领域拒绝 → AppError;库存不足时补充 SKU 编码/名称/仓库名称便于展示(需求 13.10) */
  private async reject(tx: Tx, r: { code: any; message?: string; details: any[] }): Promise<AppError> {
    let details = r.details
    if (r.code === 'INSUFFICIENT_STOCK') {
      const skuIds = [...new Set(details.map((d) => d.skuId).filter(Boolean))]
      const whIds = [...new Set(details.map((d) => d.warehouseId).filter(Boolean))]
      const skus = new Map((await tx.rows('SELECT s.id, s.code, p.name FROM sku s JOIN product p ON p.tenant_id=s.tenant_id AND p.id=s.product_id WHERE s.id = ANY($1::uuid[])', [skuIds])).map((x) => [x.id, x]))
      const whs = new Map((await tx.rows('SELECT id, name FROM warehouse WHERE id = ANY($1::uuid[])', [whIds])).map((x) => [x.id, x.name]))
      details = details.map((d) => ({ ...d, skuCode: skus.get(d.skuId)?.code, productName: skus.get(d.skuId)?.name, warehouseName: whs.get(d.warehouseId) }))
      return new AppError('INSUFFICIENT_STOCK', `库存不足:${details.map((d) => `${d.skuCode ?? d.skuId}(${d.warehouseName ?? ''})当前 ${d.currentQty},需出库 ${d.requiredQty}`).join(';')}`, details)
    }
    return new AppError(r.code, r.message, details)
  }

  private async outbox(tx: Tx, tenantId: string, type: 'document.afterAudit' | 'document.afterUnaudit', doc: DocView) {
    const payload = toEventPayload(tenantId, type, doc, doc.status)
    await tx.query('INSERT INTO event_outbox (tenant_id, event_type, payload) VALUES ($1,$2,$3)', [tenantId, type, JSON.stringify(payload)])
  }

  /* ═══════════════════════ 订单进度 ═══════════════════════ */

  private async progressRows(tx: Tx, orderId: string) {
    return tx.rows(
      `SELECT dl.sku_id, s.code AS sku_code, p.name, sum(dl.base_qty)::text AS ordered,
         COALESCE((SELECT sum(x.base_qty) FROM document_line x JOIN document d ON d.tenant_id = x.tenant_id AND d.id = x.document_id
                   WHERE d.upstream_id = $1 AND d.status = 'audited' AND x.sku_id = dl.sku_id), 0)::text AS received
       FROM document_line dl JOIN sku s ON s.tenant_id = dl.tenant_id AND s.id = dl.sku_id JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
       WHERE dl.document_id = $1 GROUP BY dl.sku_id, s.code, p.name ORDER BY s.code`,
      [orderId],
    )
  }

  /** 订购/已执行/未执行(未执行最小为 0;需求 15.5、16.6) */
  async progressOf(tx: Tx, order: DocView) {
    const rows = await this.progressRows(tx, order.id)
    return {
      fulfillment: order.fulfillment ?? 'none',
      items: rows.map((r) => ({
        skuId: r.sku_id,
        skuCode: r.sku_code,
        name: r.name,
        ordered: r.ordered,
        received: r.received,
        // 与 ordered/received 同为存储精度(4 位),未执行数量最小为 0
        pending: max0(dec(r.ordered).minus(r.received)).toFixed(4),
      })),
    }
  }

  /** 下游单据审核/反审核的同一事务内重新计算订单进度(需求 15.6、16.11) */
  private async recomputeFulfillment(tx: Tx, orderId: string): Promise<void> {
    const order = await tx.maybeOne('SELECT doc_type FROM document WHERE id=$1', [orderId])
    if (!order || (order.doc_type !== 'purchase_order' && order.doc_type !== 'sales_order')) return
    const rows = await this.progressRows(tx, orderId)
    const status = fulfillmentStatus(rows.map((r) => r.ordered), rows.map((r) => r.received))
    await tx.query('UPDATE document SET fulfillment=$2 WHERE id=$1', [orderId, status])
  }
}

