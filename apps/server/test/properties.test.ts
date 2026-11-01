import fc from 'fast-check'
import { AppError, MODULE_CODES, NumberingRule, checkOverQty, dec } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { World, createTestApp, nextPhone, TestApp, FAR_FUTURE } from './support/app'

let app: TestApp
beforeAll(async () => {
  app = await createTestApp(inject('pgAdminUrl'))
})
afterAll(async () => {
  await app.close()
})

const code = (e: unknown) => (e instanceof AppError ? e.code : `ERR:${(e as Error).message}`)

// Feature: lite-erp, Property 1: 租户隔离
describe('Property 1: 租户隔离(服务级)', () => {
  it('两个租户使用相同编码与单据编号;A 的列表/详情/筛选/报表/导出只含 A 的数据,请求 B 的 id 与不存在的 id 完全相同,引用 B 的记录被整体拒绝', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ code: fc.stringMatching(/^[A-Z0-9]{1,6}$/), qty: fc.integer({ min: 1, max: 9 }), price: fc.integer({ min: 1, max: 99 }) }), { minLength: 1, maxLength: 4 }).map((l) => l.filter((x, i, a) => a.findIndex((y) => y.code === x.code) === i)),
        fc.array(fc.record({ code: fc.stringMatching(/^[A-Z0-9]{1,6}$/), qty: fc.integer({ min: 1, max: 9 }), price: fc.integer({ min: 1, max: 99 }) }), { minLength: 1, maxLength: 4 }).map((l) => l.filter((x, i, a) => a.findIndex((y) => y.code === x.code) === i)),
        async (aItems, bItems) => {
          const [fa, fb] = [await app.newTenant(), await app.newTenant()]
          const [wa, wb] = [new World(app, fa), new World(app, fb)]
          const seed = async (w: World, items: typeof aItems, tag: string) => {
            const sup = await w.partner('SHARED', 'supplier') // 相同的往来单位编码(允许跨租户重复)
            const docs: string[] = []
            for (const it of items) {
              const sku = await w.product(it.code)
              const d = await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, String(it.qty), String(it.price))] }))
              docs.push(d.id)
            }
            return { sup, docs, tag }
          }
          const a = await seed(wa, aItems, 'A')
          const b = await seed(wb, bItems, 'B')

          // 相同的单据编号可同时存在(各自从 1 开始)
          const noA = (await wa.c.documents.get(wa.ctx, a.docs[0])).docNo
          const noB = (await wb.c.documents.get(wb.ctx, b.docs[0])).docNo
          expect(noA).toBe(noB)

          // 列表、详情、筛选、报表、导出:与 B 的数据无交集,汇总只由 A 计算
          const listA = await wa.c.documents.list(wa.ctx, { docType: 'purchase_in', pageSize: 100 })
          expect(listA.items.map((d) => d.id).sort()).toEqual([...a.docs].sort())
          expect(listA.items.some((d) => b.docs.includes(d.id))).toBe(false)
          const byKeyword = await wa.c.documents.list(wa.ctx, { docType: 'purchase_in', keyword: noB })
          expect(byKeyword.items.every((d) => a.docs.includes(d.id))).toBe(true)
          const expected = aItems.reduce((s, x) => s + x.qty * x.price, 0)
          const rep = await wa.c.reports.summary(wa.ctx, 'purchase', { groupBy: 'product' })
          expect(dec(rep.totals.amount).eq(expected)).toBe(true)
          const products = await wa.run((tx) => wa.c.products.list(tx, { pageSize: 100 }))
          expect(products.items.map((p) => p.code).sort()).toEqual(aItems.map((x) => x.code).sort())
          const exported = await wa.c.io.export(wa.ctx, 'product')
          expect(exported.rows).toBe(aItems.length)

          // 请求 B 的记录 id:与不存在的 id 返回相同的"记录不存在",且 B 的记录不变
          const bDoc = await wb.c.documents.get(wb.ctx, b.docs[0])
          const cross = await wa.c.documents.get(wa.ctx, b.docs[0]).catch((e) => e)
          const missing = await wa.c.documents.get(wa.ctx, '01900000-0000-7000-8000-00000000dead').catch((e) => e)
          expect(code(cross)).toBe('NOT_FOUND')
          expect(cross.toBody()).toEqual(missing.toBody())
          expect(await wa.c.posting.audit(wa.ctx, b.docs[0], bDoc.version).catch((e) => code(e))).toBe('NOT_FOUND')
          expect(await wa.c.posting.unaudit(wa.ctx, b.docs[0], bDoc.version).catch((e) => code(e))).toBe('NOT_FOUND')
          expect(await wa.c.documents.void(wa.ctx, b.docs[0], bDoc.version).catch((e) => code(e))).toBe('NOT_FOUND')
          const after = await wb.c.documents.get(wb.ctx, b.docs[0])
          expect(after).toEqual(bDoc)

          // 引用 B 的商品/往来单位/仓库/资金账户:整个请求被拒绝,不写入任何数据
          const bSku = (await wb.run((tx) => tx.one('SELECT id FROM sku LIMIT 1'))).id
          const before = (await wa.run((tx) => tx.one('SELECT count(*)::int AS n FROM document'))).n
          const bad: [string, object][] = [
            ['skuId', wa.doc('purchase_in', { partnerId: a.sup, lines: [wa.line(bSku, '1', '1')] })],
            ['partnerId', wa.doc('purchase_in', { partnerId: b.sup, lines: [wa.line((await wa.run((tx) => tx.one('SELECT id FROM sku LIMIT 1'))).id, '1', '1')] })],
            ['warehouseId', wa.doc('purchase_in', { partnerId: a.sup, warehouseId: fb.warehouseId, lines: [wa.line((await wa.run((tx) => tx.one('SELECT id FROM sku LIMIT 1'))).id, '1', '1')] })],
            ['fundAccountId', wa.doc('purchase_in', { partnerId: a.sup, fundAccountId: fb.cashId, paidAmount: '1', lines: [wa.line((await wa.run((tx) => tx.one('SELECT id FROM sku LIMIT 1'))).id, '10', '10')] })],
          ]
          for (const [field, input] of bad) {
            const e = (await wa.save(input as never).catch((x) => x)) as AppError
            expect(e.code, field).toBe('RELATION_NOT_FOUND')
            expect(e.details!.some((d) => d.field === field)).toBe(true)
          }
          expect((await wa.run((tx) => tx.one('SELECT count(*)::int AS n FROM document'))).n).toBe(before)

          // 租户标识来自会话:即使请求体里夹带了 tenantId 也被忽略
          const sneaky = await wa.c.documents.save(wa.ctx, { ...(wa.doc('purchase_in', { partnerId: a.sup, lines: [wa.line((await wa.run((tx) => tx.one('SELECT id FROM sku LIMIT 1'))).id, '1', '1')] }) as object), tenantId: fb.id } as never)
          expect((await wa.run((tx) => tx.one('SELECT tenant_id FROM document WHERE id=$1', [sneaky.doc.id]))).tenant_id).toBe(fa.id)
        },
      ),
      { numRuns: 15 },
    )
  })

  it('数据库层兜底:故意不带 WHERE tenant_id 的查询只返回当前租户数据(RLS)', async () => {
    const [fa, fb] = [await app.newTenant(), await app.newTenant()]
    await new World(app, fa).product('RLS1')
    await new World(app, fb).product('RLS2')
    const rows = await app.c.db.withTenant(fa.id, (tx) => tx.rows('SELECT code FROM product'))
    expect(rows.map((r) => r.code)).toEqual(['RLS1'])
  })
})

