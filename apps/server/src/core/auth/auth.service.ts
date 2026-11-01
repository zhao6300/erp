import { AppError, phoneSchema } from '@erp/shared'
import { AuditService } from '../audit'
import type { ClientType } from '../context'
import { fakeVerify, hashPassword, randomToken, sha256, verifyPassword } from '../crypto'
import type { Db, Tx } from '../db'
import type { Kv } from '../kv'
import type { Clock } from '../time'

export const SESSION_TTL_SECONDS = 168 * 3600 // 7 天滑动过期(需求 9.7)
const TICKET_TTL_SECONDS = 300 // 选择租户 5 分钟
const BIND_TTL_SECONDS = 600
export const MAX_FAILED_LOGINS = 5
export const LOCK_MINUTES = 15

export interface SessionData {
  accountId: string
  tenantUserId: string
  tenantId: string
  isTenantAdmin: boolean
  name: string
  userEpoch: number
  tenantEpoch: number
  client: ClientType
}

export interface TenantBrief {
  id: string
  name: string
}

export type LoginResult =
  | { status: 'ok'; token: string; tenant: TenantBrief; user: { id: string; name: string; isTenantAdmin: boolean }; mustChangePassword: boolean }
  | { status: 'select_tenant'; selectTicket: string; tenants: TenantBrief[] }
  | { status: 'need_bind'; bindTicket: string }

export interface WechatClient {
  code2Session(code: string): Promise<{ openid: string }>
}

/** 真实的微信 code2Session 调用 */
export class HttpWechatClient implements WechatClient {
  constructor(
    private appid: string,
    private secret: string,
  ) {}
  async code2Session(code: string): Promise<{ openid: string }> {
    const u = new URL('https://api.weixin.qq.com/sns/jscode2session')
    u.search = new URLSearchParams({ appid: this.appid, secret: this.secret, js_code: code, grant_type: 'authorization_code' }).toString()
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) })
    const body = (await res.json()) as { openid?: string; errcode?: number; errmsg?: string }
    if (!body.openid) throw new AppError('UNAUTHENTICATED', `微信登录失败:${body.errmsg ?? '未知错误'}`)
    return { openid: body.openid }
  }
}

interface AccountRow {
  id: string
  phone: string
  password_hash: string
  failed_count: number
  locked_until: Date | null
  must_change_password: boolean
}

type FailReason = '账号不存在' | '密码错误' | '账号已禁用' | 'Tenant 已停用'

interface Membership {
  tenant_user_id: string
  tenant_id: string
  tenant_name: string
  tenant_status: string
  user_status: string
  name: string
  is_tenant_admin: boolean
  user_epoch: number
  tenant_epoch: number
}

export class AuthService {
  constructor(
    private db: Db,
    private kv: Kv,
    private audit: AuditService,
    private clock: Clock,
    private wechat: WechatClient | null,
    private wechatAppid = 'wx-default',
  ) {}

  /* ───────── 密码登录 ───────── */

  async loginByPassword(login: string, password: string, client: ClientType, ip?: string): Promise<LoginResult> {
    const { account, members } = await this.authenticate(login, password, client, ip)
    return this.finish(account.id, members, client, ip, account.must_change_password)
  }

