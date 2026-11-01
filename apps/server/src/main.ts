import { ConfigError, loadConfig } from './config'
import { createContainer } from './container'
import { startWorker } from './worker'
import { buildApp } from './http/app'
import { ensurePlatformAdmin } from './http/platform-routes'
import { loadPlugins } from './core/plugin-loader'
import { MigrationError, provisionRolesFromUrls, runMigrations } from './core/migrate'

/**
 * 启动流程(设计:部署模式):
 * 1. 校验环境变量;DEPLOYMENT_MODE 缺失或非法 → 输出错误并以非零码退出,不监听端口(需求 1.8)
 * 2. 在单个事务内执行全部待执行迁移;失败整体回滚,输出失败的迁移文件名并退出(需求 23.5、23.8)
 * 3. 独立部署模式:持锁检查 Tenant 数量,为 0 则原子创建默认 Tenant(需求 1.2)
 * 4. 开始监听
 */
async function main() {
  let config
  try {
    config = loadConfig()
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[启动失败] ${e.message}`)
      process.exit(1)
    }
    throw e
  }

  try {
    await provisionRolesFromUrls(config.DATABASE_ADMIN_URL, config.DATABASE_APP_URL, config.DATABASE_PLATFORM_URL)
  } catch (e) {
    console.error(`[启动失败] 数据库角色初始化失败: ${(e as Error).message}`)
    process.exit(1)
  }

  try {
    const r = await runMigrations(config.DATABASE_ADMIN_URL)
    if (r.applied.length) console.log(`[迁移] 已执行: ${r.applied.join(', ')}`)
  } catch (e) {
    if (e instanceof MigrationError) console.error(`[启动失败] ${e.message}。数据库已回滚到迁移前状态,不以新版本受理请求。`)
    else console.error('[启动失败] 迁移无法执行', e)
    process.exit(1)
  }

  const c = await createContainer(config)
  await loadPlugins(c, config.PLUGINS_DIR)

  if (config.DEPLOYMENT_MODE === 'standalone') {
    await c.tenants.bootstrapStandalone({ name: config.STANDALONE_TENANT_NAME, phone: config.STANDALONE_ADMIN_PHONE, log: (m) => console.log(m) })
  } else if (process.env.PLATFORM_ADMIN_USERNAME && process.env.PLATFORM_ADMIN_PASSWORD) {
    if (await ensurePlatformAdmin(c, process.env.PLATFORM_ADMIN_USERNAME, process.env.PLATFORM_ADMIN_PASSWORD)) console.log('[启动] 已创建平台管理员')
  }

  const roles = config.ROLE === 'all' ? ['api', 'worker'] : [config.ROLE]
  const stops: (() => Promise<void>)[] = []
  if (roles.includes('api')) {
    const app = await buildApp(c, { logger: true })
    await app.listen({ port: config.PORT, host: '0.0.0.0' })
    stops.push(() => app.close())
  }
  if (roles.includes('worker')) stops.push(await startWorker(c))

  const shutdown = async () => {
    for (const s of stops) await s().catch(() => {})
    await c.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
