import { AppError, mergeRoles } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { World, setupWorld, TestApp } from './support/app'

let app: TestApp
let w: World

beforeAll(async () => {
  const s = await setupWorld(inject('pgAdminUrl'))
  app = s.app
  w = s.w
})
afterAll(async () => {
  await app.close()
})

const errOf = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    return e as AppError
  }
  throw new Error('expected rejection')
}

describe('收款单核销(需求 17.2、17.4、17.5)', () => {
  it('先按指定核销,剩余金额按先进先出(期初最早)分配,审核后更新被核销单据与应收余额', async () => {
    const sku = await w.product('F001')
    const supplier = await w.partner('SF', 'supplier')
    await w.saveAudit(w.doc('purchase_in', { partnerId: supplier, lines: [w.line(sku, '100', '1')] }))
    const cust = await w.partner('CF', 'customer', { openingAr: '50' })
    const o1 = await w.saveAudit(w.doc('sales_out', { partnerId: cust, docDate: '2026-09-01', lines: [w.line(sku, '1', '100')] }))
    const o2 = await w.saveAudit(w.doc('sales_out', { partnerId: cust, docDate: '2026-09-02', lines: [w.line(sku, '1', '200')] }))
    const o3 = await w.saveAudit(w.doc('sales_out', { partnerId: cust, docDate: '2026-09-03', lines: [w.line(sku, '1', '300')] }))
    expect((await w.partnerBal(cust)).ar_balance).toBe('650.00') // 50 + 100 + 200 + 300

    // 收款 400:指定核销 o3 的 250,其余 150 按 FIFO:期初 50 + o1 100
    const r = await w.save(w.doc('receipt', { partnerId: cust, fundAccountId: w.f.cashId, amount: '400', lines: [], allocations: [{ key: o3.id, amount: '250' }] }))
    const settlements = await w.run((tx) => tx.rows('SELECT kind, target_type, target_doc_id, amount, applied FROM settlement WHERE document_id=$1 ORDER BY kind, amount', [r.doc.id]))
    expect(settlements).toEqual([
      { kind: 'fifo', target_type: 'opening', target_doc_id: null, amount: '50.00', applied: false },
      { kind: 'fifo', target_type: 'document', target_doc_id: o1.id, amount: '100.00', applied: false },
      { kind: 'manual', target_type: 'document', target_doc_id: o3.id, amount: '250.00', applied: false },
    ])
    // 保存时核销尚未生效
    expect((await w.c.documents.get(w.ctx, o1.id)).settledAmount).toBe('0.00')

    const cashBefore = await w.fundBal(w.f.cashId)
    const audited = await w.c.posting.audit(w.ctx, r.doc.id, r.doc.version)
    expect(audited.status).toBe('audited')
    expect((await w.partnerBal(cust)).ar_balance).toBe('250.00') // 650 − 400
    expect(Number(await w.fundBal(w.f.cashId)) - Number(cashBefore)).toBe(400)
    expect((await w.c.documents.get(w.ctx, o1.id)).settledAmount).toBe('100.00')
    expect((await w.c.documents.get(w.ctx, o2.id)).settledAmount).toBe('0.00')
    expect((await w.c.documents.get(w.ctx, o3.id)).settledAmount).toBe('250.00')

    // 被核销的出库单现在被收款单引用,不能反审核,并列出收款单编号(需求 13.5)
    const e = await errOf(w.c.posting.unaudit(w.ctx, o3.id, (await w.c.documents.get(w.ctx, o3.id)).version))
    expect(e.code).toBe('REFERENCED_BY_DOWNSTREAM')
    expect(e.details![0].docNo).toBe(audited.docNo)

    // 反审核收款单后恢复,出库单可再反审核
    await w.c.posting.unaudit(w.ctx, audited.id, audited.version)
    expect((await w.partnerBal(cust)).ar_balance).toBe('650.00')
    expect((await w.c.documents.get(w.ctx, o3.id)).settledAmount).toBe('0.00')
  })

  it('核销金额非法:指定金额 ≤ 0、超过该单未核销、总额超过全部未核销,均拒绝并提示可核销金额', async () => {
    const cust = await w.partner('CG', 'customer')
    const sku = await w.product('F002')
    const sup = await w.partner('SG', 'supplier')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '1')] }))
    const o = await w.saveAudit(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '1', '100')] }))
    const base = { partnerId: cust, fundAccountId: w.f.cashId, lines: [] as never[] }
    for (const alloc of [
      { amount: '10', allocations: [{ key: o.id, amount: '0' }] },
      { amount: '10', allocations: [{ key: o.id, amount: '100.01' }] },
      { amount: '100.01', allocations: [] },
    ]) {
      const e = await errOf(w.save(w.doc('receipt', { ...base, ...alloc })))
      expect(e.code).toBe('VALIDATION_FAILED')
      expect(e.details!.some((d) => d.field === 'allocations')).toBe(true)
    }
    const e = await errOf(w.save(w.doc('receipt', { ...base, amount: '100.01' })))
    expect(e.details![0].available).toBe('100.00')
  })

  it('付款单:资金不足拒绝并返回当前余额;足够时扣减账户与应付', async () => {
    const sup = await w.partner('SH', 'supplier')
    const sku = await w.product('F003')
    const bank = await w.fund('招行', '50')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '30')] })) // 应付 300
    const pay = await w.save(w.doc('payment', { partnerId: sup, fundAccountId: bank, amount: '100', lines: [] }))
    const e = await errOf(w.c.posting.audit(w.ctx, pay.doc.id, pay.doc.version))
    expect(e.code).toBe('FUND_INSUFFICIENT')
    expect(e.details![0].balance).toBe('50')
    expect((await w.c.documents.get(w.ctx, pay.doc.id)).status).toBe('draft')
    expect(await w.fundBal(bank)).toBe('50.00')
    // 补充资金后可审核
    const inc = await w.save(w.doc('other_income', { fundAccountId: bank, fundCategoryId: (await w.run((tx) => w.c.funds.createCategory(tx, w.ctx, 'in', '利息'))).id, amount: '60', lines: [] }))
    await w.c.posting.audit(w.ctx, inc.doc.id, inc.doc.version)
    await w.c.posting.audit(w.ctx, pay.doc.id, pay.doc.version)
    expect(await w.fundBal(bank)).toBe('10.00')
    expect((await w.partnerBal(sup)).ap_balance).toBe('200.00')
  })

  it('停用的资金账户:审核被拒绝', async () => {
    const acc = await w.fund('停用账户', '1000')
    const inc = await w.save(w.doc('other_income', { fundAccountId: acc, fundCategoryId: (await w.run((tx) => w.c.funds.createCategory(tx, w.ctx, 'in', '其他'))).id, amount: '5', lines: [] }))
    await w.run((tx) => w.c.funds.setAccountEnabled(tx, w.ctx, acc, false))
    expect((await errOf(w.c.posting.audit(w.ctx, inc.doc.id, inc.doc.version))).code).toBe('FUND_ACCOUNT_DISABLED')
    expect(await w.fundBal(acc)).toBe('1000.00')
  })
})

