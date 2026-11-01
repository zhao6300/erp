import { uuidv7 } from './ids'
import type { Tx } from './db'
import type { ClientType, Ctx } from './context'

export interface AuditEntry {
  tenantId: string | null
  actorId?: string | null
  actorType?: 'user' | 'platform' | 'plugin' | 'open_api' | 'system'
  actorName?: string | null
  client?: ClientType | 'system' | null
  ip?: string | null
  action: string
  objectType?: string | null
  objectId?: string | null
  objectNo?: string | null
  before?: unknown
  after?: unknown
  detail?: unknown
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** 只记录取值发生变化的字段,custom 内的键展开为 custom.<code>(需求 22.1) */
export function diffRecord(before: Record<string, any> | null | undefined, after: Record<string, any> | null | undefined): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (!before) return { before: null, after: after ?? null }
  if (!after) return { before: before ?? null, after: null }
  const flat = (o: Record<string, any>) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'custom' && v && typeof v === 'object') for (const [ck, cv] of Object.entries(v)) out[`custom.${ck}`] = cv
      else out[k] = v
    }
    return out
  }
  const b = flat(before)
  const a = flat(after)
  const ob: Record<string, unknown> = {}
  const oa: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!same(b[k], a[k])) {
      if (k in b) ob[k] = b[k]
      if (k in a) oa[k] = a[k]
    }
  }
  return { before: ob, after: oa }
}

/** 审计日志:与业务变更同一事务写入,写入失败回滚业务操作(需求 22.8) */
export class AuditService {
  async write(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, actor_name, client, ip, action, object_type, object_id, object_no, before, after, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        uuidv7(),
        e.tenantId,
        e.actorId ?? null,
        e.actorType ?? 'user',
        e.actorName ?? null,
        e.client ?? null,
        e.ip ?? null,
        e.action,
        e.objectType ?? null,
        e.objectId ?? null,
        e.objectNo ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.detail === undefined ? null : JSON.stringify(e.detail),
      ],
    )
  }

  /** 以请求上下文为操作人写入 */
  async log(tx: Tx, ctx: Ctx, action: string, obj: { type?: string; id?: string; no?: string; before?: Record<string, any> | null; after?: Record<string, any> | null; detail?: unknown }): Promise<void> {
    const d = obj.before !== undefined || obj.after !== undefined ? diffRecord(obj.before, obj.after) : { before: undefined, after: undefined }
    await this.write(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.tenantUserId,
      actorType: ctx.actorType,
      actorName: ctx.name,
      client: ctx.client,
      ip: ctx.ip,
      action,
      objectType: obj.type,
      objectId: obj.id,
      objectNo: obj.no,
      before: d.before,
      after: d.after,
      detail: obj.detail,
    })
  }

  /** 仅 Tenant_Admin 可查,按时间倒序分页,每页 ≤ 100(需求 22.3) */
  async query(
    tx: Tx,
    ctx: Ctx,
    f: { actorId?: string; action?: string; objectType?: string; from?: string; to?: string; page?: number; pageSize?: number },
  ): Promise<{ items: Record<string, any>[]; total: number }> {
    const { AppError } = await import('@erp/shared')
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const where = ['tenant_id = $1']
    const params: unknown[] = [ctx.tenantId]
    const add = (sql: string, v: unknown) => {
      params.push(v)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (f.actorId) add('actor_id = ?', f.actorId)
    if (f.action) add('action = ?', f.action)
    if (f.objectType) add('object_type = ?', f.objectType)
    if (f.from) add('occurred_at >= ?', f.from)
    if (f.to) add('occurred_at <= ?', f.to)
    const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 100)
    const page = Math.max(f.page ?? 1, 1)
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${where.join(' AND ')}`, params)).n
    const items = await tx.rows(
      `SELECT id, actor_id, actor_name, actor_type, client, ip, action, object_type, object_id, object_no, before, after, detail, occurred_at
       FROM audit_log WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    )
    return { items, total }
  }

  /** 为当前月与下一个月创建分区;数据库已有默认分区时仍可安全执行 */
  async ensurePartitions(tx: Tx, from = new Date()): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1))
      try {
        await tx.query('SAVEPOINT audit_part')
        await tx.query('SELECT ensure_audit_partition($1::date)', [d.toISOString().slice(0, 10)])
        await tx.query('RELEASE SAVEPOINT audit_part')
      } catch {
        // 默认分区里已有该月数据时无法创建分区,忽略,数据仍可查询
        await tx.query('ROLLBACK TO SAVEPOINT audit_part')
      }
    }
  }
}
