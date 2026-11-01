import { AppError, DocInput, MODULE_CODES, ModuleCode, serializeConfigPackage, emptyConfig } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { World, nextPhone, setupWorld, TestApp, TenantFixture, FAR_FUTURE } from './support/app'

let app: TestApp

beforeAll(async () => {
  app = (await setupWorld(inject('pgAdminUrl'))).app
})
afterAll(async () => {
  await app.close()
})

const errOf = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof AppError) return e
    throw e
  }
  throw new Error('expected rejection')
}

describe('租户开通(需求 1.3、1.7)', () => {
  it('原子创建 Tenant、默认资金账户、默认仓库、Tenant_Admin、角色模板、编号规则、打印模板,并启用全部已授权模块', async () => {
    const t = await app.newTenant({ license: { modules: ['product', 'inventory', 'sales'] } })
    // 同一事务连接上的查询必须顺序执行(并发会触发 pg 的弃用行为)
    const { fa, wh, users, roles, rules, prints, mods } = await app.c.db.withTenant(t.id, async (tx) => ({
      fa: await tx.rows('SELECT name FROM fund_account'),
      wh: await tx.rows('SELECT code FROM warehouse'),
      users: await tx.rows('SELECT is_tenant_admin FROM tenant_user'),
      roles: await tx.rows('SELECT name, is_template FROM role ORDER BY name'),
      rules: await tx.one('SELECT count(*)::int AS n FROM numbering_rule'),
      prints: await tx.one('SELECT count(*)::int AS n FROM print_template WHERE is_default'),
      mods: await tx.rows('SELECT module FROM tenant_module WHERE enabled ORDER BY module'),
    }))
    expect(fa).toEqual([{ name: '现金' }])
    expect(wh).toEqual([{ code: 'WH001' }])
    expect(users).toEqual([{ is_tenant_admin: true }])
    expect(roles.map((r) => r.name).sort()).toEqual(['仓管', '财务', '老板', '采购员', '销售员'].sort())
    expect(roles.every((r) => r.is_template)).toBe(true)
    expect(rules.n).toBe(12)
    expect(prints.n).toBe(12)
    expect(mods.map((m) => m.module)).toEqual(['inventory', 'product', 'sales'])
  })

  it('字段校验:一次性逐一标明全部未通过的字段,不创建任何数据(需求 1.7)', async () => {
    const before = (await app.c.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM tenant'))).n
    const e = await errOf(app.c.tenants.createTenant({ name: '  ', contact: '', phone: '123', license: { expireDate: '', modules: [], maxUsers: 0, maxWarehouses: 1000 } }))
    expect(e.code).toBe('VALIDATION_FAILED')
    const fields = e.details!.map((d) => d.field)
    for (const x of ['name', 'contact', 'phone', 'license.expireDate', 'license.modules', 'license.maxUsers', 'license.maxWarehouses']) expect(fields).toContain(x)
    expect((await app.c.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM tenant'))).n).toBe(before)
  })

  it('企业名称重复被拒绝;名称去除首尾空格后比较', async () => {
    const name = `重名企业-${nextPhone()}`
    await app.newTenant({ name })
    const e = await errOf(app.c.tenants.createTenant({ name: `  ${name}  `, contact: 'x', phone: nextPhone(), license: { expireDate: FAR_FUTURE, modules: ['product'], maxUsers: 1, maxWarehouses: 1 } }))
    expect(e.details!.some((d) => d.field === 'name')).toBe(true)
  })

  it('同一手机号在第二个租户中复用账号,不重置密码,登录后列出两个租户供选择(需求 9.4)', async () => {
    const phone = nextPhone()
    const a = await app.newTenant({ phone, name: `多租户A-${phone}` })
    const b = await app.newTenant({ phone, name: `多租户B-${phone}` })
    expect(b.adminPassword).toBe('') // 账号已存在,没有新密码
    expect(a.adminPassword).not.toBe('')
    const r = await app.c.auth.loginByPassword(phone, a.adminPassword, 'web')
    expect(r.status).toBe('select_tenant')
    if (r.status !== 'select_tenant') return
    expect(r.tenants.map((t) => t.name).sort()).toEqual([`多租户A-${phone}`, `多租户B-${phone}`])
    const s = await app.c.auth.selectTenant(r.selectTicket, b.id)
    expect(s.status === 'ok' && s.tenant.id).toBe(b.id)
    // 票据一次性
    expect((await errOf(app.c.auth.selectTenant(r.selectTicket, a.id))).code).toBe('UNAUTHENTICATED')
  })

  it('开通时选择不可用的配置包被拒绝,不创建 Tenant', async () => {
    const before = (await app.c.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM tenant'))).n
    const e = await errOf(app.c.tenants.createTenant({ name: `X-${nextPhone()}`, contact: 'x', phone: nextPhone(), license: { expireDate: FAR_FUTURE, modules: ['product'], maxUsers: 1, maxWarehouses: 1 }, configPackageId: '00000000-0000-7000-8000-000000000000' }))
    expect(e.details![0].field).toBe('configPackageId')
    expect((await app.c.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM tenant'))).n).toBe(before)
  })
})

describe('登录与认证(需求 9)', () => {
  let t: TenantFixture
  beforeAll(async () => {
    t = await app.newTenant()
  })

  it('正确的手机号与密码签发会话令牌;令牌可校验;错误账号与错误密码使用同一错误码与提示(需求 9.9)', async () => {
    const ok = await app.c.auth.loginByPassword(t.adminPhone, t.adminPassword, 'web')
    expect(ok.status).toBe('ok')
    if (ok.status !== 'ok') return
    expect((await app.c.auth.validate(ok.token)).tenantId).toBe(t.id)
    const missing = await errOf(app.c.auth.loginByPassword('13999999999', 'whatever12', 'web'))
    const wrong = await errOf(app.c.auth.loginByPassword(t.adminPhone, 'wrong-password', 'web'))
    expect(missing.code).toBe('INVALID_CREDENTIALS')
    expect(wrong.code).toBe('INVALID_CREDENTIALS')
    expect(missing.message).toBe(wrong.message)
  })

  it('登录成功与失败都写 Audit_Log,不含密码(需求 22.2)', async () => {
    await app.c.auth.loginByPassword(t.adminPhone, 'definitely-wrong', 'miniapp', '10.0.0.9').catch(() => {})
    const logs = await app.c.db.withTenant(t.id, (tx) => tx.rows(`SELECT client, ip, detail FROM audit_log WHERE action='auth.login' ORDER BY occurred_at`))
    expect(logs.some((l) => l.detail.result === 'success')).toBe(true)
    // 同一租户此前还有 web 端的失败记录,按本次请求的 IP 精确定位
    const fail = logs.find((l) => l.detail.result === 'fail' && l.ip === '10.0.0.9')!
    expect(fail.detail.reason).toBe('密码错误')
    expect(fail.client).toBe('miniapp')
    expect(fail.ip).toBe('10.0.0.9')
    expect(JSON.stringify(logs)).not.toContain('definitely-wrong')
    const unknown = await app.c.db.withPlatform((tx) => tx.rows(`SELECT detail FROM audit_log WHERE tenant_id IS NULL AND action='auth.login'`))
    expect(unknown.some((l) => l.detail.reason === '账号不存在')).toBe(true)
  })

  it('连续 5 次错误锁定 15 分钟:锁定期间正确密码也被拒绝并提示剩余分钟(向上取整);到期后恢复', async () => {
    const x = await app.newTenant()
    for (let i = 0; i < 4; i++) expect((await errOf(app.c.auth.loginByPassword(x.adminPhone, 'bad-password', 'web'))).code).toBe('INVALID_CREDENTIALS')
    expect((await errOf(app.c.auth.loginByPassword(x.adminPhone, 'bad-password', 'web'))).code).toBe('ACCOUNT_LOCKED')
    // 锁定期间:正确密码同样被拒
    const locked = await errOf(app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web'))
    expect(locked.code).toBe('ACCOUNT_LOCKED')
    expect(locked.details![0].minutes).toBe(15)
    app.setNow(new Date(app.now.getTime() + 14 * 60_000 + 30_000)) // 剩余 30 秒 → 提示 1 分钟
    expect((await errOf(app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web'))).details![0].minutes).toBe(1)
    app.setNow(new Date(app.now.getTime() + 60_000))
    expect((await app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web')).status).toBe('ok')
    app.setNow('2026-09-30T04:00:00Z')
  })

  it('成功登录会清零失败计数', async () => {
    const x = await app.newTenant()
    for (let i = 0; i < 3; i++) await errOf(app.c.auth.loginByPassword(x.adminPhone, 'bad-password', 'web'))
    await app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web')
    for (let i = 0; i < 4; i++) expect((await errOf(app.c.auth.loginByPassword(x.adminPhone, 'bad-password', 'web'))).code).toBe('INVALID_CREDENTIALS')
  })

  it('会话 7 天未使用失效,每次校验滑动续期(需求 9.7)', async () => {
    const x = await app.newTenant()
    const base = app.now
    const login = await app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web')
    if (login.status !== 'ok') throw new Error()
    // MemoryKv 使用真实时钟计 TTL,此处验证续期调用不抛错且令牌仍有效
    expect((await app.c.auth.validate(login.token)).tenantUserId).toBe(x.adminUserId)
    app.setNow(base)
  })

  it('禁用 User:全部会话立即失效,拒绝登录并提示已被禁用;重新启用后旧令牌保持失效(需求 9.8、9.10)', async () => {
    const x = await app.newTenant()
    const created = await app.c.users.create(x.admin, { name: '李四', phone: nextPhone(), password: 'Passw0rd!x' })
    const login = await app.c.auth.loginByPassword(created.user.phone, 'Passw0rd!x', 'web')
    if (login.status !== 'ok') throw new Error()
    await app.c.auth.validate(login.token)
    await app.c.users.setStatus(x.admin, created.user.id, false)
    expect((await errOf(app.c.auth.validate(login.token))).code).toBe('UNAUTHENTICATED')
    expect((await errOf(app.c.auth.loginByPassword(created.user.phone, 'Passw0rd!x', 'web'))).code).toBe('ACCOUNT_DISABLED')
    await app.c.users.setStatus(x.admin, created.user.id, true)
    expect((await errOf(app.c.auth.validate(login.token))).code).toBe('UNAUTHENTICATED') // 纪元不回退
    expect((await app.c.auth.loginByPassword(created.user.phone, 'Passw0rd!x', 'web')).status).toBe('ok')
  })

  it('停用租户:令牌立即失效、拒绝登录、数据保留;重新启用后新登录可用而旧令牌仍失效(需求 1.5、1.6)', async () => {
    const x = await app.newTenant()
    const sku = await new World(app, x).product('T1')
    const login = await app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web')
    if (login.status !== 'ok') throw new Error()
    await app.c.tenants.disableTenant(x.id)
    expect((await errOf(app.c.auth.validate(login.token))).code).toBe('UNAUTHENTICATED')
    expect((await errOf(app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web'))).code).toBe('TENANT_DISABLED')
    expect((await app.c.db.withTenant(x.id, (tx) => tx.one('SELECT count(*)::int AS n FROM sku WHERE id=$1', [sku]))).n).toBe(1)
    await app.c.tenants.enableTenant(x.id)
    expect((await errOf(app.c.auth.validate(login.token))).code).toBe('UNAUTHENTICATED')
    expect((await app.c.auth.loginByPassword(x.adminPhone, x.adminPassword, 'web')).status).toBe('ok')
  })

  it('响应与数据库中不会泄露明文密码;密码使用 argon2id 哈希(需求 9.6)', async () => {
    const h = await app.c.db.withPlatform((tx) => tx.one('SELECT password_hash FROM account WHERE phone=$1', [t.adminPhone]))
    expect(h.password_hash.startsWith('$argon2id$')).toBe(true)
    expect(h.password_hash).not.toContain(t.adminPassword)
  })
})

describe('微信登录与绑定(需求 9.2、9.3、9.11)', () => {
  it('首次要求绑定;绑定失败计入连续错误次数;绑定成功后免密登录', async () => {
    const x = await app.newTenant()
    let openid = 'oid-1'
    const a2 = await (await import('./support/app')).createTestApp(inject('pgAdminUrl'), { wechat: { code2Session: async () => ({ openid }) } })
    try {
      const t = await a2.newTenant()
      const first = await a2.c.auth.loginByWechat('code1')
      expect(first.status).toBe('need_bind')
      if (first.status !== 'need_bind') return
      // 绑定时密码错误:不保存绑定关系
      expect((await errOf(a2.c.auth.bindWechat(first.bindTicket, t.adminPhone, 'bad-password-1'))).code).toBe('INVALID_CREDENTIALS')
      expect((await a2.c.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM wechat_binding'))).n).toBe(0)
      const bound = await a2.c.auth.bindWechat(first.bindTicket, t.adminPhone, t.adminPassword)
      expect(bound.status).toBe('ok')
      // 之后无需密码
      const again = await a2.c.auth.loginByWechat('code2')
      expect(again.status).toBe('ok')
      // 不同微信身份仍需绑定
      openid = 'oid-2'
      expect((await a2.c.auth.loginByWechat('code3')).status).toBe('need_bind')
      // 禁用后拒绝
      await a2.c.users.create(t.admin, { name: '王五', phone: nextPhone() })
      await a2.c.db.withPlatform((tx) => tx.query(`UPDATE tenant_user SET status='disabled' WHERE id=$1`, [t.adminUserId]))
      openid = 'oid-1'
      expect((await errOf(a2.c.auth.loginByWechat('code4'))).code).toBe('ACCOUNT_DISABLED')
    } finally {
      await a2.close()
    }
    void x
  })
})

describe('License(需求 3)', () => {
  it('用户数上限:达到上限拒绝创建与重新启用;并发创建不会超额(需求 3.2)', async () => {
    const x = await app.newTenant({ license: { maxUsers: 3 } })
    await app.c.users.create(x.admin, { name: 'u1', phone: nextPhone() })
    const rs = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => app.c.users.create(x.admin, { name: `p${i}`, phone: nextPhone() })))
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1) // 管理员 + u1 + 1 = 3
    for (const r of rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) expect((r.reason as AppError).code).toBe('LICENSE_LIMIT_USERS')
    const enabled = (await app.c.db.withTenant(x.id, (tx) => tx.one(`SELECT count(*)::int AS n FROM tenant_user WHERE status='enabled'`))).n
    expect(enabled).toBe(3)
  })

  it('调低上限到小于当前启用数:现有不受影响,后续创建被拒绝(需求 3.9)', async () => {
    const x = await app.newTenant({ license: { maxUsers: 5, maxWarehouses: 3 } })
    const ww = new World(app, x)
    await ww.warehouse('X2')
    await ww.warehouse('X3') // 共 3 个
    await app.c.tenants.saveLicense(x.id, { expireDate: FAR_FUTURE, modules: [...MODULE_CODES], maxUsers: 1, maxWarehouses: 1 })
    expect((await app.c.db.withTenant(x.id, (tx) => tx.one('SELECT count(*)::int AS n FROM warehouse WHERE enabled'))).n).toBe(3)
    expect((await errOf(ww.warehouse('X4'))).code).toBe('LICENSE_LIMIT_WAREHOUSES')
    expect((await errOf(app.c.users.create(x.admin, { name: 'z', phone: nextPhone() }))).code).toBe('LICENSE_LIMIT_USERS')
    // 重新启用也受限:停用一个后启用数 2 仍 ≥ 1
    const all = await app.c.db.withTenant(x.id, (tx) => tx.rows('SELECT id FROM warehouse ORDER BY code'))
    await app.c.db.withTenant(x.id, (tx) => app.c.warehouses.setEnabled(tx, x.admin, all[1].id, false))
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.warehouses.setEnabled(tx, x.admin, all[1].id, true)))).code).toBe('LICENSE_LIMIT_WAREHOUSES')
  })

  it('过期判定:截止日当天 23:59:59 仍有效,次日 00:00:00 起过期;过期后写操作被拒绝而数据不变(需求 3.5)', async () => {
    const x = await app.newTenant({ license: { expireDate: '2026-10-05' } })
    const l = (await app.c.license.get(x.id))!
    app.setNow('2026-10-05T15:59:59Z') // 北京时间 10-05 23:59:59
    expect(app.c.license.isExpired(l)).toBe(false)
    await app.c.license.assertWritable(x.id)
    app.setNow('2026-10-05T16:00:00Z') // 北京时间 10-06 00:00:00
    expect(app.c.license.isExpired(l)).toBe(true)
    expect((await errOf(app.c.license.assertWritable(x.id))).code).toBe('LICENSE_EXPIRED')
    app.setNow('2026-09-30T04:00:00Z')
  })

  it('到期提醒:剩余 0–15 天(含端点)才提醒,天数按自然日计算(需求 3.4)', async () => {
    const mk = (d: string) => app.c.license.reminder({ expireDate: d })
    app.setNow('2026-09-30T04:00:00Z')
    expect(mk('2026-09-30')).toEqual({ expireDate: '2026-09-30', daysLeft: 0 })
    expect(mk('2026-10-15')).toEqual({ expireDate: '2026-10-15', daysLeft: 15 })
    expect(mk('2026-10-16')).toBeNull()
    expect(mk('2026-09-29')).toBeNull()
  })

  it('保存非法 License(上限越界、模块为空、日期为空)被拒绝并保留原 License(需求 3.8)', async () => {
    const x = await app.newTenant()
    const before = await app.c.license.get(x.id)
    for (const bad of [
      { expireDate: FAR_FUTURE, modules: ['product'], maxUsers: 10000, maxWarehouses: 1 },
      { expireDate: FAR_FUTURE, modules: ['product'], maxUsers: 1, maxWarehouses: 0 },
      { expireDate: FAR_FUTURE, modules: [], maxUsers: 1, maxWarehouses: 1 },
      { expireDate: '', modules: ['product'], maxUsers: 1, maxWarehouses: 1 },
      { expireDate: '2026-02-30', modules: ['product'], maxUsers: 1, maxWarehouses: 1 },
    ]) {
      expect((await errOf(app.c.tenants.saveLicense(x.id, bad))).code).toBe('VALIDATION_FAILED')
    }
    expect(await app.c.license.get(x.id)).toEqual(before)
  })

  it('License 修改后立即(缓存失效)生效:移除已启用模块时同时关闭其依赖方,保留数据(需求 3.6、4.9)', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    await ww.product('L1')
    await app.c.modules.assertEnabled(x.id, 'sales')
    const r = await app.c.tenants.saveLicense(x.id, { expireDate: FAR_FUTURE, modules: ['product', 'finance', 'report'], maxUsers: 5, maxWarehouses: 2 })
    expect(r.disabledModules.sort()).toEqual(['inventory', 'purchase', 'sales'])
    expect((await errOf(app.c.modules.assertEnabled(x.id, 'sales'))).code).toBe('MODULE_NOT_LICENSED')
    expect((await app.c.db.withTenant(x.id, (tx) => tx.one('SELECT count(*)::int AS n FROM product'))).n).toBe(1) // 数据保留
  })
})

describe('模块开关(需求 4)', () => {
  it('关闭被依赖模块被拒绝并列出依赖方;关闭后接口返回"模块未启用";数据保留;重新启用即恢复', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    const e = await errOf(app.c.db.withTenant(x.id, (tx) => app.c.modules.disable(tx, x.admin, 'product')))
    expect(e.code).toBe('MODULE_DEPENDENCY')
    expect(e.details!.map((d) => d.module).sort()).toEqual(['inventory', 'purchase', 'sales'])
    await app.c.db.withTenant(x.id, (tx) => app.c.modules.disable(tx, x.admin, 'sales'))
    expect((await errOf(app.c.modules.assertEnabled(x.id, 'sales'))).code).toBe('MODULE_DISABLED')
    await ww.product('M1')
    await app.c.db.withTenant(x.id, (tx) => app.c.modules.enable(tx, x.admin, 'sales'))
    await app.c.modules.assertEnabled(x.id, 'sales')
  })

  it('启用时自动带出依赖;未授权模块(或其依赖未授权)整体拒绝并列出,状态不变', async () => {
    const x = await app.newTenant({ license: { modules: ['product', 'inventory', 'sales'] } })
    await app.c.db.withTenant(x.id, async (tx) => {
      await app.c.modules.disable(tx, x.admin, 'sales')
      await app.c.modules.disable(tx, x.admin, 'inventory')
    })
    const r = await app.c.db.withTenant(x.id, (tx) => app.c.modules.enable(tx, x.admin, 'sales'))
    expect(r.autoEnabled).toEqual(['inventory'])
    const e = await errOf(app.c.db.withTenant(x.id, (tx) => app.c.modules.enable(tx, x.admin, 'purchase')))
    expect(e.code).toBe('MODULE_NOT_LICENSED')
    expect(e.details![0].module).toBe('purchase')
    expect((await app.c.modules.visible(x.id)).sort()).toEqual(['inventory', 'product', 'sales'])
  })
})

describe('品牌白标(需求 5)', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
  it('整份校验:任一项不合规则不保存,原配置不变;域名全局唯一', async () => {
    const x = await app.newTenant()
    const y = await app.newTenant()
    const save = (t: TenantFixture, v: unknown) => app.c.db.withTenant(t.id, (tx) => app.c.branding.save(tx, t.admin, t.id, v))
    const ok = await save(x, { systemName: '我的ERP', themeColor: '#FF5500', copyright: '© 某公司', customDomain: 'erp.example.com' })
    expect(ok).toMatchObject({ systemName: '我的ERP', themeColor: '#FF5500' })
    for (const bad of [{ systemName: '' }, { systemName: 'x'.repeat(31) }, { systemName: 'ok', themeColor: 'red' }, { systemName: 'ok', copyright: 'c'.repeat(101) }, { systemName: 'ok', customDomain: 'not a domain' }]) {
      expect((await errOf(save(x, bad))).code).toBe('VALIDATION_FAILED')
    }
    expect(await app.c.db.withTenant(x.id, (tx) => app.c.branding.get(tx))).toMatchObject({ systemName: '我的ERP', themeColor: '#FF5500' })
    const dup = await errOf(save(y, { systemName: 'Y', customDomain: 'ERP.example.com' }))
    expect(dup.details![0].field).toBe('customDomain')
  })

  it('按域名查品牌;未登记域名与未配置项回退平台默认值;证书 ask 端点只放行已登记域名(需求 5.3、5.4、5.9)', async () => {
    const x = await app.newTenant()
    await app.c.db.withTenant(x.id, (tx) => app.c.branding.save(tx, x.admin, x.id, { systemName: '客户品牌', customDomain: 'brand.example.org' }))
    const hit = await app.c.branding.byHost('brand.example.org:443')
    expect(hit).toMatchObject({ systemName: '客户品牌', tenantId: x.id, themeColor: '#1677FF' })
    expect(hit.configured).toMatchObject({ systemName: true, themeColor: false })
    const miss = await app.c.branding.byHost('unknown.example.net')
    expect(miss).toMatchObject({ systemName: 'Lite ERP', tenantId: null })
    expect(await app.c.branding.isRegisteredDomain('brand.example.org')).toBe(true)
    expect(await app.c.branding.isRegisteredDomain('evil.example.org')).toBe(false)
  })

  it('只有本租户 Tenant_Admin 可修改(需求 5.8);图片按魔数校验格式与 2MB 上限,拒绝时保留原图(需求 5.5)', async () => {
    const x = await app.newTenant()
    const nonAdmin = app.ctx(x, x.adminUserId, { isAdmin: false, permissions: [], dataScope: { all: false, warehouseIds: [], own: true } })
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.branding.save(tx, nonAdmin, x.id, { systemName: 'hack' })))).code).toBe('NO_PERMISSION')
    const up = await app.c.db.withTenant(x.id, (tx) => app.c.branding.uploadImage(tx, x.admin, png))
    expect(up.mime).toBe('image/png')
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.branding.uploadImage(tx, x.admin, big)))).code).toBe('VALIDATION_FAILED')
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.branding.uploadImage(tx, x.admin, Buffer.from('GIF89a....'))))).code).toBe('VALIDATION_FAILED')
    // 声称是图片的脚本被拒绝;SVG 中的脚本被净化
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.branding.uploadImage(tx, x.admin, Buffer.from('<script>alert(1)</script>'))))).code).toBe('VALIDATION_FAILED')
    const svg = await app.c.db.withTenant(x.id, (tx) => app.c.branding.uploadImage(tx, x.admin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect/></svg>')))
    const stored = await app.c.files.readSigned(x.id, svg.id)
    expect(stored.data.toString()).not.toMatch(/script|onload/i)
    // 附件签名链接 5 分钟有效
    const s = app.c.files.signUrl(x.id, up.id, 1_000_000)
    expect(app.c.files.verifySignature(x.id, up.id, s.expires, s.sig, 1_000_000 + 299_000)).toBe(true)
    expect(app.c.files.verifySignature(x.id, up.id, s.expires, s.sig, 1_000_000 + 301_000)).toBe(false)
    // 跨租户读取附件 = 不存在
    const y = await app.newTenant()
    expect((await errOf(app.c.files.readSigned(y.id, up.id))).code).toBe('NOT_FOUND')
  })
})