  /**
   * 账号密码校验(登录与微信绑定共用,失败计数合并;需求 9.5、9.11)。
   * 返回账号与其全部成员关系;禁用/停用情形在此判定。
   */
  private async authenticate(login: string, password: string, client: ClientType, ip?: string) {
    const now = this.clock()
    return this.db.withPlatform(async (tx) => {
      // 行锁串行化同一账号的并发尝试,计数不会被并发请求绕过
      const account = await tx.maybeOne<AccountRow>('SELECT * FROM account WHERE phone=$1 OR username=$1 FOR UPDATE', [login])
      if (!account) {
        await fakeVerify(password)
        await this.audit.write(tx, { tenantId: null, actorType: 'user', actorName: login, client, ip, action: 'auth.login', detail: { result: 'fail', reason: '账号不存在' satisfies FailReason } })
        return { failedAuth: true as const, locked: false } // 提交审计日志后再抛出,避免回滚
      }
      const members = await this.memberships(tx, account.id)

      if (account.locked_until && new Date(account.locked_until).getTime() > now.getTime()) {
        // 锁定期间不校验密码(包括密码正确的请求),以分钟提示剩余时间,不足 1 分钟按 1 分钟(需求 9.5)
        const minutes = Math.ceil((new Date(account.locked_until).getTime() - now.getTime()) / 60000)
        return { lockedMinutes: minutes }
      }

      const ok = await verifyPassword(account.password_hash, password)
      if (!ok) {
        const failed = account.failed_count + 1
        const locked = failed >= MAX_FAILED_LOGINS
        await tx.query('UPDATE account SET failed_count=$2, locked_until=$3 WHERE id=$1', [account.id, locked ? 0 : failed, locked ? new Date(now.getTime() + LOCK_MINUTES * 60000) : null])
        await this.logToTenants(tx, members, account, client, ip, { result: 'fail', reason: '密码错误' satisfies FailReason })
        // 提交失败计数(此处抛错会回滚,因此改为先标记再在事务外抛出)
        return { failedAuth: true as const, locked }
      }

      await tx.query('UPDATE account SET failed_count=0, locked_until=NULL WHERE id=$1', [account.id])
      const enabledUsers = members.filter((m) => m.user_status === 'enabled')
      if (members.length > 0 && enabledUsers.length === 0) {
        await this.logToTenants(tx, members, account, client, ip, { result: 'fail', reason: '账号已禁用' satisfies FailReason })
        return { disabled: 'ACCOUNT_DISABLED' as const }
      }
      const usable = enabledUsers.filter((m) => m.tenant_status === 'enabled')
      if (enabledUsers.length > 0 && usable.length === 0) {
        await this.logToTenants(tx, enabledUsers, account, client, ip, { result: 'fail', reason: 'Tenant 已停用' satisfies FailReason })
        return { disabled: 'TENANT_DISABLED' as const }
      }
      if (usable.length === 0) return { failedAuth: true as const, locked: false }
      return { account, members: usable }
    }).then((r) => {
      if ('lockedMinutes' in r) throw new AppError('ACCOUNT_LOCKED', `账号已被锁定,请 ${r.lockedMinutes} 分钟后再试`, [{ reason: '账号锁定', minutes: r.lockedMinutes }])
      if ('failedAuth' in r) {
        if (r.locked) throw new AppError('ACCOUNT_LOCKED', `连续输错密码 ${MAX_FAILED_LOGINS} 次,账号已锁定 ${LOCK_MINUTES} 分钟`, [{ reason: '账号锁定', minutes: LOCK_MINUTES }])
        throw new AppError('INVALID_CREDENTIALS')
      }
      if ('disabled' in r && r.disabled) throw new AppError(r.disabled)
      return r
    })
  }

  private async memberships(tx: Tx, accountId: string): Promise<Membership[]> {
    return tx.rows<Membership>(
      `SELECT tu.id AS tenant_user_id, tu.tenant_id, t.name AS tenant_name, t.status AS tenant_status, tu.status AS user_status, tu.name, tu.is_tenant_admin,
              tu.auth_epoch AS user_epoch, t.auth_epoch AS tenant_epoch
       FROM tenant_user tu JOIN tenant t ON t.id = tu.tenant_id WHERE tu.account_id = $1 ORDER BY t.name`,
      [accountId],
    )
  }

  private async logToTenants(tx: Tx, members: Membership[], account: { phone: string }, client: ClientType, ip: string | undefined, detail: Record<string, unknown>) {
    const seen = new Set<string>()
    for (const m of members) {
      if (seen.has(m.tenant_id)) continue
      seen.add(m.tenant_id)
      await this.audit.write(tx, { tenantId: m.tenant_id, actorId: m.tenant_user_id, actorType: 'user', actorName: account.phone, client, ip, action: 'auth.login', detail })
    }
  }

  /** 登录成功后:1 个租户直接签发会话;≥2 个返回一次性选择票据(需求 9.1、9.4) */
  private async finish(accountId: string, members: Membership[], client: ClientType, ip: string | undefined, mustChange: boolean): Promise<LoginResult> {
    if (members.length === 1) return this.issue(accountId, members[0], client, ip, mustChange)
    const ticket = randomToken(24)
    await this.kv.set(`sel:${sha256(ticket)}`, JSON.stringify({ accountId, tenantUserIds: members.map((m) => m.tenant_user_id), client, mustChange }), TICKET_TTL_SECONDS)
    return { status: 'select_tenant', selectTicket: ticket, tenants: members.map((m) => ({ id: m.tenant_id, name: m.tenant_name })) }
  }

