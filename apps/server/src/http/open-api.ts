import { AppError, DocType, mergeRoles, pageQuerySchema } from '@erp/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Container } from '../container'
import type { Ctx } from '../core/context'
import { hmac, randomToken, safeEqual } from '../core/crypto'
import { uuidv7 } from '../core/ids'
import { DocView } from '../docs/document.model'

/**
 * 开放接口 /open/v1(需求 23.4、23.7)。
 * - 认证:Authorization: Bearer <keyId>.<secret>;缺失、不存在、停用或租户停用都返回 OPEN_API_AUTH_FAILED 及具体原因
 * - 认证通过后调用与租户接口相同的 Service,因此校验、单据状态规则与 License 限制一致
 * - v1 响应字段由 mapper 固定,内部字段变化只需修改 mapper,已发布字段不删除、不改名
 */

export const OPEN_API_VERSION = 'v1'

/** v1 固定字段集合 */
export const mapProductV1 = (p: any) => ({ id: p.id, code: p.code, name: p.name, spec: p.spec, baseUnit: p.baseUnit, barcode: p.barcode, enabled: p.enabled, refSalePrice: p.refSalePrice, skus: p.skus.map((s: any) => ({ id: s.id, code: s.code, barcode: s.barcode, enabled: s.enabled })) })
export const mapPartnerV1 = (p: any) => ({ id: p.id, code: p.code, name: p.name, kind: p.kind, phone: p.phone, enabled: p.enabled, creditLimit: p.creditLimit, ...(p.arBalance !== undefined ? { arBalance: p.arBalance, apBalance: p.apBalance } : {}) })
export const mapStockV1 = (s: any) => ({ skuId: s.skuId, skuCode: s.skuCode, warehouseId: s.warehouseId, qty: s.qty })
export const mapDocumentV1 = (d: DocView) => ({
  id: d.id,
  docType: d.docType,
  docNo: d.docNo,
  docDate: d.docDate,
  status: d.status,
  partnerId: d.partnerId,
  warehouseId: d.warehouseId,
  totalAmount: d.totalAmount,
  version: d.version,
  lines: d.lines.map((l) => ({ lineNo: l.lineNo, skuId: l.skuId, qty: l.qty, price: l.price, discountRate: l.discountRate, amount: l.amount })),
})

const authFail = (reason: string) => new AppError('OPEN_API_AUTH_FAILED', `开放接口认证失败:${reason}`, [{ reason }])

export async function authenticateOpenApi(c: Container, req: FastifyRequest): Promise<Ctx> {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) throw authFail('缺少访问密钥')
  const token = h.slice(7).trim()
  const dot = token.indexOf('.')
  if (dot < 1) throw authFail('访问密钥格式不正确')
  const keyId = token.slice(0, dot)
  const secret = token.slice(dot + 1)
  const row = await c.db.withPlatform(async (tx) => {
    const k = await tx.maybeOne<{ tenant_id: string; secret_hash: string; enabled: boolean; scopes: string[]; status: string }>(
      'SELECT k.tenant_id, k.secret_hash, k.enabled, k.scopes, t.status FROM open_api_key k JOIN tenant t ON t.id = k.tenant_id WHERE k.key_id=$1',
      [keyId],
    )
    if (!k) return null
    // 以租户的第一个启用的管理员作为操作人,审计中标记为 open_api
    const admin = await tx.maybeOne('SELECT id, name FROM tenant_user WHERE tenant_id=$1 AND is_tenant_admin AND status=$2 ORDER BY created_at LIMIT 1', [k.tenant_id, 'enabled'])
    return { ...k, admin }
  })
  if (!row) throw authFail('访问密钥不存在')
  if (!safeEqual(row.secret_hash, hmac(c.config.BACKUP_HMAC_SECRET, secret))) throw authFail('访问密钥不存在')
  if (!row.enabled) throw authFail('访问密钥已停用')
  if (row.status !== 'enabled') throw authFail('租户已停用')
  if (!row.admin) throw authFail('租户没有可用的管理员')
  return {
    tenantId: row.tenant_id,
    tenantUserId: row.admin.id,
    accountId: '',
    name: `OpenAPI:${keyId}`,
    isTenantAdmin: false,
    // 开放接口按密钥的 scopes 授权(而非管理员全部权限):最小权限
    perms: mergeRoles([{ permissions: row.scopes, dataScope: { type: 'all' } }], false),
    client: 'api',
    ip: req.ip,
    actorType: 'open_api',
  }
}

/** 创建访问密钥,secret 只返回一次 */
export async function createOpenApiKey(c: Container, tenantId: string, name: string, scopes: string[]): Promise<{ keyId: string; secret: string }> {
  const keyId = `ak_${uuidv7().replaceAll('-', '').slice(0, 16)}`
  const secret = randomToken(30) // 密码学随机源,256 位熵量级
  await c.db.withPlatform((tx) =>
    tx.query('INSERT INTO open_api_key (id, tenant_id, key_id, secret_hash, name, scopes) VALUES ($1,$2,$3,$4,$5,$6)', [uuidv7(), tenantId, keyId, hmac(c.config.BACKUP_HMAC_SECRET, secret), name, scopes]),
  )
  return { keyId, secret }
}

