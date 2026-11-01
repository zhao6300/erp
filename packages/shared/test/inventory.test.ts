import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  Allocation,
  CostBalance,
  OpenItem,
  allocateSettlement,
  applyInbound,
  applyOutbound,
  balanceOf,
  checkOverQty,
  dec,
  fifoOrder,
  fulfillmentStatus,
  isAllocationError,
  remainingBySku,
  remainingQty,
  sum,
} from '../src'
import { divRoundHalfUp, pow10, toFixedScaled } from './arbitraries'

/* ───────── Property 14: 移动加权平均成本 ───────── */

// 余额用缩放整数表示:数量 1e-4,金额 1e-2,均价 1e-ps
const balArb = (ps: number) =>
  fc.record({
    qty: fc.integer({ min: -50_000_000, max: 500_000_000 }),
    amount: fc.integer({ min: -5_000_000_000, max: 5_000_000_000 }),
    avg: fc.integer({ min: 0, max: 10 ** Math.min(ps + 6, 12) }),
  })

const toBal = (b: { qty: number; amount: number; avg: number }, ps: number): CostBalance =>
  balanceOf(toFixedScaled(b.qty, 4), toFixedScaled(b.amount, 2), toFixedScaled(b.avg, ps))

// Feature: lite-erp, Property 14: 移动加权平均成本
describe('Property 14: 移动加权平均成本', () => {
  it('入库:newQty > 0 时 avg = round((amount + inAmount) / newQty),否则 round(inAmount / inQty);结果不为负', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 200_000_000 }),
        fc.integer({ min: 0, max: 5_000_000_000 }),
        fc.integer({ min: 0, max: 2 }),
        (ps, inQ, inA, _s) => {
          return fc.assert(
            fc.property(balArb(ps), (b) => {
              const bal = toBal(b, ps)
              const r = applyInbound(bal, toFixedScaled(inQ, 4), toFixedScaled(inA, 2), { priceScale: ps, amountScale: 2 })
              const newQ = BigInt(b.qty) + BigInt(inQ)
              let expected: bigint
              if (newQ > 0n) {
                // (amount+inAmount)[1e-2] / newQty[1e-4] → 元/单位 × 1e-ps
                expected = divRoundHalfUp((BigInt(b.amount) + BigInt(inA)) * 100n * pow10(ps), newQ)
              } else {
                expected = divRoundHalfUp(BigInt(inA) * 100n * pow10(ps), BigInt(inQ))
              }
              if (expected < 0n) expected = 0n
              expect(r.avgCost.mul(pow10(ps).toString()).toFixed(0)).toBe(expected.toString())
              expect(r.avgCost.isNegative()).toBe(false)
              expect(r.qty.eq(dec(toFixedScaled(newQ, 4)))).toBe(true)
              expect(r.amount.eq(dec(toFixedScaled(BigInt(b.amount) + BigInt(inA), 2)))).toBe(true)
            }),
            { numRuns: 20 },
          )
        },
      ),
      { numRuns: 20 },
    )
  })

  it('出库:单位成本 = 出库前 avg_cost,金额 = round(outQty × avg, 金额位数),均价不变;从未入库时成本为 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 2 }),
        balArb(6),
        fc.integer({ min: 1, max: 200_000_000 }),
        (ps, as, b, outQ) => {
          const bal = toBal(b, ps)
          const r = applyOutbound(bal, toFixedScaled(outQ, 4), { priceScale: ps, amountScale: as })
          expect(r.unitCost.eq(bal.avgCost)).toBe(true)
          // outQ[1e-4] × avg[1e-ps] → 元 × 1e-(4+ps) → 金额 1e-as
          const expected = divRoundHalfUp(BigInt(outQ) * BigInt(r.unitCost.mul(pow10(ps).toString()).toFixed(0)) * pow10(as), pow10(4 + ps))
          expect(r.amount.mul(pow10(as).toString()).toFixed(0)).toBe(expected.toString())
          expect(r.bal.avgCost.eq(bal.avgCost)).toBe(true)
          expect(r.bal.qty.eq(bal.qty.minus(dec(toFixedScaled(outQ, 4))))).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('从未入库(均价 0)的出库成本为 0', () => {
    const r = applyOutbound(balanceOf(0, 0, 0), '5', { priceScale: 4, amountScale: 2 })
    expect(r.unitCost.isZero()).toBe(true)
    expect(r.amount.isZero()).toBe(true)
  })

  it('需求 14.11:负库存后入库使用本次入库单价', () => {
    // 结存 -5,再入库 3 @ 单价 10 → newQty = -2 ≤ 0 → avg = 30/3 = 10
    const r = applyInbound(balanceOf('-5', '-50', '10'), '3', '30', { priceScale: 4, amountScale: 2 })
    expect(r.avgCost.toString()).toBe('10')
  })
})

