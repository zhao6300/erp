import type { EffectivePermission } from '@erp/shared'

export type ClientType = 'web' | 'miniapp' | 'api'

/** 经过认证的请求上下文。tenantId 只来自已认证会话(设计 D1) */
export interface Ctx {
  tenantId: string
  tenantUserId: string
  accountId: string
  name: string
  isTenantAdmin: boolean
  perms: EffectivePermission
  client: ClientType
  ip?: string
  actorType: 'user' | 'open_api'
}

/** 控制器方法声明的操作类别,LicenseGuard 依据它判断过期后是否放行(需求 3.5) */
export type OpKind = 'read' | 'write' | 'export'
