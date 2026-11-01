import { AppError, DataScope, EffectivePermission, FIELD_PERMS, RoleLike, hasPermission, mergeRoles, roleSchema } from '@erp/shared'
import type { Ctx } from '../context'
import type { Db, Tx } from '../db'
import { uuidv7 } from '../ids'
import type { Kv } from '../kv'
import { AuditService } from '../audit'
import { ROLE_TEMPLATES } from './catalog'

const permKey = (tenantUserId: string) => `perm:${tenantUserId}`

export interface RoleRow {
  id: string
  name: string
  is_template: boolean
  permissions: string[]
  data_scope: DataScope
}

/** 单据可见性判断所需的最小信息 */
export interface DocScopeInfo {
  docType: string
  createdBy?: string | null
  handlerId?: string | null
  warehouseIds: (string | null | undefined)[]
}

const WAREHOUSE_FREE_DOCS = ['receipt', 'payment', 'other_income', 'other_expense']

export class PermissionService {
  constructor(
    private db: Db,
    private kv: Kv,
    private audit: AuditService,
  ) {}

  /* ───────── 生效权限(Redis 缓存,变更时同步失效;需求 10.12) ───────── */

  async effective(tenantId: string, tenantUserId: string, isTenantAdmin: boolean): Promise<EffectivePermission> {
    if (isTenantAdmin) return mergeRoles([], true)
    const cached = await this.kv.get(permKey(tenantUserId))
    if (cached) return JSON.parse(cached) as EffectivePermission
    const roles = await this.db.withTenant(tenantId, (tx) =>
      tx.rows<RoleRow>(`SELECT r.id, r.name, r.is_template, r.permissions, r.data_scope FROM user_role ur JOIN role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id WHERE ur.tenant_user_id = $1`, [tenantUserId]),
    )
    const eff = mergeRoles(roles.map<RoleLike>((r) => ({ permissions: r.permissions, dataScope: r.data_scope })), false)
    await this.kv.set(permKey(tenantUserId), JSON.stringify(eff), 3600)
    return eff
  }

  async invalidateUser(tenantUserId: string): Promise<void> {
    await this.kv.del(permKey(tenantUserId))
  }

  private async invalidateRole(tx: Tx, roleId: string): Promise<void> {
    const users = await tx.rows<{ tenant_user_id: string }>('SELECT tenant_user_id FROM user_role WHERE role_id = $1', [roleId])
    await this.kv.del(...users.map((u) => permKey(u.tenant_user_id)))
  }

  /* ───────── 判定 ───────── */

  can(ctx: Pick<Ctx, 'perms'>, code: string): boolean {
    return hasPermission(ctx.perms, code)
  }

  require(ctx: Pick<Ctx, 'perms'>, code: string): void {
    if (!this.can(ctx, code)) throw new AppError('NO_PERMISSION')
  }

  canViewCost(ctx: Pick<Ctx, 'perms'>) {
    return this.can(ctx, FIELD_PERMS.cost)
  }
  canViewProfit(ctx: Pick<Ctx, 'perms'>) {
    return this.can(ctx, FIELD_PERMS.profit)
  }

  /* ───────── Data_Scope ───────── */

  /** 文档是否在 Data_Scope 内(需求 10.7、10.8、10.10) */
  docVisible(ctx: Pick<Ctx, 'perms' | 'tenantUserId'>, d: DocScopeInfo): boolean {
    const s = ctx.perms.dataScope
    if (ctx.perms.isAdmin || s.all) return true
    if (s.own && (d.createdBy === ctx.tenantUserId || d.handlerId === ctx.tenantUserId)) return true
    if (s.warehouseIds.length > 0) {
      if (WAREHOUSE_FREE_DOCS.includes(d.docType)) return true
      if (d.warehouseIds.some((w) => w && s.warehouseIds.includes(w))) return true
    }
    return false
  }

  assertDocVisible(ctx: Pick<Ctx, 'perms' | 'tenantUserId'>, d: DocScopeInfo): void {
    if (!this.docVisible(ctx, d)) throw new AppError('NO_DATA_PERMISSION')
  }