  async selectTenant(selectTicket: string, tenantId: string, ip?: string): Promise<LoginResult> {
    const key = `sel:${sha256(selectTicket)}`
    const raw = await this.kv.get(key)
    if (!raw) throw new AppError('UNAUTHENTICATED', '选择已过期,请重新登录')
    await this.kv.del(key) // 一次性
    const t = JSON.parse(raw) as { accountId: string; tenantUserIds: string[]; client: ClientType; mustChange: boolean }
    const m = await this.db.withPlatform(async (tx) => {
      const members = await this.memberships(tx, t.accountId)
      return members.find((x) => x.tenant_id === tenantId && t.tenantUserIds.includes(x.tenant_user_id) && x.user_status === 'enabled' && x.tenant_status === 'enabled')
    })
    if (!m) throw new AppError('UNAUTHENTICATED', '无法进入所选租户')
    return this.issue(t.accountId, m, t.client, ip, t.mustChange)
  }

  private async issue(accountId: string, m: Membership, client: ClientType, ip: string | undefined, mustChange: boolean): Promise<LoginResult> {
    const token = randomToken(32)
    const data: SessionData = {
      accountId,
      tenantUserId: m.tenant_user_id,
      tenantId: m.tenant_id,
      isTenantAdmin: m.is_tenant_admin,
      name: m.name,
      userEpoch: m.user_epoch,
      tenantEpoch: m.tenant_epoch,
      client,
    }
    await this.kv.set(`sess:${sha256(token)}`, JSON.stringify(data), SESSION_TTL_SECONDS)
    await this.kv.set(`ep:u:${m.tenant_user_id}`, String(m.user_epoch))
    await this.kv.set(`ep:t:${m.tenant_id}`, String(m.tenant_epoch))
    await this.db.withPlatform((tx) => this.audit.write(tx, { tenantId: m.tenant_id, actorId: m.tenant_user_id, actorName: m.name, client, ip, action: 'auth.login', detail: { result: 'success' } }))
    return { status: 'ok', token, tenant: { id: m.tenant_id, name: m.tenant_name }, user: { id: m.tenant_user_id, name: m.name, isTenantAdmin: m.is_tenant_admin }, mustChangePassword: mustChange }
  }

  /* ───────── 会话校验 ───────── */

  /** 校验令牌:纪元不一致即失效;每次成功校验滑动续期(需求 9.7、9.8、1.5) */
  async validate(token: string | undefined): Promise<SessionData> {
    if (!token) throw new AppError('UNAUTHENTICATED')
    const key = `sess:${sha256(token)}`
    const raw = await this.kv.get(key)
    if (!raw) throw new AppError('UNAUTHENTICATED')
    const s = JSON.parse(raw) as SessionData
    const [ue, te] = await Promise.all([this.epoch('u', s.tenantUserId), this.epoch('t', s.tenantId)])
    if (ue !== s.userEpoch || te !== s.tenantEpoch) {
      await this.kv.del(key)
      throw new AppError('UNAUTHENTICATED')
    }
    await this.kv.expire(key, SESSION_TTL_SECONDS)
    return s
  }

  private async epoch(kind: 'u' | 't', id: string): Promise<number> {
    const k = `ep:${kind}:${id}`
    const cached = await this.kv.get(k)
    if (cached !== null) return Number(cached)
    const v = await this.db.withPlatform(async (tx) => {
      const r = await tx.maybeOne<{ auth_epoch: number }>(kind === 'u' ? 'SELECT auth_epoch FROM tenant_user WHERE id=$1' : 'SELECT auth_epoch FROM tenant WHERE id=$1', [id])
      return r?.auth_epoch ?? -1
    })
    await this.kv.set(k, String(v))
    return v
  }

  async logout(token: string): Promise<void> {
    await this.kv.del(`sess:${sha256(token)}`)
  }

