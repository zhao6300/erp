import fc from 'fast-check'
import { AppError, Dec, dec } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { SaveInput } from '../src/docs/document.service'
import { World, createTestApp, TestApp } from './support/app'

let app: TestApp
beforeAll(async () => {
  app = await createTestApp(inject('pgAdminUrl'))
})
afterAll(async () => {
  await app.close()
})

/**
 * 后端模型测试:在内存参考模型与真实服务(PostgreSQL)上同时执行命令序列,
 * 每条命令之后比较状态、余额与流水,并检查不变量。
 */

type DocKind = 'purchase_in' | 'purchase_return' | 'sales_out' | 'sales_return' | 'transfer' | 'stocktake' | 'receipt' | 'payment' | 'other_income' | 'other_expense'
interface DocSpec {
  kind: DocKind
  sku: number
  qty: number
  price: number
  partner: number
  fund: number
  amount: number
  paidPct: number
  counted: number
}

const specArb: fc.Arbitrary<DocSpec> = fc.record({
  kind: fc.constantFrom<DocKind>('purchase_in', 'purchase_in', 'sales_out', 'sales_out', 'purchase_return', 'transfer', 'stocktake', 'receipt', 'payment', 'other_income', 'other_expense'),
  sku: fc.nat(1),
  qty: fc.integer({ min: 1, max: 15 }),
  price: fc.integer({ min: 1, max: 60 }),
  partner: fc.nat(1),
  fund: fc.nat(1),
  amount: fc.integer({ min: 1, max: 300 }),
  paidPct: fc.constantFrom(0, 0, 50, 100),
  counted: fc.integer({ min: 0, max: 30 }),
})
type Cmd = { op: 'audit' | 'unaudit' | 'void' | 'edit'; idx: number }
const cmdArb: fc.Arbitrary<Cmd> = fc.record({ op: fc.constantFrom<Cmd['op']>('audit', 'audit', 'audit', 'unaudit', 'unaudit', 'void', 'edit'), idx: fc.nat(5) })

const codeOf = (e: unknown) => (e instanceof AppError ? e.code : `ERR:${(e as Error).message}`)

