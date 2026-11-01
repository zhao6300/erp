import fc from 'fast-check'
import { AppError, D, dec, mergeRoles } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { World, createTestApp, TestApp } from './support/app'

let app: TestApp
beforeAll(async () => {
  app = await createTestApp(inject('pgAdminUrl'))
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

describe('报表示例(需求 18)', () => {
  it('只统计已审核单据;反审核后不再计入;销售汇总 = 出库 − 退货;首页指标', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    const sku = await w.product('R1')
    const sup = await w.partner('SR', 'supplier')
    const cust = await w.partner('CR', 'customer')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '100', '10')] }))
    const out1 = await w.saveAudit(w.doc('sales_out', { partnerId: cust, fundAccountId: f.cashId, paidAmount: '200', lines: [w.line(sku, '10', '50')] }))
    const draft = await w.save(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '99', '50')] })) // 草稿不统计
    const voided = await w.save(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '98', '50')] }))
    await w.c.documents.void(w.ctx, voided.doc.id, voided.doc.version)
    void draft
    const ret = await w.save(w.doc('sales_return', { partnerId: cust, upstreamId: out1.id, lines: [w.line(sku, '2', '50', { upstreamLineId: out1.lines[0].id })] }))
    const retA = await w.c.posting.audit(w.ctx, ret.doc.id, ret.doc.version)

    const s = await w.c.reports.summary(w.ctx, 'sales', { groupBy: 'product' })
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ qty: '8.0000', amount: '400.00', totalCost: '80.00', grossProfit: '320.00' })
    const dash = await w.c.reports.dashboard(w.ctx)
    expect(dash.today).toMatchObject({ salesAmount: '400.00', grossProfit: '320.00', receiptAmount: '200.00', paymentAmount: '0.00' })
    expect(dash.month.salesAmount).toBe('400.00')
    expect(dash.receivableTotal).toBe('200.00') // 500 − 已收 200 − 退货 100

    // 反审核退货后不再计入
    await w.c.posting.unaudit(w.ctx, retA.id, retA.version)
    expect((await w.c.reports.summary(w.ctx, 'sales', { groupBy: 'product' })).items[0]).toMatchObject({ qty: '10.0000', amount: '500.00' })
  })

  it('日期区间:默认当月 1 日至今天;闭区间含边界;起始晚于结束被拒绝', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    const sku = await w.product('R2')
    const sup = await w.partner('SR2', 'supplier')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, docDate: '2026-09-01', lines: [w.line(sku, '5', '2')] }))
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, docDate: '2026-08-31', lines: [w.line(sku, '7', '2')] }))
    const def = await w.c.reports.summary(w.ctx, 'purchase', {})
    expect(def).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
    expect(def.totals.qty).toBe('5.0000')
    expect((await w.c.reports.summary(w.ctx, 'purchase', { from: '2026-08-31', to: '2026-09-01' })).totals.qty).toBe('12.0000')
    const e = await errOf(w.c.reports.summary(w.ctx, 'purchase', { from: '2026-09-10', to: '2026-09-09' }))
    expect(e.code).toBe('INVALID_DATE_RANGE')
  })

  it('无利润权限:商品毛利表返回无操作权限,汇总与首页不含毛利;无成本权限不含成本', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    const sku = await w.product('R3')
    const sup = await w.partner('SR3', 'supplier')
    const cust = await w.partner('CR3', 'customer')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '10', '10')] }))
    await w.saveAudit(w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, '1', '30')] }))
    const mk = (perms: string[]) => app.ctx(f, f.adminUserId, mergeRoles([{ permissions: ['report:view', ...perms], dataScope: { type: 'all' } }], false))
    const noProfit = mk(['field:cost'])
    expect((await errOf(w.c.reports.productProfit(noProfit, {}))).code).toBe('NO_PERMISSION')
    const s = await w.c.reports.summary(noProfit, 'sales', {})
    expect(JSON.stringify(s)).not.toMatch(/grossProfit/)
    expect(s.items[0]).toHaveProperty('totalCost')
    const noCost = await w.c.reports.summary(mk(['field:profit']), 'sales', {})
    expect(JSON.stringify(noCost)).not.toMatch(/totalCost|grossProfit/) // 毛利同时受两项权限约束
    const dash = await w.c.reports.dashboard(noProfit)
    expect(JSON.stringify(dash)).not.toMatch(/grossProfit/)
    const both = await w.c.reports.productProfit(mk(['field:cost', 'field:profit']), {})
    expect(both.items[0]).toMatchObject({ grossProfit: '20.00', grossMargin: '66.67' })
    expect((await w.c.reports.available(noProfit)).map((r) => r.key)).not.toContain('product_profit')
  })

  it('数据权限:仅指定仓库/本人单据的用户只统计范围内数据(需求 18.9)', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    const sku = await w.product('R4')
    const sup = await w.partner('SR4', 'supplier')
    const wb = await w.warehouse('WB')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '3', '1')] }))
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, warehouseId: wb, lines: [w.line(sku, '4', '1')] }))
    const base = ['report:view', 'purchase_in:view', 'stock:view']
    const wh = app.ctx(f, '00000000-0000-7000-8000-0000000000aa', mergeRoles([{ permissions: base, dataScope: { type: 'warehouses', ids: [wb] } }], false))
    expect((await w.c.reports.summary(wh, 'purchase', {})).totals.qty).toBe('4.0000')
    const own = app.ctx(f, f.adminUserId, mergeRoles([{ permissions: base, dataScope: { type: 'own' } }], false))
    expect((await w.c.reports.summary(own, 'purchase', {})).totals.qty).toBe('7.0000') // 两张单据都由管理员创建
    const stranger = app.ctx(f, '00000000-0000-7000-8000-0000000000bb', mergeRoles([{ permissions: base, dataScope: { type: 'own' } }], false))
    expect((await w.c.reports.summary(stranger, 'purchase', {})).totals.qty).toBe('0.0000')
  })

  it('模块关闭时对应报表不可用(需求 4.1):报表数据来源模块均启用才可用', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    await app.c.db.withTenant(f.id, (tx) => app.c.modules.disable(tx, f.admin, 'purchase'))
    const keys = (await w.c.reports.available(w.ctx)).map((r) => r.key)
    expect(keys).not.toContain('purchase_summary')
    expect(keys).toContain('sales_summary')
    expect((await errOf(w.c.reports.summary(w.ctx, 'purchase', {}))).code).toBe('MODULE_DISABLED')
  })
})

