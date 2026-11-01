import { AppError } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { World, setupWorld, TestApp } from './support/app'

let app: TestApp
let w: World
let sku: string
let customer: string
let supplier: string

beforeAll(async () => {
  const s = await setupWorld(inject('pgAdminUrl'))
  app = s.app
  w = s.w
  sku = await w.product('A001')
  customer = await w.partner('C1', 'customer')
  supplier = await w.partner('S1', 'supplier')
})
afterAll(async () => {
  await app.close()
})

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'OK'
  } catch (e) {
    return e instanceof AppError ? e.code : `ERR:${(e as Error).message}`
  }
}

describe('单据保存与编号(需求 7.3、13.1)', () => {
  it('首次保存生成草稿与编号;编号 = 前缀 + 日期 + 补零流水号', async () => {
    const r = await w.save(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku, '1', '10')] }))
    expect(r.doc.status).toBe('draft')
    expect(r.doc.docNo).toBe('CGRK202609300001')
    const r2 = await w.save(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku, '1', '10')] }))
    expect(r2.doc.docNo).toBe('CGRK202609300002')
  })

  it('不同单据类型各自计数', async () => {
    const r = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    expect(r.doc.docNo).toBe('XSDD202609300001')
  })

  it('字段校验失败时一次性返回全部问题并带行号,不写入任何数据', async () => {
    const before = await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM document'))
    try {
      await w.save(w.doc('sales_out', { partnerId: customer, lines: [w.line(sku, '0', '10'), w.line(sku, '1', '-1')] }))
      expect.unreachable()
    } catch (e) {
      const err = e as AppError
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(err.details?.map((d) => `${d.field}@${d.row}`)).toEqual(['qty@1', 'price@2'])
    }
    expect((await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM document'))).n).toBe(before.n)
  })
})

