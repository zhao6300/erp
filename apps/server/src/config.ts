import { z } from 'zod'

/** 环境变量校验。DEPLOYMENT_MODE 缺失或非法时启动失败(需求 1.1、1.8) */
export const DEPLOYMENT_MODES = ['saas', 'standalone'] as const
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number]

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const envSchema = z.object({
  DEPLOYMENT_MODE: z.enum(DEPLOYMENT_MODES),
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().default(3000),
  /** 迁移与初始化使用的管理员连接(拥有建表与建角色权限) */
  DATABASE_ADMIN_URL: z.string().min(1),
  /** 租户接口使用的受限连接(erp_app,无 BYPASSRLS) */
  DATABASE_APP_URL: z.string().min(1),
  /** 平台接口与登录前查询使用的连接(erp_platform,BYPASSRLS) */
  DATABASE_PLATFORM_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  TZ: z.string().default('Asia/Shanghai'),
  FILE_STORAGE_DIR: z.string().default('./data/files'),
  BACKUP_DIR: z.string().default('./data/backups'),
  /** 受信代理:仅信任这些来源设置的 X-Forwarded-Proto */
  TRUSTED_PROXIES: z.string().default('127.0.0.1,::1'),
  /** 独立部署:License 文件签名公钥(PEM, Ed25519) */
  LICENSE_PUBLIC_KEY: z.string().optional(),
  BACKUP_HMAC_SECRET: z.string().default('dev-only-change-me'),
  WECHAT_APPID: z.string().optional(),
  WECHAT_SECRET: z.string().optional(),
  PLUGINS_DIR: z.string().default('./plugins'),
  /** 默认的独立部署管理员手机号 */
  STANDALONE_ADMIN_PHONE: z.string().default('13800000000'),
  STANDALONE_TENANT_NAME: z.string().default('默认企业'),
})
export type AppConfig = z.infer<typeof envSchema>

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  if (!env.DEPLOYMENT_MODE || !(DEPLOYMENT_MODES as readonly string[]).includes(env.DEPLOYMENT_MODE)) {
    throw new ConfigError('Deployment_Mode 配置无效:DEPLOYMENT_MODE 须为 saas 或 standalone')
  }
  const r = envSchema.safeParse(env)
  if (!r.success) {
    throw new ConfigError('环境变量配置无效:' + r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '))
  }
  return r.data
}
