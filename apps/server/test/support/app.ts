import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DocInput, ModuleCode, MODULE_CODES, mergeRoles, RoleLike, EffectivePermission } from '@erp/shared'
import { loadConfig } from '../../src/config'
import { Container, ContainerOverrides, createContainer } from '../../src/container'
import type { Ctx } from '../../src/core/context'
import { MemoryKv } from '../../src/core/kv'
import { TestDb, createTestDb } from './db'

export const FAR_FUTURE = '2099-12-31'

export interface TenantFixture {
  id: string
  name: string
  adminPhone: string
  adminPassword: string
  adminUserId: string
  admin: Ctx
  warehouseId: string
  cashId: string
}

export interface TestApp {
  c: Container
  t: TestDb
  now: Date
  setNow(d: Date | string): void
  newTenant(o?: { name?: string; license?: Partial<{ expireDate: string; modules: ModuleCode[]; maxUsers: number; maxWarehouses: number }>; phone?: string }): Promise<TenantFixture>
  ctx(f: TenantFixture, userId: string, perms: EffectivePermission, extra?: Partial<Ctx>): Ctx
  close(): Promise<void>
}

let phoneSeq = 13_800_000_000
export const nextPhone = () => String(++phoneSeq)

export async function createTestApp(adminUrl: string, overrides: ContainerOverrides = {}): Promise<TestApp> {
  const t = await createTestDb(adminUrl)
  const config = loadConfig({
    DEPLOYMENT_MODE: 'saas',
    DATABASE_ADMIN_URL: t.adminUrl,
    DATABASE_APP_URL: t.appUrl,
    DATABASE_PLATFORM_URL: t.platformUrl,
    FILE_STORAGE_DIR: mkdtempSync(path.join(os.tmpdir(), 'erp-files-')),
    TZ: 'Asia/Shanghai',
  })
  const state = { now: new Date('2026-09-30T04:00:00Z') } // 北京时间 2026-09-30 12:00
  const c = await createContainer(config, { db: t.db, kv: new MemoryKv(), clock: () => state.now, ...overrides })

  const app: TestApp = {
    c,
    t,
    get now() {
      return state.now
    },
    setNow(d) {
      state.now = typeof d === 'string' ? new Date(d) : d
    },
    async newTenant(o = {}) {
      const phone = o.phone ?? nextPhone()
      const r = await c.tenants.createTenant({
        name: o.name ?? `测试企业-${phone}`,
        contact: '张三',
        phone,
        license: { expireDate: FAR_FUTURE, modules: [...MODULE_CODES], maxUsers: 20, maxWarehouses: 10, ...o.license },
      })
      const id = r.tenant.id
      const info = await c.db.withTenant(id, async (tx) => ({
        user: await tx.one('SELECT id FROM tenant_user WHERE is_tenant_admin'),
        wh: await tx.one('SELECT id FROM warehouse'),
        cash: await tx.one('SELECT id FROM fund_account'),
      }))
      const admin: Ctx = {
        tenantId: id,
        tenantUserId: info.user.id,
        accountId: '',
        name: '张三',
        isTenantAdmin: true,
        perms: mergeRoles([], true),
        client: 'web',
        actorType: 'user',
      }
      return { id, name: r.tenant.name, adminPhone: phone, adminPassword: r.initialPassword ?? '', adminUserId: info.user.id, admin, warehouseId: info.wh.id, cashId: info.cash.id }
    },
    ctx(f, userId, perms, extra = {}) {
      return { tenantId: f.id, tenantUserId: userId, accountId: '', name: 'u', isTenantAdmin: false, perms, client: 'web', actorType: 'user', ...extra }
    },
    async close() {
      await c.close().catch(() => {})
      await t.drop().catch(() => {})
    },
  }
  return app
}

/* ───────────── 业务数据构造辅助 ───────────── */

export class World {
  skuIds = new Map<string, string>()
  constructor(
    public app: TestApp,
    public f: TenantFixture,
  ) {}
  get c() {
    return this.app.c
  }
  get ctx() {
    return this.f.admin
  }
  run<T>(fn: (tx: import('../../src/core/db').Tx) => Promise<T>) {
    return this.c.db.withTenant(this.f.id, fn)
  }

  async product(code: string, o: { refSale?: string; refCost?: string; units?: { unitName: string; ratio: number }[]; barcode?: string; custom?: Record<string, unknown> } = {}): Promise<string> {
    const p = await this.run((tx) =>
      this.c.products.create(tx, this.ctx, { code, name: `商品${code}`, baseUnit: '个', refSalePrice: o.refSale ?? '100', refCostPrice: o.refCost ?? '60', barcode: o.barcode ?? '', units: o.units, custom: o.custom }),
    )
    this.skuIds.set(code, p.skus[0].id)
    return p.skus[0].id
  }
  async partner(code: string, kind: 'customer' | 'supplier' | 'both' = 'both', o: Record<string, unknown> = {}): Promise<string> {
    return (await this.run((tx) => this.c.partners.create(tx, this.ctx, { code, name: `往来${code}`, kind, ...o }))).id
  }
  async warehouse(code: string): Promise<string> {
    return (await this.run((tx) => this.c.warehouses.create(tx, this.ctx, { code, name: `仓${code}` }))).id
  }
  async fund(name: string, opening = '0'): Promise<string> {
    return (await this.run((tx) => this.c.funds.createAccount(tx, this.ctx, { name, type: 'bank', openingBalance: opening }))).id
  }

  /** 构造单据输入 */
  doc(type: DocInput['docType'], o: Partial<DocInput> & { lines?: DocInput['lines'] }): DocInput {
    return { docType: type, docDate: '2026-09-30', docDiscount: '0', paidAmount: '0', warehouseId: this.f.warehouseId, lines: [], ...o }
  }
  line(sku: string, qty: string, price: string, o: Partial<DocInput['lines'][number]> = {}): DocInput['lines'][number] {
    return { skuId: sku, qty, price, discountRate: '100', ...o }
  }

  async stock(sku: string, wh = this.f.warehouseId) {
    return this.run((tx) => tx.maybeOne('SELECT qty, amount, avg_cost FROM stock_balance WHERE sku_id=$1 AND warehouse_id=$2', [sku, wh]))
  }
  async partnerBal(id: string) {
    return this.run((tx) => tx.one('SELECT ar_balance, ap_balance FROM partner_balance WHERE partner_id=$1', [id]))
  }
  async fundBal(id: string) {
    return (await this.run((tx) => tx.one('SELECT balance FROM fund_account WHERE id=$1', [id]))).balance as string
  }
  async save(input: DocInput & { id?: string }, opts = {}) {
    return this.c.documents.save(this.ctx, input, opts)
  }
  async saveAudit(input: DocInput & { id?: string }) {
    const r = await this.save(input)
    return this.c.posting.audit(this.ctx, r.doc.id, r.doc.version)
  }
}

export async function setupWorld(adminUrl: string, o: ContainerOverrides = {}) {
  const app = await createTestApp(adminUrl, o)
  const f = await app.newTenant()
  return { app, f, w: new World(app, f) }
}

export type { RoleLike }
