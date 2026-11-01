import { D, Dec, DecValue, dec, roundHalfUp, sum } from './decimal'

/**
 * 行金额 = round(数量 × 单价 × 折扣率%, 金额位数)。discountRate 以百分比表示(0–100,100 表示不打折)。
 * (需求 15.2、16.2)
 */
export function calcLineAmount(qty: DecValue, price: DecValue, discountRate: DecValue, amountScale: number): Dec {
  return roundHalfUp(dec(qty).times(dec(price)).times(dec(discountRate)).div(100), amountScale)
}

/** 单据总金额 = Σ 已四舍五入的行金额 − 整单优惠 */
export function calcDocTotal(lineAmounts: DecValue[], docDiscount: DecValue): Dec {
  return sum(lineAmounts).minus(dec(docDiscount))
}

/**
 * 把整单优惠按行金额比例分摊到各行(设计 D6)。最后一行承担尾差,分摊之和严格等于 docDiscount。
 * 返回每行分摊后的优惠金额(非负)。
 */
export function allocateDocDiscount(lineAmounts: DecValue[], docDiscount: DecValue, amountScale: number): Dec[] {
  const amounts = lineAmounts.map(dec)
  const discount = dec(docDiscount)
  const total = sum(amounts)
  const n = amounts.length
  if (n === 0) return []
  if (discount.isZero() || total.isZero()) {
    const zeros = amounts.map(() => new D(0))
    if (!discount.isZero()) zeros[n - 1] = discount // 全部行金额为 0 时无法按比例,尾行承担
    return zeros
  }
  const out: Dec[] = []
  let allocated = new D(0)
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      out.push(discount.minus(allocated))
    } else {
      const share = roundHalfUp(discount.times(amounts[i]).div(total), amountScale)
      out.push(share)
      allocated = allocated.plus(share)
    }
  }
  return out
}

/** 扣除整单优惠分摊后的各行净金额 */
export function netLineAmounts(lineAmounts: DecValue[], docDiscount: DecValue, amountScale: number): Dec[] {
  const shares = allocateDocDiscount(lineAmounts, docDiscount, amountScale)
  return lineAmounts.map((a, i) => dec(a).minus(shares[i]))
}