describe('带本单付款的采购入库(需求 17.6、17.14)', () => {
  it('余额不足时整张采购入库单审核失败,库存与应付均不变化', async () => {
    const sup = await w.partner('SI', 'supplier')
    const sku = await w.product('F004')
    const poor = await w.fund('穷账户', '10')
    const d = await w.save(w.doc('purchase_in', { partnerId: sup, fundAccountId: poor, paidAmount: '100', lines: [w.line(sku, '5', '40')] }))
    const e = await errOf(w.c.posting.audit(w.ctx, d.doc.id, d.doc.version))
    expect(e.code).toBe('FUND_INSUFFICIENT')
    // 审核失败整体回滚:没有创建库存余额行,也没有任何入库流水
    expect(await w.stock(sku)).toBeNull()
    expect((await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM stock_ledger WHERE sku_id=$1', [sku]))).n).toBe(0)
    expect((await w.partnerBal(sup)).ap_balance).toBe('0.00')
    expect(await w.fundBal(poor)).toBe('10.00')
    expect((await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM document WHERE origin_doc_id=$1', [d.doc.id]))).n).toBe(0)
  })
})

describe('信用额度(需求 12.5)', () => {
  it('超出需确认;未确认保持草稿且不产生应收;确认后完成', async () => {
    const sku = await w.product('F005')
    const sup = await w.partner('SJ', 'supplier')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '50', '10')] }))
    const cust = await w.partner('CJ', 'customer', { creditLimit: '300', openingAr: '100' })
    const d = await w.save(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '3', '100')] })) // 100 + 300 − 300 = 100 超出
    const e = await errOf(w.c.posting.audit(w.ctx, d.doc.id, d.doc.version))
    expect(e.code).toBe('CREDIT_CONFIRM_REQUIRED')
    expect(e.details![0].excess).toBe('100')
    expect((await w.c.documents.get(w.ctx, d.doc.id)).status).toBe('draft')
    expect((await w.partnerBal(cust)).ar_balance).toBe('100.00')
    const ok = await w.c.posting.audit(w.ctx, d.doc.id, d.doc.version, { confirmCredit: true })
    expect(ok.status).toBe('audited')
    expect((await w.partnerBal(cust)).ar_balance).toBe('400.00')
  })
})