  /** 新建单据所选仓库须在 Data_Scope 内(需求 10.10) */
  assertWarehouseAllowed(ctx: Pick<Ctx, 'perms'>, warehouseIds: (string | null | undefined)[]): void {
    const s = ctx.perms.dataScope
    if (ctx.perms.isAdmin || s.all || s.own) return
    if (warehouseIds.some((w) => w && !s.warehouseIds.includes(w))) throw new AppError('NO_DATA_PERMISSION')
  }

  /**
   * 生成单据的 Data_Scope SQL 条件。报表与导出复用同一过滤器(需求 18.9、21.10)。
   * 参数会被追加到 params,返回形如 `(... )` 的片段。
   */
  documentFilter(ctx: Pick<Ctx, 'perms' | 'tenantUserId'>, alias: string, params: unknown[]): string {
    const s = ctx.perms.dataScope
    if (ctx.perms.isAdmin || s.all) return 'TRUE'
    const parts: string[] = []
    if (s.own) {
      params.push(ctx.tenantUserId)
      parts.push(`(${alias}.created_by = $${params.length} OR ${alias}.handler_id = $${params.length})`)
    }
    if (s.warehouseIds.length > 0) {
      params.push(s.warehouseIds)
      const p = `$${params.length}::uuid[]`
      parts.push(
        `(${alias}.doc_type IN ('receipt','payment','other_income','other_expense') OR ${alias}.warehouse_id = ANY(${p}) OR ${alias}.to_warehouse_id = ANY(${p}) OR EXISTS (SELECT 1 FROM document_line sl WHERE sl.tenant_id = ${alias}.tenant_id AND sl.document_id = ${alias}.id AND sl.warehouse_id = ANY(${p})))`,
      )
    }
    return parts.length ? `(${parts.join(' OR ')})` : 'FALSE'
  }

  /** 库存类查询(余额、流水):仅指定仓库范围生效;本人单据范围不限制库存可见性 */
  stockFilter(ctx: Pick<Ctx, 'perms'>, warehouseCol: string, params: unknown[]): string {
    const s = ctx.perms.dataScope
    if (ctx.perms.isAdmin || s.all || s.own) return 'TRUE'
    if (s.warehouseIds.length === 0) return 'FALSE'
    params.push(s.warehouseIds)
    return `${warehouseCol} = ANY($${params.length}::uuid[])`
  }

  /* ───────── 角色管理(Tenant_Admin;需求 10.1、10.2) ───────── */

  private assertAdmin(ctx: Ctx) {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
  }

  async listRoles(tx: Tx): Promise<RoleRow[]> {
    return tx.rows<RoleRow>('SELECT id, name, is_template, permissions, data_scope FROM role ORDER BY is_template DESC, name')
  }

  async createRole(tx: Tx, ctx: Ctx, input: unknown): Promise<RoleRow> {
    this.assertAdmin(ctx)
    const v = this.parse(input)
    const id = uuidv7()
    await this.insertRole(tx, ctx.tenantId, id, v.name, v.permissions, v.dataScope as DataScope, false)
    await this.audit.log(tx, ctx, 'role.create', { type: 'role', id, no: v.name, before: null, after: { name: v.name, permissions: v.permissions, dataScope: v.dataScope } })
    return (await tx.one<RoleRow>('SELECT id, name, is_template, permissions, data_scope FROM role WHERE id=$1', [id]))
  }

  async updateRole(tx: Tx, ctx: Ctx, roleId: string, input: unknown): Promise<RoleRow> {
    this.assertAdmin(ctx)
    const old = await tx.maybeOne<RoleRow>('SELECT id, name, is_template, permissions, data_scope FROM role WHERE id=$1 FOR UPDATE', [roleId])
    if (!old) throw new AppError('NOT_FOUND')
    if (old.is_template) throw new AppError('VALIDATION_FAILED', '预置角色模板不可修改,请复制后再编辑', [{ field: 'id', reason: '预置模板只读' }])
    const v = this.parse(input)
    try {
      await tx.query('UPDATE role SET name=$2, permissions=$3, data_scope=$4, version=version+1 WHERE id=$1', [roleId, v.name, v.permissions, JSON.stringify(v.dataScope)])
    } catch (e) {
      throw this.dup(e)
    }
    await this.invalidateRole(tx, roleId) // 受影响用户下一次请求起按新权限判定,无需重新登录
    await this.audit.log(tx, ctx, 'role.update', {
      type: 'role',
      id: roleId,
      no: v.name,
      before: { name: old.name, permissions: old.permissions, dataScope: old.data_scope },
      after: { name: v.name, permissions: v.permissions, dataScope: v.dataScope },
    })
    return tx.one<RoleRow>('SELECT id, name, is_template, permissions, data_scope FROM role WHERE id=$1', [roleId])
  }

