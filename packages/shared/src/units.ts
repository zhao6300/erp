import { Dec, DecValue, dec } from './decimal'

/** 辅助单位数量 → 基本单位数量(需求 11.6) */
export function toBaseQty(qty: DecValue, ratio: number): Dec {
  return dec(qty).times(ratio)
}

/** 基本单位数量 → 辅助单位数量 */
export function fromBaseQty(baseQty: DecValue, ratio: number): Dec {
  return dec(baseQty).div(ratio)
}

export function isValidUnitRatio(ratio: number): boolean {
  return Number.isInteger(ratio) && ratio >= 2 && ratio <= 100000
}
