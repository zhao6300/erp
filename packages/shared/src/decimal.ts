import Decimal from 'decimal.js'

/**
 * 独立的 Decimal 构造器:高精度 + ROUND_HALF_UP。
 * 数量、单价、金额禁止使用 JS 浮点数,一律经由本模块计算。
 */
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -60, toExpPos: 60 })
export type Dec = InstanceType<typeof D>
export type DecValue = string | number | Dec

export const ZERO: Dec = new D(0)

export function dec(v: DecValue | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return new D(0)
  return new D(v as any)
}

/** 四舍五入(ROUND_HALF_UP)到指定小数位 */
export function roundHalfUp(v: DecValue, scale: number): Dec {
  return dec(v).toDecimalPlaces(scale, D.ROUND_HALF_UP)
}

/** 小数位数不超过 maxScale 时返回 true */
export function assertScale(v: DecValue, maxScale: number): boolean {
  return dec(v).decimalPlaces() <= maxScale
}

/** 固定小数位的字符串(用于 JSON 传输与存储) */
export function fixed(v: DecValue, scale: number): string {
  return roundHalfUp(v, scale).toFixed(scale)
}

export function sum(values: DecValue[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(dec(v)), new D(0))
}

export function isDecimalString(s: unknown): s is string {
  return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s)
}

export function eq(a: DecValue, b: DecValue): boolean {
  return dec(a).eq(dec(b))
}

export function max0(v: DecValue): Dec {
  const d = dec(v)
  return d.isNegative() ? new D(0) : d
}
