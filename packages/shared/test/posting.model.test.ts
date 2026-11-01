import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CostBalance,
  Dec,
  DocType,
  DocumentSnapshot,
  FundState,
  PostedEntries,
  PostingPlan,
  PostingRejection,
  Scales,
  balanceOf,
  dec,
  emptyBalance,
  isRejection,
  planPosting,
  planReversal,
  planTransfer,
  roundHalfUp,
  stockKey,
  sum,
  D,
  netLineAmounts,
  calcDocTotal,
} from '../src'
import { toFixedScaled } from './arbitraries'

/* ═══════════════ 内存参考模型 ═══════════════ */

const SCALES: Scales = { qtyScale: 2, priceScale: 4, amountScale: 2 }
const SKUS = ['S0', 'S1', 'S2']
const WHS = ['W0', 'W1']
const FUNDS = ['F0', 'F1']
const PARTNERS = ['P0', 'P1']

interface LedgerRow {
  id: string
  docId: string
  key: string
  qtyDelta: Dec
  unitCost: Dec
  amountDelta: Dec
  balanceAfter: Dec
  reversalOf?: string
  lineId?: string
}
interface FundRow { id: string; docId: string; account: string; amountDelta: Dec; reversalOf?: string; source: any; role: 'self' | 'inline' }
interface PartnerRow { id: string; docId: string; partnerId: string; direction: 'AR' | 'AP'; amountDelta: Dec; reversalOf?: string; role: 'self' | 'inline' }

interface InitState {
  opening: Record<string, { qty: string; avg: string }>
  funds: Record<string, string>
  openingAr: Record<string, string>
  openingAp: Record<string, string>
}

class Sim {
  stock = new Map<string, CostBalance>()
  openingQty = new Map<string, Dec>()
  ledger: LedgerRow[] = []
  fundRows: FundRow[] = []
  partnerRows: PartnerRow[] = []
  fundOpening = new Map<string, Dec>()
  fundBalance = new Map<string, Dec>()
  ar = new Map<string, Dec>()
  ap = new Map<string, Dec>()
  openingAr = new Map<string, Dec>()
  openingAp = new Map<string, Dec>()
  status = new Map<string, 'draft' | 'audited'>()
  posted = new Map<string, PostedEntries>()
  seq = 0
  constructor(
    public docs: DocumentSnapshot[],
    init: InitState,
    public allowNegative: boolean,
  ) {
    for (const [k, v] of Object.entries(init.opening)) {
      const qty = dec(v.qty)
      this.openingQty.set(k, qty)
      // 期初金额按均价计,保持 amount = qty × avg
      this.stock.set(k, balanceOf(qty, roundHalfUp(qty.times(v.avg), 2), v.avg))
    }
    for (const [k, v] of Object.entries(init.funds)) {
      this.fundOpening.set(k, dec(v))
      this.fundBalance.set(k, dec(v))
    }
    for (const p of PARTNERS) {
      this.openingAr.set(p, dec(init.openingAr[p]))
      this.openingAp.set(p, dec(init.openingAp[p]))
      this.ar.set(p, dec(init.openingAr[p]))
      this.ap.set(p, dec(init.openingAp[p]))
    }
    docs.forEach((d) => this.status.set(d.id, 'draft'))
  }

  fundStates(): Map<string, FundState> {
    return new Map([...this.fundBalance].map(([k, v]) => [k, { balance: v, enabled: true }]))
  }

  audit(doc: DocumentSnapshot): { ok: boolean; rejection?: PostingRejection } {
    if (this.status.get(doc.id) !== 'draft') return { ok: false }
    const plan = planPosting(doc, { scales: SCALES, allowNegativeStock: this.allowNegative, stock: this.stock, funds: this.fundStates() })
    if (isRejection(plan)) return { ok: false, rejection: plan }
    this.apply(doc.id, plan)
    this.status.set(doc.id, 'audited')
    return { ok: true }
  }