/* ───────── Property 24 ───────── */

type Op = { kind: 'purchase_in' | 'sales_out'; sku: number; qty: number; price: number; partner: number; day: number; fate: 'draft' | 'audit' | 'audit_unaudit' | 'void' }
const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom('purchase_in' as const, 'sales_out' as const),
  sku: fc.nat(2),
  qty: fc.integer({ min: 1, max: 20 }),
  price: fc.integer({ min: 1, max: 100 }),
  partner: fc.nat(1),
  day: fc.integer({ min: 1, max: 28 }),
  fate: fc.constantFrom('draft' as const, 'audit' as const, 'audit' as const, 'audit_unaudit' as const, 'void' as const),
})

// Feature: lite-erp, Property 24: 报表口径一致与收发存平衡
describe('Property 24: 报表口径一致与收发存平衡', () => {
  it('销售/采购汇总的各维度总数量与总金额两两相等且只由已审核单据计算;收发存期末 = 期初 + 入 − 出 = 当前库存', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 3, maxLength: 14 }), fc.integer({ min: 1, max: 28 }), fc.integer({ min: 1, max: 28 }), async (ops, d1, d2) => {
        const f = await app.newTenant()
        const w = new World(app, f)
        const skus = [await w.product('P1'), await w.product('P2'), await w.product('P3')]
        const sup = [await w.partner('S1', 'supplier'), await w.partner('S2', 'supplier')]
        const cust = [await w.partner('C1', 'customer'), await w.partner('C2', 'customer')]
        // 先给每个 SKU 充足库存(2026-08 的已审核采购,落在查询区间之前),让销售更容易成功
        for (const s of skus) await w.saveAudit(w.doc('purchase_in', { partnerId: sup[0], docDate: '2026-08-15', lines: [w.line(s, '1000', '1')] }))

        const expected = { sales: { qty: new D(0), amount: new D(0) }, purchase: { qty: new D(0), amount: new D(0) } }
        const from = `2026-09-${String(Math.min(d1, d2)).padStart(2, '0')}`
        const to = `2026-09-${String(Math.max(d1, d2)).padStart(2, '0')}`
        for (const op of ops) {
          const docDate = `2026-09-${String(op.day).padStart(2, '0')}`
          const partnerId = op.kind === 'purchase_in' ? sup[op.partner] : cust[op.partner]
          const saved = await w.save(w.doc(op.kind, { partnerId, docDate, lines: [w.line(skus[op.sku], String(op.qty), String(op.price))] }))
          let status = 'draft'
          let doc = saved.doc
          if (op.fate === 'void') {
            await w.c.documents.void(w.ctx, doc.id, doc.version)
            status = 'voided'
          } else if (op.fate !== 'draft') {
            doc = await w.c.posting.audit(w.ctx, doc.id, doc.version)
            status = 'audited'
            if (op.fate === 'audit_unaudit') {
              await w.c.posting.unaudit(w.ctx, doc.id, doc.version)
              status = 'draft'
            }
          }
          if (status === 'audited' && docDate >= from && docDate <= to) {
            const bucket = op.kind === 'sales_out' ? expected.sales : expected.purchase
            bucket.qty = bucket.qty.plus(op.qty)
            bucket.amount = bucket.amount.plus(doc.totalAmount)
          }
        }

        for (const kind of ['sales', 'purchase'] as const) {
          const dims = kind === 'sales' ? (['product', 'partner', 'salesperson', 'date'] as const) : (['product', 'partner', 'date'] as const)
          const totals = []
          for (const groupBy of dims) totals.push((await w.c.reports.summary(w.ctx, kind, { from, to, groupBy })).totals)
          for (const t of totals) {
            expect(t.qty).toBe(totals[0].qty)
            expect(t.amount).toBe(totals[0].amount)
          }
          expect(dec(totals[0].qty).eq(expected[kind].qty)).toBe(true)
          expect(dec(totals[0].amount).eq(expected[kind].amount)).toBe(true)
        }

        // 收发存按流水发生时间(审核时刻,即数据库真实当前时间)统计,而不是单据日期。
        // 因此"期末 = 当前库存"的前提(结束日不早于当日)要以真实今天为准(需求 18.7)。
        const realToday = new Date().toISOString().slice(0, 10)
        for (const [a, b] of [[from, to], ['2026-09-01', '2026-09-30'], ['2026-01-01', realToday]] as const) {
          const r = await w.c.reports.stockInOut(w.ctx, { from: a, to: b })
          for (const row of r.items) {
            expect(dec(row.closing).eq(dec(row.opening).plus(row.qtyIn).minus(row.qtyOut))).toBe(true)
          }
        }
        const full = await w.c.reports.stockInOut(w.ctx, { from: '2026-01-01', to: realToday })
        for (const row of full.items) {
          const cur = await w.stock(row.skuId, row.warehouseId)
          expect(dec(row.closing).eq(dec(cur!.qty))).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })
})
