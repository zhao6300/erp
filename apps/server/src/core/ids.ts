import { randomBytes } from 'node:crypto'

/** UUIDv7:48 位毫秒时间戳 + 随机,按时间有序且不可枚举 */
let lastMs = 0
let counter = 0
export function uuidv7(now: number = Date.now()): string {
  // 同一毫秒内保持单调递增
  if (now <= lastMs) {
    now = lastMs
    counter++
  } else {
    lastMs = now
    counter = 0
  }
  const b = randomBytes(16)
  b[0] = (now / 2 ** 40) & 0xff
  b[1] = (now / 2 ** 32) & 0xff
  b[2] = (now / 2 ** 24) & 0xff
  b[3] = (now / 2 ** 16) & 0xff
  b[4] = (now / 2 ** 8) & 0xff
  b[5] = now & 0xff
  b[6] = 0x70 | ((counter >> 8) & 0x0f)
  b[7] = counter & 0xff
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
