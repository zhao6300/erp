import type { EventPayload } from '@erp/plugin-sdk'
import type { Container } from './container'
import { startBackupScheduler } from './ops/backup'

const POLL_MS = 1000
const MAX_ATTEMPTS = 3

/**
 * 处理 event_outbox:审核后/反审核后事件异步分发给插件(需求 23.6)。
 * 用 FOR UPDATE SKIP LOCKED 领取,多个 worker 并行不会重复分发。插件失败只写 Audit_Log,不影响已完成的审核。
 */
export async function drainOutbox(c: Container, limit = 50): Promise<number> {
  let processed = 0
  for (let i = 0; i < limit; i++) {
    const claimed = await c.db.withPlatform(async (tx) => {
      const row = await tx.maybeOne<{ id: number; tenant_id: string; payload: EventPayload; attempts: number }>(
        `SELECT id, tenant_id, payload, attempts FROM event_outbox WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
      if (!row) return null
      await tx.query('UPDATE event_outbox SET attempts = attempts + 1 WHERE id=$1', [row.id])
      return row
    })
    if (!claimed) break
    try {
      await c.events.dispatchAsync(claimed.payload)
      await c.db.withPlatform((tx) => tx.query(`UPDATE event_outbox SET status='done', processed_at=now() WHERE id=$1`, [claimed.id]))
    } catch (e) {
      console.error('[outbox] 分发失败', claimed.id, e)
      await c.db.withPlatform((tx) => tx.query(`UPDATE event_outbox SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END WHERE id=$1`, [claimed.id, MAX_ATTEMPTS]))
    }
    processed++
  }
  return processed
}

export async function startWorker(c: Container): Promise<() => Promise<void>> {
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      try {
        const n = await drainOutbox(c)
        if (n === 0) await new Promise((r) => setTimeout(r, POLL_MS))
      } catch (e) {
        console.error('[worker] outbox 轮询出错', e)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  })()
  const stopBackup = startBackupScheduler(c)
  return async () => {
    stopped = true
    stopBackup()
    await loop
  }
}