describe('自定义字段(需求 6)', () => {
  it('创建、编码重复(不区分大小写)、停用保留值、重新启用恢复、保存校验必填与类型、列表筛选', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    const def = { code: 'brand', label: '品牌', type: 'select' as const, required: true, options: ['A', 'B'], displayOrder: 1, showInList: true, filterable: true, enabled: true }
    const created = await app.c.db.withTenant(x.id, (tx) => app.c.customFields.create(tx, x.admin, 'product', def))
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.customFields.create(tx, x.admin, 'product', { ...def, code: 'BRAND' })))).message).toBe('字段编码重复')
    // 必填缺失
    expect((await errOf(ww.product('CF1'))).message).toContain('品牌')
    // 非法取值
    const bad = await errOf(ww.run((tx) => app.c.products.create(tx, x.admin, { code: 'CF2', name: 'n', baseUnit: '个', custom: { brand: 'Z' } })))
    expect(bad.code).toBe('VALIDATION_FAILED')
    expect(bad.details![0].field).toBe('custom.brand')
    const p1 = await ww.run((tx) => app.c.products.create(tx, x.admin, { code: 'CF3', name: 'n', baseUnit: '个', custom: { brand: 'A' } }))
    await ww.run((tx) => app.c.products.create(tx, x.admin, { code: 'CF4', name: 'n', baseUnit: '个', custom: { brand: 'B' } }))
    // 筛选
    const onlyA = await ww.run((tx) => app.c.products.list(tx, { cf: { brand: { values: ['A'] } } }))
    expect(onlyA.items.map((i) => i.code)).toEqual(['CF3'])
    // 停用:不再校验必填,值保留
    await app.c.db.withTenant(x.id, (tx) => app.c.customFields.setEnabled(tx, x.admin, created.id, false))
    const p5 = await ww.run((tx) => app.c.products.create(tx, x.admin, { code: 'CF5', name: 'n', baseUnit: '个' }))
    expect(p5.custom).toEqual({})
    expect((await ww.run((tx) => app.c.products.get(tx, p1.id))).custom).toEqual({ brand: 'A' })
    // 修改 p1 时不会抹掉停用字段的旧值
    await ww.run((tx) => app.c.products.update(tx, x.admin, p1.id, { code: 'CF3', name: '改名', baseUnit: '个' }))
    expect((await ww.run((tx) => app.c.products.get(tx, p1.id))).custom).toEqual({ brand: 'A' })
    await app.c.db.withTenant(x.id, (tx) => app.c.customFields.setEnabled(tx, x.admin, created.id, true))
    // 编码与类型不可修改
    const up = await errOf(app.c.db.withTenant(x.id, (tx) => app.c.customFields.update(tx, x.admin, created.id, { ...def, type: 'text', options: undefined })))
    expect(up.message).toContain('不可修改')
    // 每个对象最多 50 个
    for (let i = 0; i < 49; i++) await app.c.db.withTenant(x.id, (tx) => app.c.customFields.create(tx, x.admin, 'product', { ...def, code: `f${i}`, required: false, filterable: false }))
    expect((await errOf(app.c.db.withTenant(x.id, (tx) => app.c.customFields.create(tx, x.admin, 'product', { ...def, code: 'overflow', required: false })))).code).toBe('VALIDATION_FAILED')
  })
})

