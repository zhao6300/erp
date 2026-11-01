import fc from 'fast-check'
import ExcelJS from 'exceljs'
import { AppError, mergeRoles } from '@erp/shared'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { World, createTestApp, TestApp, TenantFixture } from './support/app'

let app: TestApp
beforeAll(async () => {
  app = await createTestApp(inject('pgAdminUrl'))
})
afterAll(async () => {
  await app.close()
})

const errOf = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    return e as AppError
  }
  throw new Error('expected rejection')
}

async function sheet(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('导入')
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}
async function readRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as never)
  const out: string[][] = []
  wb.worksheets[0].eachRow((row) => out.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))))
  return out
}
const PRODUCT_HEADER = ['商品编码*', '商品名称*', '基本单位*', '规格型号', '条码', '参考进价', '参考售价', '批发价', '库存下限', '库存上限', '备注']

describe('导入模板与文件检查(需求 21.2、21.9)', () => {
  it('模板首行为列标题:系统字段 + 启用的 Custom_Field,必填带 *,单选列附带可选项', async () => {
    const f = await app.newTenant()
    await app.c.db.withTenant(f.id, async (tx) => {
      await app.c.customFields.create(tx, f.admin, 'product', { code: 'grade', label: '等级', type: 'select', required: true, options: ['A', 'B'], displayOrder: 1, showInList: false, filterable: false, enabled: true })
      const off = await app.c.customFields.create(tx, f.admin, 'product', { code: 'old', label: '旧字段', type: 'text', required: false, displayOrder: 2, showInList: false, filterable: false, enabled: true })
      await app.c.customFields.setEnabled(tx, f.admin, off.id, false)
    })
    const rows = await readRows(await app.c.io.template(f.admin, 'product'))
    expect(rows[0]).toEqual([...PRODUCT_HEADER, '等级*']) // 停用字段不出现
  })

  it('拒绝:非 xlsx、列标题与模板不一致、0 行数据;不写入任何记录', async () => {
    const f = await app.newTenant()
    const ctx = f.admin
    expect((await errOf(app.c.io.preview(ctx, 'product', Buffer.from('a,b\n1,2')))).code).toBe('IMPORT_FILE_INVALID')
    expect((await errOf(app.c.io.preview(ctx, 'product', await sheet([['错误的列'], ['x']])))).message).toContain('列标题')
    expect((await errOf(app.c.io.preview(ctx, 'product', await sheet([PRODUCT_HEADER])))).message).toContain('没有数据行')
    const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(10 * 1024 * 1024 + 1)])
    expect((await errOf(app.c.io.preview(ctx, 'product', big))).message).toContain('10 MB')
    expect((await app.c.db.withTenant(f.id, (tx) => tx.one('SELECT count(*)::int AS n FROM product'))).n).toBe(0)
  })

  it('权限:导入需要新增权限,"编码已存在时更新"还需编辑权限(需求 21.10)', async () => {
    const f = await app.newTenant()
    const buf = await sheet([PRODUCT_HEADER, ['A1', '商品', '个', '', '', '', '', '', '', '', '']])
    const noPerm = app.ctx(f, f.adminUserId, mergeRoles([{ permissions: ['product:view'], dataScope: { type: 'all' } }], false))
    expect((await errOf(app.c.io.preview(noPerm, 'product', buf))).code).toBe('NO_PERMISSION')
    const createOnly = app.ctx(f, f.adminUserId, mergeRoles([{ permissions: ['product:create'], dataScope: { type: 'all' } }], false))
    await app.c.io.preview(createOnly, 'product', buf)
    expect((await errOf(app.c.io.preview(createOnly, 'product', buf, { updateExisting: true }))).code).toBe('NO_PERMISSION')
  })
})