  unaudit(doc: DocumentSnapshot): { ok: boolean; rejection?: PostingRejection } {
    if (this.status.get(doc.id) !== 'audited') return { ok: false }
    const posted = this.posted.get(doc.id)!
    const plan = planReversal(posted, { scales: SCALES, allowNegativeStock: this.allowNegative, stock: this.stock })
    if (isRejection(plan)) return { ok: false, rejection: plan }
    this.apply(doc.id, plan)
    this.posted.delete(doc.id)
    this.status.set(doc.id, 'draft')
    return { ok: true }
  }

  private apply(docId: string, plan: PostingPlan) {
    const posted: PostedEntries = { stock: [], partner: [], fund: [] }
    for (const e of plan.stockEntries) {
      const key = stockKey(e.skuId, e.warehouseId)
      const row: LedgerRow = { id: `L${++this.seq}`, docId, key, qtyDelta: e.qtyDelta, unitCost: e.unitCost, amountDelta: e.amountDelta, balanceAfter: e.balanceAfter, reversalOf: e.reversalOf, lineId: e.lineId }
      this.ledger.push(row)
      posted.stock.push({ id: row.id, lineId: e.lineId, skuId: e.skuId, warehouseId: e.warehouseId, qtyDelta: e.qtyDelta, unitCost: e.unitCost, amountDelta: e.amountDelta })
    }
    for (const [k, b] of plan.stockBalances) this.stock.set(k, b)
    for (const e of plan.partnerEntries) {
      const row: PartnerRow = { id: `PL${++this.seq}`, docId, partnerId: e.partnerId, direction: e.direction, amountDelta: e.amountDelta, reversalOf: e.reversalOf, role: e.role }
      this.partnerRows.push(row)
      posted.partner.push({ id: row.id, partnerId: e.partnerId, direction: e.direction, amountDelta: e.amountDelta, role: e.role })
      const m = e.direction === 'AR' ? this.ar : this.ap
      m.set(e.partnerId, m.get(e.partnerId)!.plus(e.amountDelta))
    }
    for (const e of plan.fundEntries) {
      const row: FundRow = { id: `FL${++this.seq}`, docId, account: e.fundAccountId, amountDelta: e.amountDelta, reversalOf: e.reversalOf, source: e.source, role: e.role }
      this.fundRows.push(row)
      posted.fund.push({ id: row.id, fundAccountId: e.fundAccountId, source: e.source, amountDelta: e.amountDelta, role: e.role })
      this.fundBalance.set(e.fundAccountId, this.fundBalance.get(e.fundAccountId)!.plus(e.amountDelta))
    }
    // 审核时登记已过账明细;反审核后清除(由调用方 delete)
    if (!plan.stockEntries.some((s) => s.reversalOf) && !plan.partnerEntries.some((s) => s.reversalOf) && !plan.fundEntries.some((s) => s.reversalOf)) this.posted.set(docId, posted)
    else if (!this.posted.has(docId)) this.posted.set(docId, posted)
  }

  qty(key: string): Dec {
    return this.stock.get(key)?.qty ?? new D(0)
  }
  snapshot() {
    return {
      qty: new Map([...this.stock].map(([k, v]) => [k, v.qty.toString()])),
      ar: new Map([...this.ar].map(([k, v]) => [k, v.toString()])),
      ap: new Map([...this.ap].map(([k, v]) => [k, v.toString()])),
      funds: new Map([...this.fundBalance].map(([k, v]) => [k, v.toString()])),
    }
  }
}

/* ═══════════════ 生成器 ═══════════════ */

const money = (maxInt: number) => fc.integer({ min: 1, max: maxInt * 100 }).map((n) => toFixedScaled(n, 2))
const qtyArb = fc.integer({ min: 1, max: 50 }).map((n) => String(n))

