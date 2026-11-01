import { AppError, ERROR_HTTP_STATUS, ErrorBody, ModuleCode, maskFields, visibilityOf } from '@erp/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Container } from '../container'
import type { Ctx, OpKind } from '../core/context'
import type { Tx } from '../core/db'

export interface RouteMeta {
  /** 路由所属业务模块(ModuleGuard) */
  module?: ModuleCode
  /** 需要的操作权限码(PermissionGuard);文档类路由由服务内部按单据类型校验 */
  perm?: string
  /** 操作类别:过期后 read/export 放行,write 拒绝 */
  op: OpKind
  /** 是否由管线开启租户事务;单据服务自行管理事务时为 none */
  tx?: 'tenant' | 'none'
  /** 是否对响应做字段脱敏 */
  mask?: boolean
  /** 仅 Tenant_Admin */
  adminOnly?: boolean
  /** 允许在 must_change_password 状态下访问(修改密码本身) */
  public?: boolean
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) return h.slice(7).trim()
  return undefined
}

/**
 * 请求处理管线(设计:请求处理管线)。按固定顺序:
 * 认证 → 租户上下文(只取自会话) → 租户状态 → License(过期只读) → 模块开关 → 权限 → 租户事务 → 业务 → 字段脱敏。
 */
export class Pipeline {
  constructor(private c: Container) {}

  async context(req: FastifyRequest, meta: Pick<RouteMeta, 'adminOnly'> = {}): Promise<Ctx> {
    const s = await this.c.auth.validate(bearer(req))
    const perms = await this.c.perms.effective(s.tenantId, s.tenantUserId, s.isTenantAdmin)
    const ctx: Ctx = {
      tenantId: s.tenantId, // 只来自已认证会话,忽略请求中携带的任何租户标识(需求 2.5)
      tenantUserId: s.tenantUserId,
      accountId: s.accountId,
      name: s.name,
      isTenantAdmin: s.isTenantAdmin,
      perms,
      client: s.client,
      ip: req.ip,
      actorType: 'user',
    }
    if (meta.adminOnly && !ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    return ctx
  }

  async guards(ctx: Ctx, meta: RouteMeta): Promise<void> {
    if (meta.op === 'write') await this.c.license.assertWritable(ctx.tenantId) // 需求 3.5
    else if (!(await this.c.license.get(ctx.tenantId))) throw new AppError('LICENSE_EXPIRED')
    if (meta.module) await this.c.modules.assertEnabled(ctx.tenantId, meta.module) // 需求 3.7、4.6
    if (meta.perm) this.c.perms.require(ctx, meta.perm) // 需求 10.6
  }

  async run<T>(req: FastifyRequest, meta: RouteMeta, fn: (ctx: Ctx, tx: Tx) => Promise<T>): Promise<T> {
    const ctx = await this.context(req, meta)
    await this.guards(ctx, meta)
    const out =
      meta.tx === 'none'
        ? await fn(ctx, undefined as unknown as Tx)
        : await this.c.db.withTenant(ctx.tenantId, (tx) => fn(ctx, tx), { readOnly: meta.op === 'read' || meta.op === 'export' })
    return meta.mask === false ? out : maskFields(out, visibilityOf(ctx.perms))
  }
}

/** 全局异常过滤:领域错误、校验错误、数据库错误统一转换为 { code, message, details } */
export function toErrorBody(e: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (e instanceof AppError) return { status: e.status, body: { ...e.toBody(), requestId } }
  const code = (e as { code?: string })?.code
  if ((e as { name?: string })?.name === 'ZodError') {
    const issues = (e as { issues: { path: (string | number)[]; message: string }[] }).issues
    return { status: 422, body: { code: 'VALIDATION_FAILED', message: '提交的数据未通过校验', details: issues.map((i) => ({ field: i.path.join('.'), reason: i.message })), requestId } }
  }
  const http = (e as { statusCode?: number })?.statusCode
  if (http && http >= 400 && http < 500) return { status: http, body: { code: 'VALIDATION_FAILED', message: (e as Error).message, requestId } }
  void code
  // INTERNAL_ERROR 只返回 requestId,不返回 SQL、堆栈或其他租户信息
  return { status: ERROR_HTTP_STATUS.INTERNAL_ERROR, body: { code: 'INTERNAL_ERROR', message: '系统内部错误', requestId } }
}

export async function reply<T>(res: FastifyReply, fn: () => Promise<T>): Promise<void> {
  const out = await fn()
  res.send(out)
}
