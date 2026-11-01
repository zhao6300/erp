import { createPublicKey, verify } from 'node:crypto'
import {
  AppError,
  ErrorDetail,
  LicenseInput,
  ModuleCode,
  MODULE_CODES,
  createTenantSchema,
  defaultEnabledModules,
} from '@erp/shared'
import type { AuthService } from '../core/auth/auth.service'
import { AuditService } from '../core/audit'
import type { ConfigPackageService } from '../config/packages.service'
import type { PrintService } from '../config/print.service'
import type { SettingsService } from '../config/settings.service'
import type { DeploymentMode } from '../config'
import { hashPassword, randomPassword } from '../core/crypto'
import type { Db, Tx } from '../core/db'
import { uuidv7 } from '../core/ids'
import { withAdvisoryLock } from '../core/migrate'
import { LicenseService } from '../core/license.service'
import type { PermissionService } from '../core/permission/permission.service'
import { addDays, todayStr, Clock } from '../core/time'
import type { ConfigCache } from '../core/cache'

export interface TenantRow {
  id: string
  name: string
  contact: string
  phone: string
  status: 'enabled' | 'disabled'
}

export interface CreateTenantResult {
  tenant: TenantRow
  adminPhone: string
  /** 仅当为该手机号新建账号时返回,须首次登录修改 */
  initialPassword?: string
  skippedConfig?: { category: string; key: string; reason: string }[]
}

const actor = { id: null, name: 'Platform_Admin', type: 'platform' as const }

export class TenantManager {
  constructor(
    private db: Db,
    private mode: DeploymentMode,
    private deps: {
      settings: SettingsService
      perms: PermissionService
      print: PrintService
      packages: ConfigPackageService
      license: LicenseService
      auth: AuthService
      audit: AuditService
      cache: ConfigCache
      clock: Clock
      tz: string
      adminUrl: string
      licensePublicKey?: string
    },
  ) {}

  /* ───────── 开通 ───────── */

  async createTenant(rawInput: unknown): Promise<CreateTenantResult> {
    if (this.mode === 'standalone') throw new AppError('STANDALONE_NO_NEW_TENANT')

    // 一次性返回全部字段问题(需求 1.7)
    const issues: ErrorDetail[] = []
    const parsed = createTenantSchema.safeParse(rawInput)
    if (!parsed.success) for (const i of parsed.error.issues) issues.push({ field: i.path.join('.') || 'body', reason: i.message })
    const input = parsed.success ? parsed.data : null
    if (input) {
      try {
        LicenseService.validate(input.license)
      } catch (e) {
        if (e instanceof AppError) issues.push(...(e.details ?? []).map((d) => ({ ...d, field: `license.${d.field}` })))
      }
    }
    const name = input?.name ?? (typeof (rawInput as any)?.name === 'string' ? (rawInput as any).name.trim() : '')
    if (name && (await this.db.withPlatform((tx) => tx.maybeOne('SELECT 1 FROM tenant WHERE name=$1', [name])))) issues.push({ field: 'name', reason: '企业名称已存在' })
    if (issues.length) throw new AppError('VALIDATION_FAILED', `提交的租户信息有 ${issues.length} 项未通过校验`, issues)
    const v = input!

    try {
      const result = await this.db.withPlatform(async (tx) => {
        let pkgText: string | null = null
        if (v.configPackageId) {
          const p = await tx.maybeOne('SELECT content, status FROM config_package WHERE id=$1', [v.configPackageId])
          if (!p || p.status !== 'available') throw new AppError('VALIDATION_FAILED', '所选配置包不存在或已不可用', [{ field: 'configPackageId', reason: 'Config_Package 不可用' }])
          pkgText = typeof p.content === 'string' ? p.content : JSON.stringify(p.content)
        }
        return this.provision(tx, { name: v.name, contact: v.contact, phone: v.phone, license: v.license, pkgText, configPackageId: v.configPackageId })
      })
      return result
    } catch (e) {
      if (e instanceof AppError) throw e
      // 其中任一步失败已整体回滚,不留下任何部分创建的数据
      throw new AppError('INTERNAL_ERROR', `开通失败,已回滚:${(e as Error).message}`)
    }
  }