  /** 禁用 User:纪元 +1 并同步写入 Redis,其全部会话令牌失效;重新启用不回退纪元(需求 9.8) */
  async revokeUser(tx: Tx, tenantUserId: string): Promise<void> {
    const r = await tx.one<{ auth_epoch: number }>('UPDATE tenant_user SET auth_epoch = auth_epoch + 1 WHERE id=$1 RETURNING auth_epoch', [tenantUserId])
    // Redis 在提交后写入;写入前的极短窗口内旧令牌仍按旧纪元通过,与"保存成功之后"的语义一致
    tx.onCommit(() => this.kv.set(`ep:u:${tenantUserId}`, String(r.auth_epoch)))
  }

  /** 停用 Tenant:纪元 +1,该租户全部会话令牌失效(需求 1.5) */
  async revokeTenant(tx: Tx, tenantId: string): Promise<void> {
    const r = await tx.one<{ auth_epoch: number }>('UPDATE tenant SET auth_epoch = auth_epoch + 1 WHERE id=$1 RETURNING auth_epoch', [tenantId])
    tx.onCommit(() => this.kv.set(`ep:t:${tenantId}`, String(r.auth_epoch)))
  }

  /* ───────── 微信 ───────── */

  async loginByWechat(code: string, ip?: string): Promise<LoginResult> {
    if (!this.wechat) throw new AppError('UNAUTHENTICATED', '未配置微信登录')
    const { openid } = await this.wechat.code2Session(code)
    const bound = await this.db.withPlatform(async (tx) => {
      const b = await tx.maybeOne<{ account_id: string }>('SELECT account_id FROM wechat_binding WHERE appid=$1 AND openid=$2', [this.wechatAppid, openid])
      if (!b) return null
      const account = await tx.one('SELECT id, must_change_password FROM account WHERE id=$1', [b.account_id])
      return { account, members: await this.memberships(tx, b.account_id) }
    })
    if (!bound) {
      const ticket = randomToken(24)
      await this.kv.set(`bind:${sha256(ticket)}`, JSON.stringify({ openid }), BIND_TTL_SECONDS)
      return { status: 'need_bind', bindTicket: ticket }
    }
    const enabled = bound.members.filter((m) => m.user_status === 'enabled')
    if (bound.members.length > 0 && enabled.length === 0) throw new AppError('ACCOUNT_DISABLED')
    const usable = enabled.filter((m) => m.tenant_status === 'enabled')
    if (enabled.length > 0 && usable.length === 0) throw new AppError('TENANT_DISABLED')
    if (usable.length === 0) throw new AppError('UNAUTHENTICATED')
    return this.finish(bound.account.id, usable, 'miniapp', ip, bound.account.must_change_password)
  }

  /** 首次微信登录:输入已有账号手机号与密码绑定;失败计入连续错误次数(需求 9.2、9.11) */
  async bindWechat(bindTicket: string, phone: string, password: string, ip?: string): Promise<LoginResult> {
    const key = `bind:${sha256(bindTicket)}`
    const raw = await this.kv.get(key)
    if (!raw) throw new AppError('UNAUTHENTICATED', '绑定已过期,请重新登录')
    const { openid } = JSON.parse(raw) as { openid: string }
    const { account, members } = await this.authenticate(phone, password, 'miniapp', ip)
    await this.db.withPlatform((tx) =>
      tx.query(`INSERT INTO wechat_binding (appid, openid, account_id) VALUES ($1,$2,$3) ON CONFLICT (appid, openid) DO UPDATE SET account_id=$3`, [this.wechatAppid, openid, account.id]),
    )
    await this.kv.del(key)
    return this.finish(account.id, members, 'miniapp', ip, account.must_change_password)
  }

  /* ───────── 密码管理 ───────── */

  static validatePassword(pw: string): void {
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'password', reason: '密码长度须为 8 至 72 个字符' }])
  }

  async changePassword(accountId: string, oldPassword: string, newPassword: string): Promise<void> {
    AuthService.validatePassword(newPassword)
    await this.db.withPlatform(async (tx) => {
      const a = await tx.maybeOne('SELECT password_hash FROM account WHERE id=$1 FOR UPDATE', [accountId])
      if (!a || !(await verifyPassword(a.password_hash, oldPassword))) throw new AppError('INVALID_CREDENTIALS')
      await tx.query('UPDATE account SET password_hash=$2, must_change_password=false WHERE id=$1', [accountId, await hashPassword(newPassword)])
    })
  }

  static validatePhone(phone: string): void {
    if (!phoneSchema.safeParse(phone).success) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'phone', reason: '手机号须为 11 位中国大陆手机号' }])
  }
}