describe('销售/采购退货的冲抵', () => {
  it('退货减少应收并冲抵原单未核销金额;反审核恢复', async () => {
    const sku = await w.product('F006')
    const sup = await w.partner('SK', 'supplier')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '20', '10')] }))
    const cust = await w.partner('CK', 'customer')
    const out = await w.saveAudit(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '10', '50')] })) // AR 500
    const ret = await w.save(w.doc('sales_return', { partnerId: cust, upstreamId: out.id, lines: [w.line(sku, '4', '50', { upstreamLineId: out.lines[0].id })] }))
    const a = await w.c.posting.audit(w.ctx, ret.doc.id, ret.doc.version)
    expect((await w.partnerBal(cust)).ar_balance).toBe('300.00')
    expect((await w.c.documents.get(w.ctx, out.id)).settledAmount).toBe('200.00')
    await w.c.posting.unaudit(w.ctx, a.id, a.version)
    expect((await w.partnerBal(cust)).ar_balance).toBe('500.00')
    expect((await w.c.documents.get(w.ctx, out.id)).settledAmount).toBe('0.00')
  })
})

describe('资金转账(需求 17.11、17.14)', () => {
  it('转出减少、转入增加、总额不变;写一对流水', async () => {
    const a = await w.fund('转A', '500')
    const b = await w.fund('转B', '100')
    const total = async () => Number(await w.fundBal(a)) + Number(await w.fundBal(b))
    const before = await total()
    const r = await w.run((tx) => w.c.funds.transfer(tx, w.ctx, { fromAccountId: a, toAccountId: b, amount: '200.50', transferDate: '2026-09-30' }))
    expect(await w.fundBal(a)).toBe('299.50')
    expect(await w.fundBal(b)).toBe('300.50')
    expect(await total()).toBe(before)
    const rows = await w.run((tx) => tx.rows('SELECT source, amount_delta FROM fund_ledger WHERE source_id=$1 ORDER BY source', [r.id]))
    expect(rows).toEqual([
      { source: 'transfer_in', amount_delta: '200.50' },
      { source: 'transfer_out', amount_delta: '-200.50' },
    ])
  })

  it('被拒绝的转账(余额不足、同一账户、账户停用)不写任何流水', async () => {
    const a = await w.fund('转C', '10')
    const b = await w.fund('转D', '0')
    const d = await w.fund('转E', '0')
    await w.run((tx) => w.c.funds.setAccountEnabled(tx, w.ctx, d, false))
    const count = async () => (await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM fund_ledger'))).n
    const n0 = await count()
    expect((await errOf(w.run((tx) => w.c.funds.transfer(tx, w.ctx, { fromAccountId: a, toAccountId: b, amount: '10.01', transferDate: '2026-09-30' })))).code).toBe('FUND_INSUFFICIENT')
    expect((await errOf(w.run((tx) => w.c.funds.transfer(tx, w.ctx, { fromAccountId: a, toAccountId: a, amount: '1', transferDate: '2026-09-30' })))).code).toBe('FUND_TRANSFER_SAME_ACCOUNT')
    expect((await errOf(w.run((tx) => w.c.funds.transfer(tx, w.ctx, { fromAccountId: a, toAccountId: d, amount: '1', transferDate: '2026-09-30' })))).code).toBe('FUND_ACCOUNT_DISABLED')
    expect(await count()).toBe(n0)
    expect(await w.fundBal(a)).toBe('10.00')
  })

  it('并发转账不会使余额为负', async () => {
    const a = await w.fund('转F', '100')
    const b = await w.fund('转G', '0')
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => w.run((tx) => w.c.funds.transfer(tx, w.ctx, { fromAccountId: a, toAccountId: b, amount: '30', transferDate: '2026-09-30' }))))
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    expect(await w.fundBal(a)).toBe('10.00')
    expect(await w.fundBal(b)).toBe('90.00')
  })
})