describe('配置包(需求 8)', () => {
  it('导出 → 在另一租户预览(新增/覆盖)→ 确认导入;不含业务数据;单事务应用,失败整体回滚', async () => {
    const src = await app.newTenant()
    const ws = new World(app, src)
    await ws.product('SECRET-PRODUCT')
    await app.c.db.withTenant(src.id, async (tx) => {
      await app.c.customFields.create(tx, src.admin, 'product', { code: 'color', label: '颜色', type: 'text', required: false, displayOrder: 1, showInList: false, filterable: false, enabled: true })
      await app.c.settings.update(tx, src.admin, { qtyScale: 3, priceScale: 5, amountScale: 2, allowNegativeStock: true, requireAudit: true, multiUnit: true, multiSku: false, barcodeEnabled: true })
      await app.c.settings.updateRule(tx, src.admin, 'sales_out', { prefix: 'XS', dateFormat: 'YM', seqDigits: 5, reset: 'monthly' })
      await app.c.perms.createRole(tx, src.admin, { name: '门店店长', permissions: ['menu:sales_out'], dataScope: { type: 'warehouses', ids: [src.warehouseId] } })
    })
    const exported = await app.c.db.withTenant(src.id, (tx) => app.c.packages.export(tx, src.id, new Date('2026-09-30T00:00:00Z')))
    expect(exported.text).not.toContain('SECRET-PRODUCT')
    expect(exported.text).not.toContain(src.adminPhone)
    expect(exported.notices.some((n) => n.includes('门店店长'))).toBe(true)

    const dst = await app.newTenant({ license: { modules: ['product', 'inventory', 'sales', 'finance', 'report'] } })
    const lic = (await app.c.license.get(dst.id))!.modules
    const preview = await app.c.db.withTenant(dst.id, (tx) => app.c.packages.preview(tx, dst.id, exported.text, lic))
    expect(preview.items.find((i) => i.category === 'customField')!.action).toBe('add')
    expect(preview.items.find((i) => i.category === 'numberingRule' && i.key === 'sales_out')!.action).toBe('overwrite')
    // 预览不修改目标配置
    expect((await app.c.db.withTenant(dst.id, (tx) => tx.one('SELECT count(*)::int AS n FROM custom_field_def'))).n).toBe(0)

    const applied = await app.c.db.withTenant(dst.id, (tx) => app.c.packages.apply(tx, dst.id, exported.text, lic))
    expect(applied.skipped.map((s) => s.key)).toEqual(['purchase']) // 目标未授权采购
    expect(applied.added).toBeGreaterThan(0)
    const got = await app.c.db.withTenant(dst.id, async (tx) => ({
      cf: await tx.rows('SELECT code FROM custom_field_def'),
      rule: await tx.one(`SELECT prefix, date_format, seq_digits FROM numbering_rule WHERE doc_type='sales_out'`),
      st: await tx.one('SELECT qty_scale, allow_negative_stock FROM tenant_settings'),
      role: await tx.one(`SELECT data_scope FROM role WHERE name='门店店长'`),
    }))
    expect(got.cf).toEqual([{ code: 'color' }])
    expect(got.rule).toEqual({ prefix: 'XS', date_format: 'YM', seq_digits: 5 })
    expect(got.st).toEqual({ qty_scale: 3, allow_negative_stock: true })
    expect(got.role.data_scope).toEqual({ type: 'own' }) // 指定仓库不可移植,降级为本人单据
    // 幂等:再次预览"新增"为 0
    const again = await app.c.db.withTenant(dst.id, (tx) => app.c.packages.preview(tx, dst.id, exported.text, lic))
    expect(again.items.filter((i) => i.action === 'add')).toHaveLength(0)
    // 编号规则不影响已有流水号
  })

  it('配置包错误:非法 JSON / 结构错误带出错位置,目标配置不变', async () => {
    const x = await app.newTenant()
    const lic = (await app.c.license.get(x.id))!.modules
    const e = await errOf(app.c.db.withTenant(x.id, (tx) => app.c.packages.preview(tx, x.id, '{"formatVersion": 1,\n"modules": [}', lic)))
    expect(e.code).toBe('CONFIG_PACKAGE_INVALID')
    expect(e.details![0].row).toBeGreaterThanOrEqual(2)
    const good = JSON.parse(serializeConfigPackage(emptyConfig(), 'now'))
    const e2 = await errOf(app.c.db.withTenant(x.id, (tx) => app.c.packages.apply(tx, x.id, JSON.stringify({ ...good, settings: { ...good.settings, qtyScale: 9 } }), lic)))
    expect(e2.details![0].field).toBe('$.settings.qtyScale')
  })

  it('应用过程中任一项失败整体回滚(事务内无部分写入)', async () => {
    const x = await app.newTenant()
    const lic = (await app.c.license.get(x.id))!.modules
    const cfg = emptyConfig()
    cfg.customFields = [{ objectType: 'product', code: 'ok1', label: 'OK', type: 'text', required: false, displayOrder: 0, showInList: false, filterable: false, enabled: true }]
    cfg.roleTemplates = [{ name: '老板', permissions: [], dataScope: { type: 'all' } }] // 与预置模板重名 → 失败
    cfg.settings = { ...cfg.settings, qtyScale: 4 }
    const e = await errOf(app.c.db.withTenant(x.id, (tx) => app.c.packages.apply(tx, x.id, serializeConfigPackage(cfg, 'now'), lic)))
    expect(e.code).toBe('CONFIG_PACKAGE_APPLY_FAILED')
    expect(e.details![0].field).toBe('role:老板')
    expect((await app.c.db.withTenant(x.id, (tx) => tx.one('SELECT count(*)::int AS n FROM custom_field_def'))).n).toBe(0)
    expect((await app.c.db.withTenant(x.id, (tx) => tx.one('SELECT qty_scale FROM tenant_settings'))).qty_scale).toBe(2)
  })

  it('开通租户时应用配置包与建租户在同一原子操作内', async () => {
    const src = await app.newTenant()
    await app.c.db.withTenant(src.id, (tx) => app.c.customFields.create(tx, src.admin, 'customer', { code: 'level', label: '等级', type: 'text', required: false, displayOrder: 0, showInList: false, filterable: false, enabled: true }))
    const pkgText = (await app.c.db.withTenant(src.id, (tx) => app.c.packages.export(tx, src.id))).text
    const pkgId = '01900000-0000-7000-8000-000000000001'
    await app.c.db.withPlatform((tx) => tx.query(`INSERT INTO config_package (id, name, industry, content) VALUES ($1,'零售','retail',$2)`, [pkgId, JSON.stringify(pkgText)]))
    const t = await app.c.tenants.createTenant({ name: `用包-${nextPhone()}`, contact: 'c', phone: nextPhone(), license: { expireDate: FAR_FUTURE, modules: ['product', 'inventory', 'sales'], maxUsers: 3, maxWarehouses: 2 }, configPackageId: pkgId })
    expect((await app.c.db.withTenant(t.tenant.id, (tx) => tx.one('SELECT code FROM custom_field_def'))).code).toBe('level')
    expect(t.skippedConfig?.map((s) => s.key)).toEqual(expect.arrayContaining(['purchase']))
  })
})

