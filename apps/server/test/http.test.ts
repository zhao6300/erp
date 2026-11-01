import { mkdtempSync, readdirSync, utimesSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MODULE_CODES } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { loadConfig, ConfigError } from '../src/config'
import { buildApp } from '../src/http/app'
import { createOpenApiKey } from '../src/http/open-api'
import { ensurePlatformAdmin } from '../src/http/platform-routes'
import { pruneBackups, restoreBackup, runBackup, verifyBackup, RestoreError, inBackupWindow, startBackupScheduler } from '../src/ops/backup'
import { drainOutbox } from '../src/worker'
import { TenantFixture, TestApp, World, createTestApp, nextPhone, FAR_FUTURE } from './support/app'
import type { FastifyInstance } from 'fastify'

let app: TestApp
let http: FastifyInstance
let f: TenantFixture
let token: string

const HTTPS = { 'x-forwarded-proto': 'https' }
const auth = (t = token) => ({ ...HTTPS, authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = await createTestApp(inject('pgAdminUrl'))
  // 测试请求来自 127.0.0.1(受信代理),因此可以带 X-Forwarded-Proto
  http = await buildApp(app.c)
  f = await app.newTenant()
  const r = await app.c.auth.loginByPassword(f.adminPhone, f.adminPassword, 'web')
  if (r.status !== 'ok') throw new Error('login failed')
  token = r.token
})
afterAll(async () => {
  await http.close()
  await app.close()
})

describe('启动配置(需求 1.1、1.8)', () => {
  it('DEPLOYMENT_MODE 缺失或非法时启动失败并指明配置无效;两种合法取值均可', () => {
    const base = { DATABASE_ADMIN_URL: 'x', DATABASE_APP_URL: 'x', DATABASE_PLATFORM_URL: 'x' }
    expect(() => loadConfig({ ...base })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, DEPLOYMENT_MODE: 'cloud' })).toThrow(/Deployment_Mode 配置无效/)
    expect(loadConfig({ ...base, DEPLOYMENT_MODE: 'saas' }).DEPLOYMENT_MODE).toBe('saas')
    expect(loadConfig({ ...base, DEPLOYMENT_MODE: 'standalone' }).DEPLOYMENT_MODE).toBe('standalone')
  })
})

