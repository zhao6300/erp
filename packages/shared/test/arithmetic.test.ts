import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { allocateDocDiscount, calcDocTotal, calcLineAmount, dec, formatDocNo, fromBaseQty, resolveUnitPrice, roundHalfUp, sum, toBaseQty, validateNumberingRule, periodKey, NumberingRule } from '../src'
import { decStr, divRoundHalfUp, pow10, toFixedScaled, toScaledBig } from './arbitraries'

// Feature: lite-erp, Property 10: 单位换算往返
describe('Property 10: 单位换算往返', () => {
  it('fromBaseQty(toBaseQty(q, ratio), ratio) 等于 q', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 100000 }), fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 999_999_999 }), (ratio, scale, n) => {
        const q = toFixedScaled(n, scale)
        const back = fromBaseQty(toBaseQty(q, ratio), ratio)
        expect(back.eq(dec(q))).toBe(true)
      }),
      { numRuns: 200 },
    )
  })
})

// Feature: lite-erp, Property 11: 行金额与单据总金额计算
describe('Property 11: 行金额与单据总金额计算', () => {
  const lineArb = fc.record({
    qty: fc.integer({ min: 0, max: 99_999_999 }), // 缩放 qs 位
    price: fc.integer({ min: 0, max: 99_999_999 }), // 缩放 ps 位
    rate: fc.integer({ min: 0, max: 10000 }), // 0.00% – 100.00%
  })

  it('calcLineAmount 等于 BigInt 精确四舍五入结果', () => {
    fc.assert(
      fc.property(lineArb, fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 2 }), (l, qs, ps, as) => {
        const got = calcLineAmount(toFixedScaled(l.qty, qs), toFixedScaled(l.price, ps), toFixedScaled(l.rate, 2), as)
        // amount = qty × price × rate% ;全部转成整数
        const num = BigInt(l.qty) * BigInt(l.price) * BigInt(l.rate) * pow10(as)
        const den = pow10(qs) * pow10(ps) * pow10(2) * 100n
        const expected = divRoundHalfUp(num, den)
        expect(toScaledBig(got.toFixed(as), as)).toBe(expected)
      }),
      { numRuns: 300 },
    )
  })

  it('calcDocTotal 等于各行金额之和减整单优惠;采购与销售同一结果', () => {
    fc.assert(
      fc.property(fc.array(decStr({ scale: 2, maxInt: 100000 }), { minLength: 1, maxLength: 20 }), decStr({ scale: 2, maxInt: 1000 }), (amounts, discount) => {
        const total = calcDocTotal(amounts, discount)
        expect(total.eq(sum(amounts).minus(dec(discount)))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('整单优惠分摊之和严格等于整单优惠', () => {
    fc.assert(
      fc.property(fc.array(decStr({ scale: 2, maxInt: 10000 }), { minLength: 1, maxLength: 15 }), decStr({ scale: 2, maxInt: 5000 }), (amounts, discount) => {
        const shares = allocateDocDiscount(amounts, discount, 2)
        expect(shares).toHaveLength(amounts.length)
        expect(sum(shares).eq(dec(discount))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})

// Feature: lite-erp, Property 12: 价格等级取价
describe('Property 12: 价格等级取价', () => {
  it('零售取参考售价,批发取批发价(未设置取参考售价),折扣取 round(参考售价 × 折扣率)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.option(fc.integer({ min: 0, max: 99_999_999 }), { nil: undefined }),
        fc.integer({ min: 100, max: 10000 }),
        fc.integer({ min: 0, max: 6 }),
        (sale, wholesale, rate, ps) => {
          const product = { refSalePrice: toFixedScaled(sale, 2), wholesalePrice: wholesale === undefined ? null : toFixedScaled(wholesale, 2) }
          expect(resolveUnitPrice(product, { type: 'retail' }, ps).eq(roundHalfUp(product.refSalePrice, ps))).toBe(true)
          const w = resolveUnitPrice(product, { type: 'wholesale' }, ps)
          expect(w.eq(roundHalfUp(wholesale === undefined ? product.refSalePrice : product.wholesalePrice!, ps))).toBe(true)
          const d = resolveUnitPrice(product, { type: 'discount', rate: toFixedScaled(rate, 2) }, ps)
          // 参考售价 sale/100 × rate/100 /100, 结果取 ps 位
          const num = BigInt(sale) * BigInt(rate) * pow10(ps)
          const den = 100n * 100n * 100n
          expect(toScaledBig(d.toFixed(ps), ps)).toBe(divRoundHalfUp(num, den))
        },
      ),
      { numRuns: 300 },
    )
  })
})

// Feature: lite-erp, Property 2: 单据编号格式与唯一性(格式化部分)
describe('Property 2: 单据编号格式', () => {
  const ruleArb: fc.Arbitrary<NumberingRule> = fc.record({
    prefix: fc.stringMatching(/^[A-Z0-9-]{0,10}$/),
    dateFormat: fc.constantFrom('YMD', 'YM', 'NONE') as fc.Arbitrary<NumberingRule['dateFormat']>,
    seqDigits: fc.integer({ min: 3, max: 8 }),
    reset: fc.constantFrom('daily', 'monthly', 'yearly', 'never') as fc.Arbitrary<NumberingRule['reset']>,
  })
  const dateArb = fc.record({ y: fc.integer({ min: 2000, max: 2099 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) })

  it('结果 = 前缀 + 日期段 + 左补零流水号(超出位数按实际位数)', () => {
    fc.assert(
      fc.property(ruleArb, dateArb, fc.integer({ min: 1, max: 999_999_999 }), (rule, date, seq) => {
        const no = formatDocNo(rule, date, seq)
        const ymd = String(date.y * 10000 + date.m * 100 + date.d)
        const ym = String(date.y * 100 + date.m)
        const seg = rule.dateFormat === 'YMD' ? ymd : rule.dateFormat === 'YM' ? ym : ''
        const s = String(seq)
        const expected = rule.prefix + seg + (s.length >= rule.seqDigits ? s : '0'.repeat(rule.seqDigits - s.length) + s)
        expect(no).toBe(expected)
        expect(no.startsWith(rule.prefix + seg)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  it('重置周期标识与规则校验', () => {
    expect(periodKey({ reset: 'daily' }, { y: 2026, m: 9, d: 30 })).toBe('20260930')
    expect(periodKey({ reset: 'monthly' }, { y: 2026, m: 9, d: 30 })).toBe('202609')
    expect(periodKey({ reset: 'yearly' }, { y: 2026, m: 9, d: 30 })).toBe('2026')
    expect(periodKey({ reset: 'never' }, { y: 2026, m: 9, d: 30 })).toBe('-')
    expect(validateNumberingRule({ prefix: 'XS', dateFormat: 'NONE', seqDigits: 4, reset: 'daily' })).not.toHaveLength(0)
    expect(validateNumberingRule({ prefix: 'XS', dateFormat: 'YM', seqDigits: 4, reset: 'daily' })).not.toHaveLength(0)
    expect(validateNumberingRule({ prefix: 'xs', dateFormat: 'YMD', seqDigits: 4, reset: 'daily' })).not.toHaveLength(0)
    expect(validateNumberingRule({ prefix: 'XS', dateFormat: 'YMD', seqDigits: 2, reset: 'daily' })).not.toHaveLength(0)
    expect(validateNumberingRule({ prefix: 'XS-', dateFormat: 'YMD', seqDigits: 4, reset: 'never' })).toHaveLength(0)
  })
})