  async deleteRole(tx: Tx, ctx: Ctx, roleId: string): Promise<void> {
    this.assertAdmin(ctx)
    const old = await tx.maybeOne<RoleRow>('SELECT id, name, is_template, permissions, data_scope FROM role WHERE id=$1 FOR UPDATE', [roleId])
    if (!old) throw new AppError('NOT_FOUND')
    if (old.is_template) throw new AppError('VALIDATION_FAILED', '预置角色模板不可删除', [{ field: 'id', reason: '预置模板只读' }])
    const used = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM user_role WHERE role_id=$1', [roleId])
    if (used.n > 0) throw new AppError('VALIDATION_FAILED', '该角色仍分配给用户,无法删除', [{ field: 'id', reason: `仍有 ${used.n} 个用户使用该角色` }])
    await tx.query('DELETE FROM role WHERE id=$1', [roleId])
    await this.audit.log(tx, ctx, 'role.delete', { type: 'role', id: roleId, no: old.name, before: { name: old.name }, after: null })
  }

  /** 复制预置模板,新角色初始权限与模板相同且可编辑,修改新角色不改变模板 */
  async copyRole(tx: Tx, ctx: Ctx, sourceId: string, name: string): Promise<RoleRow> {
    this.assertAdmin(ctx)
    const src = await tx.maybeOne<RoleRow>('SELECT id, name, is_template, permissions, data_scope FROM role WHERE id=$1', [sourceId])
    if (!src) throw new AppError('NOT_FOUND')
    return this.createRole(tx, ctx, { name, permissions: src.permissions, dataScope: src.data_scope })
  }

  async assignRoles(tx: Tx, ctx: Ctx, tenantUserId: string, roleIds: string[]): Promise<void> {
    this.assertAdmin(ctx)
    const user = await tx.maybeOne('SELECT id FROM tenant_user WHERE id=$1', [tenantUserId])
    if (!user) throw new AppError('NOT_FOUND')
    const found = await tx.rows<{ id: string }>('SELECT id FROM role WHERE id = ANY($1::uuid[])', [roleIds])
    if (found.length !== new Set(roleIds).size) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'roleIds', reason: '角色不存在' }])
    const before = (await tx.rows<{ role_id: string }>('SELECT role_id FROM user_role WHERE tenant_user_id=$1', [tenantUserId])).map((r) => r.role_id)
    await tx.query('DELETE FROM user_role WHERE tenant_user_id=$1', [tenantUserId])
    for (const rid of new Set(roleIds)) await tx.query('INSERT INTO user_role (tenant_id, tenant_user_id, role_id) VALUES ($1,$2,$3)', [ctx.tenantId, tenantUserId, rid])
    await this.invalidateUser(tenantUserId)
    await this.audit.log(tx, ctx, 'user.assign_roles', { type: 'user', id: tenantUserId, before: { roleIds: before }, after: { roleIds: [...new Set(roleIds)] } })
  }

  /** 创建租户时预置五个角色模板 */
  async seedTemplates(tx: Tx, tenantId: string): Promise<void> {
    for (const t of ROLE_TEMPLATES) await this.insertRole(tx, tenantId, uuidv7(), t.name, t.permissions, t.dataScope, true)
  }

  private async insertRole(tx: Tx, tenantId: string, id: string, name: string, permissions: string[], dataScope: DataScope, isTemplate: boolean) {
    try {
      await tx.query('INSERT INTO role (id, tenant_id, name, is_template, permissions, data_scope) VALUES ($1,$2,$3,$4,$5,$6)', [id, tenantId, name, isTemplate, permissions, JSON.stringify(dataScope)])
    } catch (e) {
      throw this.dup(e)
    }
  }

  private parse(input: unknown) {
    const r = roleSchema.safeParse(input)
    if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })))
    return r.data
  }

  private dup(e: unknown): unknown {
    if ((e as { code?: string }).code === '23505') return new AppError('VALIDATION_FAILED', undefined, [{ field: 'name', reason: '角色名称已存在' }])
    return e
  }
}
