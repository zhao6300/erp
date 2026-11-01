import { AppError, LicenseInput, ModuleCode, enabledAfterLicenseChange, licenseSchema } from '@erp/shared'
import type { Db, Tx } from './db'
import type { ConfigCache } from './cache'
import { Clock, addDays, diffDays, startOfDayUtc, todayStr } from './time'

export interface LicenseRow {
  tenantId: string
  expireDate: string
  modules: ModuleCode[]
  maxUsers: number
  maxWarehouses: number
}

const rowToLicense = (r: any): LicenseRow => ({ tenantId: r.tenant_id, expireDate: r.expire_date, modules: r.modules, maxUsers: r.max_users, maxWarehouses: r.max_warehouses })

export class LicenseService {
  constructor(
    private db: Db,
    private cache: ConfigCache,
    private clock: Clock,
    private tz: string,
  ) {}

  async get(tenantId: string): Promise<LicenseRow | null> {
    return this.cache.get(`lic:${tenantId}`, () =>
      this.db.withTenant(tenantId, async (tx) => {
        const r = await tx.maybeOne('SELECT * FROM license WHERE tenant_id=$1', [tenantId])
        return r ? rowToLicense(r) : null
      }),
    )
  }

  /** 过期判定:当前时间晚于截止日期当天 23:59:59(服务器时区)。过期日当天整天仍有效(需求 3.5) */
  isExpired(l: Pick<LicenseRow, 'expireDate'>, now: Date = this.clock()): boolean {
    const boundary = startOfDayUtc(addDays(l.expireDate, 1), this.tz) // 次日 00:00:00
    return now.getTime() >= boundary.getTime()
  }

  /** 剩余天数 = 截止日期 − 当前日期(自然日);0–15 天时提醒 Tenant_Admin(需求 3.4) */
  reminder(l: Pick<LicenseRow, 'expireDate'>): { expireDate: string; daysLeft: number } | null {
    const daysLeft = diffDays(todayStr(this.tz, this.clock()), l.expireDate)
    return daysLeft >= 0 && daysLeft <= 15 ? { expireDate: l.expireDate, daysLeft } : null
  }

  async assertWritable(tenantId: string): Promise<void> {
    const l = await this.get(tenantId)
    if (!l || this.isExpired(l)) throw new AppError('LICENSE_EXPIRED')
  }

  async assertModuleLicensed(tenantId: string, module: ModuleCode): Promise<void> {
    const l = await this.get(tenantId)
    if (!l || !l.modules.includes(module)) throw new AppError('MODULE_NOT_LICENSED')
  }

  static validate(input: unknown): LicenseInput {
    const r = licenseSchema.safeParse(input)
    if (!r.success) {
      throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.') || 'license', reason: i.message })))
    }
    // 日期必须是有效日历日期
    const [y, m, d] = r.data.expireDate.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
      throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'expireDate', reason: '截止日期不是有效日期' }])
    return r.data
  }

  /** 平台事务内写入 License;移除已启用模块时同事务关闭该模块及依赖方(需求 3.6、3.8、4.9)。调用方提交后须 invalidate */
  async save(tx: Tx, tenantId: string, input: unknown): Promise<{ license: LicenseRow; disabledModules: ModuleCode[] }> {
    const v = LicenseService.validate(input)
    const old = await tx.maybeOne('SELECT tenant_id FROM license WHERE tenant_id=$1 FOR UPDATE', [tenantId])
    if (old)
      await tx.query('UPDATE license SET expire_date=$2, modules=$3, max_users=$4, max_warehouses=$5, updated_at=now() WHERE tenant_id=$1', [tenantId, v.expireDate, v.modules, v.maxUsers, v.maxWarehouses])
    else await tx.query('INSERT INTO license (tenant_id, expire_date, modules, max_users, max_warehouses) VALUES ($1,$2,$3,$4,$5)', [tenantId, v.expireDate, v.modules, v.maxUsers, v.maxWarehouses])

    // 平台连接绕过 RLS,必须显式按租户过滤
    const enabledOfTenant = (await tx.rows<{ module: ModuleCode }>('SELECT module FROM tenant_module WHERE tenant_id=$1 AND enabled', [tenantId])).map((r) => r.module)
    const keep = enabledAfterLicenseChange(enabledOfTenant, v.modules)
    const disabled = enabledOfTenant.filter((m) => !keep.includes(m))
    if (disabled.length > 0) await tx.query('UPDATE tenant_module SET enabled=false WHERE tenant_id=$1 AND module = ANY($2)', [tenantId, disabled])
    const row = await tx.one('SELECT * FROM license WHERE tenant_id=$1', [tenantId])
    tx.onCommit(() => this.invalidate(tenantId))
    return { license: rowToLicense(row), disabledModules: disabled }
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.cache.invalidate(`lic:${tenantId}`)
    await this.cache.invalidate(`mod:${tenantId}`)
  }

  /**
   * 用户数/仓库数上限:锁定 License 行后计数,防止并发超额(需求 3.2、3.3、3.9)。
   * 创建或重新启用时调用;调低上限不影响现有启用项,仅阻止后续创建/启用。
   */
  async assertCanActivate(tx: Tx, tenantId: string, kind: 'users' | 'warehouses'): Promise<void> {
    const l = await tx.maybeOne('SELECT max_users, max_warehouses FROM license WHERE tenant_id=$1 FOR UPDATE', [tenantId])
    if (!l) throw new AppError('LICENSE_EXPIRED')
    if (kind === 'users') {
      const n = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_user WHERE tenant_id=$1 AND status='enabled'`, [tenantId])).n
      if (n >= l.max_users) throw new AppError('LICENSE_LIMIT_USERS')
    } else {
      const n = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM warehouse WHERE tenant_id=$1 AND enabled`, [tenantId])).n
      if (n >= l.max_warehouses) throw new AppError('LICENSE_LIMIT_WAREHOUSES')
    }
  }
}
