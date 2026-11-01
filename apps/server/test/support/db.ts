import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { Db, createPool } from '../../src/core/db'
import { provisionRoles, runMigrations } from '../../src/core/migrate'

export const APP_PW = 'app_pw'
export const PLATFORM_PW = 'platform_pw'

export interface TestDb {
  name: string
  adminUrl: string
  appUrl: string
  platformUrl: string
  db: Db
  admin(): Promise<pg.Client>
  drop(): Promise<void>
}

function withDb(url: string, dbName: string, user?: string, password?: string): string {
  const u = new URL(url)
  u.pathname = '/' + dbName
  if (user) {
    u.username = user
    u.password = password ?? ''
  }
  return u.toString()
}

/** 创建全新数据库 → 创建角色 → 执行全部迁移 */
export async function createTestDb(serverAdminUrl: string, opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const name = 'erp_' + randomBytes(5).toString('hex')
  const root = new pg.Client({ connectionString: serverAdminUrl })
  await root.connect()
  try {
    await root.query('SELECT pg_advisory_lock(424242)') // 角色是集群级对象,并行测试文件需要串行创建
    await provisionRoles(root, { app: APP_PW, platform: PLATFORM_PW })
    await root.query(`CREATE DATABASE ${name}`)
    await root.query('SELECT pg_advisory_unlock(424242)')
  } finally {
    await root.end()
  }
  const adminUrl = withDb(serverAdminUrl, name)
  const appUrl = withDb(serverAdminUrl, name, 'erp_app', APP_PW)
  const platformUrl = withDb(serverAdminUrl, name, 'erp_platform', PLATFORM_PW)
  if (opts.migrate !== false) await runMigrations(adminUrl)
  const db = new Db(createPool(appUrl, 20), createPool(platformUrl, 10))
  return {
    name,
    adminUrl,
    appUrl,
    platformUrl,
    db,
    async admin() {
      const c = new pg.Client({ connectionString: adminUrl })
      await c.connect()
      return c
    },
    async drop() {
      await db.close()
      const c = new pg.Client({ connectionString: serverAdminUrl })
      await c.connect()
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await c.end()
    },
  }
}
