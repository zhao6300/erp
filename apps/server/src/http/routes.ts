import { AppError, DOC_TYPES, DocType, MODULE_CODES, ModuleCode, loginSchema, pageQuerySchema } from '@erp/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Container } from '../container'
import type { Ctx } from '../core/context'
import { bearer, Pipeline, RouteMeta } from './pipeline'
import { registerOpenApi } from './open-api'
import { registerPlatformRoutes } from './platform-routes'

const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => {
  const r = schema.safeParse(req.body ?? {})
  if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })))
  return r.data
}
const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>
const id = (req: FastifyRequest) => (req.params as { id: string }).id
const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v))
const bool = (v: string | undefined) => (v === undefined || v === '' ? undefined : v === 'true')
const docTypeOf = (v: string | undefined): DocType | undefined => {
  if (!v) return undefined
  if (!(DOC_TYPES as readonly string[]).includes(v)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'docType', reason: '未知的单据类型' }])
  return v as DocType
}
/** cf.<编码>=... 形式的自定义字段筛选参数 */
function cfFilters(query: Record<string, any>) {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(query)) {
    if (!k.startsWith('cf.')) continue
    const parts = k.split('.')
    const code = parts[1]
    const kind = parts[2] ?? 'text'
    out[code] ??= {}
    if (kind === 'text') out[code].text = String(v)
    else if (kind === 'min' || kind === 'max') out[code][kind] = String(v)
    else if (kind === 'values') out[code].values = String(v).split(',')
    else if (kind === 'bool') out[code].bool = v === 'true'
  }
  return Object.keys(out).length ? out : undefined
}