describe('逐行校验、仅导入正确行、错误行文件(需求 21.3、21.4)', () => {
  it('列出可导入/错误行数与每条错误的 Excel 行号和原因;写入前不落库;错误行文件保留原始数据并标注原因', async () => {
    const f = await app.newTenant()
    const rows = [
      PRODUCT_HEADER,
      ['OK1', '正常商品', '个', '', '', '', '10.5', '', '', '', ''], // 行 2 正确
      ['', '缺编码', '个', '', '', '', '', '', '', '', ''], // 行 3:必填
      ['OK1', '文件内重复', '个', '', '', '', '', '', '', '', ''], // 行 4:文件内重复
      ['BAD3', '价格精度', '个', '', '', '', '1.23456789', '', '', '', ''], // 行 5:超过 4 位小数... 参考售价单价精度
      ['OK2', '另一个正确', '箱', '规格', '690123', '', '', '', '', '', '备注'], // 行 6 正确
      ['NUM', '非数字', '个', '', '', '', 'abc', '', '', '', ''], // 行 7
    ]
    const p = await app.c.io.preview(f.admin, 'product', await sheet(rows))
    expect(p.total).toBe(6)
    expect(p.valid).toBe(2)
    expect(p.invalid).toBe(4)
    expect(p.errors.map((e) => e.row)).toEqual([3, 4, 5, 7])
    expect(p.errors[0].reason).toContain('不能为空')
    expect(p.errors[1].reason).toContain('重复')
    expect((await app.c.db.withTenant(f.id, (tx) => tx.one('SELECT count(*)::int AS n FROM product'))).n).toBe(0) // 预览不写入
    const errFile = await readRows(await app.c.io.errorFile(f.admin, p.sessionId))
    expect(errFile[0][errFile[0].length - 1]).toBe('错误原因')
    expect(errFile.slice(1).map((r) => r[0])).toEqual(['', 'OK1', 'BAD3', 'NUM'])
    expect(errFile[2][errFile[2].length - 1]).toContain('重复')

    const done = await app.c.io.commit(f.admin, p.sessionId, 'valid_only')
    expect(done).toEqual({ imported: 2, updated: 0, skipped: 4 })
    const codes = (await app.c.db.withTenant(f.id, (tx) => tx.rows('SELECT code FROM product ORDER BY code'))).map((r) => r.code)
    expect(codes).toEqual(['OK1', 'OK2'])
    // 会话一次性
    expect((await errOf(app.c.io.commit(f.admin, p.sessionId, 'valid_only'))).code).toBe('NOT_FOUND')
  })

  it('选择取消:不写入任何记录', async () => {
    const f = await app.newTenant()
    const p = await app.c.io.preview(f.admin, 'product', await sheet([PRODUCT_HEADER, ['C1', 'x', '个', '', '', '', '', '', '', '', '']]))
    expect(await app.c.io.commit(f.admin, p.sessionId, 'cancel')).toEqual({ imported: 0, updated: 0, skipped: 0 })
    expect((await app.c.db.withTenant(f.id, (tx) => tx.one('SELECT count(*)::int AS n FROM product'))).n).toBe(0)
  })

  it('"编码已存在时更新":默认判错误"编码已存在";选中后仅用非空单元格覆盖,空单元格保留原值(需求 21.5)', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    await w.run((tx) => app.c.products.create(tx, f.admin, { code: 'U1', name: '原名称', baseUnit: '个', spec: '原规格', remark: '原备注', refSalePrice: '8.5' }))
    const buf = await sheet([PRODUCT_HEADER, ['U1', '新名称', '个', '', '', '', '', '', '', '', '']])
    const strict = await app.c.io.preview(f.admin, 'product', buf)
    expect(strict.errors[0].reason).toContain('编码已存在')
    const upd = await app.c.io.preview(f.admin, 'product', buf, { updateExisting: true })
    expect(upd.valid).toBe(1)
    expect(await app.c.io.commit(f.admin, upd.sessionId, 'valid_only')).toEqual({ imported: 0, updated: 1, skipped: 0 })
    const p = await w.run((tx) => tx.one(`SELECT name, spec, remark, ref_sale_price FROM product WHERE code='U1'`))
    expect(p).toEqual({ name: '新名称', spec: '原规格', remark: '原备注', ref_sale_price: '8.500000' })
  })

  it('期初库存与期初应收应付:引用必须存在;期初库存按"数量 = 期初 + Σ流水"生效', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    const sku = await w.product('OS1')
    await w.partner('OP1', 'customer')
    const stockHeader = ['SKU编码*', '仓库编码*', '期初数量*', '单位成本*']
    const bad = await app.c.io.preview(f.admin, 'opening_stock', await sheet([stockHeader, ['NOPE', 'WH001', 5, 2], ['OS1', 'NOWH', 5, 2], ['OS1', 'WH001', 10, 3]]))
    expect(bad.errors.map((e) => e.reason.includes('不存在'))).toEqual([true, true])
    await app.c.io.commit(f.admin, bad.sessionId, 'valid_only')
    expect(await w.stock(sku)).toMatchObject({ qty: '10.0000', amount: '30.00', avg_cost: '3.000000' })
    const opening = await w.run((tx) => tx.one('SELECT opening_qty FROM stock_balance WHERE sku_id=$1', [sku]))
    expect(opening.opening_qty).toBe('10.0000')
    const sup = await w.partner('OPS', 'supplier')
    await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '5', '4')] }))
    const inv = await w.run((tx) => tx.one('SELECT qty, opening_qty + (SELECT sum(qty_delta) FROM stock_ledger WHERE sku_id=$1) AS expected FROM stock_balance WHERE sku_id=$1', [sku]))
    expect(inv.qty).toBe(inv.expected)
    // 已有流水后不允许再设置期初
    const again = await app.c.io.preview(f.admin, 'opening_stock', await sheet([stockHeader, ['OS1', 'WH001', 99, 1]]))
    expect((await errOf(app.c.io.commit(f.admin, again.sessionId, 'valid_only'))).code).toBe('VALIDATION_FAILED')
    // 期初应收应付
    const balHeader = ['往来单位编码*', '期初应收', '期初应付']
    const b = await app.c.io.preview(f.admin, 'opening_balance', await sheet([balHeader, ['OP1', 120, ''], ['GHOST', 1, '']]))
    expect(b.errors).toHaveLength(1)
    await app.c.io.commit(f.admin, b.sessionId, 'valid_only')
    expect((await w.partnerBal((await w.run((tx) => tx.one(`SELECT id FROM partner WHERE code='OP1'`))).id)).ar_balance).toBe('120.00')
  })

  it('导入失败整体回滚(单个事务):中途一行写入失败时,已写入的行全部撤销(需求 21.11)', async () => {
    const f = await app.newTenant()
    const p = await app.c.io.preview(f.admin, 'product', await sheet([PRODUCT_HEADER, ['R1', 'a', '个', '', 'BC123', '', '', '', '', '', ''], ['R2', 'b', '个', '', 'BC999', '', '', '', '', '', '']]))
    expect(p.valid).toBe(2)
    // 预览之后、确认之前,有人占用了 R2 的条码 → 第二行写入时失败
    await new World(app, f).run((tx) => app.c.products.create(tx, f.admin, { code: 'SNIPE', name: 'x', baseUnit: '个', barcode: 'BC999' }))
    const e = await errOf(app.c.io.commit(f.admin, p.sessionId, 'valid_only'))
    expect(e.code).toBe('VALIDATION_FAILED')
    const codes = (await app.c.db.withTenant(f.id, (tx) => tx.rows('SELECT code FROM product ORDER BY code'))).map((r) => r.code)
    expect(codes).toEqual(['SNIPE']) // R1 没有被留下
  })
})

