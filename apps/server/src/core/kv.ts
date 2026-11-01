import { EventEmitter } from 'node:events'

/** Redis 的最小抽象:会话、缓存、失效广播。测试与单进程部署用内存实现,生产用 ioredis */
export interface Kv {
  get(key: string): Promise<string | null>
  /** ttlSeconds 省略则不过期 */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(...keys: string[]): Promise<void>
  expire(key: string, ttlSeconds: number): Promise<void>
  /** 原子自增,用于限流与计数 */
  incr(key: string): Promise<number>
  publish(channel: string, message: string): Promise<void>
  subscribe(channel: string, handler: (message: string) => void): Promise<void>
  close(): Promise<void>
}

export class MemoryKv implements Kv {
  private store = new Map<string, { v: string; exp: number | null }>()
  private bus = new EventEmitter()
  constructor(private now: () => number = Date.now) {}

  private live(key: string) {
    const e = this.store.get(key)
    if (!e) return undefined
    if (e.exp !== null && e.exp <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    return e
  }
  async get(key: string) {
    return this.live(key)?.v ?? null
  }
  async set(key: string, value: string, ttlSeconds?: number) {
    this.store.set(key, { v: value, exp: ttlSeconds ? this.now() + ttlSeconds * 1000 : null })
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.store.delete(k))
  }
  async expire(key: string, ttlSeconds: number) {
    const e = this.live(key)
    if (e) e.exp = this.now() + ttlSeconds * 1000
  }
  async incr(key: string) {
    const e = this.live(key)
    const n = (e ? Number(e.v) : 0) + 1
    this.store.set(key, { v: String(n), exp: e?.exp ?? null })
    return n
  }
  async publish(channel: string, message: string) {
    queueMicrotask(() => this.bus.emit(channel, message))
  }
  async subscribe(channel: string, handler: (m: string) => void) {
    this.bus.on(channel, handler)
  }
  async close() {
    this.bus.removeAllListeners()
  }
}

export async function createRedisKv(url: string): Promise<Kv> {
  const { default: IORedis } = await import('ioredis')
  const main = new IORedis(url, { maxRetriesPerRequest: 2 })
  const sub = new IORedis(url)
  const handlers = new Map<string, ((m: string) => void)[]>()
  sub.on('message', (ch: string, msg: string) => handlers.get(ch)?.forEach((h) => h(msg)))
  return {
    get: (k) => main.get(k),
    set: async (k, v, ttl) => {
      if (ttl) await main.set(k, v, 'EX', ttl)
      else await main.set(k, v)
    },
    del: async (...ks) => {
      if (ks.length) await main.del(...ks)
    },
    expire: async (k, ttl) => {
      await main.expire(k, ttl)
    },
    incr: (k) => main.incr(k),
    publish: async (c, m) => {
      await main.publish(c, m)
    },
    subscribe: async (c, h) => {
      handlers.set(c, [...(handlers.get(c) ?? []), h])
      await sub.subscribe(c)
    },
    close: async () => {
      main.disconnect()
      sub.disconnect()
    },
  }
}

export const CACHE_CHANNEL = 'erp:cache-invalidate'
