import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

export class MigrationError extends Error {
  constructor(
    public readonly file: string,
    cause: unknown,
  ) {
    super(`迁移失败: ${file}: ${(cause as Error)?.message ?? cause}`)
    this.name = 'MigrationError'
  }
}

const ADVISORY_KEY = 727_001 // 迁移与独立部署初始化共用的 advisory lock

/** 源码运行(src/core/ → src/migrations)与打包产物(dist/main.js → dist/migrations)两种布局 */
export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [path.join(here, 'migrations'), path.join(here, '..', 'migrations')].find((d) => existsSync(d)) ?? path.join(here, '..', 'migrations')
}

export function listMigrations(dir = migrationsDir()): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }))
}

/** 创建受限角色(幂等)。应用角色:无 BYPASSRLS、非表所有者(需求 22.4、设计 D1) */
export async function provisionRoles(admin: pg.ClientBase, passwords: { app: string; platform: string }): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
        CREATE ROLE erp_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${q(passwords.app)};
      ELSE
        ALTER ROLE erp_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${q(passwords.app)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
        CREATE ROLE erp_platform LOGIN NOSUPERUSER BYPASSRLS PASSWORD ${q(passwords.platform)};
      ELSE
        ALTER ROLE erp_platform LOGIN NOSUPERUSER BYPASSRLS PASSWORD ${q(passwords.platform)};
      END IF;
    END $$;`)
}

/**
 * 启动时按 DATABASE_APP_URL / DATABASE_PLATFORM_URL 中的口令幂等创建受限角色。
 * 连接串的用户名必须分别为 erp_app / erp_platform(迁移中的授权以这两个角色名为准)。
 */
export async function provisionRolesFromUrls(adminUrl: string, appUrl: string, platformUrl: string): Promise<void> {
  const parse = (url: string, expected: string) => {
    const u = new URL(url)
    if (decodeURIComponent(u.username) !== expected) throw new Error(`连接串的用户名必须为 ${expected}`)
    if (!u.password) throw new Error(`${expected} 的连接串必须包含口令`)
    return decodeURIComponent(u.password)
  }
  const passwords = { app: parse(appUrl, 'erp_app'), platform: parse(platformUrl, 'erp_platform') }
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_KEY])
    await provisionRoles(client, passwords)
  } finally {
    await client.end() // 会话结束时 advisory lock 自动释放
  }
}

export interface MigrationResult {
  applied: string[]
}

/**
 * 在单个事务内执行全部待执行迁移(PostgreSQL 事务性 DDL)。
 * 失败则整体回滚,抛出 MigrationError 并指明失败的迁移文件名(需求 23.5、23.8)。
 */
export async function runMigrations(adminUrl: string, dir = migrationsDir()): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_KEY])
    const applied: string[] = []
    await client.query('BEGIN')
    let current = ''
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
      const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version))
      for (const m of listMigrations(dir)) {
        if (done.has(m.name)) continue
        current = m.name
        await client.query(m.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.name])
        applied.push(m.name)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw new MigrationError(current || 'schema_migrations', e)
    }
    return { applied }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY])
    } catch {
      /* ignore */
    }
    await client.end()
  }
}

export async function withAdvisoryLock<T>(adminUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_KEY])
    return await fn(client)
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY])
    } catch {
      /* ignore */
    }
    await client.end()
  }
}