describe('采购入库 → 销售出库 → 反审核(需求 13、14、15、16)', () => {
  let purchaseId: string
  it('采购入库审核:增加库存与应付,写入库存流水,移动加权平均成本', async () => {
    const d = await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku, '10', '60')] }))
    purchaseId = d.id
    expect(d.status).toBe('audited')
    const s = await w.stock(sku)
    expect(s).toMatchObject({ qty: '10.0000', amount: '600.00', avg_cost: '60.000000' })
    expect((await w.partnerBal(supplier)).ap_balance).toBe('600.00')
    const ledger = await w.run((tx) => tx.rows('SELECT qty_delta, balance_after, unit_cost, amount_delta FROM stock_ledger WHERE doc_id=$1', [d.id]))
    expect(ledger).toEqual([{ qty_delta: '10.0000', balance_after: '10.0000', unit_cost: '60.000000', amount_delta: '600.00' }])
  })

  it('再入库一批,均价按(原金额 + 入库金额)÷(原数量 + 入库数量)重算', async () => {
    await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku, '10', '80')] }))
    expect(await w.stock(sku)).toMatchObject({ qty: '20.0000', amount: '1400.00', avg_cost: '70.000000' })
  })

  it('销售出库(带本单已收):扣库存、增加应收、生成内联收款单、保存毛利', async () => {
    const before = await w.fundBal(w.f.cashId)
    const d = await w.saveAudit(w.doc('sales_out', { partnerId: customer, fundAccountId: w.f.cashId, paidAmount: '100', lines: [w.line(sku, '5', '100')] }))
    expect(d.status).toBe('audited')
    expect(await w.stock(sku)).toMatchObject({ qty: '15.0000', amount: '1050.00', avg_cost: '70.000000' })
    expect((await w.partnerBal(customer)).ar_balance).toBe('400.00') // 500 − 已收 100
    expect(Number(await w.fundBal(w.f.cashId)) - Number(before)).toBe(100)
    expect(d.grossProfit).toBe('150.00') // 500 − 5×70
    expect(d.lines[0]).toMatchObject({ costPrice: '70.000000', costAmount: '350.00', lineProfit: '150.00' })
    expect(d.settledAmount).toBe('100.00')
    const inline = await w.run((tx) => tx.one(`SELECT doc_type, status, total_amount, is_inline FROM document WHERE origin_doc_id=$1`, [d.id]))
    expect(inline).toEqual({ doc_type: 'receipt', status: 'audited', total_amount: '100.00', is_inline: true })
  })

  it('反审核销售出库:库存、应收、资金回到审核前,以反向流水冲回,原流水保留', async () => {
    const list = await w.c.documents.list(w.ctx, { docType: 'sales_out' })
    const out = list.items[0]
    const before = { stock: await w.stock(sku), ar: await w.partnerBal(customer), cash: await w.fundBal(w.f.cashId) }
    const ledgerBefore = (await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM stock_ledger WHERE doc_id=$1', [out.id]))).n
    const d = await w.c.posting.unaudit(w.ctx, out.id, out.version)
    expect(d.status).toBe('draft')
    expect(await w.stock(sku)).toMatchObject({ qty: '20.0000', amount: '1400.00', avg_cost: '70.000000' })
    expect((await w.partnerBal(customer)).ar_balance).toBe('0.00')
    expect(Number(await w.fundBal(w.f.cashId)) - Number(before.cash)).toBe(-100)
    expect(before.stock!.qty).toBe('15.0000')
    const rows = await w.run((tx) => tx.rows('SELECT qty_delta, reversal_of FROM stock_ledger WHERE doc_id=$1 ORDER BY seq', [out.id]))
    expect(rows).toHaveLength(ledgerBefore * 2)
    expect(rows[1].reversal_of).not.toBeNull()
    expect(rows[1].qty_delta).toBe('5.0000')
    expect(d.grossProfit).toBeNull()
    expect(d.settledAmount).toBe('0.00')
    const inline = await w.run((tx) => tx.one(`SELECT status FROM document WHERE origin_doc_id=$1`, [out.id]))
    expect(inline.status).toBe('draft')
  })

  it('库存一致性:余额 = 期初 + Σ流水', async () => {
    const r = await w.run((tx) => tx.one('SELECT sb.qty, sb.opening_qty + COALESCE((SELECT sum(qty_delta) FROM stock_ledger l WHERE l.sku_id=sb.sku_id AND l.warehouse_id=sb.warehouse_id),0) AS expected FROM stock_balance sb WHERE sb.sku_id=$1', [sku]))
    expect(r.qty).toBe(r.expected)
  })

  it('重新审核反审核过的单据成功(往返后可再次过账)', async () => {
    const out = (await w.c.documents.list(w.ctx, { docType: 'sales_out' })).items[0]
    const d = await w.c.posting.audit(w.ctx, out.id, out.version + 0)
    expect(d.status).toBe('audited')
    expect((await w.stock(sku))!.qty).toBe('15.0000')
  })

  it('采购入库单被后续(已审核)退货引用前可反审核;被引用后拒绝并列出编号', async () => {
    const ret = await w.save(w.doc('purchase_return', { partnerId: supplier, upstreamId: purchaseId, lines: [w.line(sku, '2', '60')] }))
    const err = await w.c.posting.unaudit(w.ctx, purchaseId, (await w.c.documents.get(w.ctx, purchaseId)).version).catch((e) => e as AppError)
    expect((err as AppError).code).toBe('REFERENCED_BY_DOWNSTREAM')
    expect((err as AppError).details?.[0].docNo).toBe(ret.doc.docNo)
    // 作废下游后不再计为引用
    await w.c.documents.void(w.ctx, ret.doc.id, ret.doc.version)
    const ok = await w.c.posting.unaudit(w.ctx, purchaseId, (await w.c.documents.get(w.ctx, purchaseId)).version)
    expect(ok.status).toBe('draft')
  })
})

describe('库存不足与原子性(需求 14.5、13.10)', () => {
  it('负库存关闭:出库超量被拒绝,列出 SKU/仓库/当前库存,单据保持草稿且无任何流水', async () => {
    const sku2 = await w.product('B001')
    await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku2, '3', '10')] }))
    const draft = await w.save(w.doc('sales_out', { partnerId: customer, lines: [w.line(sku2, '2', '20'), w.line(sku2, '2', '20')] })) // 同 SKU 两行合并为 4 > 3
    const ledgerBefore = (await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM stock_ledger'))).n
    const err = (await w.c.posting.audit(w.ctx, draft.doc.id, draft.doc.version).catch((e) => e)) as AppError
    expect(err.code).toBe('INSUFFICIENT_STOCK')
    expect(err.details).toHaveLength(1)
    expect(err.details![0]).toMatchObject({ skuCode: 'B001', currentQty: '3', requiredQty: '4' })
    expect((await w.c.documents.get(w.ctx, draft.doc.id)).status).toBe('draft')
    expect((await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM stock_ledger'))).n).toBe(ledgerBefore)
    expect((await w.stock(sku2))!.qty).toBe('3.0000')
  })
})