function makeDoc(id: string, docType: DocType, p: { partner: string; wh: string; to: string; fund: string; lines: { sku: string; qty: string; price: string }[]; discountPct: number; paidPct: number; amount: string; counted: string[] }): DocumentSnapshot {
  const lines = p.lines.map((l, i) => ({
    id: `${id}-L${i}`,
    skuId: l.sku,
    warehouseId: p.wh,
    baseQty: l.qty,
    amount: roundHalfUp(dec(l.qty).times(l.price), 2).toString(),
    countedQty: docType === 'stocktake' ? p.counted[i] : null,
  }))
  const linesTotal = sum(lines.map((l) => l.amount))
  const discount = roundHalfUp(linesTotal.times(p.discountPct).div(100), 2)
  const total = calcDocTotal(lines.map((l) => l.amount), discount)
  const fundDocs: DocType[] = ['receipt', 'payment', 'other_income', 'other_expense']
  const isFund = fundDocs.includes(docType)
  const paid = docType === 'purchase_in' || docType === 'sales_out' ? roundHalfUp(total.times(p.paidPct).div(100), 2) : new D(0)
  const totalAmount = isFund ? dec(p.amount) : total
  return {
    id,
    docType,
    docNo: id,
    docDate: '2026-09-30',
    partnerId: ['purchase_in', 'purchase_return', 'sales_out', 'sales_return', 'receipt', 'payment'].includes(docType) ? p.partner : null,
    warehouseId: p.wh,
    toWarehouseId: docType === 'transfer' ? p.to : null,
    fundAccountId: p.fund,
    docDiscount: isFund ? '0' : discount.toString(),
    paidAmount: paid.toString(),
    totalAmount: totalAmount.toString(),
    lines: isFund ? [] : lines,
    allocations: docType === 'receipt' || docType === 'payment' ? [{ targetType: 'opening', amount: p.amount }] : undefined,
  }
}

const DOC_TYPES_POOL: DocType[] = ['purchase_in', 'purchase_return', 'sales_out', 'sales_return', 'transfer', 'stocktake', 'receipt', 'payment', 'other_income', 'other_expense']

const docArb = (id: string, types: DocType[] = DOC_TYPES_POOL, uniqueSkus = false): fc.Arbitrary<DocumentSnapshot> =>
  fc
    .record({
      docType: fc.constantFrom(...types),
      partner: fc.constantFrom(...PARTNERS),
      wh: fc.constantFrom(...WHS),
      fund: fc.constantFrom(...FUNDS),
      lines: fc.array(fc.record({ sku: fc.constantFrom(...SKUS), qty: qtyArb, price: money(50) }), { minLength: 1, maxLength: 3 }),
      discountPct: fc.integer({ min: 0, max: 30 }),
      paidPct: fc.integer({ min: 0, max: 100 }),
      amount: money(5000),
      counted: fc.array(fc.integer({ min: 0, max: 80 }).map(String), { minLength: 3, maxLength: 3 }),
    })
    .map((p) => {
      const lines = uniqueSkus || p.docType === 'stocktake' ? p.lines.filter((l, i, arr) => arr.findIndex((x) => x.sku === l.sku) === i) : p.lines
      return makeDoc(id, p.docType, { ...p, lines, to: p.wh === 'W0' ? 'W1' : 'W0' })
    })

const initArb: fc.Arbitrary<InitState> = fc.record({
  opening: fc
    .tuple(...SKUS.flatMap((s) => WHS.map((w) => fc.record({ qty: fc.integer({ min: 0, max: 60 }).map(String), avg: fc.integer({ min: 0, max: 50 * 10000 }).map((n) => toFixedScaled(n, 4)) }).map((v) => [stockKey(s, w), v] as const))))
    .map((pairs) => Object.fromEntries(pairs)),
  funds: fc.record({ F0: fc.integer({ min: 0, max: 200000 }).map((n) => toFixedScaled(n, 2)), F1: fc.integer({ min: 0, max: 200000 }).map((n) => toFixedScaled(n, 2)) }),
  openingAr: fc.record({ P0: money(5000), P1: money(5000) }),
  openingAp: fc.record({ P0: money(5000), P1: money(5000) }),
})

const opsArb = fc.array(fc.record({ kind: fc.constantFrom<'audit' | 'unaudit'>('audit', 'audit', 'unaudit'), idx: fc.nat(7) }), { minLength: 1, maxLength: 40 })

/* ═══════════════ 不变量检查 ═══════════════ */