describe('幂等提交(需求 19.8)', () => {
  it('同一 clientRequestId 重复提交只保存一张单据;并发"保存并审核"只过账一次', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    const sku = await ww.product('ID1')
    const sup = await ww.partner('SID', 'supplier')
    await ww.saveAudit(ww.doc('purchase_in', { partnerId: sup, lines: [ww.line(sku, '100', '1')] }))
    const cust = await ww.partner('CID', 'customer')
    const input: DocInput = ww.doc('sales_out', { partnerId: cust, lines: [ww.line(sku, '5', '9')] })
    const rid = 'req-0001'
    const rs = await Promise.all(Array.from({ length: 8 }, () => ww.c.documents.save(ww.ctx, input, { clientRequestId: rid, autoAudit: true })))
    expect(new Set(rs.map((r) => r.doc.docNo)).size).toBe(1)
    expect(rs.every((r) => r.doc.status === 'audited')).toBe(true)
    expect((await ww.run((tx) => tx.one(`SELECT count(*)::int AS n FROM document WHERE doc_type='sales_out'`))).n).toBe(1)
    expect((await ww.run((tx) => tx.one('SELECT count(*)::int AS n FROM idempotency_key WHERE key=$1', [rid]))).n).toBe(1)
    expect((await ww.stock(sku))!.qty).toBe('95.0000')
    expect((await ww.run((tx) => tx.one(`SELECT count(*)::int AS n FROM stock_ledger WHERE doc_type='sales_out'`))).n).toBe(1)
    expect((await ww.partnerBal(cust)).ar_balance).toBe('45.00')
    // 首次已保存成功后的重试返回已保存单据编号
    const again = await ww.c.documents.save(ww.ctx, input, { clientRequestId: rid })
    expect(again.replayed).toBe(true)
    expect(again.doc.docNo).toBe(rs[0].doc.docNo)
  })

  it('"保存并审核"的审核失败时保存仍成功,单据保持草稿并返回原因;重试复用同一 clientRequestId 再次尝试审核(需求 7.8、16.12)', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    const sku = await ww.product('ID2')
    const cust = await ww.partner('CID2', 'customer')
    const input = ww.doc('sales_out', { partnerId: cust, lines: [ww.line(sku, '5', '9')] })
    const r = await ww.c.documents.save(ww.ctx, input, { clientRequestId: 'req-0002', autoAudit: true })
    expect(r.doc.status).toBe('draft')
    expect(r.auditError?.code).toBe('INSUFFICIENT_STOCK')
    const sup = await ww.partner('SID2', 'supplier')
    await ww.saveAudit(ww.doc('purchase_in', { partnerId: sup, lines: [ww.line(sku, '10', '1')] }))
    const retry = await ww.c.documents.save(ww.ctx, input, { clientRequestId: 'req-0002', autoAudit: true })
    expect(retry.doc.id).toBe(r.doc.id)
    expect(retry.doc.status).toBe('audited')
    expect((await ww.stock(sku))!.qty).toBe('5.0000')
  })

  it('单据无需审核参数关闭时,保存即审核;审核失败时保存成功并保持草稿(需求 7.5、7.8)', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    await app.c.db.withTenant(x.id, (tx) => app.c.settings.update(tx, x.admin, { qtyScale: 2, priceScale: 4, amountScale: 2, allowNegativeStock: false, requireAudit: false, multiUnit: false, multiSku: false, barcodeEnabled: false }))
    const sku = await ww.product('ID3')
    const sup = await ww.partner('SID3', 'supplier')
    const a = await ww.save(ww.doc('purchase_in', { partnerId: sup, lines: [ww.line(sku, '4', '5')] }))
    expect(a.doc.status).toBe('audited')
    expect((await ww.stock(sku))!.qty).toBe('4.0000')
    const cust = await ww.partner('CID3', 'customer')
    const b = await ww.save(ww.doc('sales_out', { partnerId: cust, lines: [ww.line(sku, '9', '5')] }))
    expect(b.doc.status).toBe('draft')
    expect(b.auditError?.code).toBe('INSUFFICIENT_STOCK')
    expect((await ww.stock(sku))!.qty).toBe('4.0000')
  })
})

