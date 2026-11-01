import { LocalDate, formatLocalDate } from '@erp/shared'

/** 时钟抽象,便于测试"过期日当天 23:59:59"等边界 */
export type Clock = () => Date
export const systemClock: Clock = () => new Date()

/** 取某时区下的日历日期 */
export function localDateIn(tz: string, now: Date): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

/** 某时区下 YYYY-MM-DD 当天零点对应的 UTC 时刻 */
export function startOfDayUtc(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0)
  // 通过格式化推算该时区在 guess 时刻的偏移,再回退
  const offsetMs = tzOffsetMs(tz, new Date(guess))
  let t = guess - offsetMs
  // 夏令时边界再校正一次
  const off2 = tzOffsetMs(tz, new Date(t))
  if (off2 !== offsetMs) t = guess - off2
  return new Date(t)
}

function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return formatLocalDate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() })
}

/** 自然日差:b − a */
export function diffDays(a: string, b: string): number {
  const f = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((f(b) - f(a)) / 86_400_000)
}

export const todayStr = (tz: string, now: Date) => formatLocalDate(localDateIn(tz, now))