describe('调拨与盘点(需求 14.6–14.8、14.12–14.13)', () => {
  it('调拨:一出一入,调入成本等于调出成本,全仓库总量不变;同仓调拨被拒', async () => {
    const sku = await w.product('G001')
    const sup = await w.partner('SL', 'supplier')
    const w2 = await w.warehouse('W2')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '33')] }))
    const t = await w.saveAudit(w.doc('transfer', { warehouseId: w.f.warehouseId, toWarehouseId: w2, lines: [w.line(sku, '4', '0')] }))
    expect(await w.stock(sku)).toMatchObject({ qty: '6.0000', amount: '198.00' })
    expect(await w.stock(sku, w2)).toMatchObject({ qty: '4.0000', amount: '132.00', avg_cost: '33.000000' })
    const rows = await w.run((tx) => tx.rows('SELECT qty_delta, unit_cost, amount_delta FROM stock_ledger WHERE doc_id=$1 ORDER BY seq', [t.id]))
    expect(rows).toEqual([
      { qty_delta: '-4.0000', unit_cost: '33.000000', amount_delta: '-132.00' },
      { qty_delta: '4.0000', unit_cost: '33.000000', amount_delta: '132.00' },
    ])
    expect((await errOf(w.save(w.doc('transfer', { warehouseId: w2, toWarehouseId: w2, lines: [w.line(sku, '1', '0')] })))).details![0].field).toBe('toWarehouseId')
    // 反审核后两个仓库恢复
    await w.c.posting.unaudit(w.ctx, t.id, t.version)
    expect((await w.stock(sku))!.qty).toBe('10.0000')
    expect((await w.stock(sku, w2))!.qty).toBe('0.0000')
  })

  it('盘点:草稿期间快照不随流水变化;审核按审核时刻差额生成盘盈/盘亏;差额为 0 不写流水', async () => {
    const s1 = await w.product('G002')
    const s2 = await w.product('G003')
    const s3 = await w.product('G004')
    const sup = await w.partner('SM', 'supplier')
    for (const s of [s1, s2, s3]) await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(s, '10', '20')] }))
    const draft = await w.save(w.doc('stocktake', { lines: [w.line(s1, '0', '0', { countedQty: '12' }), w.line(s2, '0', '0', { countedQty: '7' }), w.line(s3, '0', '0', { countedQty: '10' })] }))
    expect(draft.doc.lines.map((l) => l.snapshotQty)).toEqual(['10.0000', '10.0000', '10.0000'])
    // 盘点期间又出库 3 个 s1
    await w.saveAudit(w.doc('sales_out', { partnerId: await w.partner('CM', 'customer'), lines: [w.line(s1, '3', '50')] }))
    const reread = await w.c.documents.get(w.ctx, draft.doc.id)
    expect(reread.lines[0].snapshotQty).toBe('10.0000') // 快照不变
    const edited = await w.save({ ...w.doc('stocktake', { lines: [w.line(s1, '0', '0', { countedQty: '12' }), w.line(s2, '0', '0', { countedQty: '7' }), w.line(s3, '0', '0', { countedQty: '10' })] }), id: draft.doc.id }, { version: reread.version })
    expect(edited.doc.lines[0].snapshotQty).toBe('10.0000') // 重新保存也保留首次快照
    const a = await w.c.posting.audit(w.ctx, draft.doc.id, edited.doc.version)
    // 审核时刻 s1 库存 7,盘点 12 → 盘盈 5;s2 10 → 7 盘亏 3;s3 差额 0
    const led = await w.run((tx) => tx.rows('SELECT sku_id, qty_delta FROM stock_ledger WHERE doc_id=$1 ORDER BY seq', [a.id]))
    expect(led).toEqual([
      { sku_id: s1, qty_delta: '5.0000' },
      { sku_id: s2, qty_delta: '-3.0000' },
    ])
    expect((await w.stock(s1))!.qty).toBe('12.0000')
    expect((await w.stock(s2))!.qty).toBe('7.0000')
    expect((await w.stock(s3))!.qty).toBe('10.0000')
  })

  it('盘点数量为空或负数被拒绝并标出行号', async () => {
    const s = await w.product('G005')
    const e = await errOf(w.save(w.doc('stocktake', { lines: [w.line(s, '0', '0', { countedQty: '3' }), w.line(s, '0', '0', { countedQty: '-1' }), w.line(s, '0', '0', { countedQty: null })] })))
    expect(e.details!.map((d) => `${d.field}@${d.row}`)).toEqual(['countedQty@2', 'countedQty@3'])
  })
})

