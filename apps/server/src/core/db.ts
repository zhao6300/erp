import { AppError } from '@erp/shared'
import pg from 'pg'

// numeric 保持字符串,避免任何浮点转换(金额、数量、单价)
pg.types.setTypeParser(1700, (v) => v)
// date 保持 YYYY-MM-DD 字符串,避免时区偏移
pg.types.setTypeParser(1082, (v) => v)
// int8(count、bigserial)转数字,业务上不会超过 2^53
pg.types.setTypeParser(20, (v) => Number(v))

export type Row = Record<string, any>

/** 事务内的查询句柄 */
export class Tx {
  /** 事务提交后执行(缓存失效、事件广播等);回滚时丢弃 */
  readonly commitHooks: (() => Promise<void> | void)[] = []

  constructor(
    private readonly client: pg.PoolClient,
    readonly tenantId: string | null,
  ) {}

  onCommit(fn: () => Promise<void> | void): void {
    this.commitHooks.push(fn)
  }

  async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.client.query<T>(text, params as any[])
  }
  async rows<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.query<T>(text, params)).rows
  }
  async maybeOne<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.query<T>(text, params)
    return r.rows[0] ?? null
  }
  async one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T> {
    const r = await this.maybeOne<T>(text, params)
    if (!r) throw new Error('expected one row')
    return r
  }
  async exec(text: string, params: unknown[] = []): Promise<number> {
    return (await this.query(text, params)).rowCount ?? 0
  }
}

export interface TxOptions {
  /** 行锁等待上限,超时回滚并提示重新打开单据 */
  lockTimeoutMs?: number
  /** 语句超时(报表 30 秒) */
  statementTimeoutMs?: number
  readOnly?: boolean
}

/** 把 PostgreSQL 并发类错误映射为领域错误(设计:Error Handling 并发) */
export function mapDbError(e: unknown): unknown {
  const code = (e as { code?: string })?.code
  if (code === '55P03' || code === '40P01' || code === '40001') return new AppError('DOC_STATUS_CHANGED')
  if (code === '57014') return new AppError('REPORT_TIMEOUT')
  return e
}

export class Db {
  constructor(
    readonly appPool: pg.Pool,
    readonly platformPool: pg.Pool,
  ) {}

  private async run<T>(pool: pg.Pool, tenantId: string | null, fn: (tx: Tx) => Promise<T>, opts: TxOptions): Promise<T> {
    const client = await pool.connect()
    let committed = false
    try {
      await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      if (tenantId) await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      if (opts.lockTimeoutMs) await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${opts.lockTimeoutMs}ms`])
      if (opts.statementTimeoutMs) await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${opts.statementTimeoutMs}ms`])
      const tx = new Tx(client, tenantId)
      const result = await fn(tx)
      await client.query('COMMIT')
      committed = true
      // 提交后的钩子失败不应影响已提交的业务结果
      for (const h of tx.commitHooks) {
        try {
          await h()
        } catch (e) {
          console.error('[onCommit hook failed]', e)
        }
      }
      return result
    } catch (e) {
      if (!committed) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* 连接可能已损坏 */
        }
      }
      throw mapDbError(e)
    } finally {
      client.release()
    }
  }

  /** 租户事务:BEGIN; SET LOCAL app.tenant_id; ...。事务结束后连接池复用不会串租户 */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    if (!tenantId) throw new Error('tenantId required')
    return this.run(this.appPool, tenantId, fn, { lockTimeoutMs: 5000, ...opts })
  }

  /** 平台事务:erp_platform(BYPASSRLS),仅 platform/auth 模块使用 */
  withPlatform<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    return this.run(this.platformPool, null, fn, opts)
  }

  async close(): Promise<void> {
    await Promise.all([this.appPool.end(), this.platformPool.end()])
  }
}

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max })
}