  /** 在给定平台事务内原子创建 Tenant 及其全部初始数据 */
  async provision(tx: Tx, p: { name: string; contact: string; phone: string; license: LicenseInput; pkgText?: string | null; configPackageId?: string; adminPassword?: string; id?: string }): Promise<CreateTenantResult> {
    const tenantId = p.id ?? uuidv7()
    await tx.query('INSERT INTO tenant (id, name, contact, phone, config_package_id) VALUES ($1,$2,$3,$4,$5)', [tenantId, p.name, p.contact, p.phone, p.configPackageId ?? null])
    await this.deps.license.save(tx, tenantId, p.license)
    await this.deps.settings.seedDefaults(tx, tenantId)
    await this.deps.perms.seedTemplates(tx, tenantId)
    await this.deps.print.seedDefaults(tx, tenantId)

    // 默认 Fund_Account 与 Warehouse
    await tx.query(`INSERT INTO fund_account (id, tenant_id, name, type) VALUES ($1,$2,'现金','cash')`, [uuidv7(), tenantId])
    await tx.query(`INSERT INTO warehouse (id, tenant_id, code, name) VALUES ($1,$2,'WH001','主仓库')`, [uuidv7(), tenantId])

    // Tenant_Admin:手机号已有账号则只建立成员关系,不重置密码
    let account = await tx.maybeOne<{ id: string }>('SELECT id FROM account WHERE phone=$1 FOR UPDATE', [p.phone])
    let initialPassword: string | undefined
    if (!account) {
      initialPassword = p.adminPassword ?? randomPassword()
      const id = uuidv7()
      await tx.query('INSERT INTO account (id, phone, password_hash, must_change_password) VALUES ($1,$2,$3,true)', [id, p.phone, await hashPassword(initialPassword)])
      account = { id }
    }
    await tx.query('INSERT INTO tenant_user (id, tenant_id, account_id, name, is_tenant_admin) VALUES ($1,$2,$3,$4,true)', [uuidv7(), tenantId, account.id, p.contact])

    // 模块:未选配置包时启用全部已授权模块(需求 4.8);选择配置包时在同一原子操作内应用
    let skipped: CreateTenantResult['skippedConfig']
    for (const m of MODULE_CODES) await tx.query('INSERT INTO tenant_module (tenant_id, module, enabled) VALUES ($1,$2,false)', [tenantId, m])
    if (p.pkgText) {
      const r = await this.deps.packages.apply(tx, tenantId, p.pkgText, p.license.modules, actor)
      skipped = r.skipped
      // 配置包没有声明模块开关时,按授权启用,避免出现全部关闭的租户
      const any = await tx.maybeOne(`SELECT 1 FROM tenant_module WHERE tenant_id=$1 AND enabled`, [tenantId])
      if (!any) await tx.query('UPDATE tenant_module SET enabled=true WHERE tenant_id=$1 AND module = ANY($2)', [tenantId, defaultEnabledModules(p.license.modules)])
    } else {
      await tx.query('UPDATE tenant_module SET enabled=true WHERE tenant_id=$1 AND module = ANY($2)', [tenantId, defaultEnabledModules(p.license.modules)])
    }
    await this.deps.audit.write(tx, { tenantId, actorType: 'platform', actorName: 'Platform_Admin', client: 'system', action: 'tenant.create', objectType: 'tenant', objectId: tenantId, objectNo: p.name, after: { name: p.name, contact: p.contact, phone: p.phone } })
    return { tenant: { id: tenantId, name: p.name, contact: p.contact, phone: p.phone, status: 'enabled' }, adminPhone: p.phone, initialPassword, skippedConfig: skipped }
  }

  /* ───────── 停用 / 启用 ───────── */

  /** 停用:全部会话令牌立即失效(纪元 +1),业务数据保持不变(需求 1.5) */
  async disableTenant(tenantId: string): Promise<void> {
    await this.db.withPlatform(async (tx) => {
      const t = await tx.maybeOne('SELECT status FROM tenant WHERE id=$1 FOR UPDATE', [tenantId])
      if (!t) throw new AppError('NOT_FOUND')
      if (t.status === 'disabled') return
      await tx.query(`UPDATE tenant SET status='disabled' WHERE id=$1`, [tenantId])
      await this.deps.auth.revokeTenant(tx, tenantId)
      await this.deps.audit.write(tx, { tenantId, actorType: 'platform', actorName: 'Platform_Admin', client: 'system', action: 'tenant.disable', objectType: 'tenant', objectId: tenantId, before: { status: 'enabled' }, after: { status: 'disabled' } })
    })
  }

  /** 重新启用:恢复启用状态 User 的登录能力;停用时失效的令牌保持失效(纪元不回退;需求 1.6) */
  async enableTenant(tenantId: string): Promise<void> {
    await this.db.withPlatform(async (tx) => {
      const t = await tx.maybeOne('SELECT status FROM tenant WHERE id=$1 FOR UPDATE', [tenantId])
      if (!t) throw new AppError('NOT_FOUND')
      if (t.status === 'enabled') return
      await tx.query(`UPDATE tenant SET status='enabled' WHERE id=$1`, [tenantId])
      await this.deps.audit.write(tx, { tenantId, actorType: 'platform', actorName: 'Platform_Admin', client: 'system', action: 'tenant.enable', objectType: 'tenant', objectId: tenantId, before: { status: 'disabled' }, after: { status: 'enabled' } })
    })
  }

  async list(): Promise<(TenantRow & { createdAt: string })[]> {
    return this.db.withPlatform(async (tx) => (await tx.rows('SELECT id, name, contact, phone, status, created_at FROM tenant ORDER BY created_at')).map((r) => ({ id: r.id, name: r.name, contact: r.contact, phone: r.phone, status: r.status, createdAt: r.created_at.toISOString() })))
  }

  /* ───────── License ───────── */

