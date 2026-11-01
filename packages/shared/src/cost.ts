import { D, Dec, DecValue, dec, max0, roundHalfUp } from './decimal'
import type { Scales } from './types'

/** 某 SKU 在某仓库的成本结存(设计 D6) */
export interface CostBalance {
  qty: Dec // 基本单位结存数量
  amount: Dec // 结存金额
  avgCost: Dec // 移动加权平均成本
}

export type CostScales = Pick<Scales, 'priceScale' | 'amountScale'>

export function emptyBalance(): CostBalance {
  return { qty: new D(0), amount: new D(0), avgCost: new D(0) }
}

export function balanceOf(qty: DecValue, amount: DecValue, avgCost: DecValue): CostBalance {
  return { qty: dec(qty), amount: dec(amount), avgCost: dec(avgCost) }
}

/**
 * 入库:newQty = qty + inQty;newQty > 0 时 avg = round((amount + inAmount) / newQty);
 * 否则 avg = round(inAmount / inQty)(需求 14.3、14.11)。
 */
export function applyInbound(bal: CostBalance, inQty: DecValue, inAmount: DecValue, scales: CostScales): CostBalance {
  const q = dec(inQty)
  const a = dec(inAmount)
  const newQty = bal.qty.plus(q)
  const newAmount = bal.amount.plus(a)
  let avg: Dec
  if (newQty.gt(0)) avg = roundHalfUp(newAmount.div(newQty), scales.priceScale)
  else if (q.gt(0)) avg = roundHalfUp(a.div(q), scales.priceScale)
  else avg = bal.avgCost
  return { qty: newQty, amount: newAmount, avgCost: max0(avg) }
}

export interface OutboundResult {
  bal: CostBalance
  unitCost: Dec
  amount: Dec // 出库金额(正数)
}

/** 出库:单位成本 = 出库前 avg_cost,出库不改变均价;qty 归零时 amount 置 0 消除舍入残差(需求 14.4) */
export function applyOutbound(bal: CostBalance, outQty: DecValue, scales: CostScales): OutboundResult {
  const q = dec(outQty)
  const unitCost = bal.avgCost
  const amount = roundHalfUp(q.times(unitCost), scales.amountScale)
  const newQty = bal.qty.minus(q)
  const newAmount = newQty.isZero() ? new D(0) : bal.amount.minus(amount)
  return { bal: { qty: newQty, amount: newAmount, avgCost: bal.avgCost }, unitCost, amount }
}

/** 冲回入库类流水:按原数量与金额反向扣减;qty > 0 时 avg = round(amount / qty),否则保持原 avg */
export function applyReverseInbound(bal: CostBalance, qty: DecValue, amount: DecValue, scales: CostScales): CostBalance {
  const newQty = bal.qty.minus(dec(qty))
  const newAmount = newQty.isZero() ? new D(0) : bal.amount.minus(dec(amount))
  const avg = newQty.gt(0) ? max0(roundHalfUp(newAmount.div(newQty), scales.priceScale)) : bal.avgCost
  return { qty: newQty, amount: newAmount, avgCost: avg }
}

/** 冲回出库类流水:按原数量与金额反向加回,并按入库公式重算 avg */
export function applyReverseOutbound(bal: CostBalance, qty: DecValue, amount: DecValue, scales: CostScales): CostBalance {
  return applyInbound(bal, qty, amount, scales)
}

export const stockKey = (skuId: string, warehouseId: string) => `${skuId}|${warehouseId}`
