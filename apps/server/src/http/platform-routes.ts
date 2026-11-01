import { AppError, ModuleCode } from '@erp/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Container } from '../container'
import { hashPassword, randomToken, sha256, verifyPassword, fakeVerify } from '../core/crypto'
import { uuidv7 } from '../core/ids'
import { createOpenApiKey } from './open-api'

const PSESS_TTL = 12 * 3600

/** 平台运营后台接口 /platform/*。使用独立的平台管理员会话,只在本模块内使用 BYPASSRLS 的平台连接 */
export function registerPlatformRoutes(app: FastifyInstance, c: Container): void {
  const admin = async (req: FastifyRequest) => {
    const h = req.headers.authorization
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : ''
    const raw = token ? await c.kv.get(`psess:${sha256(token)}`) : null
    if (!raw) throw new AppError('UNAUTHENTICATED')
    await c.kv.expire(`psess:${sha256(token)}`, PSESS_TTL)
    return JSON.parse(raw) as { id: string; username: string }
  }
  const id = (req: FastifyRequest) => (req.params as { id: string }).id
  const body = <T extends z.ZodTypeAny>(s: T, req: FastifyRequest): z.infer<T> => {
    const r = s.safeParse(req.body ?? {})
    if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })))
    return r.data
  }

  app.post('/platform/auth/login', async (req, res) => {
    const b = body(z.object({ username: z.string(), password: z.string() }), req)
    const a = await c.db.withPlatform((tx) => tx.maybeOne('SELECT id, username, password_hash FROM platform_admin WHERE username=$1', [b.username]))
    if (!a) {
      await fakeVerify(b.password)
      throw new AppError('INVALID_CREDENTIALS')
    }
    if (!(await verifyPassword(a.password_hash, b.password))) throw new AppError('INVALID_CREDENTIALS')
    const token = randomToken(32)
    await c.kv.set(`psess:${sha256(token)}`, JSON.stringify({ id: a.id, username: a.username }), PSESS_TTL)
    res.send({ token })
  })

  app.get('/platform/tenants', async (req, res) => {
    await admin(req)
    res.send(await c.tenants.list())
  })
  // 独立部署模式下新建租户返回 STANDALONE_NO_NEW_TENANT(需求 1.9)
  app.post('/platform/tenants', async (req, res) => {
    await admin(req)
    res.status(201).send(await c.tenants.createTenant(req.body))
  })
  app.post('/platform/tenants/:id/disable', async (req, res) => {
    await admin(req)
    await c.tenants.disableTenant(id(req))
    res.send({ ok: true })
  })
  app.post('/platform/tenants/:id/enable', async (req, res) => {
    await admin(req)
    await c.tenants.enableTenant(id(req))
    res.send({ ok: true })
  })
  app.put('/platform/tenants/:id/license', async (req, res) => {
    await admin(req)
    res.send(await c.tenants.saveLicense(id(req), req.body))
  })
  app.post('/platform/tenants/:id/license-file', async (req, res) => {
    await admin(req)
    res.send(await c.tenants.importLicenseFile(id(req), String((req.body as { text?: string })?.text ?? '')))
  })
  app.put('/platform/tenants/:id/plugins/:name', async (req, res) => {
    await admin(req)
    const b = body(z.object({ enabled: z.boolean(), config: z.record(z.unknown()).optional() }), req)
    await c.tenants.setPlugin(id(req), (req.params as { name: string }).name, b.enabled, b.config)
    res.send({ ok: true })
  })
  app.post('/platform/tenants/:id/api-keys', async (req, res) => {
    await admin(req)
    const b = body(z.object({ name: z.string().min(1), scopes: z.array(z.string()).default([]) }), req)
    res.status(201).send(await createOpenApiKey(c, id(req), b.name, b.scopes))
  })
  app.put('/platform/tenants/:id/api-keys/:keyId', async (req, res) => {
    await admin(req)
    const b = body(z.object({ enabled: z.boolean() }), req)
    await c.db.withPlatform((tx) => tx.query('UPDATE open_api_key SET enabled=$3 WHERE tenant_id=$1 AND key_id=$2', [id(req), (req.params as { keyId: string }).keyId, b.enabled]))
    res.send({ ok: true })
  })

  /* 配置包:平台为指定租户导出/预览/应用,并管理行业配置包库 */
  app.get('/platform/tenants/:id/config-package', async (req, res) => {
    await admin(req)
    res.send(await c.db.withPlatform((tx) => c.packages.export(tx, id(req))))
  })
  app.post('/platform/tenants/:id/config-package/preview', async (req, res) => {
    await admin(req)
    res.send(
      await c.db.withPlatform(async (tx) => {
        const lic = await tx.maybeOne<{ modules: ModuleCode[] }>('SELECT modules FROM license WHERE tenant_id=$1', [id(req)])
        if (!lic) throw new AppError('NOT_FOUND')
        return c.packages.preview(tx, id(req), String((req.body as { text?: string })?.text ?? ''), lic.modules)
      }),
    )
  })
  app.post('/platform/tenants/:id/config-package/apply', async (req, res) => {
    await admin(req)
    const tenantId = id(req)
    const r = await c.db.withPlatform(async (tx) => {
      const lic = await tx.maybeOne<{ modules: ModuleCode[] }>('SELECT modules FROM license WHERE tenant_id=$1', [tenantId])
      if (!lic) throw new AppError('NOT_FOUND')
      const out = await c.packages.apply(tx, tenantId, String((req.body as { text?: string })?.text ?? ''), lic.modules, { type: 'platform', name: 'Platform_Admin' })
      tx.onCommit(() => c.modules.invalidate(tenantId))
      return out
    })
    res.send(r)
  })
  app.get('/platform/config-packages', async (req, res) => {
    await admin(req)
    res.send(await c.db.withPlatform((tx) => tx.rows('SELECT id, name, industry, status, created_at FROM config_package ORDER BY created_at DESC')))
  })
  app.post('/platform/config-packages', async (req, res) => {
    await admin(req)
    const b = body(z.object({ name: z.string().min(1), industry: z.string().default(''), text: z.string() }), req)
    const parsed = (await import('@erp/shared')).parseConfigPackage(b.text)
    if (!parsed.ok) throw new AppError('CONFIG_PACKAGE_INVALID', undefined, parsed.issues.map((i) => ({ field: i.path, row: i.line, reason: i.reason })))
    const pid = uuidv7()
    await c.db.withPlatform((tx) => tx.query('INSERT INTO config_package (id, name, industry, content) VALUES ($1,$2,$3,$4)', [pid, b.name, b.industry, JSON.stringify(b.text)]))
    res.status(201).send({ id: pid })
  })
  app.put('/platform/config-packages/:id', async (req, res) => {
    await admin(req)
    const b = body(z.object({ status: z.enum(['available', 'unavailable']) }), req)
    await c.db.withPlatform((tx) => tx.query('UPDATE config_package SET status=$2 WHERE id=$1', [id(req), b.status]))
    res.send({ ok: true })
  })
  app.get('/platform/plugins', async (req, res) => {
    await admin(req)
    res.send(c.plugins.names())
  })
}

/** 首次启动时创建平台管理员(SaaS 模式)。密码来自环境变量,不打印到日志 */
export async function ensurePlatformAdmin(c: Container, username: string, password: string): Promise<boolean> {
  return c.db.withPlatform(async (tx) => {
    if (await tx.maybeOne('SELECT 1 FROM platform_admin LIMIT 1')) return false
    await tx.query('INSERT INTO platform_admin (id, username, password_hash) VALUES ($1,$2,$3)', [uuidv7(), username, await hashPassword(password)])
    return true
  })
}