// Feature: lite-erp, Property 2: 单据编号格式与唯一性
describe('Property 2: 单据编号唯一性(并发取号 + 中途修改规则)', () => {
  it('交替进行并发取号与修改 Numbering_Rule,同一租户同一单据类型的 doc_no 两两不同', async () => {
    const ruleArb: fc.Arbitrary<NumberingRule> = fc.oneof(
      fc.record({ prefix: fc.constantFrom('XS', 'XS-', ''), dateFormat: fc.constantFrom('YMD' as const, 'YM' as const, 'NONE' as const), seqDigits: fc.integer({ min: 3, max: 5 }), reset: fc.constantFrom('daily' as const, 'monthly' as const, 'yearly' as const, 'never' as const) }),
    ).filter((r) => (r.dateFormat === 'NONE' ? r.reset === 'never' : r.dateFormat === 'YM' ? r.reset !== 'daily' : true))
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(fc.record({ kind: fc.constant('create' as const), n: fc.integer({ min: 1, max: 6 }) }), fc.record({ kind: fc.constant('rule' as const), rule: ruleArb })), { minLength: 3, maxLength: 8 }), async (steps) => {
        const f = await app.newTenant()
        const w = new World(app, f)
        const sku = await w.product('NUM1')
        const cust = await w.partner('NUMC', 'customer')
        const make = () => w.save(w.doc('sales_order', { partnerId: cust, lines: [w.line(sku, '1', '1')] }))
        for (const s of steps) {
          if (s.kind === 'rule') await w.run((tx) => app.c.settings.updateRule(tx, f.admin, 'sales_order', s.rule))
          else await Promise.all(Array.from({ length: s.n }, make)) // 并发生成
        }
        const nos = (await w.run((tx) => tx.rows(`SELECT doc_no FROM document WHERE doc_type='sales_order'`))).map((r) => r.doc_no)
        expect(new Set(nos).size).toBe(nos.length)
      }),
      { numRuns: 25 },
    )
  })

  it('中途把流水号位数从 3 改为 4 后新格式与旧编号碰撞时继续递增,直到未占用', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    const sku = await w.product('NUM2')
    const cust = await w.partner('NUMC2', 'customer')
    await w.run((tx) => app.c.settings.updateRule(tx, f.admin, 'sales_order', { prefix: 'X', dateFormat: 'NONE', seqDigits: 3, reset: 'never' }))
    const a = await w.save(w.doc('sales_order', { partnerId: cust, lines: [w.line(sku, '1', '1')] })) // X001
    // 手工占用 X0002(模拟旧规则 4 位下已有的编号)
    await w.run((tx) => tx.query(`INSERT INTO document (id, tenant_id, doc_type, doc_no, doc_date) VALUES ('01900000-0000-7000-8000-0000000000a1', $1, 'sales_order', 'X0002', '2026-09-30')`, [f.id]))
    await w.run((tx) => app.c.settings.updateRule(tx, f.admin, 'sales_order', { prefix: 'X', dateFormat: 'NONE', seqDigits: 4, reset: 'never' }))
    const b = await w.save(w.doc('sales_order', { partnerId: cust, lines: [w.line(sku, '1', '1')] }))
    expect(a.doc.docNo).toBe('X001')
    expect(b.doc.docNo).toBe('X0003') // 序号 2 对应的 X0002 已占用,继续递增
  })
})