describe('状态机(需求 13.1、13.6、13.7、13.8、13.11)', () => {
  it('已审核单据拒绝编辑;审核非草稿、反审核非已审核被拒;作废后为终态', async () => {
    const d = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    const audited = await w.c.posting.audit(w.ctx, d.doc.id, d.doc.version)
    expect(audited.fulfillment).toBe('none')
    expect(await code(w.save({ ...w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '2', '10')] }), id: d.doc.id }, { version: audited.version }))).toBe('INVALID_STATE_TRANSITION')
    expect(await code(w.c.posting.audit(w.ctx, d.doc.id, audited.version))).toBe('INVALID_STATE_TRANSITION')
    const draft = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    expect(await code(w.c.posting.unaudit(w.ctx, draft.doc.id, draft.doc.version))).toBe('INVALID_STATE_TRANSITION')
    const voided = await w.c.documents.void(w.ctx, draft.doc.id, draft.doc.version)
    expect(voided.status).toBe('voided')
    const v = (await w.c.documents.get(w.ctx, draft.doc.id)).version
    expect(await code(w.c.documents.void(w.ctx, draft.doc.id, v))).toBe('INVALID_STATE_TRANSITION')
    expect(await code(w.c.posting.audit(w.ctx, draft.doc.id, v))).toBe('INVALID_STATE_TRANSITION')
    expect(await code(w.c.documents.void(w.ctx, d.doc.id, audited.version))).toBe('INVALID_STATE_TRANSITION') // 只有草稿可作废
  })

  it('作废的编号不会复用', async () => {
    const a = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    await w.c.documents.void(w.ctx, a.doc.id, a.doc.version)
    const b = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    expect(b.doc.docNo).not.toBe(a.doc.docNo)
    expect((await w.c.documents.get(w.ctx, a.doc.id)).docNo).toBe(a.doc.docNo)
  })

  it('过期版本的请求被拒绝为"单据状态已变更"', async () => {
    const d = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    const edited = await w.save({ ...w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '2', '10')] }), id: d.doc.id }, { version: d.doc.version })
    expect(edited.doc.version).toBe(d.doc.version + 1)
    expect(await code(w.save({ ...w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '3', '10')] }), id: d.doc.id }, { version: d.doc.version }))).toBe('DOC_STATUS_CHANGED')
    expect(await code(w.c.posting.audit(w.ctx, d.doc.id, d.doc.version))).toBe('DOC_STATUS_CHANGED')
    expect(await code(w.c.documents.void(w.ctx, d.doc.id, d.doc.version))).toBe('DOC_STATUS_CHANGED')
  })

  it('并发审核同一张单据:只有一个成功,库存只变动一次', async () => {
    const sku3 = await w.product('C001')
    const d = await w.save(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku3, '7', '5')] }))
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => w.c.posting.audit(w.ctx, d.doc.id, d.doc.version)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect(['DOC_STATUS_CHANGED', 'INVALID_STATE_TRANSITION']).toContain((r.reason as AppError).code)
    expect((await w.stock(sku3))!.qty).toBe('7.0000')
    expect((await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM stock_ledger WHERE doc_id=$1', [d.doc.id]))).n).toBe(1)
  })
})