function checkInvariants(sim: Sim, allowNegative: boolean, prevLedger: LedgerRow[]) {
  // P13 库存流水一致性:余额 = 期初 + Σ流水;balance_after 为写入时刻结存
  const running = new Map<string, Dec>()
  for (const k of new Set([...sim.openingQty.keys(), ...sim.ledger.map((r) => r.key), ...sim.stock.keys()])) running.set(k, sim.openingQty.get(k) ?? new D(0))
  for (const row of sim.ledger) {
    running.set(row.key, running.get(row.key)!.plus(row.qtyDelta))
    expect(row.balanceAfter.eq(running.get(row.key)!)).toBe(true)
  }
  for (const [k, q] of running) expect(sim.qty(k).eq(q)).toBe(true)
  // 已有流水不变(只追加)
  prevLedger.forEach((r, i) => {
    expect(sim.ledger[i]).toBe(r)
  })
  // 冲回记录指向原记录,数量相反
  const byId = new Map(sim.ledger.map((r) => [r.id, r]))
  for (const r of sim.ledger.filter((x) => x.reversalOf)) {
    const o = byId.get(r.reversalOf!)!
    expect(o).toBeDefined()
    expect(r.qtyDelta.eq(o.qtyDelta.negated())).toBe(true)
    expect(r.amountDelta.eq(o.amountDelta.negated())).toBe(true)
    expect(r.key).toBe(o.key)
  }
  // P15 负库存
  if (!allowNegative) for (const [, q] of running) expect(q.gte(0)).toBe(true)

  // P22 资金余额 = 期初 + Σ资金流水 = 期初 + 已审核单据收支
  for (const f of FUNDS) {
    const viaLedger = sim.fundOpening.get(f)!.plus(sum(sim.fundRows.filter((r) => r.account === f).map((r) => r.amountDelta)))
    expect(sim.fundBalance.get(f)!.eq(viaLedger)).toBe(true)
    const viaDocs = sim.docs
      .filter((d) => sim.status.get(d.id) === 'audited' && d.fundAccountId === f)
      .reduce((acc, d) => {
        const t = dec(d.totalAmount)
        const paid = dec(d.paidAmount)
        switch (d.docType) {
          case 'receipt':
          case 'other_income':
            return acc.plus(t)
          case 'payment':
          case 'other_expense':
            return acc.minus(t)
          case 'sales_out':
            return acc.plus(paid)
          case 'purchase_in':
            return acc.minus(paid)
          default:
            return acc
        }
      }, sim.fundOpening.get(f)!)
    expect(sim.fundBalance.get(f)!.eq(viaDocs)).toBe(true)
    // 注意:需求 17.14 只在“审核付款/其他支出/带本单付款的入库/转账”时校验余额不足,
    // 反审核其他收入或收款单可能使余额为负,规格未要求拒绝,因此这里不断言 balance ≥ 0。
  }
  // P22 应收应付
  for (const p of PARTNERS) {
    let ar = sim.openingAr.get(p)!
    let ap = sim.openingAp.get(p)!
    for (const d of sim.docs.filter((x) => sim.status.get(x.id) === 'audited' && x.partnerId === p)) {
      const t = dec(d.totalAmount)
      const paid = dec(d.paidAmount)
      if (d.docType === 'sales_out') ar = ar.plus(t).minus(paid)
      if (d.docType === 'sales_return') ar = ar.minus(t)
      if (d.docType === 'receipt') ar = ar.minus(t)
      if (d.docType === 'purchase_in') ap = ap.plus(t).minus(paid)
      if (d.docType === 'purchase_return') ap = ap.minus(t)
      if (d.docType === 'payment') ap = ap.minus(t)
    }
    expect(sim.ar.get(p)!.eq(ar)).toBe(true)
    expect(sim.ap.get(p)!.eq(ap)).toBe(true)
  }
}

/** 单据需求量:出库类按 (sku, 仓库) 合并 */
function outDemand(d: DocumentSnapshot): Map<string, Dec> {
  const m = new Map<string, Dec>()
  const add = (k: string, q: Dec) => m.set(k, (m.get(k) ?? new D(0)).plus(q))
  if (d.docType === 'purchase_return' || d.docType === 'sales_out') for (const l of d.lines) add(stockKey(l.skuId, l.warehouseId), dec(l.baseQty))
  if (d.docType === 'transfer') for (const l of d.lines) add(stockKey(l.skuId, l.warehouseId), dec(l.baseQty))
  return m
}

