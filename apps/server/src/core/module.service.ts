import { AppError, MODULE_CODES, MODULE_LABEL, ModuleCode, disableModule, enableModule } from '@erp/shared'
import { AuditService } from './audit'
import type { ConfigCache } from './cache'
import type { Ctx } from './context'
import type { Db, Tx } from './db'
import type { LicenseService } from './license.service'

/** Module_Registry:模块启用状态与依赖(需求 4) */
export class ModuleService {
  constructor(
    private db: Db,
    private cache: ConfigCache,
    private license: LicenseService,
    private audit: AuditService,
  ) {}

  async enabled(tenantId: string): Promise<ModuleCode[]> {
    return this.cache.get(`mod:${tenantId}`, () =>
      this.db.withTenant(tenantId, async (tx) => (await tx.rows<{ module: ModuleCode }>('SELECT module FROM tenant_module WHERE enabled')).map((r) => r.module)),
    )
  }

  /** ModuleGuard:未授权返回 MODULE_NOT_LICENSED,已授权但关闭返回 MODULE_DISABLED(需求 3.7、4.6) */
  async assertEnabled(tenantId: string, module: ModuleCode): Promise<void> {
    await this.license.assertModuleLicensed(tenantId, module)
    if (!(await this.enabled(tenantId)).includes(module)) throw new AppError('MODULE_DISABLED')
  }

  /** 客户端菜单:已剔除未授权与未启用的模块(需求 3.7、4.5) */
  async visible(tenantId: string): Promise<ModuleCode[]> {
    const l = await this.license.get(tenantId)
    const en = await this.enabled(tenantId)
    return en.filter((m) => l?.modules.includes(m))
  }

  /** 报表可用性:report 启用且该报表数据来源模块均启用(需求 4.1) */
  reportAvailable(enabled: ModuleCode[], sources: ModuleCode[]): boolean {
    return enabled.includes('report') && sources.every((s) => enabled.includes(s))
  }

  async list(tx: Tx): Promise<{ module: ModuleCode; label: string; enabled: boolean; licensed: boolean }[]> {
    const lic = await tx.maybeOne<{ modules: ModuleCode[] }>('SELECT modules FROM license')
    const en = new Set((await tx.rows<{ module: ModuleCode }>('SELECT module FROM tenant_module WHERE enabled')).map((r) => r.module))
    return MODULE_CODES.map((m) => ({ module: m, label: MODULE_LABEL[m], enabled: en.has(m), licensed: !!lic?.modules.includes(m) }))
  }

  async enable(tx: Tx, ctx: Ctx, target: ModuleCode): Promise<{ enabled: ModuleCode[]; autoEnabled: ModuleCode[] }> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const lic = await tx.one<{ modules: ModuleCode[] }>('SELECT modules FROM license WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId])
    const cur = (await tx.rows<{ module: ModuleCode }>('SELECT module FROM tenant_module WHERE enabled')).map((r) => r.module)
    const r = enableModule(cur, lic.modules, target)
    if (!r.ok) {
      throw new AppError('MODULE_NOT_LICENSED', `该模块未授权:${r.unlicensed.map((m) => MODULE_LABEL[m]).join('、')}`, r.unlicensed.map((m) => ({ field: 'module', reason: '未授权', module: m })))
    }
    for (const m of [target, ...r.autoEnabled]) {
      await tx.query(`INSERT INTO tenant_module (tenant_id, module, enabled) VALUES ($1,$2,true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled=true`, [ctx.tenantId, m])
    }
    tx.onCommit(() => this.invalidate(ctx.tenantId))
    await this.audit.log(tx, ctx, 'module.enable', { type: 'module', id: target, no: target, before: { enabled: cur }, after: { enabled: r.enabled } })
    return { enabled: r.enabled, autoEnabled: r.autoEnabled }
  }

  async disable(tx: Tx, ctx: Ctx, target: ModuleCode): Promise<{ enabled: ModuleCode[] }> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const cur = (await tx.rows<{ module: ModuleCode }>('SELECT module FROM tenant_module WHERE enabled')).map((r) => r.module)
    const r = disableModule(cur, target)
    if (!r.ok) {
      throw new AppError('MODULE_DEPENDENCY', `以下已启用模块依赖该模块:${r.dependents.map((m) => MODULE_LABEL[m]).join('、')}`, r.dependents.map((m) => ({ field: 'module', reason: '被依赖', module: m })))
    }
    // 关闭不删除任何业务数据
    await tx.query('UPDATE tenant_module SET enabled=false WHERE tenant_id=$1 AND module=$2', [ctx.tenantId, target])
    tx.onCommit(() => this.invalidate(ctx.tenantId))
    await this.audit.log(tx, ctx, 'module.disable', { type: 'module', id: target, no: target, before: { enabled: cur }, after: { enabled: r.enabled } })
    return { enabled: r.enabled }
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.cache.invalidate(`mod:${tenantId}`)
  }
}