export function registerOpenApi(app: FastifyInstance, c: Container): void {
  const guarded = async (req: FastifyRequest, module: 'product' | 'inventory' | 'sales' | 'purchase' | 'finance' | null, write: boolean) => {
    const ctx = await authenticateOpenApi(c, req)
    // 与租户接口相同的管线:License(过期只读)、模块开关
    if (write) await c.license.assertWritable(ctx.tenantId)
    else if (!(await c.license.get(ctx.tenantId))) throw new AppError('LICENSE_EXPIRED')
    if (module) await c.modules.assertEnabled(ctx.tenantId, module)
    return ctx
  }
  const q = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>

  app.get(`/open/${OPEN_API_VERSION}/products`, async (req, res) => {
    const ctx = await guarded(req, 'product', false)
    c.perms.require(ctx, 'product:view')
    const pg = pageQuerySchema.parse(q(req))
    const r = await c.db.withTenant(ctx.tenantId, (tx) => c.products.list(tx, { keyword: q(req).keyword, page: pg.page, pageSize: pg.pageSize }), { readOnly: true })
    res.send({ items: r.items.map(mapProductV1), total: r.total, page: r.page, pageSize: r.pageSize })
  })
  app.post(`/open/${OPEN_API_VERSION}/products`, async (req, res) => {
    const ctx = await guarded(req, 'product', true)
    c.perms.require(ctx, 'product:create')
    res.status(201).send(mapProductV1(await c.db.withTenant(ctx.tenantId, (tx) => c.products.create(tx, ctx, req.body))))
  })
  app.get(`/open/${OPEN_API_VERSION}/partners`, async (req, res) => {
    const ctx = await guarded(req, null, false)
    c.perms.require(ctx, 'partner:view')
    const pg = pageQuerySchema.parse(q(req))
    const r = await c.db.withTenant(ctx.tenantId, (tx) => c.partners.list(tx, { keyword: q(req).keyword, kind: q(req).kind as never, page: pg.page, pageSize: pg.pageSize }), { readOnly: true })
    res.send({ items: r.items.map(mapPartnerV1), total: r.total, page: r.page, pageSize: r.pageSize })
  })
  app.post(`/open/${OPEN_API_VERSION}/partners`, async (req, res) => {
    const ctx = await guarded(req, null, true)
    c.perms.require(ctx, 'partner:create')
    res.status(201).send(mapPartnerV1(await c.db.withTenant(ctx.tenantId, (tx) => c.partners.create(tx, ctx, req.body))))
  })
  app.get(`/open/${OPEN_API_VERSION}/stock`, async (req, res) => {
    const ctx = await guarded(req, 'inventory', false)
    const r = await c.inventory.balances(ctx, { skuId: q(req).skuId, warehouseId: q(req).warehouseId, page: Number(q(req).page ?? 1), pageSize: Number(q(req).pageSize ?? 50) })
    res.send({ items: r.items.map(mapStockV1), total: r.total })
  })
  app.get(`/open/${OPEN_API_VERSION}/documents`, async (req, res) => {
    const ctx = await guarded(req, null, false)
    const pg = pageQuerySchema.parse(q(req))
    const r = await c.documents.list(ctx, { docType: q(req).docType as DocType | undefined, status: q(req).status as never, from: q(req).from, to: q(req).to, page: pg.page, pageSize: pg.pageSize })
    res.send({ items: r.items.map((d) => ({ id: d.id, docType: d.docType, docNo: d.docNo, docDate: d.docDate, status: d.status, partnerId: d.partnerId, totalAmount: d.totalAmount, version: d.version })), total: r.total })
  })
  app.get(`/open/${OPEN_API_VERSION}/documents/:id`, async (req, res) => {
    const ctx = await guarded(req, null, false)
    res.send(mapDocumentV1(await c.documents.get(ctx, (req.params as { id: string }).id)))
  })
  // 通过开放接口写入的单据执行与 Web 端相同的校验、状态规则与 License 限制
  app.post(`/open/${OPEN_API_VERSION}/documents`, async (req, res) => {
    const ctx = await guarded(req, null, true)
    const b = (req.body ?? {}) as { clientRequestId?: string }
    const r = await c.documents.save(ctx, req.body as never, { clientRequestId: b.clientRequestId })
    res.status(201).send({ ...mapDocumentV1(r.doc), replayed: r.replayed })
  })
  app.post(`/open/${OPEN_API_VERSION}/documents/:id/audit`, async (req, res) => {
    const ctx = await guarded(req, null, true)
    const v = (req.body as { version?: number })?.version
    if (typeof v !== 'number') throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'version', reason: '缺少 version' }])
    res.send(mapDocumentV1(await c.posting.audit(ctx, (req.params as { id: string }).id, v)))
  })
}