/* ───────── Property 21: 收付款核销 ───────── */

const openItemsArb = fc
  .uniqueArray(
    fc.record({
      key: fc.uuid(),
      isOpening: fc.boolean(),
      day: fc.integer({ min: 1, max: 28 }),
      month: fc.integer({ min: 1, max: 12 }),
      seq: fc.integer({ min: 1, max: 9999 }),
      unsettled: fc.integer({ min: 1, max: 100_000_000 }),
    }),
    { minLength: 1, maxLength: 8, selector: (x) => x.key },
  )
  .map((items) => {
    let hasOpening = false
    return items.map<OpenItem>((x) => {
      const opening = x.isOpening && !hasOpening
      if (opening) hasOpening = true
      return {
        key: opening ? 'opening' : x.key,
        type: opening ? 'opening' : 'document',
        date: `2026-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}`,
        docNo: `NO${String(x.seq).padStart(4, '0')}`,
        unsettled: toFixedScaled(x.unsettled, 2),
      }
    })
  })

// Feature: lite-erp, Property 21: 收付款核销
describe('Property 21: 收付款核销', () => {
  it('合法输入:保留指定分配,剩余先进先出;合计等于金额;每项不超过未核销', () => {
    fc.assert(
      fc.property(
        openItemsArb,
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 8, maxLength: 8 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (items, fractions, totalFrac, useExplicit) => {
          const openTotal = sum(items.map((i) => i.unsettled))
          // 指定分配:对前几项指定部分金额(整数分)
          const explicit = useExplicit
            ? items
                .map((it, idx) => ({ key: it.key, amount: toFixedScaled(Math.max(1, Math.floor(Number(dec(it.unsettled).times(100)) * fractions[idx])), 2) }))
                .filter((e, idx) => idx % 2 === 0 && dec(e.amount).lte(dec(items[idx].unsettled)))
            : []
          const explicitTotal = sum(explicit.map((e) => e.amount))
          const spare = openTotal.minus(explicitTotal)
          const extraCents = Math.floor(Number(spare.times(100)) * totalFrac)
          const amount = explicitTotal.plus(dec(toFixedScaled(extraCents, 2)))
          if (!amount.gt(0)) return
          const r = allocateSettlement(amount, explicit, items)
          if (isAllocationError(r)) throw new Error('unexpected error ' + JSON.stringify(r.issues))
          // 合计等于金额
          expect(sum(r.map((a) => a.amount)).eq(amount)).toBe(true)
          // 每项分配 > 0
          expect(r.every((a) => a.amount.gt(0))).toBe(true)
          // 保留全部指定分配
          const manual = r.filter((a) => a.kind === 'manual')
          expect(manual).toHaveLength(explicit.length)
          explicit.forEach((e, i) => {
            expect(manual[i].key).toBe(e.key)
            expect(manual[i].amount.eq(dec(e.amount))).toBe(true)
          })
          // 每项合计 ≤ 未核销金额
          const perKey = new Map<string, Allocation[]>()
          r.forEach((a) => perKey.set(a.key, [...(perKey.get(a.key) ?? []), a]))
          for (const it of items) {
            const got = sum((perKey.get(it.key) ?? []).map((a) => a.amount))
            expect(got.lte(dec(it.unsettled))).toBe(true)
          }
          // 先进先出:若某项收到 fifo 分配,则排在它前面的项必须已被核销完(指定+fifo)
          const order = fifoOrder(items)
          order.forEach((it, idx) => {
            const hasFifo = (perKey.get(it.key) ?? []).some((a) => a.kind === 'fifo')
            if (!hasFifo) return
            for (const earlier of order.slice(0, idx)) {
              const got = sum((perKey.get(earlier.key) ?? []).map((a) => a.amount))
              expect(got.eq(dec(earlier.unsettled))).toBe(true)
            }
          })
          // 期初项最早
          const opening = order.find((o) => o.type === 'opening')
          if (opening) expect(order[0].key).toBe('opening')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('非法输入返回 AllocationError', () => {
    fc.assert(
      fc.property(openItemsArb, fc.constantFrom('zero', 'negative', 'over-item', 'over-total', 'unknown-key', 'explicit-over-amount'), (items, mode) => {
        const first = items[0]
        const openTotal = sum(items.map((i) => i.unsettled))
        let r
        switch (mode) {
          case 'zero':
            r = allocateSettlement(first.unsettled, [{ key: first.key, amount: '0' }], items)
            break
          case 'negative':
            r = allocateSettlement(first.unsettled, [{ key: first.key, amount: '-1.00' }], items)
            break
          case 'over-item':
            r = allocateSettlement(dec(first.unsettled).plus('0.01'), [{ key: first.key, amount: dec(first.unsettled).plus('0.01').toString() }], items)
            break
          case 'over-total':
            r = allocateSettlement(openTotal.plus('0.01'), [], items)
            break
          case 'unknown-key':
            r = allocateSettlement('0.01', [{ key: 'nope', amount: '0.01' }], items)
            break
          case 'explicit-over-amount':
            r = allocateSettlement('0.01', [{ key: first.key, amount: '0.02' }], items)
            break
        }
        // 'over-item' 在只有一个单据且总额也被超过时同样是错误
        expect(isAllocationError(r!)).toBe(true)
      }),
      { numRuns: 120 },
    )
  })
})

/* ───────── Property 20(纯函数部分): 可退数量 / 可入库数量 ───────── */

describe('Property 20: 剩余数量(纯函数)', () => {
  it('remainingQty = 上游 − 已审核下游;超量被检出', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ sku: fc.integer({ min: 0, max: 3 }), qty: fc.integer({ min: 1, max: 1000 }) }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.record({ lineIdx: fc.nat(5), qty: fc.integer({ min: 1, max: 400 }) }), { maxLength: 10 }),
        (ups, downs) => {
          const upstream = ups.map((u, i) => ({ id: `L${i}`, skuId: `S${u.sku}`, baseQty: String(u.qty) }))
          // 只保留不超量的下游
          const used = new Map<string, number>()
          const audited = downs
            .map((d) => ({ line: upstream[d.lineIdx % upstream.length], qty: d.qty }))
            .filter((d) => {
              const cur = used.get(d.line.id) ?? 0
              if (cur + d.qty > Number(d.line.baseQty)) return false
              used.set(d.line.id, cur + d.qty)
              return true
            })
            .map((d) => ({ upstreamLineId: d.line.id, skuId: d.line.skuId, baseQty: String(d.qty) }))
          const rem = remainingQty(upstream, audited)
          for (const u of upstream) expect(rem.get(u.id)!.eq(dec(u.baseQty).minus(used.get(u.id) ?? 0))).toBe(true)
          const bySku = remainingBySku(upstream, audited)
          const total = (m: Map<string, any>) => sum([...m.values()])
          expect(total(bySku).eq(total(rem))).toBe(true)
          // 超量检出:请求恰好 remaining+1 必被拒绝,恰好 remaining 通过
          for (const [skuId, left] of bySku) {
            expect(checkOverQty(upstream, audited, [{ skuId, baseQty: left.plus(1).toString() }])).toHaveLength(1)
            if (left.gt(0)) expect(checkOverQty(upstream, audited, [{ skuId, baseQty: left.toString() }])).toHaveLength(0)
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  it('订单进度', () => {
    expect(fulfillmentStatus(['10', '5'], ['0', '0'])).toBe('none')
    expect(fulfillmentStatus(['10', '5'], ['10', '5'])).toBe('done')
    expect(fulfillmentStatus(['10', '5'], ['12', '5'])).toBe('done')
    expect(fulfillmentStatus(['10', '5'], ['10', '0'])).toBe('partial')
    expect(fulfillmentStatus(['10', '5'], ['3', '0'])).toBe('partial')
  })
})
