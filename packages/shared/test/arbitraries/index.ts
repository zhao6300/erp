import fc from 'fast-check'

/** 生成 0 .. maxInt 的字符串小数,精确到 scale 位(边界:0、最大值) */
export function decStr(opts: { scale: number; maxInt?: number; min?: number }): fc.Arbitrary<string> {
  const { scale, maxInt = 100000, min = 0 } = opts
  const factor = 10 ** scale
  const hi = maxInt * factor
  const lo = Math.round(min * factor)
  return fc
    .oneof(
      { weight: 8, arbitrary: fc.integer({ min: lo, max: hi }) },
      { weight: 1, arbitrary: fc.constant(lo) },
      { weight: 1, arbitrary: fc.constant(hi) },
    )
    .map((n) => toFixedScaled(n, scale))
}

/** 整数(按 10^scale 缩放)转固定小数位字符串,避免浮点 */
export function toFixedScaled(n: number | bigint, scale: number): string {
  const neg = n < 0
  const s = (neg ? -BigInt(n) : BigInt(n)).toString().padStart(scale + 1, '0')
  const body = scale === 0 ? s : `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`
  return neg ? `-${body}` : body
}

export const scaleArb = (max: number) => fc.integer({ min: 0, max })

export const idArb = fc.uuid()

/** 四舍五入(half up)整数除法,分母为正 */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (num < 0n) return -divRoundHalfUp(-num, den)
  return (2n * num + den) / (2n * den)
}

export const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** 字符串小数 → 缩放整数 */
export function toScaledBig(s: string, scale: number): bigint {
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const v = BigInt(i + f.padEnd(scale, '0').slice(0, scale))
  return neg ? -v : v
}