  /** SaaS:直接编辑并保存。独立部署:须通过平台方签发的 License 文件(Ed25519 签名)导入 */
  async saveLicense(tenantId: string, input: unknown): Promise<{ license: unknown; disabledModules: ModuleCode[] }> {
    if (this.mode === 'standalone') throw new AppError('VALIDATION_FAILED', '独立部署模式须导入平台方签发的 License 文件', [{ field: 'license', reason: '请使用 License 文件导入' }])
    return this.db.withPlatform(async (tx) => {
      const t = await tx.maybeOne('SELECT 1 FROM tenant WHERE id=$1 FOR UPDATE', [tenantId])
      if (!t) throw new AppError('NOT_FOUND')
      const before = await tx.maybeOne('SELECT expire_date, modules, max_users, max_warehouses FROM license WHERE tenant_id=$1', [tenantId])
      const r = await this.deps.license.save(tx, tenantId, input)
      await this.deps.audit.write(tx, { tenantId, actorType: 'platform', actorName: 'Platform_Admin', client: 'system', action: 'license.update', objectType: 'license', objectId: tenantId, before, after: r.license })
      return r
    })
  }

  /** 验证并导入签名的 License 文件:{ payload: base64(json), signature: base64 } */
  async importLicenseFile(tenantId: string, fileText: string): Promise<{ license: unknown }> {
    if (!this.deps.licensePublicKey) throw new AppError('VALIDATION_FAILED', '未配置 License 验证公钥', [{ field: 'license', reason: '未配置公钥' }])
    let file: { payload: string; signature: string }
    try {
      file = JSON.parse(fileText)
    } catch {
      throw new AppError('VALIDATION_FAILED', 'License 文件格式不正确', [{ field: 'license', reason: '不是合法的 License 文件' }])
    }
    const data = Buffer.from(file.payload ?? '', 'base64')
    const ok = (() => {
      try {
        return verify(null, data, createPublicKey(this.deps.licensePublicKey!), Buffer.from(file.signature ?? '', 'base64'))
      } catch {
        return false
      }
    })()
    if (!ok) throw new AppError('VALIDATION_FAILED', 'License 文件签名无效,可能已被修改', [{ field: 'license', reason: '签名校验失败' }])
    const payload = JSON.parse(data.toString('utf8'))
    return this.db.withPlatform(async (tx) => {
      const r = await this.deps.license.save(tx, tenantId, payload)
      await tx.query('UPDATE license SET signature=$2 WHERE tenant_id=$1', [tenantId, file.signature])
      await this.deps.audit.write(tx, { tenantId, actorType: 'platform', client: 'system', action: 'license.import', objectType: 'license', objectId: tenantId, after: r.license })
      return { license: r.license }
    })
  }

  /* ───────── 独立部署 ───────── */

  /**
   * 独立部署模式启动时:不存在任何 Tenant 则原子创建唯一的默认 Tenant(需求 1.2)。
   * 持有 advisory lock 检查与创建,并发启动也只会创建一个。初始密码只打印到启动日志。
   */
  async bootstrapStandalone(opts: { name: string; phone: string; log?: (m: string) => void }): Promise<{ created: boolean; initialPassword?: string }> {
    if (this.mode !== 'standalone') return { created: false }
    return withAdvisoryLock(this.deps.adminUrl, async () => {
      const exists = await this.db.withPlatform((tx) => tx.maybeOne('SELECT 1 FROM tenant LIMIT 1'))
      if (exists) return { created: false }
      const today = todayStr(this.deps.tz, this.deps.clock())
      const r = await this.db.withPlatform((tx) =>
        this.provision(tx, {
          name: opts.name,
          contact: '管理员',
          phone: opts.phone,
          // 试用授权 30 天;正式授权须导入平台方签发的 License 文件
          license: { expireDate: addDays(today, 30), modules: [...MODULE_CODES], maxUsers: 5, maxWarehouses: 3 },
        }),
      )
      opts.log?.(`[standalone] 已创建默认企业“${opts.name}”,管理员手机号 ${opts.phone},初始密码:${r.initialPassword},首次登录须修改`)
      return { created: true, initialPassword: r.initialPassword }
    })
  }

  /* ───────── 插件启停(需求 23.3) ───────── */

  async setPlugin(tenantId: string, pluginName: string, enabled: boolean, config: Record<string, unknown> = {}): Promise<void> {
    await this.db.withPlatform(async (tx) => {
      if (!(await tx.maybeOne('SELECT 1 FROM tenant WHERE id=$1', [tenantId]))) throw new AppError('NOT_FOUND')
      await tx.query(
        `INSERT INTO tenant_plugin (tenant_id, plugin_name, enabled, config) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, plugin_name) DO UPDATE SET enabled=$3, config=CASE WHEN $5 THEN $4 ELSE tenant_plugin.config END`,
        [tenantId, pluginName, enabled, JSON.stringify(config), Object.keys(config).length > 0],
      )
      await this.deps.audit.write(tx, { tenantId, actorType: 'platform', client: 'system', action: enabled ? 'plugin.enable' : 'plugin.disable', objectType: 'plugin', objectId: pluginName })
      tx.onCommit(() => this.deps.cache.invalidate(`plug:${tenantId}`))
    })
  }
}