describe('库存查询与预警(需求 14.9、14.10)', () => {
  it('预警:低于下限/高于上限列出并显示差额;未设置的限值不参与;回到区间(含端点)后消失', async () => {
    const sku = await w.run((tx) => w.c.products.create(tx, w.ctx, { code: 'H001', name: '预警品', baseUnit: '个', stockMin: '10', stockMax: '20' })).then((p) => p.skus[0].id)
    const onlyMin = await w.run((tx) => w.c.products.create(tx, w.ctx, { code: 'H002', name: '仅下限', baseUnit: '个', stockMin: '5' })).then((p) => p.skus[0].id)
    const sup = await w.partner('SN', 'supplier')
    const alerts = async () => (await w.c.inventory.alerts(w.ctx)).filter((a) => [sku, onlyMin].includes(a.skuId))
    // 无库存:0 < 10 与 0 < 5
    expect((await alerts()).map((a) => [a.skuCode, a.kind, a.diff])).toEqual([['H001', 'below', '-10.0000'], ['H002', 'below', '-5.0000']])
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '1'), w.line(onlyMin, '5', '1')] })) // 恰好等于下限:不预警
    expect(await alerts()).toEqual([])
    const w2 = await w.warehouse('W3')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, warehouseId: w2, lines: [w.line(sku, '10', '1')] })) // 两仓合计 20 = 上限:不预警
    expect(await alerts()).toEqual([])
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '1', '1')] })) // 21 > 20
    expect((await alerts()).map((a) => [a.skuCode, a.kind, a.diff, a.totalQty])).toEqual([['H001', 'above', '1.0000', '21.0000']])
  })

  it('截至某日的库存余额由流水还原;流水明细按时间升序、含起止日', async () => {
    const sku = await w.product('H003')
    const sup = await w.partner('SO', 'supplier')
    app.setNow('2026-10-01T04:00:00Z')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '2')] }))
    // 流水时间戳来自数据库 clock_timestamp(),此处以真实当前时间断言区间语义
    const today = new Date().toISOString().slice(0, 10)
    const l = await w.c.inventory.ledger(w.ctx, { skuId: sku, from: today, to: today })
    expect(l.items).toHaveLength(1)
    expect(l.items[0]).toMatchObject({ qtyDelta: '10.0000', balanceAfter: '10.0000' })
    const none = await w.c.inventory.ledger(w.ctx, { skuId: sku, from: '2000-01-01', to: '2000-01-02' })
    expect(none.items).toHaveLength(0)
    const asOf = await w.c.inventory.balances(w.ctx, { skuId: sku, asOf: '2000-01-01' })
    expect(asOf.items[0].qty).toBe('0.0000')
    const now = await w.c.inventory.balances(w.ctx, { skuId: sku, asOf: '2099-01-01' })
    expect(now.items[0]).toMatchObject({ qty: '10.0000', amount: '20.00' })
  })

  it('开单提示:当前仓库库存与客户最近成交价(无则 null)', async () => {
    const sku = await w.product('H004')
    const sup = await w.partner('SP', 'supplier')
    const cust = await w.partner('CP', 'customer')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '2')] }))
    expect(await w.c.inventory.salesHints(w.ctx, { skuId: sku, warehouseId: w.f.warehouseId, partnerId: cust })).toEqual({ onHandQty: '10.0000', lastPrice: null })
    await w.saveAudit(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '1', '8.5')] }))
    await w.saveAudit(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '1', '9')] }))
    expect((await w.c.inventory.salesHints(w.ctx, { skuId: sku, warehouseId: w.f.warehouseId, partnerId: cust })).lastPrice).toBe('9.000000')
  })
})

