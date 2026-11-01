import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Container } from '../container'
import { hmac, safeEqual } from '../core/crypto'
import { listMigrations } from '../core/migrate'

export const ERP_VERSION = '0.1.0'
export const BACKUP_RETENTION_DAYS = 30
export const RETRY_INTERVAL_MS = 20 * 60_000 // 60 分钟内最多重试 3 次(需求 22.9)
export const MAX_RETRIES = 3

export interface BackupManifest {
  file: string
  sha256: string
  erpVersion: string
  migrationVersion: string
  createdAt: string
  /** HMAC(安装标识密钥, file|sha256|erpVersion|migrationVersion),证明备份由本系统生成 */
  signature: string
}

export class RestoreError extends Error {}

const signaturePayload = (m: Omit<BackupManifest, 'signature'>) => `${m.file}|${m.sha256}|${m.erpVersion}|${m.migrationVersion}`

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => reject(new Error(`${cmd} 无法执行: ${e.message}`)))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}: ${err.trim().slice(0, 500)}`))))
  })
}

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`

/** 执行一次备份:pg_dump -Fc + manifest.json(SHA-256、ERP 版本、迁移版本、HMAC 签名) */
export async function runBackup(opts: { dir: string; databaseUrl: string; secret: string; now?: Date; dump?: (file: string) => Promise<void> }): Promise<BackupManifest> {
  mkdirSync(opts.dir, { recursive: true })
  const now = opts.now ?? new Date()
  const file = `backup-${stamp(now)}.dump`
  const full = path.join(opts.dir, file)
  try {
    await (opts.dump ?? ((f) => run('pg_dump', ['-Fc', '-f', f, '--dbname', opts.databaseUrl])))(full)
    const migs = listMigrations()
    const base = { file, sha256: await sha256File(full), erpVersion: ERP_VERSION, migrationVersion: migs[migs.length - 1]?.name ?? '', createdAt: now.toISOString() }
    const manifest: BackupManifest = { ...base, signature: hmac(opts.secret, signaturePayload(base)) }
    writeFileSync(path.join(opts.dir, file.replace(/\.dump$/, '.manifest.json')), JSON.stringify(manifest, null, 2))
    return manifest
  } catch (e) {
    rmSync(full, { force: true }) // 不留下不完整的备份文件
    throw e
  }
}

/** 仅在备份成功后才清理 30 天以前的备份;失败时不删除任何已有备份(需求 22.5、22.9) */
export function pruneBackups(dir: string, now: Date, days = BACKUP_RETENTION_DAYS): string[] {
  const removed: string[] = []
  const cutoff = now.getTime() - days * 86_400_000
  for (const f of readdirSync(dir)) {
    if (!/^backup-\d{8}-\d{4}\.(dump|manifest\.json)$/.test(f)) continue
    if (statSync(path.join(dir, f)).mtimeMs < cutoff) {
      rmSync(path.join(dir, f), { force: true })
      removed.push(f)
    }
  }
  return removed
}

/** 备份时间窗口:服务器本地时间 00:00–06:00 */
export const inBackupWindow = (d: Date) => d.getHours() >= 0 && d.getHours() < 6

/**
 * 每日备份调度:窗口内、当日未成功过则执行;失败记录日志并每 20 分钟重试,最多 3 次(需求 22.5、22.9)。
 */
export function startBackupScheduler(c: Container, hooks: { tickMs?: number; run?: typeof runBackup } = {}): () => void {
  const state = { lastSuccessDay: '', failures: 0, retryAfter: 0, failedDay: '' }
  const tick = async () => {
    const now = c.clock()
    const day = now.toISOString().slice(0, 10)
    if (!inBackupWindow(now) || state.lastSuccessDay === day) return
    if (state.failedDay !== day) {
      state.failedDay = day
      state.failures = 0
      state.retryAfter = 0
    }
    if (state.failures > MAX_RETRIES || now.getTime() < state.retryAfter) return
    try {
      await (hooks.run ?? runBackup)({ dir: c.config.BACKUP_DIR, databaseUrl: c.config.DATABASE_ADMIN_URL, secret: c.config.BACKUP_HMAC_SECRET, now })
      state.lastSuccessDay = day
      pruneBackups(c.config.BACKUP_DIR, now)
    } catch (e) {
      state.failures++
      state.retryAfter = now.getTime() + RETRY_INTERVAL_MS
      console.error(`[备份失败] ${now.toISOString()} 第 ${state.failures} 次: ${(e as Error).message}${state.failures <= MAX_RETRIES ? ',20 分钟后重试' : ',已达到最大重试次数'}`)
    }
  }
  const timer = setInterval(() => void tick(), hooks.tickMs ?? 60_000)
  void tick()
  return () => clearInterval(timer)
}

/** 校验备份:文件存在、manifest 签名与 SHA-256 一致;任何一项失败都拒绝恢复且数据库不动(需求 22.10) */
export async function verifyBackup(file: string, secret: string): Promise<BackupManifest> {
  if (!existsSync(file)) throw new RestoreError(`备份文件不存在: ${file}`)
  const manifestPath = file.replace(/\.dump$/, '.manifest.json')
  if (!existsSync(manifestPath)) throw new RestoreError('缺少 manifest.json,该文件不是由本系统生成的备份')
  let m: BackupManifest
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new RestoreError('manifest.json 已损坏')
  }
  const expected = hmac(secret, signaturePayload(m))
  if (typeof m.signature !== 'string' || !safeEqual(m.signature, expected)) throw new RestoreError('manifest 签名无效,该文件不是由本系统生成的备份')
  if (m.file !== path.basename(file)) throw new RestoreError('manifest 与备份文件不匹配')
  if ((await sha256File(file)) !== m.sha256) throw new RestoreError('备份文件已损坏(SHA-256 校验失败)')
  return m
}

/**
 * 命令行恢复:校验 → 要求输入 RESTORE 确认 → pg_restore --clean --single-transaction(失败自动回滚)→ 迁移到当前版本。
 * 恢复前应由运维停止对外服务。
 */
export async function restoreBackup(opts: { file: string; databaseUrl: string; secret: string; confirm: string; restore?: (file: string) => Promise<void>; migrate?: () => Promise<unknown> }): Promise<BackupManifest> {
  const m = await verifyBackup(opts.file, opts.secret)
  if (opts.confirm !== 'RESTORE') throw new RestoreError('未确认:请输入 RESTORE 以继续恢复')
  await (opts.restore ?? ((f) => run('pg_restore', ['--clean', '--if-exists', '--single-transaction', '--no-owner', '--dbname', opts.databaseUrl, f])))(opts.file)
  await opts.migrate?.()
  return m
}