describe('导出(需求 21.6、21.10)', () => {
  it('导出全部筛选结果(不限分页);无成本权限时去除成本列', async () => {
    const f = await app.newTenant()
    const w = new World(app, f)
    for (let i = 0; i < 120; i++) await w.run((tx) => app.c.products.create(tx, f.admin, { code: `EXP${String(i).padStart(3, '0')}`, name: `n${i}`, baseUnit: '个', refCostPrice: '1.5', refSalePrice: '3' }))
    const full = await app.c.io.export(f.admin, 'product')
    expect(full.rows).toBe(120) // 超过单页上限 100,仍全部导出
    const rows = await readRows(full.data)
    expect(rows[0]).toContain('参考进价')
    const noCost = app.ctx(f, f.adminUserId, mergeRoles([{ permissions: ['product:export'], dataScope: { type: 'all' } }], false))
    const masked = await readRows((await app.c.io.export(noCost, 'product')).data)
    expect(masked[0]).not.toContain('参考进价')
    expect(masked[0]).toContain('参考售价')
    const noExport = app.ctx(f, f.adminUserId, mergeRoles([{ permissions: ['product:view'], dataScope: { type: 'all' } }], false))
    expect((await errOf(app.c.io.export(noExport, 'product'))).code).toBe('NO_PERMISSION')
  })

  it('后台任务:成功后可下载结果文件,7 天后清理;失败记录原因', async () => {
    const f = await app.newTenant()
    await new World(app, f).run((tx) => app.c.products.create(tx, f.admin, { code: 'J1', name: 'j', baseUnit: '个' }))
    const jobId = await app.c.io.createJob(f.admin, 'export', 'product', {})
    expect((await app.c.io.listJobs(f.admin))[0].status).toBe('queued')
    await app.c.io.runExportJob(f.admin, jobId)
    const job = (await app.c.io.listJobs(f.admin)).find((j) => j.id === jobId)!
    expect(job.status).toBe('succeeded')
    expect((await app.c.db.withTenant(f.id, (tx) => app.c.files.read(tx, job.result_file_id))).mime).toContain('spreadsheetml')
    expect(await app.c.io.purgeExpiredResults(new Date(Date.now() + 6 * 86_400_000))).toBe(0)
    expect(await app.c.io.purgeExpiredResults(new Date(Date.now() + 8 * 86_400_000))).toBe(1)
    const bad = await app.c.io.createJob(f.admin, 'export', 'not_an_object', {})
    await app.c.io.runExportJob(f.admin, bad)
    expect((await app.c.io.listJobs(f.admin)).find((j) => j.id === bad)!.status).toBe('failed')
  })
})