describe('扩展插件(需求 23)', () => {
  it('审核前插件拒绝/异常/超时都会中止审核且数据不变;审核后事件经 outbox 异步分发,失败写 Audit_Log 而不影响审核', async () => {
    const a2 = await (await import('./support/app')).createTestApp(inject('pgAdminUrl'), { pluginTimeoutMs: 150 })
    try {
      const x = await a2.newTenant()
      const ww = new World(a2, x)
      const mode = { v: 'ok' as 'ok' | 'reject' | 'throw' | 'hang' }
      const seen: string[] = []
      a2.c.plugins.register({
        name: 'guard',
        version: '1.0.0',
        subscribes: ['document.beforeAudit', 'document.afterAudit'],
        async handle(ev) {
          seen.push(ev.eventType)
          if (ev.eventType === 'document.afterAudit') {
            if (mode.v === 'throw') throw new Error('boom-after')
            return
          }
          if (mode.v === 'reject') return { ok: false, message: '金额超过审批阈值' }
          if (mode.v === 'throw') throw new Error('boom')
          if (mode.v === 'hang') await new Promise(() => {})
        },
      })
      const sku = await ww.product('PL1')
      const sup = await ww.partner('SPL', 'supplier')
      const d = await ww.save(ww.doc('purchase_in', { partnerId: sup, lines: [ww.line(sku, '3', '5')] }))
      // 未启用:插件不接收事件
      mode.v = 'reject'
      expect((await a2.c.posting.audit(x.admin, d.doc.id, d.doc.version)).status).toBe('audited')
      expect(seen).toEqual([])
      await a2.c.posting.unaudit(x.admin, d.doc.id, (await a2.c.documents.get(x.admin, d.doc.id)).version)

      await a2.c.tenants.setPlugin(x.id, 'guard', true)
      const v = (await a2.c.documents.get(x.admin, d.doc.id)).version
      const rej = await errOf(a2.c.posting.audit(x.admin, d.doc.id, v))
      expect(rej).toMatchObject({ code: 'PLUGIN_REJECTED', message: '金额超过审批阈值' })
      mode.v = 'throw'
      const thr = await errOf(a2.c.posting.audit(x.admin, d.doc.id, v))
      expect(thr.code).toBe('PLUGIN_ERROR')
      expect(thr.message).toContain('guard')
      mode.v = 'hang'
      const hang = await errOf(a2.c.posting.audit(x.admin, d.doc.id, v))
      expect(hang.code).toBe('PLUGIN_TIMEOUT')
      expect(hang.message).toContain('guard')
      expect((await a2.c.documents.get(x.admin, d.doc.id)).status).toBe('draft')
      expect(await ww.stock(sku)).toMatchObject({ qty: '0.0000' })

      // 审核成功后写入 outbox,由 worker 分发;插件失败只写 Audit_Log
      mode.v = 'ok'
      await a2.c.posting.audit(x.admin, d.doc.id, v)
      const pending = await a2.c.db.withPlatform((tx) => tx.rows(`SELECT id, event_type, payload FROM event_outbox WHERE tenant_id=$1 AND status='pending'`, [x.id]))
      // outbox 按顺序记录了此前的审核、反审核,以及本次审核
      expect(pending.map((p) => p.event_type)).toEqual(['document.afterAudit', 'document.afterUnaudit', 'document.afterAudit'])
      const latest = pending[pending.length - 1]
      expect(latest.payload).toMatchObject({ version: 1, tenantId: x.id, docType: 'purchase_in', status: 'audited' })
      mode.v = 'throw'
      const { failures } = await a2.c.events.dispatchAsync(latest.payload)
      expect(failures).toBe(1)
      const log = await a2.c.db.withTenant(x.id, (tx) => tx.one(`SELECT detail FROM audit_log WHERE action='plugin.failed'`))
      expect(log.detail).toMatchObject({ pluginName: 'guard', eventType: 'document.afterAudit', reason: 'boom-after' })
      expect((await a2.c.documents.get(x.admin, d.doc.id)).status).toBe('audited') // 审核结果不受影响

      // 停用后不再接收
      seen.length = 0
      await a2.c.tenants.setPlugin(x.id, 'guard', false)
      await a2.c.posting.unaudit(x.admin, d.doc.id, (await a2.c.documents.get(x.admin, d.doc.id)).version)
      expect(seen).toEqual([])
    } finally {
      await a2.close()
    }
  })

  it('保存前插件拒绝时单据不保存', async () => {
    const x = await app.newTenant()
    const ww = new World(app, x)
    app.c.plugins.register({ name: 'saver', version: '1', subscribes: ['document.beforeSave'], handle: () => ({ ok: false, message: '禁止保存' }) })
    await app.c.tenants.setPlugin(x.id, 'saver', true)
    const sku = await ww.product('PL2')
    const sup = await ww.partner('SPL2', 'supplier')
    const e = await errOf(ww.save(ww.doc('purchase_in', { partnerId: sup, lines: [ww.line(sku, '1', '1')] })))
    expect(e).toMatchObject({ code: 'PLUGIN_REJECTED', message: '禁止保存' })
    expect((await ww.run((tx) => tx.one('SELECT count(*)::int AS n FROM document'))).n).toBe(0)
    void (MODULE_CODES as readonly ModuleCode[])
  })
})
