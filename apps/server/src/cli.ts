import { createInterface } from 'node:readline/promises'
import { loadConfig } from './config'
import { runMigrations } from './core/migrate'
import { RestoreError, restoreBackup, runBackup } from './ops/backup'

/**
 * erp-cli:运维命令行
 *   erp-cli backup                  立即备份
 *   erp-cli restore <file>          从备份文件恢复(需输入 RESTORE 确认)
 *   erp-cli migrate                 执行待执行迁移
 */
async function main() {
  const [cmd, arg] = process.argv.slice(2)
  const config = loadConfig()
  switch (cmd) {
    case 'migrate': {
      const r = await runMigrations(config.DATABASE_ADMIN_URL)
      console.log(r.applied.length ? `已执行: ${r.applied.join(', ')}` : '无待执行迁移')
      return
    }
    case 'backup': {
      const m = await runBackup({ dir: config.BACKUP_DIR, databaseUrl: config.DATABASE_ADMIN_URL, secret: config.BACKUP_HMAC_SECRET })
      console.log(`备份完成: ${m.file} (sha256 ${m.sha256})`)
      return
    }
    case 'restore': {
      if (!arg) throw new RestoreError('用法: erp-cli restore <备份文件>')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const confirm = await rl.question('恢复将覆盖当前全部数据,请先停止对外服务。输入 RESTORE 确认: ')
      rl.close()
      const m = await restoreBackup({
        file: arg,
        databaseUrl: config.DATABASE_ADMIN_URL,
        secret: config.BACKUP_HMAC_SECRET,
        confirm,
        migrate: () => runMigrations(config.DATABASE_ADMIN_URL),
      })
      console.log(`恢复完成: ${m.file}`)
      return
    }
    default:
      console.log('用法: erp-cli <backup|restore <file>|migrate>')
      process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e instanceof RestoreError ? `[恢复失败] ${e.message}` : e)
  process.exit(1)
})