// Feature: lite-erp, Property 9: License 用户数与仓库数上限
describe('Property 9: License 用户数与仓库数上限', () => {
  it('创建或重新启用 User/Warehouse 被允许当且仅当当前启用数小于上限(含上限被调低);拒绝时数量不变', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 5 }), async (maxUsers, maxWh, newMaxUsers, newMaxWh) => {
        const f = await app.newTenant({ license: { maxUsers, maxWarehouses: maxWh } })
        const w = new World(app, f)
        // 填满到上限(管理员已占 1 个用户、默认仓库占 1 个仓库)
        for (let i = 1; i < maxUsers; i++) await app.c.users.create(f.admin, { name: `u${i}`, phone: nextPhone() })
        for (let i = 1; i < maxWh; i++) await w.warehouse(`F${i}`)
        const users = () => app.c.db.withTenant(f.id, async (tx) => (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_user WHERE status='enabled'`)).n)
        const whs = () => app.c.db.withTenant(f.id, async (tx) => (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM warehouse WHERE enabled')).n)
        expect([await users(), await whs()]).toEqual([maxUsers, maxWh])

        await app.c.tenants.saveLicense(f.id, { expireDate: FAR_FUTURE, modules: [...MODULE_CODES], maxUsers: newMaxUsers, maxWarehouses: newMaxWh })
        expect([await users(), await whs()]).toEqual([maxUsers, maxWh]) // 调低上限不影响现有启用项

        const uBefore = await users()
        const uRes = await app.c.users.create(f.admin, { name: 'extra', phone: nextPhone() }).then(() => 'ok', (e) => code(e))
        expect(uRes).toBe(uBefore < newMaxUsers ? 'ok' : 'LICENSE_LIMIT_USERS')
        expect(await users()).toBe(uRes === 'ok' ? uBefore + 1 : uBefore)

        const wBefore = await whs()
        const wRes = await w.warehouse(`EXTRA`).then(() => 'ok', (e) => code(e))
        expect(wRes).toBe(wBefore < newMaxWh ? 'ok' : 'LICENSE_LIMIT_WAREHOUSES')
        expect(await whs()).toBe(wRes === 'ok' ? wBefore + 1 : wBefore)

        // 重新启用:停用一个后,当且仅当启用数仍小于上限时才能重新启用
        const target = (await app.c.db.withTenant(f.id, (tx) => tx.rows('SELECT id FROM warehouse ORDER BY code')))[0]
        await app.c.db.withTenant(f.id, (tx) => app.c.warehouses.setEnabled(tx, f.admin, target.id, false))
        const cur = await whs()
        const re = await app.c.db.withTenant(f.id, (tx) => app.c.warehouses.setEnabled(tx, f.admin, target.id, true)).then(() => 'ok', (e) => code(e))
        expect(re).toBe(cur < newMaxWh ? 'ok' : 'LICENSE_LIMIT_WAREHOUSES')
        expect(await whs()).toBe(re === 'ok' ? cur + 1 : cur)
      }),
      { numRuns: 30 },
    )
  })
})

// Feature: lite-erp, Property 20: 可退数量与可入库数量上限
describe('Property 20: 可退数量与可入库数量上限(后端模型)', () => {
  it('随机的下游保存/审核/反审核序列:已审核下游数量之和不超过上游;超量的保存或审核被拒绝且单据不变', async () => {
    type Step = { op: 'save' | 'audit' | 'unaudit'; qty: number; pick: number }
    const stepArb: fc.Arbitrary<Step> = fc.record({ op: fc.constantFrom<Step['op']>('save', 'save', 'audit', 'audit', 'unaudit'), qty: fc.integer({ min: 1, max: 8 }), pick: fc.nat(5) })
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 12 }), fc.array(stepArb, { minLength: 4, maxLength: 14 }), async (orderQty, steps) => {
        const f = await app.newTenant()
        const w = new World(app, f)
        await app.c.db.withTenant(f.id, (tx) => app.c.settings.update(tx, f.admin, { qtyScale: 2, priceScale: 4, amountScale: 2, allowNegativeStock: true, requireAudit: true, multiUnit: false, multiSku: false, barcodeEnabled: false }))
        const sku = await w.product('Q1')
        const sup = await w.partner('QS', 'supplier')
        const order = await w.saveAudit(w.doc('purchase_order', { partnerId: sup, lines: [w.line(sku, String(orderQty), '5')] }))
        const downs: string[] = []
        const auditedQty = async () => dec((await w.run((tx) => tx.one(`SELECT COALESCE(sum(dl.base_qty),0)::text AS q FROM document_line dl JOIN document d ON d.id = dl.document_id WHERE d.upstream_id=$1 AND d.status='audited'`, [order.id]))).q)
        for (const s of steps) {
          if (s.op === 'save') {
            const used = await auditedQty()
            const r = await w.save(w.doc('purchase_in', { partnerId: sup, upstreamId: order.id, lines: [w.line(sku, String(s.qty), '5', { upstreamLineId: order.lines[0].id })] })).then((x) => x, (e) => e as AppError)
            const remaining = dec(orderQty).minus(used)
            if (dec(s.qty).gt(remaining)) {
              expect(code(r)).toBe('OVER_RETURNABLE') // 保存时即被拒绝
              expect(code(r)).not.toBe('ok')
            } else downs.push((r as { doc: { id: string } }).doc.id)
          } else if (downs.length) {
            const id = downs[s.pick % downs.length]
            const cur = await w.c.documents.get(w.ctx, id)
            const before = await auditedQty()
            if (s.op === 'audit') {
              const r = await w.c.posting.audit(w.ctx, id, cur.version).then(() => 'ok', (e) => code(e))
              if (cur.status === 'draft') {
                const need = dec(cur.lines[0].baseQty)
                expect(r).toBe(before.plus(need).gt(orderQty) ? 'OVER_RETURNABLE' : 'ok')
              }
            } else {
              await w.c.posting.unaudit(w.ctx, id, cur.version).catch(() => {})
            }
          }
          const total = await auditedQty()
          expect(total.lte(orderQty)).toBe(true) // 任一时刻已审核下游数量之和不超过上游
          // 与纯函数口径一致
          const lines = await w.run((tx) => tx.rows(`SELECT dl.sku_id, dl.base_qty, dl.upstream_line_id FROM document_line dl JOIN document d ON d.id = dl.document_id WHERE d.upstream_id=$1 AND d.status='audited'`, [order.id]))
          expect(checkOverQty([{ id: order.lines[0].id, skuId: sku, baseQty: String(orderQty) }], [], lines.map((l) => ({ skuId: l.sku_id, baseQty: l.base_qty }))).length === 0).toBe(true)
        }
      }),
      { numRuns: 25 },
    )
  })
})

// Feature: lite-erp, Property 25: 幂等提交
describe('Property 25: 幂等提交(随机并发)', () => {
  it('同一 clientRequestId 的任意次(含并发)"保存"或"保存并审核"只保存一张单据、只过账一次、返回相同编号', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.constantFrom('save', 'saveAndAudit', 'mixed'), fc.integer({ min: 1, max: 9 }), async (times, mode, qty) => {
        const f = await app.newTenant()
        const w = new World(app, f)
        const sku = await w.product('IDEM')
        const sup = await w.partner('IS', 'supplier')
        const cust = await w.partner('IC', 'customer')
        await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '100', '1')] }))
        const input = w.doc('sales_out', { partnerId: cust, lines: [w.line(sku, String(qty), '9')] })
        const rid = `rid-${Math.random().toString(36).slice(2)}`
        const rs = await Promise.all(Array.from({ length: times }, (_, i) => w.c.documents.save(w.ctx, input, { clientRequestId: rid, autoAudit: mode === 'saveAndAudit' || (mode === 'mixed' && i % 2 === 0) })))
        expect(new Set(rs.map((r) => r.doc.docNo)).size).toBe(1)
        expect((await w.run((tx) => tx.one(`SELECT count(*)::int AS n FROM document WHERE doc_type='sales_out'`))).n).toBe(1)
        expect((await w.run((tx) => tx.one('SELECT count(*)::int AS n FROM idempotency_key WHERE key=$1', [rid]))).n).toBe(1)
        const audited = rs.some((r) => r.doc.status === 'audited')
        const posted = (await w.run((tx) => tx.one(`SELECT count(*)::int AS n FROM stock_ledger WHERE doc_type='sales_out'`))).n
        expect(posted).toBeLessThanOrEqual(1) // 至多一次审核变动
        if (mode === 'saveAndAudit') expect(posted).toBe(1)
        void audited
      }),
      { numRuns: 20 },
    )
  })
})