describe('下推与剩余数量(需求 13.9、13.12、15.5–15.9、16.6–16.7)', () => {
  it('采购订单 → 入库单:带入剩余数量;超过未入库数量被拒;入库进度随审核/反审核更新', async () => {
    const s = await w.product('D001')
    const order = await w.saveAudit(w.doc('purchase_order', { partnerId: supplier, lines: [w.line(s, '10', '5')] }))
    const g = await w.c.documents.generateDownstream(w.ctx, order.id, 'purchase_in')
    expect(g.status).toBe('draft')
    expect(g.upstreamId).toBe(order.id)
    expect(g.lines[0]).toMatchObject({ qty: '10.0000', upstreamLineId: order.lines[0].id })

    // 先入库 4
    const part = await w.save({ ...w.doc('purchase_in', { partnerId: supplier, upstreamId: order.id, lines: [w.line(s, '4', '5', { upstreamLineId: order.lines[0].id })] }) })
    const partAudited = await w.c.posting.audit(w.ctx, part.doc.id, part.doc.version)
    expect((await w.c.documents.get(w.ctx, order.id)).fulfillment).toBe('partial')
    const prog = await w.c.documents.progress(w.ctx, order.id)
    expect(prog.items[0]).toMatchObject({ ordered: '10.0000', received: '4.0000', pending: '6.0000' })

    // 再入库 7 > 未入库 6:保存时即被拒
    expect(await code(w.save(w.doc('purchase_in', { partnerId: supplier, upstreamId: order.id, lines: [w.line(s, '7', '5', { upstreamLineId: order.lines[0].id })] })))).toBe('OVER_RETURNABLE')
    // 入库剩余 6 → 完成
    const rest = await w.save(w.doc('purchase_in', { partnerId: supplier, upstreamId: order.id, lines: [w.line(s, '6', '5', { upstreamLineId: order.lines[0].id })] }))
    await w.c.posting.audit(w.ctx, rest.doc.id, rest.doc.version)
    expect((await w.c.documents.get(w.ctx, order.id)).fulfillment).toBe('done')
    // 反审核部分入库 → 回到 partial
    await w.c.posting.unaudit(w.ctx, rest.doc.id, (await w.c.documents.get(w.ctx, rest.doc.id)).version)
    expect((await w.c.documents.get(w.ctx, order.id)).fulfillment).toBe('partial')
    // 反审核全部 → none
    await w.c.posting.unaudit(w.ctx, partAudited.id, partAudited.version)
    expect((await w.c.documents.get(w.ctx, order.id)).fulfillment).toBe('none')
    // 全部入库完成后无剩余数量不可再生成
    const all = await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, upstreamId: order.id, lines: [w.line(s, '10', '5', { upstreamLineId: order.lines[0].id })] }))
    expect(all.status).toBe('audited')
    expect(await code(w.c.documents.generateDownstream(w.ctx, order.id, 'purchase_in'))).toBe('VALIDATION_FAILED')
  })

  it('未审核的上游不能下推', async () => {
    const draft = await w.save(w.doc('sales_order', { partnerId: customer, lines: [w.line(sku, '1', '10')] }))
    expect(await code(w.c.documents.generateDownstream(w.ctx, draft.doc.id, 'sales_out'))).toBe('VALIDATION_FAILED')
  })

  it('销售退货:入库成本取关联出库行的出库单位成本,可退数量上限', async () => {
    const s = await w.product('E001')
    await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(s, '10', '40')] }))
    const out = await w.saveAudit(w.doc('sales_out', { partnerId: customer, lines: [w.line(s, '4', '100')] }))
    // 入库提价,使当前均价不同于出库时的成本
    await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(s, '6', '100')] }))
    const g = await w.c.documents.generateDownstream(w.ctx, out.id, 'sales_return')
    expect(g.lines[0].qty).toBe('4.0000')
    expect(await code(w.save(w.doc('sales_return', { partnerId: customer, upstreamId: out.id, lines: [w.line(s, '5', '100', { upstreamLineId: out.lines[0].id })] })))).toBe('OVER_RETURNABLE')
    const ret = await w.save(w.doc('sales_return', { partnerId: customer, upstreamId: out.id, lines: [w.line(s, '2', '100', { upstreamLineId: out.lines[0].id })] }))
    const audited = await w.c.posting.audit(w.ctx, ret.doc.id, ret.doc.version)
    const row = await w.run((tx) => tx.one('SELECT unit_cost, amount_delta FROM stock_ledger WHERE doc_id=$1', [audited.id]))
    expect(row).toEqual({ unit_cost: '40.000000', amount_delta: '80.00' }) // 出库时成本 40,而非当前均价
  })
})