describe('HTTPS 强制(需求 22.7)', () => {
  it('明文请求被拒绝为 HTTPS_REQUIRED,且不执行任何业务逻辑(登录失败计数不增加)', async () => {
    const before = (await app.c.db.withPlatform((tx) => tx.one('SELECT failed_count FROM account WHERE phone=$1', [f.adminPhone]))).failed_count
    const res = await http.inject({ method: 'POST', url: '/api/auth/login', payload: { login: f.adminPhone, password: 'wrong-password' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('HTTPS_REQUIRED')
    expect((await app.c.db.withPlatform((tx) => tx.one('SELECT failed_count FROM account WHERE phone=$1', [f.adminPhone]))).failed_count).toBe(before)
  })

  it('不受信任来源伪造的 X-Forwarded-Proto 不被采信', async () => {
    const strict = await buildApp(app.c)
    const res = await strict.inject({ method: 'GET', url: '/api/products', remoteAddress: '203.0.113.9', headers: { ...HTTPS, authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('HTTPS_REQUIRED')
    await strict.close()
  })
})

describe('请求管线与错误格式(设计:请求处理管线、Error Handling)', () => {
  it('未登录 401;统一错误结构 { code, message, requestId }', async () => {
    const res = await http.inject({ method: 'GET', url: '/api/products', headers: HTTPS })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(res.json().requestId).toBeTruthy()
  })

  it('创建商品 → 查询 → 校验失败返回 422 与字段级 details;请求体中的 tenantId 被忽略(需求 2.5)', async () => {
    const created = await http.inject({ method: 'POST', url: '/api/products', headers: auth(), payload: { code: 'H1', name: 'HTTP商品', baseUnit: '个', tenantId: '00000000-0000-7000-8000-000000000000' } })
    expect(created.statusCode).toBe(200)
    expect(created.json().code).toBe('H1')
    const bad = await http.inject({ method: 'POST', url: '/api/products', headers: auth(), payload: { code: '', name: '', baseUnit: '' } })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().code).toBe('VALIDATION_FAILED')
    expect(bad.json().details.map((d: { field: string }) => d.field).sort()).toEqual(['baseUnit', 'code', 'name'])
    const row = await app.c.db.withTenant(f.id, (tx) => tx.one(`SELECT tenant_id FROM product WHERE code='H1'`))
    expect(row.tenant_id).toBe(f.id) // 写入的是会话所属租户
  })

  it('另一个租户看不到该商品;按他租户 id 访问与访问不存在的 id 响应完全相同(需求 2.3)', async () => {
    const other = await app.newTenant()
    const o = await app.c.auth.loginByPassword(other.adminPhone, other.adminPassword, 'web')
    if (o.status !== 'ok') throw new Error()
    const mine = (await http.inject({ method: 'GET', url: '/api/products?keyword=H1', headers: auth() })).json()
    const id = mine.items[0].id
    const theirs = (await http.inject({ method: 'GET', url: '/api/products?keyword=H1', headers: auth(o.token) })).json()
    expect(theirs.items).toHaveLength(0)
    const cross = await http.inject({ method: 'GET', url: `/api/products/${id}`, headers: auth(o.token) })
    const missing = await http.inject({ method: 'GET', url: `/api/products/01900000-0000-7000-8000-00000000dead`, headers: auth(o.token) })
    expect(cross.statusCode).toBe(404)
    expect({ ...cross.json(), requestId: '' }).toEqual({ ...missing.json(), requestId: '' })
  })

  it('权限:无权限用户得到 NO_PERMISSION;响应不包含成本字段(需求 10.4、10.6)', async () => {
    const created = await app.c.users.create(f.admin, { name: '只读', phone: nextPhone(), password: 'Passw0rd!z' })
    const roles = await app.c.db.withTenant(f.id, (tx) => app.c.perms.listRoles(tx))
    const sales = roles.find((r) => r.name === '销售员')!
    await app.c.db.withTenant(f.id, (tx) => app.c.perms.assignRoles(tx, f.admin, created.user.id, [sales.id]))
    const l = await app.c.auth.loginByPassword(created.user.phone, 'Passw0rd!z', 'web')
    if (l.status !== 'ok') throw new Error()
    // 销售员无 product:create
    const denied = await http.inject({ method: 'POST', url: '/api/products', headers: auth(l.token), payload: { code: 'X', name: 'x', baseUnit: '个' } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe('NO_PERMISSION')
    // 有 product:view,但无 field:cost → 响应不含 refCostPrice
    const list = (await http.inject({ method: 'GET', url: '/api/products', headers: auth(l.token) })).json()
    expect(list.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(list)).not.toContain('refCostPrice')
    const admin = (await http.inject({ method: 'GET', url: '/api/products', headers: auth() })).json()
    expect(JSON.stringify(admin)).toContain('refCostPrice')
  })

  it('模块关闭 → MODULE_DISABLED;License 过期 → 写操作 LICENSE_EXPIRED、读操作放行(需求 3.5、4.6)', async () => {
    const t = await app.newTenant({ license: { expireDate: '2026-10-05' } })
    const lg = await app.c.auth.loginByPassword(t.adminPhone, t.adminPassword, 'web')
    if (lg.status !== 'ok') throw new Error()
    await app.c.db.withTenant(t.id, (tx) => app.c.modules.disable(tx, t.admin, 'sales'))
    const off = await http.inject({ method: 'GET', url: '/api/sales/hints?skuId=a&warehouseId=b', headers: auth(lg.token) })
    expect(off.json().code).toBe('MODULE_DISABLED')
    // 过期前可写
    const ok = await http.inject({ method: 'POST', url: '/api/products', headers: auth(lg.token), payload: { code: 'E1', name: 'e', baseUnit: '个' } })
    expect(ok.statusCode).toBe(200)
    app.setNow('2026-10-06T00:00:00Z')
    const w = await http.inject({ method: 'POST', url: '/api/products', headers: auth(lg.token), payload: { code: 'E2', name: 'e', baseUnit: '个' } })
    expect(w.statusCode).toBe(403)
    expect(w.json().code).toBe('LICENSE_EXPIRED')
    const r = await http.inject({ method: 'GET', url: '/api/products', headers: auth(lg.token) })
    expect(r.statusCode).toBe(200)
    expect(r.json().items.map((p: { code: string }) => p.code)).toEqual(['E1']) // 数据不变
    app.setNow('2026-09-30T04:00:00Z')
  })

  it('/session/bootstrap 返回已剔除未授权/未启用模块的菜单数据、权限、精度、品牌;到期提醒仅对 Tenant_Admin(需求 3.4、3.7、4.5)', async () => {
    const t = await app.newTenant({ license: { expireDate: '2026-10-10', modules: ['product', 'inventory', 'sales'] } })
    const lg = await app.c.auth.loginByPassword(t.adminPhone, t.adminPassword, 'web')
    if (lg.status !== 'ok') throw new Error()
    await app.c.db.withTenant(t.id, (tx) => app.c.modules.disable(tx, t.admin, 'sales'))
    const b = (await http.inject({ method: 'GET', url: '/api/session/bootstrap', headers: auth(lg.token) })).json()
    expect(b.modules.sort()).toEqual(['inventory', 'product'])
    expect(b.licenseReminder).toEqual({ expireDate: '2026-10-10', daysLeft: 10 })
    expect(b.settings).toMatchObject({ qtyScale: 2, priceScale: 4, amountScale: 2 })
    expect(b.branding.systemName).toBe('Lite ERP')
    expect(b.permissions.isAdmin).toBe(true)
    expect(b.user.mustChangePassword).toBe(true) // 初始密码须首次登录修改
  })

  it('公开品牌接口按 Host 返回,未登记域名回退默认;未登录可访问', async () => {
    const t = await app.newTenant()
    await app.c.db.withTenant(t.id, (tx) => app.c.branding.save(tx, t.admin, t.id, { systemName: '域名品牌', themeColor: '#00AA00', customDomain: 'erp.mycompany.test' }))
    const hit = await http.inject({ method: 'GET', url: '/api/public/branding', headers: { ...HTTPS, host: 'erp.mycompany.test' } })
    expect(hit.json()).toMatchObject({ systemName: '域名品牌', themeColor: '#00AA00' })
    const miss = await http.inject({ method: 'GET', url: '/api/public/branding', headers: { ...HTTPS, host: 'nobody.test' } })
    expect(miss.json()).toMatchObject({ systemName: 'Lite ERP', themeColor: '#1677FF' })
    const ask = await http.inject({ method: 'GET', url: '/internal/tls-ask?domain=erp.mycompany.test' })
    expect(ask.statusCode).toBe(200)
    expect((await http.inject({ method: 'GET', url: '/internal/tls-ask?domain=evil.test' })).statusCode).toBe(404)
  })

  it('单据:保存 → 审核 → 打印 HTML;审核按钮需要 version;内部错误只返回 requestId', async () => {
    const w = new World(app, f)
    const sku = (await w.run((tx) => tx.one(`SELECT s.id FROM sku s JOIN product p ON p.id=s.product_id WHERE p.code='H1'`))).id
    const sup = await w.partner('HS', 'supplier')
    const saved = await http.inject({ method: 'POST', url: '/api/documents', headers: auth(), payload: w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '5', '12.5')] }) })
    expect(saved.statusCode).toBe(200)
    const doc = saved.json().doc
    expect(doc.docNo).toMatch(/^CGRK\d{8}\d{4}$/)
    const noVersion = await http.inject({ method: 'POST', url: `/api/documents/${doc.id}/audit`, headers: auth(), payload: {} })
    expect(noVersion.statusCode).toBe(422)
    const audited = await http.inject({ method: 'POST', url: `/api/documents/${doc.id}/audit`, headers: auth(), payload: { version: doc.version } })
    expect(audited.json().status).toBe('audited')
    const stale = await http.inject({ method: 'POST', url: `/api/documents/${doc.id}/audit`, headers: auth(), payload: { version: doc.version } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('DOC_STATUS_CHANGED')
    const html = await http.inject({ method: 'GET', url: `/api/documents/${doc.id}/print`, headers: auth() })
    expect(html.statusCode).toBe(200)
    expect(html.headers['content-type']).toContain('text/html')
    expect(html.headers['content-security-policy']).toContain("default-src 'none'")
    expect(html.body).toContain(doc.docNo)
    expect(html.body).toContain('62.50')
    expect(html.body).not.toContain('{{')
  })
})

describe('平台后台与独立部署(需求 1.9)', () => {
  it('平台管理员登录后可开通/停用租户;租户令牌不能访问平台接口', async () => {
    await ensurePlatformAdmin(app.c, 'root', 'Root-Passw0rd')
    expect((await http.inject({ method: 'GET', url: '/platform/tenants', headers: HTTPS })).statusCode).toBe(401)
    expect((await http.inject({ method: 'GET', url: '/platform/tenants', headers: auth() })).statusCode).toBe(401) // 租户会话不是平台会话
    const login = await http.inject({ method: 'POST', url: '/platform/auth/login', headers: HTTPS, payload: { username: 'root', password: 'Root-Passw0rd' } })
    const pt = login.json().token
    const created = await http.inject({ method: 'POST', url: '/platform/tenants', headers: auth(pt), payload: { name: `HTTP开通-${nextPhone()}`, contact: '王', phone: nextPhone(), license: { expireDate: FAR_FUTURE, modules: [...MODULE_CODES], maxUsers: 3, maxWarehouses: 2 } } })
    expect(created.statusCode).toBe(201)
    const tid = created.json().tenant.id
    expect((await http.inject({ method: 'POST', url: `/platform/tenants/${tid}/disable`, headers: auth(pt) })).statusCode).toBe(200)
    const list = (await http.inject({ method: 'GET', url: '/platform/tenants', headers: auth(pt) })).json()
    expect(list.find((t: { id: string }) => t.id === tid).status).toBe('disabled')
    const bad = await http.inject({ method: 'POST', url: '/platform/tenants', headers: auth(pt), payload: { name: '', contact: '', phone: '1', license: {} } })
    expect(bad.statusCode).toBe(422)
  })

  it('独立部署模式:启动时自动创建唯一默认 Tenant(幂等、并发安全);拒绝新建租户', async () => {
    const standalone = await createTestApp(inject('pgAdminUrl'))
    try {
      const sc = loadConfig({ DEPLOYMENT_MODE: 'standalone', DATABASE_ADMIN_URL: standalone.t.adminUrl, DATABASE_APP_URL: standalone.t.appUrl, DATABASE_PLATFORM_URL: standalone.t.platformUrl })
      const { createContainer } = await import('../src/container')
      const c = await createContainer(sc, { db: standalone.t.db })
      const logs: string[] = []
      const rs = await Promise.all(Array.from({ length: 4 }, () => c.tenants.bootstrapStandalone({ name: '默认企业', phone: '13800009999', log: (m) => logs.push(m) })))
      expect(rs.filter((r) => r.created)).toHaveLength(1) // 并发启动只创建一个
      expect(logs.join('')).toContain('初始密码')
      expect((await standalone.t.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM tenant'))).n).toBe(1)
      const again = await c.tenants.bootstrapStandalone({ name: '默认企业', phone: '13800009999' })
      expect(again.created).toBe(false)
      const t = await standalone.t.db.withPlatform((tx) => tx.one('SELECT id FROM tenant'))
      const parts = await standalone.t.db.withTenant(t.id, async (tx) => ({ fa: await tx.rows('SELECT 1 FROM fund_account'), wh: await tx.rows('SELECT 1 FROM warehouse'), ad: await tx.rows('SELECT 1 FROM tenant_user WHERE is_tenant_admin') }))
      expect([parts.fa.length, parts.wh.length, parts.ad.length]).toEqual([1, 1, 1])
      const err = await c.tenants.createTenant({ name: 'x', contact: 'y', phone: '13800000001', license: { expireDate: FAR_FUTURE, modules: ['product'], maxUsers: 1, maxWarehouses: 1 } }).catch((e) => e)
      expect(err.code).toBe('STANDALONE_NO_NEW_TENANT')
      expect((await standalone.t.db.withPlatform((tx) => tx.one('SELECT count(*)::int AS n FROM tenant'))).n).toBe(1)
      const web = await buildApp(c)
      expect((await web.inject({ method: 'POST', url: '/platform/tenants', headers: HTTPS })).statusCode).toBe(401)
      await web.close()
    } finally {
      await standalone.close()
    }
  })
})

describe('开放接口 /open/v1(需求 23.4、23.7)', () => {
  let key: { keyId: string; secret: string }
  beforeAll(async () => {
    key = await createOpenApiKey(app.c, f.id, 'erp-sync', ['product:view', 'product:create', 'partner:view', 'partner:create', 'purchase_in:view', 'purchase_in:create', 'purchase_in:audit', 'stock:view'])
  })
  const k = (kk = key) => ({ ...HTTPS, authorization: `Bearer ${kk.keyId}.${kk.secret}` })

  it('认证失败:缺失/不存在/错误/停用密钥、租户停用,均返回 OPEN_API_AUTH_FAILED 及具体原因,不读写数据', async () => {
    const reason = async (headers: Record<string, string>) => {
      const r = await http.inject({ method: 'GET', url: '/open/v1/products', headers })
      expect(r.statusCode).toBe(401)
      expect(r.json().code).toBe('OPEN_API_AUTH_FAILED')
      return r.json().message as string
    }
    expect(await reason(HTTPS)).toContain('缺少访问密钥')
    expect(await reason({ ...HTTPS, authorization: 'Bearer nodotinhere' })).toContain('格式')
    expect(await reason({ ...HTTPS, authorization: 'Bearer ak_nope.secret' })).toContain('不存在')
    expect(await reason({ ...HTTPS, authorization: `Bearer ${key.keyId}.wrong` })).toContain('不存在')
    await app.c.db.withPlatform((tx) => tx.query('UPDATE open_api_key SET enabled=false WHERE key_id=$1', [key.keyId]))
    expect(await reason(k())).toContain('已停用')
    await app.c.db.withPlatform((tx) => tx.query('UPDATE open_api_key SET enabled=true WHERE key_id=$1', [key.keyId]))
    const t2 = await app.newTenant()
    const k2 = await createOpenApiKey(app.c, t2.id, 'x', ['product:view'])
    await app.c.tenants.disableTenant(t2.id)
    expect(await reason(k(k2))).toContain('租户已停用')
  })

  it('读取限定在密钥所属租户;v1 响应字段固定;写入执行相同的校验与权限(scopes)', async () => {
    const list = await http.inject({ method: 'GET', url: '/open/v1/products', headers: k() })
    expect(list.statusCode).toBe(200)
    const item = list.json().items[0]
    expect(Object.keys(item).sort()).toEqual(['barcode', 'baseUnit', 'code', 'enabled', 'id', 'name', 'refSalePrice', 'skus', 'spec'])
    expect(item).not.toHaveProperty('refCostPrice') // 开放接口不暴露成本
    // 相同的校验规则
    const bad = await http.inject({ method: 'POST', url: '/open/v1/products', headers: k(), payload: { code: '', name: '', baseUnit: '' } })
    expect(bad.statusCode).toBe(422)
    const ok = await http.inject({ method: 'POST', url: '/open/v1/products', headers: k(), payload: { code: 'OAPI1', name: '开放接口商品', baseUnit: '个' } })
    expect(ok.statusCode).toBe(201)
    // 缺少 scope(未授予 product:delete / sales_out:*)
    const noScope = await http.inject({ method: 'POST', url: '/open/v1/documents', headers: k(), payload: { docType: 'sales_out', docDate: '2026-09-30', lines: [] } })
    expect(noScope.statusCode).toBe(403)
    expect(noScope.json().code).toBe('NO_PERMISSION')
  })

  it('通过开放接口创建单据遵循相同的状态规则;过期后写入被拒绝(License 限制)', async () => {
    const w = new World(app, f)
    const sku = (await w.run((tx) => tx.one(`SELECT s.id FROM sku s JOIN product p ON p.id=s.product_id WHERE p.code='OAPI1'`))).id
    const sup = await w.partner('OS', 'supplier')
    const created = await http.inject({ method: 'POST', url: '/open/v1/documents', headers: k(), payload: { ...w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '3', '10')] }), clientRequestId: 'open-1' } })
    expect(created.statusCode).toBe(201)
    const again = await http.inject({ method: 'POST', url: '/open/v1/documents', headers: k(), payload: { ...w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '3', '10')] }), clientRequestId: 'open-1' } })
    expect(again.json().docNo).toBe(created.json().docNo) // 幂等
    expect(again.json().replayed).toBe(true)
    const audited = await http.inject({ method: 'POST', url: `/open/v1/documents/${created.json().id}/audit`, headers: k(), payload: { version: created.json().version } })
    expect(audited.json().status).toBe('audited')
    const again2 = await http.inject({ method: 'POST', url: `/open/v1/documents/${created.json().id}/audit`, headers: k(), payload: { version: created.json().version } })
    expect(again2.statusCode).toBe(409) // 同样的状态机规则
    const stock = await http.inject({ method: 'GET', url: `/open/v1/stock?skuId=${sku}`, headers: k() })
    expect(stock.json().items[0]).toEqual({ skuId: sku, skuCode: 'OAPI1', warehouseId: f.warehouseId, qty: '3.0000' })
    app.setNow('2099-12-31T20:00:00Z') // 北京时间 2100-01-01,已过 FAR_FUTURE
    const expired = await http.inject({ method: 'POST', url: '/open/v1/products', headers: k(), payload: { code: 'OAPI2', name: 'x', baseUnit: '个' } })
    expect(expired.json().code).toBe('LICENSE_EXPIRED')
    expect((await http.inject({ method: 'GET', url: '/open/v1/products', headers: k() })).statusCode).toBe(200) // 读取放行
    app.setNow('2026-09-30T04:00:00Z')
  })
})