/* ───────── Property 26 ───────── */

const text = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() === s && s.length > 0 && !/[\u0000-\u001f]/.test(s))
const alnum = (n: number) => fc.stringMatching(new RegExp(`^[A-Za-z0-9]{1,${n}}$`))
const money = (scale: number, maxInt: number) => fc.integer({ min: 0, max: maxInt * 10 ** scale }).map((n) => (scale === 0 ? String(n) : `${Math.floor(n / 10 ** scale)}.${String(n % 10 ** scale).padStart(scale, '0')}`))
const date = fc.record({ y: fc.integer({ min: 2000, max: 2099 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) }).map(({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)

const productArb = fc.uniqueArray(
  fc.record({
    code: alnum(10),
    name: text,
    baseUnit: text,
    spec: fc.option(text, { nil: undefined }),
    barcode: fc.option(alnum(12), { nil: undefined }),
    refCostPrice: fc.option(money(2, 99999), { nil: undefined }),
    refSalePrice: fc.option(money(2, 99999), { nil: undefined }),
    stockMin: fc.option(money(2, 1000), { nil: undefined }),
    remark: fc.option(text, { nil: undefined }),
    brand: fc.option(fc.constantFrom('A', 'B', 'C'), { nil: undefined }),
    weight: fc.option(money(3, 1000), { nil: undefined }),
    shelfDate: fc.option(date, { nil: undefined }),
    tags: fc.option(fc.subarray(['x', 'y,z', 'w\\v'], { minLength: 1 }), { nil: undefined }),
    organic: fc.option(fc.boolean(), { nil: undefined }),
    qty: fc.option(fc.integer({ min: -999999, max: 999999 }), { nil: undefined }),
  }),
  { minLength: 1, maxLength: 8, selector: (p) => p.code.toLowerCase() },
).filter((list) => new Set(list.map((p) => p.barcode).filter(Boolean)).size === list.filter((p) => p.barcode).length && list.every((p) => !list.some((q) => q !== p && q.barcode && q.barcode === p.code)))

const partnerArb = fc.uniqueArray(
  fc.record({
    code: alnum(10),
    name: text,
    kind: fc.constantFrom('customer' as const, 'supplier' as const, 'both' as const),
    contact: fc.option(text, { nil: undefined }),
    phone: fc.option(alnum(11), { nil: undefined }),
    openingAr: fc.option(money(2, 99999), { nil: undefined }),
    openingAp: fc.option(money(2, 99999), { nil: undefined }),
    creditLimit: fc.option(money(2, 99999), { nil: undefined }),
    remark: fc.option(text, { nil: undefined }),
    tier: fc.option(text, { nil: undefined }),
  }),
  { minLength: 1, maxLength: 8, selector: (p) => p.code.toLowerCase() },
)

async function setupFields(f: TenantFixture) {
  await app.c.db.withTenant(f.id, async (tx) => {
    const mk = (objectType: 'product' | 'customer', code: string, label: string, type: any, extra: object = {}) =>
      app.c.customFields.create(tx, f.admin, objectType, { code, label, type, required: false, displayOrder: 0, showInList: false, filterable: false, enabled: true, ...extra })
    await mk('product', 'brand', '品牌', 'select', { options: ['A', 'B', 'C'] })
    await mk('product', 'weight', '重量', 'decimal')
    await mk('product', 'shelfDate', '上架日期', 'date')
    await mk('product', 'tags', '标签', 'multiselect', { options: ['x', 'y,z', 'w\\v'] })
    await mk('product', 'organic', '有机', 'boolean')
    await mk('product', 'qty', '整数值', 'integer')
    await mk('customer', 'tier', '等级', 'text')
  })
}

// Feature: lite-erp, Property 26: Excel 导出导入往返
describe('Property 26: Excel 导出导入往返', () => {
  it('导出为 xlsx 后导入到空白 Tenant,记录数相同且每条记录的系统字段与启用 Custom_Field 值相同', async () => {
    const src = await app.newTenant()
    const dst = await app.newTenant()
    await setupFields(src)
    await setupFields(dst)
    const ws = new World(app, src)
    await fc.assert(
      fc.asyncProperty(productArb, partnerArb, async (products, partners) => {
        // 清空源与目标
        for (const t of [src, dst]) {
          await app.c.db.withPlatform(async (tx) => {
            for (const tbl of ['partner_ledger', 'partner_balance', 'settlement', 'document_line', 'document', 'stock_ledger', 'stock_balance']) await tx.query(`DELETE FROM ${tbl} WHERE tenant_id=$1`, [t.id]).catch(() => {})
            await tx.query('DELETE FROM partner_balance WHERE tenant_id=$1', [t.id])
            await tx.query('DELETE FROM partner WHERE tenant_id=$1', [t.id])
            await tx.query('DELETE FROM product_unit WHERE tenant_id=$1', [t.id])
            await tx.query('DELETE FROM sku WHERE tenant_id=$1', [t.id])
            await tx.query('DELETE FROM code_registry WHERE tenant_id=$1', [t.id])
            await tx.query('DELETE FROM product WHERE tenant_id=$1', [t.id])
          })
        }
        for (const p of products) {
          const custom: Record<string, unknown> = {}
          if (p.brand !== undefined) custom.brand = p.brand
          if (p.weight !== undefined) custom.weight = p.weight
          if (p.shelfDate !== undefined) custom.shelfDate = p.shelfDate
          if (p.tags !== undefined) custom.tags = p.tags
          if (p.organic !== undefined) custom.organic = p.organic
          if (p.qty !== undefined) custom.qty = p.qty
          await ws.run((tx) => app.c.products.create(tx, src.admin, { code: p.code, name: p.name, baseUnit: p.baseUnit, spec: p.spec ?? '', barcode: p.barcode ?? '', refCostPrice: p.refCostPrice ?? '0', refSalePrice: p.refSalePrice ?? '0', stockMin: p.stockMin ?? null, remark: p.remark ?? '', custom }))
        }
        for (const p of partners) {
          await ws.run((tx) => app.c.partners.create(tx, src.admin, { code: p.code, name: p.name, kind: p.kind, contact: p.contact ?? '', phone: p.phone ?? '', openingAr: p.openingAr ?? '0', openingAp: p.openingAp ?? '0', creditLimit: p.kind === 'supplier' ? null : (p.creditLimit ?? null), remark: p.remark ?? '', custom: p.kind === 'supplier' ? {} : p.tier === undefined ? {} : { tier: p.tier } }))
        }

        // 导出 → 导入到空白 Tenant
        for (const obj of ['product', 'partner'] as const) {
          const exp = await app.c.io.export(src.admin, obj)
          const pv = await app.c.io.preview(dst.admin, obj, exp.data)
          expect(pv.invalid, JSON.stringify(pv.errors)).toBe(0)
          await app.c.io.commit(dst.admin, pv.sessionId, 'valid_only')
        }

        const snap = async (t: TenantFixture, table: 'product' | 'partner') =>
          app.c.db.withTenant(t.id, async (tx) => {
            const rows = table === 'product' ? await tx.rows('SELECT code,name,base_unit,spec,barcode,ref_cost_price,ref_sale_price,stock_min,remark,custom FROM product ORDER BY code') : await tx.rows('SELECT code,name,kind,contact,phone,opening_ar,opening_ap,credit_limit,remark,custom FROM partner ORDER BY code')
            return rows
          })
        const [sp, dp, sq, dq] = [await snap(src, 'product'), await snap(dst, 'product'), await snap(src, 'partner'), await snap(dst, 'partner')]
        expect(dp).toHaveLength(sp.length)
        expect(dp).toEqual(sp)
        expect(dq).toHaveLength(sq.length)
        // 供应商的自定义字段(客户专属)不属于其对象,允许差异仅限该情形
        expect(dq.map(({ custom: _c, ...r }) => r)).toEqual(sq.map(({ custom: _c, ...r }) => r))
        for (let i = 0; i < sq.length; i++) if (sq[i].kind !== 'supplier') expect(dq[i].custom).toEqual(sq[i].custom)
      }),
      { numRuns: 25 },
    )
  })
})
