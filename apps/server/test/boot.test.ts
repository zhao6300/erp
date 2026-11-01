import { ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, inject, it } from 'vitest'
import { APP_PW, PLATFORM_PW } from './support/db'

// 角色是集群级对象,与其他测试文件共享同一集群:这里必须使用与测试夹具相同的口令,否则启动时的角色初始化会改掉别人正在用的口令。
// 真实进程启动冒烟:角色初始化 → 迁移 → 独立部署默认租户 → 监听(需求 1.2、1.8、23.5)
const SERVER_DIR = path.resolve(__dirname, '..')
const children: ChildProcess[] = []
const dirs: string[] = []
const dbs: string[] = []

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

function urlFor(adminUrl: string, db: string, user?: string, pw?: string) {
  const u = new URL(adminUrl)
  u.pathname = '/' + db
  if (user) {
    u.username = user
    u.password = pw ?? ''
  }
  return u.toString()
}

function launch(env: Record<string, string>): { proc: ChildProcess; out: () => string } {
  let out = ''
  // BOOT_ENTRY=dist 时验证 tsup 构建产物(需先执行 pnpm build),默认用 tsx 跑源码
  const [cmd, args] = process.env.BOOT_ENTRY === 'dist' ? [process.execPath, ['dist/main.js']] : [path.join(SERVER_DIR, 'node_modules/.bin/tsx'), ['src/main.ts']]
  const proc = spawn(cmd, args, {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '--no-deprecation', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout?.on('data', (d) => (out += d))
  proc.stderr?.on('data', (d) => (out += d))
  children.push(proc)
  return { proc, out: () => out }
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}

afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
  const root = new pg.Client({ connectionString: inject('pgAdminUrl') })
  await root.connect()
  for (const d of dbs) await root.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
  await root.end()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('进程启动', () => {
  it('DEPLOYMENT_MODE 缺失:非零退出且不监听端口(需求 1.8)', async () => {
    const { proc, out } = launch({ DATABASE_ADMIN_URL: 'postgres://x:y@127.0.0.1:1/z', DATABASE_APP_URL: 'x', DATABASE_PLATFORM_URL: 'x' })
    const code = await new Promise<number | null>((r) => proc.on('exit', r))
    expect(code).toBe(1)
    expect(out()).toContain('Deployment_Mode')
  })

  it('空库:创建角色 → 迁移 → 默认租户 → /healthz 可用;重启幂等', async () => {
    const adminRoot = inject('pgAdminUrl')
    const db = 'erp_boot_' + randomBytes(4).toString('hex')
    dbs.push(db)
    const root = new pg.Client({ connectionString: adminRoot })
    await root.connect()
    await root.query(`CREATE DATABASE ${db}`)
    await root.end()

    const data = mkdtempSync(path.join(os.tmpdir(), 'erp-boot-'))
    dirs.push(data)
    const port = await freePort()
    const env = {
      DEPLOYMENT_MODE: 'standalone',
      DATABASE_ADMIN_URL: urlFor(adminRoot, db),
      DATABASE_APP_URL: urlFor(adminRoot, db, 'erp_app', APP_PW),
      DATABASE_PLATFORM_URL: urlFor(adminRoot, db, 'erp_platform', PLATFORM_PW),
      PORT: String(port),
      FILE_STORAGE_DIR: path.join(data, 'files'),
      BACKUP_DIR: path.join(data, 'backups'),
      PLUGINS_DIR: path.join(data, 'plugins'),
    }

    for (const round of [1, 2]) {
      const { proc, out } = launch(env)
      const health = await until(async () => {
        if (proc.exitCode !== null) throw new Error('server exited: ' + out())
        const r = await fetch(`http://127.0.0.1:${port}/healthz`)
        return r.ok ? ((await r.json()) as { ok: boolean }) : undefined
      }).catch((e) => {
        throw new Error(`${(e as Error).message}\n${out()}`)
      })
      expect(health.ok).toBe(true)

      const c = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL })
      await c.connect()
      let tenants, migrations
      try {
        tenants = await c.query('SELECT count(*)::int AS n FROM tenant')
        migrations = await c.query('SELECT count(*)::int AS n FROM schema_migrations')
      } finally {
        await c.end()
      }
      expect(tenants.rows[0].n).toBe(1) // 重启不会重复创建(需求 1.2)
      expect(migrations.rows[0].n).toBeGreaterThanOrEqual(1)
      if (round === 1) expect(out()).toContain('[迁移]')

      // 受限角色可连接
      const app = new pg.Client({ connectionString: env.DATABASE_APP_URL })
      await app.connect()
      await app.end()

      proc.kill('SIGTERM')
      await new Promise((r) => proc.on('exit', r))
    }
  })

  it('连接串用户名不是 erp_app → 启动失败并给出原因', async () => {
    const adminRoot = inject('pgAdminUrl')
    const { proc, out } = launch({
      DEPLOYMENT_MODE: 'standalone',
      DATABASE_ADMIN_URL: adminRoot,
      DATABASE_APP_URL: urlFor(adminRoot, 'postgres', 'someone', 'pw'),
      DATABASE_PLATFORM_URL: urlFor(adminRoot, 'postgres', 'erp_platform', 'pw'),
    })
    const code = await new Promise<number | null>((r) => proc.on('exit', r))
    expect(code).toBe(1)
    expect(out()).toContain('erp_app')
  })
})