describe('事件外发 worker 与 outbox', () => {
  it('drainOutbox 领取待处理事件分发给插件并标记完成;失败写 Audit_Log', async () => {
    const t = await app.newTenant()
    const w = new World(app, t)
    const seen: string[] = []
    app.c.plugins.register({ name: 'wk', version: '1', subscribes: ['document.afterAudit'], handle: (e) => void seen.push(e.docNo ?? '') })
    await app.c.tenants.setPlugin(t.id, 'wk', true)
    const sku = await w.product('WK1')
    const sup = await w.partner('SWK', 'supplier')
    const d = await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '1', '1')] }))
    expect(await drainOutbox(app.c)).toBeGreaterThanOrEqual(1)
    expect(seen).toContain(d.docNo)
    expect((await app.c.db.withPlatform((tx) => tx.one(`SELECT count(*)::int AS n FROM event_outbox WHERE tenant_id=$1 AND status='pending'`, [t.id]))).n).toBe(0)
  })
})

describe('备份与恢复(需求 22.5、22.6、22.9、22.10)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'erp-bk-'))
  const secret = 'test-secret'
  const fakeDump = (content: string) => async (file: string) => void writeFileSync(file, content)

  it('备份产出 .dump 与带 SHA-256/版本/HMAC 签名的 manifest;校验通过', async () => {
    const now = new Date(2026, 8, 30, 2, 0)
    const m = await runBackup({ dir, databaseUrl: 'x', secret, now, dump: fakeDump('DATA-1') })
    expect(m.file).toBe('backup-20260930-0200.dump')
    expect(m.sha256).toHaveLength(64)
    expect(m.migrationVersion).toBe('001_init.sql')
    expect((await verifyBackup(path.join(dir, m.file), secret)).signature).toBe(m.signature)
  })

  it('损坏、被篡改、非本系统生成、不存在的备份都被拒绝,数据库不被触碰(需求 22.10)', async () => {
    let restored = 0
    const restore = async () => void restored++
    const file = path.join(dir, 'backup-20260930-0200.dump')
    // 内容被篡改 → SHA-256 不一致
    writeFileSync(file, 'TAMPERED')
    await expect(restoreBackup({ file, databaseUrl: 'x', secret, confirm: 'RESTORE', restore })).rejects.toThrow(/SHA-256/)
    // manifest 被篡改 → 签名无效
    const good = await runBackup({ dir, databaseUrl: 'x', secret, now: new Date(2026, 8, 30, 3, 0), dump: fakeDump('DATA-2') })
    const mf = path.join(dir, good.file.replace('.dump', '.manifest.json'))
    writeFileSync(mf, JSON.stringify({ ...good, sha256: 'a'.repeat(64) }))
    await expect(restoreBackup({ file: path.join(dir, good.file), databaseUrl: 'x', secret, confirm: 'RESTORE', restore })).rejects.toThrow(/签名无效/)
    // 用别的密钥(非本系统)校验
    const good2 = await runBackup({ dir, databaseUrl: 'x', secret, now: new Date(2026, 8, 30, 4, 0), dump: fakeDump('DATA-3') })
    await expect(restoreBackup({ file: path.join(dir, good2.file), databaseUrl: 'x', secret: 'other', confirm: 'RESTORE', restore })).rejects.toThrow(RestoreError)
    await expect(restoreBackup({ file: path.join(dir, 'nope.dump'), databaseUrl: 'x', secret, confirm: 'RESTORE', restore })).rejects.toThrow(/不存在/)
    writeFileSync(path.join(dir, 'foreign.dump'), 'x')
    await expect(restoreBackup({ file: path.join(dir, 'foreign.dump'), databaseUrl: 'x', secret, confirm: 'RESTORE', restore })).rejects.toThrow(/不是由本系统生成/)
    expect(restored).toBe(0)
  })

  it('必须输入 RESTORE 确认才执行恢复,成功后执行迁移到当前版本', async () => {
    const m = await runBackup({ dir, databaseUrl: 'x', secret, now: new Date(2026, 8, 30, 5, 0), dump: fakeDump('DATA-4') })
    const calls: string[] = []
    const opts = { file: path.join(dir, m.file), databaseUrl: 'x', secret, restore: async () => void calls.push('restore'), migrate: async () => void calls.push('migrate') }
    await expect(restoreBackup({ ...opts, confirm: 'yes' })).rejects.toThrow(/RESTORE/)
    expect(calls).toEqual([])
    await restoreBackup({ ...opts, confirm: 'RESTORE' })
    expect(calls).toEqual(['restore', 'migrate'])
  })

  it('备份失败不留下不完整文件;仅在备份成功后清理 30 天以前的备份', async () => {
    const d2 = mkdtempSync(path.join(os.tmpdir(), 'erp-bk2-'))
    const old = await runBackup({ dir: d2, databaseUrl: 'x', secret, now: new Date(2026, 7, 1, 2, 0), dump: fakeDump('OLD') })
    const past = new Date(2026, 7, 1)
    for (const f of readdirSync(d2)) utimesSync(path.join(d2, f), past, past)
    await expect(runBackup({ dir: d2, databaseUrl: 'x', secret, now: new Date(2026, 8, 30, 2, 0), dump: async (f) => { writeFileSync(f, 'partial'); throw new Error('pg_dump 失败') } })).rejects.toThrow()
    expect(existsSync(path.join(d2, 'backup-20260930-0200.dump'))).toBe(false)
    expect(existsSync(path.join(d2, old.file))).toBe(true) // 失败时不删除任何已有备份
    await runBackup({ dir: d2, databaseUrl: 'x', secret, now: new Date(2026, 8, 30, 2, 5), dump: fakeDump('NEW') })
    expect(pruneBackups(d2, new Date(2026, 8, 30)).sort()).toEqual([old.file, old.file.replace('.dump', '.manifest.json')].sort())
    expect(existsSync(path.join(d2, old.file))).toBe(false)
    expect(readdirSync(d2).some((f) => f.includes('20260930-0205'))).toBe(true)
    rmSync(d2, { recursive: true, force: true })
  })

  it('备份窗口为本地时间 00:00–06:00;失败后每 20 分钟重试、最多 3 次,不删除已有备份(需求 22.9)', async () => {
    expect([inBackupWindow(new Date(2026, 8, 30, 0, 0)), inBackupWindow(new Date(2026, 8, 30, 5, 59)), inBackupWindow(new Date(2026, 8, 30, 6, 0)), inBackupWindow(new Date(2026, 8, 30, 12, 0))]).toEqual([true, true, false, false])
    let clock = new Date(2026, 8, 30, 2, 0)
    let attempts = 0
    const fake = { config: { BACKUP_DIR: mkdtempSync(path.join(os.tmpdir(), 'erp-bk3-')), DATABASE_ADMIN_URL: 'x', BACKUP_HMAC_SECRET: 's' }, clock: () => clock } as never
    const errors: string[] = []
    const orig = console.error
    console.error = (m: string) => void errors.push(String(m))
    try {
      const stop = startBackupScheduler(fake, { tickMs: 5, run: async () => { attempts++; throw new Error('磁盘已满') } })
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await wait(30)
      expect(attempts).toBe(1) // 未到 20 分钟不重试
      for (let i = 0; i < 6; i++) {
        clock = new Date(clock.getTime() + 21 * 60_000)
        await wait(30)
      }
      stop()
      expect(attempts).toBe(4) // 首次 + 最多 3 次重试
      expect(errors.some((e) => e.includes('磁盘已满'))).toBe(true)
    } finally {
      console.error = orig
    }
  })
})

describe('受信代理匹配', () => {
  it('精确 IP、CIDR、IPv4 映射地址', async () => {
    const { trustedProxyMatcher } = await import('../src/http/app')
    const m = trustedProxyMatcher('127.0.0.1, ::1, 172.16.0.0/12')
    expect(m('127.0.0.1')).toBe(true)
    expect(m('::1')).toBe(true)
    expect(m('172.18.0.5')).toBe(true)
    expect(m('::ffff:172.18.0.5')).toBe(true)
    expect(m('172.32.0.1')).toBe(false)
    expect(m('8.8.8.8')).toBe(false)
    expect(m('not-an-ip')).toBe(false)
  })
})