/* ═══════════════ 属性 ═══════════════ */

const docsArb = fc.tuple(...Array.from({ length: 8 }, (_, i) => docArb(`D${i}`)))

// Feature: lite-erp, Property 13: 库存流水一致性
// Feature: lite-erp, Property 22: 资金、应收、应付余额不变量
describe('Property 13 / 22: 随机审核与反审核序列下的流水、余额不变量', () => {
  for (const allowNegative of [false, true]) {
    it(`负库存${allowNegative ? '允许' : '关闭'}`, () => {
      fc.assert(
        fc.property(initArb, docsArb, opsArb, (init, docs, ops) => {
          const sim = new Sim(docs, init, allowNegative)
          checkInvariants(sim, allowNegative, [])
          for (const op of ops) {
            const prev = [...sim.ledger]
            const doc = docs[op.idx]
            if (op.kind === 'audit') sim.audit(doc)
            else sim.unaudit(doc)
            checkInvariants(sim, allowNegative, prev)
          }
        }),
        { numRuns: 150 },
      )
    })
  }
})

// Feature: lite-erp, Property 15: 负库存拒绝
describe('Property 15: 负库存拒绝', () => {
  it('拒绝的单据保持草稿、无新流水;列出的组合恰好是合并数量后库存不足的组合', () => {
    fc.assert(
      fc.property(initArb, fc.tuple(...Array.from({ length: 4 }, (_, i) => docArb(`D${i}`, ['sales_out', 'purchase_return', 'transfer', 'purchase_in', 'sales_return']))), fc.array(fc.nat(3), { minLength: 1, maxLength: 12 }), (init, docs, order) => {
        const sim = new Sim(docs, init, false)
        for (const idx of order) {
          const doc = docs[idx]
          if (sim.status.get(doc.id) !== 'draft') continue
          const before = sim.ledger.length
          const demand = outDemand(doc)
          const expectedShort = new Set([...demand].filter(([k, q]) => q.gt(sim.qty(k))).map(([k]) => k))
          const r = sim.audit(doc)
          if (r.rejection?.code === 'INSUFFICIENT_STOCK') {
            expect(sim.status.get(doc.id)).toBe('draft')
            expect(sim.ledger.length).toBe(before)
            const listed = new Set(r.rejection.details.map((d) => stockKey(d.skuId as string, d.warehouseId as string)))
            expect(listed).toEqual(expectedShort)
            for (const d of r.rejection.details) {
              expect(dec(d.currentQty as string).eq(sim.qty(stockKey(d.skuId as string, d.warehouseId as string)))).toBe(true)
              expect(dec(d.requiredQty as string).gt(dec(d.currentQty as string))).toBe(true)
            }
          } else if (r.ok) {
            expect(expectedShort.size).toBe(0)
          }
          for (const q of sim.stock.values()) expect(q.qty.gte(0)).toBe(true)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// Feature: lite-erp, Property 16: 调拨守恒
describe('Property 16: 调拨守恒', () => {
  it('每行一出一入、数量相反、单位成本相等、调入金额等于调出金额、全仓库总量不变', () => {
    fc.assert(
      fc.property(initArb, docArb('T', ['transfer']), (init, doc) => {
        const sim = new Sim([doc], init, true)
        const totalBefore = (sku: string) => sum(WHS.map((w) => sim.qty(stockKey(sku, w))))
        const before = new Map(SKUS.map((s) => [s, totalBefore(s)]))
        const r = sim.audit(doc)
        expect(r.ok).toBe(true)
        for (const l of doc.lines) {
          const rows = sim.ledger.filter((x) => x.lineId === l.id)
          expect(rows).toHaveLength(2)
          const out = rows.find((x) => x.qtyDelta.isNegative())!
          const inn = rows.find((x) => x.qtyDelta.isPositive())!
          expect(out.qtyDelta.eq(inn.qtyDelta.negated())).toBe(true)
          expect(out.unitCost.eq(inn.unitCost)).toBe(true)
          expect(inn.amountDelta.eq(out.amountDelta.abs())).toBe(true)
          expect(out.key).toBe(stockKey(l.skuId, doc.warehouseId!))
          expect(inn.key).toBe(stockKey(l.skuId, doc.toWarehouseId!))
        }
        for (const s of SKUS) expect(totalBefore(s).eq(before.get(s)!)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })
})

// Feature: lite-erp, Property 17: 盘点差额
describe('Property 17: 盘点差额', () => {
  it('变动数量 = 盘点数量 − 审核时刻库存;差额为 0 不写流水;审核后库存 = 盘点数量', () => {
    fc.assert(
      fc.property(initArb, docArb('C', ['stocktake']), (init, doc) => {
        const sim = new Sim([doc], init, false)
        const beforeQty = new Map(doc.lines.map((l) => [l.id, sim.qty(stockKey(l.skuId, l.warehouseId))]))
        expect(sim.audit(doc).ok).toBe(true)
        for (const l of doc.lines) {
          const key = stockKey(l.skuId, l.warehouseId)
          const diff = dec(l.countedQty!).minus(beforeQty.get(l.id)!)
          const rows = sim.ledger.filter((x) => x.lineId === l.id)
          if (diff.isZero()) expect(rows).toHaveLength(0)
          else {
            expect(rows).toHaveLength(1)
            expect(rows[0].qtyDelta.eq(diff)).toBe(true)
          }
          expect(sim.qty(key).eq(dec(l.countedQty!))).toBe(true)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// Feature: lite-erp, Property 18: 审核/反审核往返
describe('Property 18: 审核/反审核往返', () => {
  it('审核后立即反审核:库存、应收应付、资金余额回到审核前;冲回与原变动大小相等方向相反', () => {
    fc.assert(
      fc.property(initArb, docArb('R'), (init, doc) => {
        const sim = new Sim([doc], init, false)
        const before = sim.snapshot()
        const a = sim.audit(doc)
        if (!a.ok) {
          expect(sim.snapshot()).toEqual(before) // 拒绝时不留痕
          expect(sim.status.get(doc.id)).toBe('draft')
          return
        }
        const posted = sim.posted.get(doc.id)!
        const u = sim.unaudit(doc)
        expect(u.ok).toBe(true)
        expect(sim.snapshot()).toEqual(before)
        expect(sim.status.get(doc.id)).toBe('draft')
        // 逐项冲回
        for (const e of posted.stock) {
          const rev = sim.ledger.find((r) => r.reversalOf === e.id)!
          expect(rev.qtyDelta.eq(dec(e.qtyDelta).negated())).toBe(true)
          expect(rev.amountDelta.eq(dec(e.amountDelta).negated())).toBe(true)
        }
        for (const e of posted.partner) expect(sim.partnerRows.find((r) => r.reversalOf === e.id)!.amountDelta.eq(dec(e.amountDelta).negated())).toBe(true)
        for (const e of posted.fund) expect(sim.fundRows.find((r) => r.reversalOf === e.id)!.amountDelta.eq(dec(e.amountDelta).negated())).toBe(true)
        // 可再次审核,结果与第一次相同
        const again = sim.audit(doc)
        expect(again.ok).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('本单收付款:审核生成内联收付款,反审核一并冲回', () => {
    const init: InitState = { opening: {}, funds: { F0: '1000.00', F1: '0.00' }, openingAr: { P0: '0.00', P1: '0.00' }, openingAp: { P0: '0.00', P1: '0.00' } }
    const doc = makeDoc('X', 'sales_out', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '2', price: '50.00' }], discountPct: 0, paidPct: 50, amount: '1.00', counted: [] })
    const sim = new Sim([doc], init, true)
    expect(sim.audit(doc).ok).toBe(true)
    expect(sim.ar.get('P0')!.toString()).toBe('50') // 100 − 已收 50
    expect(sim.fundBalance.get('F0')!.toString()).toBe('1050')
    expect(sim.unaudit(doc).ok).toBe(true)
    expect(sim.ar.get('P0')!.toString()).toBe('0')
    expect(sim.fundBalance.get('F0')!.toString()).toBe('1000')
  })
})

// Feature: lite-erp, Property 23: 资金转账守恒
describe('Property 23: 资金转账守恒', () => {
  const fundsArb = fc.record({ F0: fc.integer({ min: 0, max: 100000 }), F1: fc.integer({ min: 0, max: 100000 }), F2: fc.integer({ min: 0, max: 100000 }) })
  it('转出减少、转入增加、总额不变、恰好一对流水;被拒绝的转账不写流水', () => {
    fc.assert(
      fc.property(fundsArb, fc.constantFrom('F0', 'F1', 'F2'), fc.constantFrom('F0', 'F1', 'F2'), fc.integer({ min: 0, max: 150000 }), fc.record({ F0: fc.boolean(), F1: fc.boolean(), F2: fc.boolean() }), (bal, from, to, amt, enabled) => {
        const funds = new Map<string, FundState>(Object.entries(bal).map(([k, v]) => [k, { balance: toFixedScaled(v, 2), enabled: (enabled as any)[k] }]))
        const amount = toFixedScaled(amt, 2)
        const r = planTransfer({ fromAccountId: from, toAccountId: to, amount }, funds)
        const rejectedExpected = from === to || amt <= 0 || !(enabled as any)[from] || !(enabled as any)[to] || bal[from as 'F0'] < amt
        if (isRejection(r as any)) {
          expect(rejectedExpected).toBe(true)
          return
        }
        expect(rejectedExpected).toBe(false)
        const entries = (r as { fundEntries: PostingPlan['fundEntries'] }).fundEntries
        expect(entries).toHaveLength(2)
        expect(entries.filter((e) => e.source === 'transfer_out')).toHaveLength(1)
        expect(entries.filter((e) => e.source === 'transfer_in')).toHaveLength(1)
        expect(sum(entries.map((e) => e.amountDelta)).isZero()).toBe(true)
        expect(entries.find((e) => e.source === 'transfer_out')!.amountDelta.eq(dec(amount).negated())).toBe(true)
        expect(entries.find((e) => e.source === 'transfer_in')!.amountDelta.eq(dec(amount))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe('过账规划:边界与示例', () => {
  const ctx = (stock: Record<string, CostBalance> = {}, funds: Record<string, FundState> = { F0: { balance: '1000', enabled: true } }) => ({
    scales: SCALES,
    allowNegativeStock: false,
    stock: new Map(Object.entries(stock)),
    funds: new Map(Object.entries(funds)),
  })

  it('采购入库整单优惠按行比例分摊,尾差由最后一行承担,库存金额之和等于总金额', () => {
    const doc = makeDoc('A', 'purchase_in', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '3', price: '10.00' }, { sku: 'S1', qty: '3', price: '10.00' }, { sku: 'S2', qty: '3', price: '10.00' }], discountPct: 0, paidPct: 0, amount: '1', counted: [] })
    doc.docDiscount = '10.00'
    doc.totalAmount = '80.00'
    const plan = planPosting(doc, ctx()) as PostingPlan
    expect(sum(plan.stockEntries.map((e) => e.amountDelta)).toString()).toBe('80')
    expect(plan.partnerEntries[0].amountDelta.toString()).toBe('80')
    expect(netLineAmounts(doc.lines.map((l) => l.amount), '10.00', 2).map(String)).toEqual(['26.67', '26.67', '26.66'])
  })

  it('同单同 SKU 同仓多行合并校验负库存', () => {
    const doc = makeDoc('B', 'sales_out', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '6', price: '1.00' }, { sku: 'S0', qty: '6', price: '1.00' }], discountPct: 0, paidPct: 0, amount: '1', counted: [] })
    const stock = { 'S0|W0': balanceOf('10', '100', '10') }
    const r = planPosting(doc, ctx(stock))
    expect(isRejection(r)).toBe(true)
    if (isRejection(r)) {
      expect(r.code).toBe('INSUFFICIENT_STOCK')
      expect(r.details).toHaveLength(1)
      expect(r.details[0]).toMatchObject({ skuId: 'S0', warehouseId: 'W0', currentQty: '10', requiredQty: '12' })
    }
  })

  it('销售出库毛利 = 总金额 − 出库成本之和;出库不改变均价', () => {
    const doc = makeDoc('C', 'sales_out', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '4', price: '25.00' }], discountPct: 0, paidPct: 0, amount: '1', counted: [] })
    const plan = planPosting(doc, ctx({ 'S0|W0': balanceOf('10', '100', '10') })) as PostingPlan
    expect(plan.grossProfit!.toString()).toBe('60') // 100 − 4×10
    expect(plan.lineCosts[0].lineProfit!.toString()).toBe('60')
    expect(plan.stockBalances.get('S0|W0')!.avgCost.toString()).toBe('10')
  })

  it('信用额度:超出需确认,确认后放行;其余校验优先于信用额度', () => {
    const doc = makeDoc('D', 'sales_out', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '1', price: '100.00' }], discountPct: 0, paidPct: 0, amount: '1', counted: [] })
    const base = { ...ctx({ 'S0|W0': balanceOf('10', '100', '10') }) }
    const r = planPosting(doc, { ...base, credit: { limit: '150', arBalance: '100', confirmed: false } })
    expect(isRejection(r) && r.code).toBe('CREDIT_CONFIRM_REQUIRED')
    expect(isRejection(r) && r.details[0].excess).toBe('50')
    expect(isRejection(planPosting(doc, { ...base, credit: { limit: '150', arBalance: '100', confirmed: true } }))).toBe(false)
    expect(isRejection(planPosting(doc, { ...base, credit: { limit: null, arBalance: '100', confirmed: false } }))).toBe(false)
    const noStock = planPosting(doc, { ...ctx(), credit: { limit: '1', arBalance: '0', confirmed: false } })
    expect(isRejection(noStock) && noStock.code).toBe('INSUFFICIENT_STOCK')
  })

  it('付款资金不足、账户停用', () => {
    const doc = makeDoc('E', 'payment', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [], discountPct: 0, paidPct: 0, amount: '500.00', counted: [] })
    const r1 = planPosting(doc, ctx({}, { F0: { balance: '100.00', enabled: true } }))
    expect(isRejection(r1) && r1.code).toBe('FUND_INSUFFICIENT')
    expect(isRejection(r1) && r1.details[0].balance).toBe('100')
    const r2 = planPosting(doc, ctx({}, { F0: { balance: '9999', enabled: false } }))
    expect(isRejection(r2) && r2.code).toBe('FUND_ACCOUNT_DISABLED')
  })

  it('订单只改状态,不产生任何变动', () => {
    for (const t of ['purchase_order', 'sales_order'] as DocType[]) {
      const doc = makeDoc('O', t, { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '1', price: '1.00' }], discountPct: 0, paidPct: 0, amount: '1', counted: [] })
      const p = planPosting(doc, ctx()) as PostingPlan
      expect(p.stockEntries.length + p.partnerEntries.length + p.fundEntries.length).toBe(0)
    }
  })

  it('销售退货入库成本取关联出库行的单位成本,缺省取当前均价', () => {
    const mk = (cost: string | null) => {
      const d = makeDoc('F', 'sales_return', { partner: 'P0', wh: 'W0', to: 'W1', fund: 'F0', lines: [{ sku: 'S0', qty: '2', price: '30.00' }], discountPct: 0, paidPct: 0, amount: '1', counted: [] })
      d.lines[0].returnUnitCost = cost
      return d
    }
    const c = ctx({ 'S0|W0': balanceOf('10', '120', '12') })
    expect((planPosting(mk('7.5'), c) as PostingPlan).stockEntries[0].amountDelta.toString()).toBe('15')
    expect((planPosting(mk(null), c) as PostingPlan).stockEntries[0].amountDelta.toString()).toBe('24')
  })

  it('空结存的 balance 初始值', () => {
    expect(emptyBalance().avgCost.isZero()).toBe(true)
  })
})