export function registerRoutes(app: FastifyInstance, c: Container, p: Pipeline): void {
  /** 注册一条受管线保护的路由 */
  const route = <T>(method: 'get' | 'post' | 'put' | 'delete', path: string, meta: RouteMeta, handler: (ctx: Ctx, req: FastifyRequest, tx: import('../core/db').Tx) => Promise<T>) => {
    app[method](`/api${path}`, async (req, res) => {
      const out = await p.run(req, meta, (ctx, tx) => handler(ctx, req, tx))
      res.send(out ?? { ok: true })
    })
  }

  /* ───────── 公开 / 会话 ───────── */

  app.post('/api/auth/login', async (req, res) => {
    const b = body(loginSchema, req)
    res.send(await c.auth.loginByPassword(b.login, b.password, b.client, req.ip))
  })
  app.post('/api/auth/select-tenant', async (req, res) => {
    const b = body(z.object({ selectTicket: z.string(), tenantId: z.string().uuid() }), req)
    res.send(await c.auth.selectTenant(b.selectTicket, b.tenantId, req.ip))
  })
  app.post('/api/auth/wechat', async (req, res) => {
    res.send(await c.auth.loginByWechat(body(z.object({ code: z.string().min(1) }), req).code, req.ip))
  })
  app.post('/api/auth/wechat/bind', async (req, res) => {
    const b = body(z.object({ bindTicket: z.string(), phone: z.string(), password: z.string() }), req)
    res.send(await c.auth.bindWechat(b.bindTicket, b.phone, b.password, req.ip))
  })
  app.post('/api/auth/logout', async (req, res) => {
    const t = bearer(req)
    if (t) await c.auth.logout(t)
    res.send({ ok: true })
  })
  app.post('/api/auth/change-password', async (req, res) => {
    const s = await c.auth.validate(bearer(req))
    const b = body(z.object({ oldPassword: z.string(), newPassword: z.string() }), req)
    await c.auth.changePassword(s.accountId, b.oldPassword, b.newPassword)
    res.send({ ok: true })
  })

  /** 公开品牌接口:按请求 Host 查找 Branding_Config,未命中返回平台默认值(需求 5.3、5.9) */
  app.get('/api/public/branding', async (req, res) => {
    const host = (req.headers['x-forwarded-host'] as string) || req.hostname
    const b = await c.branding.byHost(host)
    res.send({ systemName: b.systemName, themeColor: b.themeColor, copyright: b.copyright, logoUrl: b.logoFileId && b.tenantId ? signedUrl(b.tenantId, b.logoFileId) : null, loginBgUrl: b.loginBgFileId && b.tenantId ? signedUrl(b.tenantId, b.loginBgFileId) : null })
  })
  const signedUrl = (tenantId: string, fileId: string) => {
    const s = c.files.signUrl(tenantId, fileId)
    return `${s.path}?expires=${s.expires}&sig=${s.sig}`
  }
  app.get('/files/:tenantId/:id', async (req, res) => {
    const { tenantId, id: fid } = req.params as { tenantId: string; id: string }
    const { expires, sig } = q(req)
    if (!c.files.verifySignature(tenantId, fid, Number(expires), sig ?? '')) throw new AppError('UNAUTHENTICATED')
    const f = await c.files.readSigned(tenantId, fid)
    res.header('content-type', f.mime).header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").header('x-content-type-options', 'nosniff').send(f.data)
  })
  /** Caddy on-demand TLS 的 ask 端点:仅放行已登记的自定义域名 */
  app.get('/internal/tls-ask', async (req, res) => {
    const domain = q(req).domain ?? ''
    res.status((await c.branding.isRegisteredDomain(domain)) ? 200 : 404).send({ ok: false })
  })

  /** 会话引导:用户、生效权限、可见模块、参数(精度)、品牌、自定义字段定义,菜单与按钮据此渲染(需求 4.5、10.9) */
  app.get('/api/session/bootstrap', async (req, res) => {
    const ctx = await p.context(req)
    const [license, modules, settings, branding, fields, scoped] = await Promise.all([
      c.license.get(ctx.tenantId),
      c.modules.visible(ctx.tenantId),
      c.settings.get(ctx.tenantId),
      c.db.withTenant(ctx.tenantId, (tx) => c.branding.get(tx)),
      Promise.all((['product', 'customer', 'supplier', 'warehouse', 'purchase_doc', 'sales_doc'] as const).map(async (o) => [o, (await c.customFields.defsFor(ctx.tenantId, o)).filter((d) => d.enabled)] as const)),
      c.db.withTenant(ctx.tenantId, (tx) => tx.one<{ name: string; must: boolean }>(`SELECT t.name, a.must_change_password AS must FROM tenant t, account a WHERE t.id=$1 AND a.id=$2`, [ctx.tenantId, ctx.accountId])),
    ])
    res.send({
      user: { id: ctx.tenantUserId, name: ctx.name, isTenantAdmin: ctx.isTenantAdmin, mustChangePassword: scoped?.must ?? false },
      tenant: { id: ctx.tenantId, name: scoped?.name },
      permissions: ctx.perms,
      modules,
      expired: license ? c.license.isExpired(license) : true,
      // 到期提醒仅对 Tenant_Admin(需求 3.4)
      licenseReminder: ctx.isTenantAdmin && license ? c.license.reminder(license) : null,
      settings: { qtyScale: settings.qtyScale, priceScale: settings.priceScale, amountScale: settings.amountScale, allowNegativeStock: settings.allowNegativeStock, requireAudit: settings.requireAudit, multiUnit: settings.multiUnit, multiSku: settings.multiSku, barcodeEnabled: settings.barcodeEnabled },
      branding: { ...branding, logoUrl: branding.logoFileId ? signedUrl(ctx.tenantId, branding.logoFileId) : null, loginBgUrl: branding.loginBgFileId ? signedUrl(ctx.tenantId, branding.loginBgFileId) : null },
      customFields: Object.fromEntries(fields),
    })
  })

  /* ───────── 基础资料:商品 ───────── */
  const pm = { module: 'product' as ModuleCode }
  route('get', '/products', { ...pm, perm: 'product:view', op: 'read' }, (_c, req, tx) => {
    const qq = q(req)
    const pg = pageQuerySchema.parse(qq)
    return c.products.list(tx, { keyword: qq.keyword, categoryId: qq.categoryId, enabled: bool(qq.enabled), cf: cfFilters(qq), page: pg.page, pageSize: pg.pageSize })
  })
  route('get', '/products/search', { ...pm, op: 'read' }, (_c, req, tx) => c.products.search(tx, q(req).keyword ?? ''))
  route('get', '/products/by-barcode', { ...pm, op: 'read' }, async (_c, req, tx) => ({ item: await c.products.findByBarcode(tx, q(req).barcode ?? '') }))
  route('get', '/products/barcode-index', { ...pm, op: 'read' }, (_c, _r, tx) => c.products.barcodeIndex(tx))
  route('get', '/products/:id', { ...pm, perm: 'product:view', op: 'read' }, (_c, req, tx) => c.products.get(tx, id(req)))
  route('post', '/products', { ...pm, perm: 'product:create', op: 'write' }, (ctx, req, tx) => c.products.create(tx, ctx, req.body))
  route('put', '/products/:id', { ...pm, perm: 'product:edit', op: 'write' }, (ctx, req, tx) => c.products.update(tx, ctx, id(req), req.body, num(q(req).version)))
  route('post', '/products/:id/enable', { ...pm, perm: 'product:edit', op: 'write' }, (ctx, req, tx) => c.products.setEnabled(tx, ctx, id(req), true))
  route('post', '/products/:id/disable', { ...pm, perm: 'product:edit', op: 'write' }, (ctx, req, tx) => c.products.setEnabled(tx, ctx, id(req), false))
  route('delete', '/products/:id', { ...pm, perm: 'product:delete', op: 'write' }, (ctx, req, tx) => c.products.delete(tx, ctx, id(req)))
  route('get', '/product-categories', { ...pm, op: 'read' }, (_c, _r, tx) => c.products.listCategories(tx))
  route('post', '/product-categories', { ...pm, perm: 'product:create', op: 'write' }, (ctx, req, tx) => {
    const b = body(z.object({ name: z.string(), parentId: z.string().uuid().nullable().optional() }), req)
    return c.products.createCategory(tx, ctx, b.name, b.parentId)
  })
  route('post', '/product-categories/:id/move', { ...pm, perm: 'product:edit', op: 'write' }, (ctx, req, tx) => c.products.moveCategory(tx, ctx, id(req), body(z.object({ parentId: z.string().uuid().nullable() }), req).parentId))

  /* ───────── 往来单位 / 仓库 / 资金 ───────── */
  route('get', '/partners', { op: 'read', perm: 'partner:view' }, (_c, req, tx) => {
    const qq = q(req)
    const pg = pageQuerySchema.parse(qq)
    return c.partners.list(tx, { keyword: qq.keyword, kind: qq.kind as 'customer' | 'supplier' | undefined, enabled: bool(qq.enabled), cf: cfFilters(qq), page: pg.page, pageSize: pg.pageSize })
  })
  route('get', '/partners/:id', { op: 'read', perm: 'partner:view' }, (_c, req, tx) => c.partners.detail(tx, id(req)))
  route('post', '/partners', { op: 'write', perm: 'partner:create' }, (ctx, req, tx) => c.partners.create(tx, ctx, req.body))
  route('put', '/partners/:id', { op: 'write', perm: 'partner:edit' }, (ctx, req, tx) => c.partners.update(tx, ctx, id(req), req.body, num(q(req).version)))
  route('post', '/partners/:id/enable', { op: 'write', perm: 'partner:edit' }, (ctx, req, tx) => c.partners.setEnabled(tx, ctx, id(req), true))
  route('post', '/partners/:id/disable', { op: 'write', perm: 'partner:edit' }, (ctx, req, tx) => c.partners.setEnabled(tx, ctx, id(req), false))

  route('get', '/warehouses', { op: 'read' }, (_c, req, tx) => c.warehouses.list(tx, { enabled: bool(q(req).enabled) }))
  route('post', '/warehouses', { op: 'write', perm: 'warehouse:create' }, (ctx, req, tx) => c.warehouses.create(tx, ctx, req.body as never))
  route('put', '/warehouses/:id', { op: 'write', perm: 'warehouse:edit' }, (ctx, req, tx) => c.warehouses.update(tx, ctx, id(req), req.body as never))
  route('post', '/warehouses/:id/enable', { op: 'write', perm: 'warehouse:edit' }, (ctx, req, tx) => c.warehouses.setEnabled(tx, ctx, id(req), true))
  route('post', '/warehouses/:id/disable', { op: 'write', perm: 'warehouse:edit' }, (ctx, req, tx) => c.warehouses.setEnabled(tx, ctx, id(req), false))

  const fm = { module: 'finance' as ModuleCode }
  route('get', '/fund-accounts', { ...fm, op: 'read' }, (_c, req, tx) => c.funds.listAccounts(tx, { enabled: bool(q(req).enabled) }))
  route('post', '/fund-accounts', { ...fm, op: 'write', perm: 'fund_account:create' }, (ctx, req, tx) => c.funds.createAccount(tx, ctx, req.body))
  route('put', '/fund-accounts/:id', { ...fm, op: 'write', perm: 'fund_account:edit' }, (ctx, req, tx) => c.funds.updateAccount(tx, ctx, id(req), req.body))
  route('post', '/fund-accounts/:id/enable', { ...fm, op: 'write', perm: 'fund_account:edit' }, (ctx, req, tx) => c.funds.setAccountEnabled(tx, ctx, id(req), true))
  route('post', '/fund-accounts/:id/disable', { ...fm, op: 'write', perm: 'fund_account:edit' }, (ctx, req, tx) => c.funds.setAccountEnabled(tx, ctx, id(req), false))
  route('get', '/fund-categories', { ...fm, op: 'read' }, (_c, req, tx) => c.funds.listCategories(tx, q(req).direction as 'in' | 'out' | undefined))
  route('post', '/fund-categories', { ...fm, op: 'write', perm: 'fund_category:create' }, (ctx, req, tx) => {
    const b = body(z.object({ direction: z.enum(['in', 'out']), name: z.string() }), req)
    return c.funds.createCategory(tx, ctx, b.direction, b.name)
  })
  route('put', '/fund-categories/:id', { ...fm, op: 'write', perm: 'fund_category:edit' }, (ctx, req, tx) => c.funds.updateCategory(tx, ctx, id(req), body(z.object({ name: z.string().optional(), enabled: z.boolean().optional() }), req)))
  route('post', '/fund-transfers', { ...fm, op: 'write', perm: 'fund_transfer:create' }, (ctx, req, tx) => c.funds.transfer(tx, ctx, body(z.object({ fromAccountId: z.string().uuid(), toAccountId: z.string().uuid(), amount: z.string(), transferDate: z.string(), remark: z.string().optional() }), req)))

  /* ───────── 单据(服务自行管理事务;权限按单据类型在服务内校验) ───────── */
  const docRoute = <T>(method: 'get' | 'post' | 'put', path: string, op: RouteMeta['op'], handler: (ctx: Ctx, req: FastifyRequest) => Promise<T>) =>
    app[method](`/api${path}`, async (req, res) => {
      const out = await p.run(req, { op, tx: 'none' }, async (ctx) => {
        const type = docTypeOf((req.body as { docType?: string })?.docType ?? q(req).docType)
        if (type) await c.modules.assertEnabled(ctx.tenantId, (await import('../docs/document.model')).DOC_META[type].module)
        return handler(ctx, req)
      })
      res.send(out)
    })
  docRoute('get', '/documents', 'read', (ctx, req) => {
    const qq = q(req)
    const pg = pageQuerySchema.parse(qq)
    return c.documents.list(ctx, { docType: docTypeOf(qq.docType), status: qq.status as never, partnerId: qq.partnerId, warehouseId: qq.warehouseId, from: qq.from, to: qq.to, keyword: qq.keyword, cf: cfFilters(qq), page: pg.page, pageSize: pg.pageSize })
  })
  app.get('/api/documents/:id', async (req, res) => res.send(await p.run(req, { op: 'read', tx: 'none' }, (ctx) => c.documents.get(ctx, id(req)))))
  docRoute('post', '/documents', 'write', (ctx, req) => {
    const qq = q(req)
    const b = (req.body ?? {}) as { clientRequestId?: string; autoAudit?: boolean; confirmCredit?: boolean; version?: number }
    return c.documents.save(ctx, req.body as never, { version: b.version ?? num(qq.version), clientRequestId: b.clientRequestId, autoAudit: b.autoAudit, confirmCredit: b.confirmCredit })
  })
  const act = (path: string, fn: (ctx: Ctx, docId: string, version: number, b: Record<string, any>) => Promise<unknown>) =>
    app.post(`/api/documents/:id/${path}`, async (req, res) => {
      const b = (req.body ?? {}) as Record<string, any>
      res.send(await p.run(req, { op: 'write', tx: 'none' }, async (ctx) => {
        if (typeof b.version !== 'number') throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'version', reason: '缺少 version' }])
        return fn(ctx, id(req), b.version, b)
      }))
    })
  act('audit', (ctx, i, v, b) => c.posting.audit(ctx, i, v, { confirmCredit: !!b.confirmCredit }))
  act('unaudit', (ctx, i, v) => c.posting.unaudit(ctx, i, v))
  act('void', (ctx, i, v) => c.documents.void(ctx, i, v))
  app.post('/api/documents/:id/generate', async (req, res) => {
    const target = docTypeOf((req.body as { targetType?: string })?.targetType)
    if (!target) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'targetType', reason: '缺少 targetType' }])
    res.send(await p.run(req, { op: 'write', tx: 'none' }, (ctx) => c.documents.generateDownstream(ctx, id(req), target)))
  })
  app.get('/api/documents/:id/progress', async (req, res) => res.send(await p.run(req, { op: 'read', tx: 'none' }, (ctx) => c.documents.progress(ctx, id(req)))))

  /* ───────── 库存 / 销售辅助 ───────── */
  const im = { module: 'inventory' as ModuleCode }
  route('get', '/stock/balances', { ...im, op: 'read' }, (ctx, req) => {
    const qq = q(req)
    return c.inventory.balances(ctx, { skuId: qq.skuId, warehouseId: qq.warehouseId, categoryId: qq.categoryId, keyword: qq.keyword, asOf: qq.asOf, tz: c.config.TZ, page: num(qq.page), pageSize: num(qq.pageSize) })
  })
  route('get', '/stock/ledger', { ...im, op: 'read' }, (ctx, req) => {
    const qq = q(req)
    return c.inventory.ledger(ctx, { skuId: qq.skuId, warehouseId: qq.warehouseId, from: qq.from, to: qq.to, tz: c.config.TZ, page: num(qq.page), pageSize: num(qq.pageSize) })
  })
  route('get', '/stock/alerts', { ...im, op: 'read' }, (ctx) => c.inventory.alerts(ctx))
  route('get', '/sales/hints', { module: 'sales', op: 'read' }, (ctx, req) => {
    const qq = q(req)
    if (!qq.skuId || !qq.warehouseId) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'skuId', reason: '缺少 skuId 或 warehouseId' }])
    return c.inventory.salesHints(ctx, { skuId: qq.skuId, warehouseId: qq.warehouseId, partnerId: qq.partnerId })
  })

  /* ───────── 报表 / 首页 ───────── */
  const rf = (req: FastifyRequest) => {
    const qq = q(req)
    return { from: qq.from, to: qq.to, warehouseId: qq.warehouseId, partnerId: qq.partnerId, categoryId: qq.categoryId, skuId: qq.skuId, groupBy: qq.groupBy as never, docCf: cfFilters(Object.fromEntries(Object.entries(qq).filter(([k]) => k.startsWith('cf.')))) }
  }
  route('get', '/dashboard', { op: 'read', mask: false }, (ctx) => c.reports.dashboard(ctx))
  route('get', '/reports', { op: 'read' }, (ctx) => c.reports.available(ctx))
  route('get', '/reports/sales-summary', { op: 'read' }, (ctx, req) => c.reports.summary(ctx, 'sales', rf(req)))
  route('get', '/reports/purchase-summary', { op: 'read' }, (ctx, req) => c.reports.summary(ctx, 'purchase', rf(req)))
  route('get', '/reports/stock-inout', { op: 'read' }, (ctx, req) => c.reports.stockInOut(ctx, rf(req)))
  route('get', '/reports/product-profit', { op: 'read' }, (ctx, req) => c.reports.productProfit(ctx, rf(req)))
  route('get', '/reports/receivables', { op: 'read' }, (ctx, req) => c.reports.receivables(ctx, 'AR', q(req).detail === 'true', rf(req)))
  route('get', '/reports/payables', { op: 'read' }, (ctx, req) => c.reports.receivables(ctx, 'AP', q(req).detail === 'true', rf(req)))
  route('get', '/reports/fund-flow', { op: 'read' }, (ctx, req) => c.reports.fundFlow(ctx, { ...rf(req), fundAccountId: q(req).fundAccountId }))

  /* ───────── 配置:业务参数 / 编号 / 模块 / 自定义字段 / 品牌 / 配置包 / 打印 ───────── */
  route('get', '/settings', { op: 'read' }, (_c, _r, tx) => c.settings.read(tx))
  route('put', '/settings', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.settings.update(tx, ctx, req.body))
  route('get', '/numbering-rules', { op: 'read' }, (_c, _r, tx) => c.settings.listRules(tx))
  route('put', '/numbering-rules/:docType', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.settings.updateRule(tx, ctx, (req.params as { docType: DocType }).docType, req.body as never))
  route('get', '/modules', { op: 'read' }, (_c, _r, tx) => c.modules.list(tx))
  route('post', '/modules/:code/enable', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.modules.enable(tx, ctx, moduleOf(req)))
  route('post', '/modules/:code/disable', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.modules.disable(tx, ctx, moduleOf(req)))
  const moduleOf = (req: FastifyRequest): ModuleCode => {
    const m = (req.params as { code: string }).code
    if (!(MODULE_CODES as readonly string[]).includes(m)) throw new AppError('NOT_FOUND')
    return m as ModuleCode
  }
  route('get', '/custom-fields/:objectType', { op: 'read' }, (_c, req, tx) => c.customFields.list(tx, (req.params as { objectType: never }).objectType))
  route('post', '/custom-fields/:objectType', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.customFields.create(tx, ctx, (req.params as { objectType: never }).objectType, req.body as never))
  route('put', '/custom-fields/def/:id', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.customFields.update(tx, ctx, id(req), req.body as never))
  route('post', '/custom-fields/def/:id/enable', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.customFields.setEnabled(tx, ctx, id(req), true))
  route('post', '/custom-fields/def/:id/disable', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.customFields.setEnabled(tx, ctx, id(req), false))
  route('get', '/branding', { op: 'read' }, (_c, _r, tx) => c.branding.get(tx))
  route('put', '/branding', { op: 'write' }, (ctx, req, tx) => c.branding.save(tx, ctx, ctx.tenantId, req.body))
  app.post('/api/branding/image', async (req, res) => {
    res.send(await p.run(req, { op: 'write' }, (ctx, tx) => c.branding.uploadImage(tx, ctx, Buffer.from(String((req.body as { base64?: string })?.base64 ?? ''), 'base64'))))
  })
  route('get', '/config-package/export', { op: 'export', adminOnly: true, mask: false }, async (ctx, _r, tx) => c.packages.export(tx, ctx.tenantId))
  route('post', '/config-package/preview', { op: 'read', adminOnly: true }, async (ctx, req, tx) => c.packages.preview(tx, ctx.tenantId, String((req.body as { text?: string })?.text ?? ''), (await c.license.get(ctx.tenantId))!.modules))
  route('post', '/config-package/apply', { op: 'write', adminOnly: true }, async (ctx, req, tx) => {
    const r = await c.packages.apply(tx, ctx.tenantId, String((req.body as { text?: string })?.text ?? ''), (await c.license.get(ctx.tenantId))!.modules, { id: ctx.tenantUserId, name: ctx.name, type: 'user' })
    return r
  })
  route('get', '/print-templates', { op: 'read' }, (_c, req, tx) => c.print.list(tx, docTypeOf(q(req).docType)))
  route('post', '/print-templates', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.print.create(tx, ctx, req.body as never))
  route('put', '/print-templates/:id', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.print.update(tx, ctx, id(req), req.body as never))
  route('post', '/print-templates/:id/default', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.print.setDefault(tx, ctx, id(req)))
  route('delete', '/print-templates/:id', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.print.delete(tx, ctx, id(req)))
  app.get('/api/documents/:id/print', async (req, res) => {
    const r = await p.run(req, { op: 'read', tx: 'none', mask: false }, async (ctx) => {
      const doc = await c.documents.get(ctx, id(req))
      c.perms.require(ctx, `${doc.docType}:print`)
      return c.print.renderHtml(ctx, id(req), q(req).templateId)
    })
    res.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:").send(r.html)
  })

  /* ───────── 权限 / 用户 / 审计 ───────── */
  route('get', '/roles', { op: 'read', adminOnly: true }, (_c, _r, tx) => c.perms.listRoles(tx))
  route('post', '/roles', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.perms.createRole(tx, ctx, req.body))
  route('put', '/roles/:id', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.perms.updateRole(tx, ctx, id(req), req.body))
  route('delete', '/roles/:id', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.perms.deleteRole(tx, ctx, id(req)))
  route('post', '/roles/:id/copy', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.perms.copyRole(tx, ctx, id(req), body(z.object({ name: z.string() }), req).name))
  route('get', '/users', { op: 'read', tx: 'none', adminOnly: true }, (ctx) => c.users.list(ctx))
  route('post', '/users', { op: 'write', tx: 'none', adminOnly: true }, (ctx, req) => c.users.create(ctx, req.body as never))
  route('post', '/users/:id/enable', { op: 'write', tx: 'none', adminOnly: true }, (ctx, req) => c.users.setStatus(ctx, id(req), true))
  route('post', '/users/:id/disable', { op: 'write', tx: 'none', adminOnly: true }, (ctx, req) => c.users.setStatus(ctx, id(req), false))
  route('put', '/users/:id/roles', { op: 'write', adminOnly: true }, (ctx, req, tx) => c.perms.assignRoles(tx, ctx, id(req), body(z.object({ roleIds: z.array(z.string().uuid()) }), req).roleIds))
  route('get', '/audit-logs', { op: 'read', adminOnly: true, mask: false }, (ctx, req, tx) => {
    const qq = q(req)
    return c.audit.query(tx, ctx, { actorId: qq.actorId, action: qq.action, objectType: qq.objectType, from: qq.from, to: qq.to, page: num(qq.page), pageSize: num(qq.pageSize) })
  })

  registerOpenApi(app, c)
  registerPlatformRoutes(app, c)
}
