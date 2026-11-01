import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'

/** argon2id(需求 9.6)。@node-rs/argon2 默认算法即 argon2id */
export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 })
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password)
  } catch {
    return false
  }
}

let dummyHash: Promise<string> | undefined
/** 账号不存在时也做一次哈希比对,使响应时间接近(需求 9.9) */
export async function fakeVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing')
  await verifyPassword(await dummyHash, password)
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 生成一次性初始密码(只打印到启动日志) */
export function randomPassword(): string {
  return randomBytes(9).toString('base64url')
}
