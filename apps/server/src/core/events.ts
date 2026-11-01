import { createHmac } from 'node:crypto'
import { AppError } from '@erp/shared'
import {
  ErpPlugin,
  EventPayload,
  EventType,
  PLUGIN_TIMEOUT_MS,
  SYNC_EVENTS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@erp/plugin-sdk'
import { AuditService } from './audit'
import type { ConfigCache } from './cache'
import type { Db } from './db'

interface Binding {
  pluginName: string
  config: { url?: string; secret?: string; events?: EventType[] }
}

/** 已注册的插件实现(进程内)。HTTP Webhook 插件通过 tenant_plugin.config.url 声明 */
export class PluginRegistry {
  private plugins = new Map<string, ErpPlugin>()
  register(p: ErpPlugin) {
    this.plugins.set(p.name, p)
  }
  get(name: string) {
    return this.plugins.get(name)
  }
  names() {
    return [...this.plugins.keys()]
  }
}

export class EventService {
  constructor(
    private db: Db,
    private cache: ConfigCache,
    private registry: PluginRegistry,
    private audit: AuditService,
    private timeoutMs = PLUGIN_TIMEOUT_MS,
  ) {}

  /** 仅分发给该 Tenant 已启用且订阅了该事件的插件(需求 23.1、23.3) */
  private async bindings(tenantId: string, type: EventType): Promise<{ name: string; binding: Binding; impl?: ErpPlugin }[]> {
    const all = await this.cache.get(`plug:${tenantId}`, () =>
      this.db.withTenant(tenantId, async (tx) => (await tx.rows<{ plugin_name: string; config: Binding['config'] }>('SELECT plugin_name, config FROM tenant_plugin WHERE enabled')).map((r) => ({ pluginName: r.plugin_name, config: r.config }))),
    )
    const out: { name: string; binding: Binding; impl?: ErpPlugin }[] = []
    for (const b of all) {
      const impl = this.registry.get(b.pluginName)
      const subscribes = impl ? impl.subscribes : (b.config.events ?? [])
      if (subscribes.includes(type)) out.push({ name: b.pluginName, binding: b, impl })
    }
    return out
  }

  private async call(entry: { name: string; binding: Binding; impl?: ErpPlugin }, event: EventPayload) {
    const run = async () => {
      if (entry.impl) return entry.impl.handle(event, { tenantId: event.tenantId, log: () => {} })
      const { url, secret } = entry.binding.config
      if (!url) throw new Error('webhook 插件未配置 url')
      const body = JSON.stringify(event)
      const ts = String(Date.now())
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_TIMESTAMP_HEADER]: ts,
          [WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', secret ?? '').update(`${ts}.${body}`).digest('hex'),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        // 同步事件:HTTP 422 视为校验失败,携带 message
        if (res.status === 422) {
          const j = (await res.json().catch(() => ({}))) as { message?: string }
          return { ok: false as const, message: j.message ?? '插件校验失败' }
        }
        throw new Error(`HTTP ${res.status}`)
      }
      return undefined
    }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new PluginTimeout()), this.timeoutMs)
    })
    try {
      return await Promise.race([run(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 同步事件(保存前/审核前):在事务外调用,避免外部调用持有行锁。
   * 拒绝、异常、超时都中止本次操作(需求 23.2)。
   */
  async dispatchSync(event: EventPayload): Promise<void> {
    if (!SYNC_EVENTS.includes(event.eventType)) throw new Error('not a sync event')
    for (const entry of await this.bindings(event.tenantId, event.eventType)) {
      try {
        const r = await this.call(entry, event)
        if (r && typeof r === 'object' && 'ok' in r && r.ok === false) throw new AppError('PLUGIN_REJECTED', r.message)
      } catch (e) {
        if (e instanceof AppError) throw e
        if (e instanceof PluginTimeout || (e as Error)?.name === 'TimeoutError') throw new AppError('PLUGIN_TIMEOUT', `扩展插件“${entry.name}”处理超时(${this.timeoutMs / 1000} 秒)`)
        throw new AppError('PLUGIN_ERROR', `扩展插件“${entry.name}”处理异常:${(e as Error)?.message ?? e}`)
      }
    }
  }

  /** 异步事件(审核后/反审核后),由 worker 从 event_outbox 分发。失败写 Audit_Log,不影响已完成的审核(需求 23.6) */
  async dispatchAsync(event: EventPayload): Promise<{ failures: number }> {
    let failures = 0
    for (const entry of await this.bindings(event.tenantId, event.eventType)) {
      try {
        const r = await this.call(entry, event)
        if (r && typeof r === 'object' && 'ok' in r && r.ok === false) throw new Error(r.message)
      } catch (e) {
        failures++
        const reason = e instanceof PluginTimeout ? '处理超时(5 秒)' : ((e as Error)?.message ?? String(e))
        await this.db.withTenant(event.tenantId, (tx) =>
          this.audit.write(tx, {
            tenantId: event.tenantId,
            actorType: 'plugin',
            actorName: entry.name,
            client: 'system',
            action: 'plugin.failed',
            objectType: event.docType,
            objectNo: event.docNo,
            detail: { pluginName: entry.name, eventType: event.eventType, docNo: event.docNo, reason },
          }),
        )
      }
    }
    return { failures }
  }

  async invalidate(tenantId: string) {
    await this.cache.invalidate(`plug:${tenantId}`)
  }
}

class PluginTimeout extends Error {
  constructor() {
    super('plugin timeout')
    this.name = 'PluginTimeout'
  }
}
