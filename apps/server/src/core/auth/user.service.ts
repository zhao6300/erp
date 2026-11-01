import { AppError } from '@erp/shared'
import { AuditService } from '../audit'
import type { Ctx } from '../context'
import { hashPassword, randomPassword } from '../crypto'
import type { Db } from '../db'
import { uuidv7 } from '../ids'
import type { LicenseService } from '../license.service'
import type { PermissionService } from '../permission/permission.service'
import { AuthService } from './auth.service'

export interface UserRow {
  id: string
  accountId: string
  name: string
  phone: string
  isTenantAdmin: boolean
  status: 'enabled' | 'disabled'
  roleIds: string[]
}

/**
 * Tenant 内用户管理。账号表是平台级(无 RLS),因此在平台事务中执行,
 * 所有查询显式带 tenant_id。同一手机号在多个租户各有一个 tenant_user,共用一套密码与锁定计数。
 */
export class UserService {
  constructor(
    private db: Db,
    private license: LicenseService,
    private auth: AuthService,
    private perms: PermissionService,
    private audit: AuditService,
  ) {}

  private assertAdmin(ctx: Ctx) {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
  }

  async list(ctx: Ctx): Promise<UserRow[]> {
    this.assertAdmin(ctx)
    return this.db.withPlatform(async (tx) => {
      const rows = await tx.rows(
        `SELECT tu.id, tu.account_id, tu.name, a.phone, tu.is_tenant_admin, tu.status,
                COALESCE((SELECT array_agg(role_id) FROM user_role ur WHERE ur.tenant_user_id = tu.id), '{}') AS role_ids
         FROM tenant_user tu JOIN account a ON a.id = tu.account_id WHERE tu.tenant_id = $1 ORDER BY tu.created_at`,
        [ctx.tenantId],
      )
      return rows.map((r) => ({ id: r.id, accountId: r.account_id, name: r.name, phone: r.phone, isTenantAdmin: r.is_tenant_admin, status: r.status, roleIds: r.role_ids }))
    })
  }

  /**
   * 创建 User。手机号已有账号时只建立成员关系,不重置密码(设计 D5);
   * 否则创建账号并返回一次性初始密码(首次登录须修改)。
   */
  async create(ctx: Ctx, input: { name: string; phone: string; roleIds?: string[]; password?: string }): Promise<{ user: UserRow; initialPassword?: string }> {
    this.assertAdmin(ctx)
    AuthService.validatePhone(input.phone)
    const name = (input.name ?? '').trim()
    if (name.length < 1 || name.length > 50) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'name', reason: '姓名为 1 至 50 个字符' }])
    if (input.password !== undefined) AuthService.validatePassword(input.password)
    const result = await this.db.withPlatform(async (tx) => {
      await this.license.assertCanActivate(tx, ctx.tenantId, 'users')
      let account = await tx.maybeOne<{ id: string; phone: string }>('SELECT id, phone FROM account WHERE phone=$1 FOR UPDATE', [input.phone])
      let initialPassword: string | undefined
      if (!account) {
        initialPassword = input.password ?? randomPassword()
        const id = uuidv7()
        await tx.query('INSERT INTO account (id, phone, password_hash, must_change_password) VALUES ($1,$2,$3,true)', [id, input.phone, await hashPassword(initialPassword)])
        account = { id, phone: input.phone }
      } else {
        const exists = await tx.maybeOne('SELECT 1 FROM tenant_user WHERE tenant_id=$1 AND account_id=$2', [ctx.tenantId, account.id])
        if (exists) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'phone', reason: '该手机号已是本企业用户' }])
      }
      const id = uuidv7()
      await tx.query('INSERT INTO tenant_user (id, tenant_id, account_id, name) VALUES ($1,$2,$3,$4)', [id, ctx.tenantId, account.id, name])
      const roleIds = [...new Set(input.roleIds ?? [])]
      if (roleIds.length) {
        const found = await tx.rows('SELECT id FROM role WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [ctx.tenantId, roleIds])
        if (found.length !== roleIds.length) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'roleIds', reason: '角色不存在' }])
        for (const r of roleIds) await tx.query('INSERT INTO user_role (tenant_id, tenant_user_id, role_id) VALUES ($1,$2,$3)', [ctx.tenantId, id, r])
      }
      await this.audit.log(tx, ctx, 'user.create', { type: 'user', id, no: input.phone, before: null, after: { name, phone: input.phone, roleIds } })
      return { user: { id, accountId: account.id, name, phone: input.phone, isTenantAdmin: false, status: 'enabled' as const, roleIds }, initialPassword }
    })
    return result
  }

  /** 启用/禁用。禁用 → 纪元 +1,全部会话立即失效;启用 → 受用户数上限约束(需求 3.2、9.8) */
  async setStatus(ctx: Ctx, tenantUserId: string, enabled: boolean): Promise<void> {
    this.assertAdmin(ctx)
    await this.db.withPlatform(async (tx) => {
      const u = await tx.maybeOne('SELECT * FROM tenant_user WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [tenantUserId, ctx.tenantId])
      if (!u) throw new AppError('NOT_FOUND')
      if (!enabled && u.id === ctx.tenantUserId) throw new AppError('VALIDATION_FAILED', '不能禁用自己', [{ field: 'id', reason: '不能禁用自己' }])
      if (!enabled && u.is_tenant_admin) {
        const admins = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_user WHERE tenant_id=$1 AND is_tenant_admin AND status='enabled'`, [ctx.tenantId])
        if (admins.n <= 1) throw new AppError('VALIDATION_FAILED', '至少保留一个启用的管理员', [{ field: 'id', reason: '至少保留一个启用的管理员' }])
      }
      if (enabled === (u.status === 'enabled')) return
      if (enabled) await this.license.assertCanActivate(tx, ctx.tenantId, 'users')
      await tx.query('UPDATE tenant_user SET status=$2 WHERE id=$1', [tenantUserId, enabled ? 'enabled' : 'disabled'])
      if (!enabled) await this.auth.revokeUser(tx, tenantUserId)
      await this.perms.invalidateUser(tenantUserId)
      await this.audit.log(tx, ctx, enabled ? 'user.enable' : 'user.disable', { type: 'user', id: tenantUserId, no: u.name, before: { status: u.status }, after: { status: enabled ? 'enabled' : 'disabled' } })
    })
  }

  async setAdmin(ctx: Ctx, tenantUserId: string, isAdmin: boolean): Promise<void> {
    this.assertAdmin(ctx)
    await this.db.withPlatform(async (tx) => {
      const u = await tx.maybeOne('SELECT * FROM tenant_user WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [tenantUserId, ctx.tenantId])
      if (!u) throw new AppError('NOT_FOUND')
      await tx.query('UPDATE tenant_user SET is_tenant_admin=$2 WHERE id=$1', [tenantUserId, isAdmin])
      await this.auth.revokeUser(tx, tenantUserId) // 管理员标识存于会话,变更后须重新登录
      await this.audit.log(tx, ctx, 'user.set_admin', { type: 'user', id: tenantUserId, no: u.name, before: { isTenantAdmin: u.is_tenant_admin }, after: { isTenantAdmin: isAdmin } })
    })
  }
}