// Feature: lite-erp, Property 13: 库存流水一致性
// Feature: lite-erp, Property 18: 审核/反审核往返
// Feature: lite-erp, Property 19: 单据状态机合法性
// Feature: lite-erp, Property 22: 资金、应收、应付余额不变量
describe('后端模型测试:随机命令序列下的不变量(Property 13/18/19/22)', () => {
  it('库存/资金/应收应付与流水一致;只有合法的状态迁移成功;被拒绝的操作不改变任何数据', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(specArb, { minLength: 4, maxLength: 6 }), fc.array(cmdArb, { minLength: 4, maxLength: 16 }), fc.boolean(), async (specs, cmds, allowNegative) => {
        const f = await app.newTenant()
        const w = new World(app, f)
        if (allowNegative) await app.c.db.withTenant(f.id, (tx) => app.c.settings.update(tx, f.admin, { qtyScale: 2, priceScale: 4, amountScale: 2, allowNegativeStock: true, requireAudit: true, multiUnit: false, multiSku: false, barcodeEnabled: false }))
        const skus = [await w.product('M1'), await w.product('M2')]
        const parts = [await w.partner('PA', 'both', { openingAr: '100', openingAp: '50' }), await w.partner('PB', 'both')]
        const funds = [f.cashId, await w.fund('M-银行', '500')]
        const cat = (await app.c.db.withTenant(f.id, (tx) => app.c.funds.createCategory(tx, f.admin, 'in', '杂项'))).id
        const catOut = (await app.c.db.withTenant(f.id, (tx) => app.c.funds.createCategory(tx, f.admin, 'out', '杂费'))).id
        const wh2 = await w.warehouse('M2WH')
        // 期初库存与资金
        for (const s of skus) await w.saveAudit(w.doc('purchase_in', { partnerId: parts[1], lines: [w.line(s, '20', '10')] }))
        await w.run((tx) => tx.query('UPDATE fund_account SET balance = balance + 1000, opening_balance = opening_balance + 1000 WHERE id=$1', [f.cashId]))

        const build = (s: DocSpec): Parameters<World['doc']>[1] & { docType: DocKind } => {
          const sku = skus[s.sku]
          const partnerId = parts[s.partner]
          const fundAccountId = funds[s.fund]
          switch (s.kind) {
            case 'purchase_in':
              return w.doc('purchase_in', { partnerId, fundAccountId, paidAmount: String(Math.floor((s.qty * s.price * s.paidPct) / 100)), lines: [w.line(sku, String(s.qty), String(s.price))] }) as never
            case 'purchase_return':
              return w.doc('purchase_return', { partnerId, lines: [w.line(sku, String(s.qty), String(s.price))] }) as never
            case 'sales_out':
              return w.doc('sales_out', { partnerId, fundAccountId, paidAmount: String(Math.floor((s.qty * s.price * s.paidPct) / 100)), lines: [w.line(sku, String(s.qty), String(s.price))] }) as never
            case 'sales_return':
              return w.doc('sales_return', { partnerId, lines: [w.line(sku, String(s.qty), String(s.price))] }) as never
            case 'transfer':
              return w.doc('transfer', { warehouseId: f.warehouseId, toWarehouseId: wh2, lines: [w.line(sku, String(s.qty), '0')] }) as never
            case 'stocktake':
              return w.doc('stocktake', { lines: [w.line(sku, '0', '0', { countedQty: String(s.counted) })] }) as never
            case 'receipt':
            case 'payment':
              return w.doc(s.kind, { partnerId, fundAccountId, amount: String(Math.min(s.amount, 100)), lines: [] }) as never
            case 'other_income':
              return w.doc('other_income', { fundAccountId, fundCategoryId: cat, amount: String(s.amount), lines: [] }) as never
            case 'other_expense':
              return w.doc('other_expense', { fundAccountId, fundCategoryId: catOut, amount: String(s.amount), lines: [] }) as never
          }
        }

        const ids: string[] = []
        for (const s of specs) {
          try {
            ids.push((await w.save(build(s) as never)).doc.id)
          } catch (e) {
            // 收款/付款在没有可核销项时保存即被拒绝(需求 17.5),这是合法行为
            expect(['VALIDATION_FAILED']).toContain(codeOf(e))
          }
        }
        if (ids.length === 0) return

        const snapshot = async () => ({
          stock: await w.run((tx) => tx.rows('SELECT sku_id, warehouse_id, qty::text, amount::text FROM stock_balance ORDER BY sku_id, warehouse_id')),
          partners: await w.run((tx) => tx.rows('SELECT partner_id, ar_balance::text, ap_balance::text FROM partner_balance ORDER BY partner_id')),
          funds: await w.run((tx) => tx.rows('SELECT id, balance::text FROM fund_account ORDER BY id')),
          ledger: (await w.run((tx) => tx.one('SELECT (SELECT count(*) FROM stock_ledger)::int + (SELECT count(*) FROM partner_ledger)::int + (SELECT count(*) FROM fund_ledger)::int AS n'))).n,
        })

        for (const cmd of cmds) {
          const id = ids[cmd.idx % ids.length]
          const before = await w.c.documents.get(w.ctx, id)
          const snapBefore = await snapshot()
          let err: unknown = null
          try {
            if (cmd.op === 'audit') await w.c.posting.audit(w.ctx, id, before.version, { confirmCredit: true })
            else if (cmd.op === 'unaudit') await w.c.posting.unaudit(w.ctx, id, before.version)
            else if (cmd.op === 'void') await w.c.documents.void(w.ctx, id, before.version)
            else {
              // 编辑:用原内容重新保存(草稿可编辑,已审核/已作废必须被拒绝)
              const isFund = ['receipt', 'payment', 'other_income', 'other_expense'].includes(before.docType)
              const edited: SaveInput = {
                ...w.doc(before.docType, {
                  partnerId: before.partnerId,
                  fundAccountId: before.fundAccountId,
                  fundCategoryId: before.fundCategoryId,
                  warehouseId: before.warehouseId,
                  toWarehouseId: before.toWarehouseId,
                  amount: isFund ? before.totalAmount : undefined,
                  lines: isFund ? [] : before.lines.map((l) => w.line(l.skuId, l.qty, l.price, { countedQty: l.countedQty })),
                }),
                id,
              }
              await w.c.documents.save(w.ctx, edited, { version: before.version })
            }
          } catch (e) {
            err = e
          }
          const after = await w.c.documents.get(w.ctx, id)
          const snapAfter = await snapshot()

          /* P19:合法迁移 */
          const allowed: Record<string, string[]> = { draft: ['draft', 'audited', 'voided'], audited: ['audited', 'draft'], voided: ['voided'] }
          expect(allowed[before.status]).toContain(after.status)
          if (cmd.op === 'audit' && !err) expect([before.status, after.status]).toEqual(['draft', 'audited'])
          if (cmd.op === 'unaudit' && !err) expect([before.status, after.status]).toEqual(['audited', 'draft'])
          if (cmd.op === 'void' && !err) expect([before.status, after.status]).toEqual(['draft', 'voided'])
          if (before.status === 'voided') expect(err).not.toBeNull() // 已作废是终态
          if (before.status === 'audited' && (cmd.op === 'edit' || cmd.op === 'void' || cmd.op === 'audit')) expect(err).not.toBeNull()
          if (before.status === 'draft' && cmd.op === 'unaudit') expect(err).not.toBeNull()
          if (err) {
            // 被拒绝的操作不改变 document 内容、状态与任何余额和流水
            expect(after.status).toBe(before.status)
            expect(after.version).toBe(before.version)
            expect(snapAfter).toEqual(snapBefore)
            expect(['VALIDATION_FAILED', 'INVALID_STATE_TRANSITION', 'INSUFFICIENT_STOCK', 'FUND_INSUFFICIENT', 'REFERENCED_BY_DOWNSTREAM', 'CREDIT_CONFIRM_REQUIRED', 'OVER_RETURNABLE', 'DOC_STATUS_CHANGED', 'FUND_ACCOUNT_DISABLED']).toContain(codeOf(err))
          }

          /* P13:库存 = 期初 + Σ流水,balance_after 为写入时刻结存;流水只追加 */
          const stockBad = await w.run((tx) =>
            tx.rows(`SELECT sb.sku_id, sb.warehouse_id FROM stock_balance sb
                     WHERE sb.qty <> sb.opening_qty + COALESCE((SELECT sum(l.qty_delta) FROM stock_ledger l WHERE l.sku_id = sb.sku_id AND l.warehouse_id = sb.warehouse_id), 0)`),
          )
          expect(stockBad).toEqual([])
          const balanceAfterBad = await w.run((tx) =>
            tx.rows(`SELECT 1 FROM (SELECT l.balance_after, (SELECT opening_qty FROM stock_balance b WHERE b.sku_id=l.sku_id AND b.warehouse_id=l.warehouse_id) + sum(l.qty_delta) OVER (PARTITION BY l.sku_id, l.warehouse_id ORDER BY l.seq) AS running FROM stock_ledger l) x WHERE x.balance_after <> x.running`),
          )
          expect(balanceAfterBad).toEqual([])
          if (!allowNegative) expect(await w.run((tx) => tx.rows('SELECT 1 FROM stock_balance WHERE qty < 0'))).toEqual([])
          expect(snapAfter.ledger).toBeGreaterThanOrEqual(snapBefore.ledger) // 只追加

          /* 反审核冲回:每条被冲回流水数量相反、reversal_of 指向原记录 */
          const bad = await w.run((tx) => tx.rows(`SELECT r.id FROM stock_ledger r JOIN stock_ledger o ON o.id = r.reversal_of WHERE r.qty_delta <> -o.qty_delta OR r.amount_delta <> -o.amount_delta OR r.sku_id <> o.sku_id`))
          expect(bad).toEqual([])
          const dupReverse = await w.run((tx) => tx.rows('SELECT reversal_of FROM stock_ledger WHERE reversal_of IS NOT NULL GROUP BY reversal_of HAVING count(*) > 1'))
          expect(dupReverse).toEqual([]) // 同一条流水至多冲回一次

          /* P22:资金余额 = 期初 + Σ资金流水 */
          const fundBad = await w.run((tx) => tx.rows(`SELECT fa.id FROM fund_account fa WHERE fa.balance <> fa.opening_balance + COALESCE((SELECT sum(amount_delta) FROM fund_ledger l WHERE l.fund_account_id = fa.id), 0)`))
          expect(fundBad).toEqual([])
          /* P22:应收/应付 = 期初 + Σ往来流水 */
          const partnerBad = await w.run((tx) =>
            tx.rows(`SELECT p.id FROM partner p JOIN partner_balance b ON b.partner_id = p.id
                     WHERE b.ar_balance <> p.opening_ar + COALESCE((SELECT sum(amount_delta) FROM partner_ledger l WHERE l.partner_id = p.id AND l.direction='AR'), 0)
                        OR b.ap_balance <> p.opening_ap + COALESCE((SELECT sum(amount_delta) FROM partner_ledger l WHERE l.partner_id = p.id AND l.direction='AP'), 0)`),
          )
          expect(partnerBad).toEqual([])
        }

        /* P22 的另一半:余额还应等于按需求公式(17.8–17.10)由已审核单据计算的值,草稿与已作废不计入。
           本单收付款在系统中表现为一张 is_inline 的收款/付款单,它就是公式里的"收款单/付款单",
           因此原出入库单只计总额,收付款由内联单据计入(不能两边都算,否则重复)。 */
        const audited = await w.run((tx) => tx.rows(`SELECT doc_type, partner_id, fund_account_id, total_amount FROM document WHERE status='audited'`))
        for (const [pi, pid] of parts.entries()) {
          let ar: Dec = dec(pi === 0 ? 100 : 0)
          let ap: Dec = dec(pi === 0 ? 50 : 0)
          for (const d of audited.filter((x) => x.partner_id === pid)) {
            const t = dec(d.total_amount)
            if (d.doc_type === 'sales_out') ar = ar.plus(t)
            else if (d.doc_type === 'sales_return' || d.doc_type === 'receipt') ar = ar.minus(t)
            else if (d.doc_type === 'purchase_in') ap = ap.plus(t)
            else if (d.doc_type === 'purchase_return' || d.doc_type === 'payment') ap = ap.minus(t)
          }
          const b = await w.partnerBal(pid)
          expect(dec(b.ar_balance).eq(ar)).toBe(true)
          expect(dec(b.ap_balance).eq(ap)).toBe(true)
        }
        for (const [fi, fid] of funds.entries()) {
          let bal: Dec = dec(fi === 0 ? 1000 : 500)
          for (const d of audited.filter((x) => x.fund_account_id === fid)) {
            const t = dec(d.total_amount)
            if (d.doc_type === 'receipt' || d.doc_type === 'other_income') bal = bal.plus(t)
            else if (d.doc_type === 'payment' || d.doc_type === 'other_expense') bal = bal.minus(t)
          }
          expect(dec(await w.fundBal(fid)).eq(bal)).toBe(true)
        }
        // 草稿与已作废单据不产生任何流水
        const strays = await w.run((tx) => tx.rows(`SELECT d.id FROM document d WHERE d.status <> 'audited' AND d.id NOT IN (SELECT doc_id FROM stock_ledger WHERE reversal_of IS NOT NULL UNION SELECT doc_id FROM partner_ledger WHERE reversal_of IS NOT NULL UNION SELECT source_id FROM fund_ledger WHERE reversal_of IS NOT NULL) AND (EXISTS (SELECT 1 FROM stock_ledger l WHERE l.doc_id=d.id) OR EXISTS (SELECT 1 FROM partner_ledger l WHERE l.doc_id=d.id) OR EXISTS (SELECT 1 FROM fund_ledger l WHERE l.source_id=d.id))`))
        expect(strays).toEqual([])
      }),
      { numRuns: 40 },
    )
  })
})
