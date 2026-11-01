import { CACHE_CHANNEL, Kv } from './kv'

/**
 * 进程内 LRU + TTL 缓存,配合 Redis pub/sub 失效广播(设计:配置生效与缓存)。
 * 广播缩短生效时间,TTL(默认 30 秒)是兜底:即使广播丢失也会在 TTL 后重新读库。
 */
export class ConfigCache {
  private map = new Map<string, { v: unknown; exp: number }>()
  constructor(
    private kv: Kv,
    private opts: { ttlMs?: number; max?: number; now?: () => number } = {},
  ) {}

  async start(): Promise<void> {
    await this.kv.subscribe(CACHE_CHANNEL, (msg) => this.invalidateLocal(msg))
  }

  private get ttl() {
    return this.opts.ttlMs ?? 30_000
  }
  private now() {
    return (this.opts.now ?? Date.now)()
  }

  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key)
    if (hit && hit.exp > this.now()) {
      // LRU:命中后移到队尾
      this.map.delete(key)
      this.map.set(key, hit)
      return hit.v as T
    }
    const v = await load()
    this.map.set(key, { v, exp: this.now() + this.ttl })
    const max = this.opts.max ?? 5000
    while (this.map.size > max) this.map.delete(this.map.keys().next().value as string)
    return v
  }

  /** 本进程立即失效,并广播给其他进程。prefix 匹配以该前缀开头的全部键 */
  async invalidate(prefix: string): Promise<void> {
    this.invalidateLocal(prefix)
    await this.kv.publish(CACHE_CHANNEL, prefix)
  }

  private invalidateLocal(prefix: string) {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k)
  }
}