describe('权限:Data_Scope 与字段脱敏(需求 10)', () => {
  it('仅指定仓库的用户看不到范围外的库存;无成本权限不返回成本字段', async () => {
    const sku = await w.product('I001')
    const sup = await w.partner('SQ', 'supplier')
    const wa = await w.warehouse('WA')
    const wb = await w.warehouse('WB')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, warehouseId: wa, lines: [w.line(sku, '3', '10')] }))
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, warehouseId: wb, lines: [w.line(sku, '4', '10')] }))
    const limited = app.ctx(w.f, w.f.adminUserId, mergeRoles([{ permissions: ['stock:view', 'purchase_in:view', 'purchase_in:create'], dataScope: { type: 'warehouses', ids: [wa] } }], false))
    const bal = await w.c.inventory.balances(limited, { skuId: sku })
    expect(bal.items.map((i) => i.warehouseId)).toEqual([wa])
    expect(bal.items[0]).not.toHaveProperty('amount')
    expect(bal.items[0]).not.toHaveProperty('avgCost')
    const withCost = app.ctx(w.f, w.f.adminUserId, mergeRoles([{ permissions: ['stock:view', 'field:cost'], dataScope: { type: 'all' } }], false))
    expect((await w.c.inventory.balances(withCost, { skuId: sku })).items[0]).toHaveProperty('avgCost')
    // 新建单据所选仓库须在范围内(需求 10.10)
    expect((await errOf(w.c.documents.save(limited, w.doc('purchase_in', { partnerId: sup, warehouseId: wb, lines: [w.line(sku, '1', '1')] })))).code).toBe('NO_DATA_PERMISSION')
    // 范围外单据不可见
    const list = await w.c.documents.list(limited, { docType: 'purchase_in' })
    for (const d of list.items) expect(d.warehouseId).toBe(wa)
    const outside = (await w.c.documents.list(w.ctx, { docType: 'purchase_in', warehouseId: wb })).items[0]
    expect((await errOf(w.c.documents.get(limited, outside.id))).code).toBe('NO_DATA_PERMISSION')
    // 无操作权限
    expect((await errOf(w.c.posting.audit(limited, outside.id, outside.version))).code).toBe('NO_PERMISSION')
  })
})
