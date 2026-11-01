import { ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'

/**
 * 启动一个真实的 PostgreSQL 16 进程用于集成测试(沙箱无 Docker)。
 * root 下 PostgreSQL 拒绝运行,因此降权到 nobody。设置 TEST_DATABASE_ADMIN_URL 可改用外部数据库
 * (例如 CI 里由 Testcontainers 启动的 postgres:16)。
 */
export interface PgServer {
  adminUrl: string
  stop(): Promise<void>
}

function platformPackage(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux'
  return `@embedded-postgres/${plat}-${arch}`
}

function binDir(): string {
  const req = createRequire(import.meta.url)
  const epPath = req.resolve('embedded-postgres')
  const inner = createRequire(epPath)
  // 平台包的 exports 不暴露 package.json,解析入口文件后向上找到包目录
  const entry = inner.resolve(platformPackage())
  let dir = path.dirname(entry)
  while (!existsSync(path.join(dir, 'native', 'bin')) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  return path.join(dir, 'native', 'bin')
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

async function waitReady(url: string, proc: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`postgres exited early (${proc.exitCode}):\n${logs()}`)
    const c = new pg.Client({ connectionString: url })
    try {
      await c.connect()
      await c.end()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw new Error('postgres did not become ready:\n' + logs())
}

export async function startPgServer(): Promise<PgServer> {
  if (process.env.TEST_DATABASE_ADMIN_URL) return { adminUrl: process.env.TEST_DATABASE_ADMIN_URL, stop: async () => {} }

  const bin = binDir()
  const root = mkdtempSync(path.join(os.tmpdir(), 'erp-pg-'))
  const isRoot = process.getuid?.() === 0
  const ids = isRoot ? { uid: 65534, gid: 65534 } : {}
  const own = (p: string) => {
    if (isRoot) chownSync(p, 65534, 65534)
  }
  chmodSync(root, 0o755)
  own(root)
  const data = path.join(root, 'data')
  const sock = path.join(root, 'sock')
  mkdirSync(sock)
  own(sock)
  const pw = path.join(root, 'pw')
  writeFileSync(pw, 'postgres')
  own(pw)

  const init = spawnSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', `--pwfile=${pw}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { ...ids, encoding: 'utf8' })
  if (init.status !== 0) throw new Error('initdb failed: ' + init.stderr + init.stdout)

  const port = await freePort()
  let log = ''
  const proc = spawn(
    path.join(bin, 'postgres'),
    ['-D', data, '-p', String(port), '-k', sock, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=300', '-c', 'log_min_messages=warning'],
    { ...ids, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  proc.stdout?.on('data', (d) => (log += d))
  proc.stderr?.on('data', (d) => (log += d))
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`
  await waitReady(adminUrl, proc, () => log)

  return {
    adminUrl,
    async stop() {
      proc.kill('SIGINT') // fast shutdown
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL')
          r()
        }, 10_000)
        proc.on('exit', () => {
          clearTimeout(t)
          r()
        })
      })
      rmSync(root, { recursive: true, force: true })
    },
  }
}
