import ExcelJS from 'exceljs'
import {
  AppError,
  ColumnDef,
  FieldDef,
  FieldType,
  ObjectType,
  buildValueSchema,
  columnVisible,
  dec,
  formatCell,
  parseCell,
  visibilityOf,
  CellValue,
} from '@erp/shared'
import type { CustomFieldService } from '../config/customFields.service'
import type { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import type { FileService } from '../core/files.service'
import { uuidv7 } from '../core/ids'
import type { Kv } from '../core/kv'
import type { PermissionService } from '../core/permission/permission.service'
import type { InventoryService } from '../docs/inventory.service'
import type { PartnerService } from '../master/partner.service'
import type { ProductService } from '../master/product.service'

export const IMPORT_OBJECTS = ['product', 'partner', 'opening_stock', 'opening_balance'] as const
export type ImportObject = (typeof IMPORT_OBJECTS)[number]

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024
export const MAX_IMPORT_ROWS = 50_000
export const BACKGROUND_THRESHOLD = 5_000
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04] // zip

const IMPORT_PERM: Record<ImportObject, string> = { product: 'product', partner: 'partner', opening_stock: 'stock', opening_balance: 'partner' }
const CF_OBJECT: Partial<Record<ImportObject, ObjectType>> = { product: 'product', partner: 'customer' }

/** 导出与导入模板共用同一份列定义,保证往返一致(需求 21.7) */
export async function columnsFor(obj: ImportObject, cf: CustomFieldService, tx: Tx): Promise<ColumnDef[]> {
  const base: Record<ImportObject, ColumnDef[]> = {
    product: [
      { key: 'code', title: '商品编码', type: 'text', required: true },
      { key: 'name', title: '商品名称', type: 'text', required: true },
      { key: 'baseUnit', title: '基本单位', type: 'text', required: true },
      { key: 'spec', title: '规格型号', type: 'text' },
      { key: 'barcode', title: '条码', type: 'text' },
      { key: 'refCostPrice', title: '参考进价', type: 'decimal', sensitive: 'cost', scale: 'price' },
      { key: 'refSalePrice', title: '参考售价', type: 'decimal', scale: 'price' },
      { key: 'wholesalePrice', title: '批发价', type: 'decimal', scale: 'price' },
      { key: 'stockMin', title: '库存下限', type: 'decimal', scale: 'qty' },
      { key: 'stockMax', title: '库存上限', type: 'decimal', scale: 'qty' },
      { key: 'remark', title: '备注', type: 'text' },
    ],
    partner: [
      { key: 'code', title: '编码', type: 'text', required: true },
      { key: 'name', title: '名称', type: 'text', required: true },
      { key: 'kind', title: '类型', type: 'select', required: true, options: ['customer', 'supplier', 'both'] },
      { key: 'category', title: '分类', type: 'text' },
      { key: 'contact', title: '联系人', type: 'text' },
      { key: 'phone', title: '电话', type: 'text' },
      { key: 'address', title: '地址', type: 'text' },
      { key: 'taxNo', title: '税号', type: 'text' },
      { key: 'bank', title: '开户银行', type: 'text' },
      { key: 'bankAccount', title: '银行账号', type: 'text' },
      { key: 'openingAr', title: '期初应收', type: 'decimal', scale: 'amount' },
      { key: 'openingAp', title: '期初应付', type: 'decimal', scale: 'amount' },
      { key: 'creditLimit', title: '信用额度', type: 'decimal', scale: 'amount' },
      { key: 'remark', title: '备注', type: 'text' },
    ],
    opening_stock: [
      { key: 'skuCode', title: 'SKU编码', type: 'text', required: true },
      { key: 'warehouseCode', title: '仓库编码', type: 'text', required: true },
      { key: 'qty', title: '期初数量', type: 'decimal', required: true, scale: 'qty' },
      { key: 'unitCost', title: '单位成本', type: 'decimal', required: true, sensitive: 'cost', scale: 'price' },
    ],
    opening_balance: [
      { key: 'partnerCode', title: '往来单位编码', type: 'text', required: true },
      { key: 'openingAr', title: '期初应收', type: 'decimal', scale: 'amount' },
      { key: 'openingAp', title: '期初应付', type: 'decimal', scale: 'amount' },
    ],
  }
  const cols = [...base[obj]]
  const o = CF_OBJECT[obj]
  if (o) {
    // 仅包含启用的 Custom_Field(需求 6.9、21.2)
    for (const d of await cf.enabledDefs(tx, o)) cols.push(fieldToColumn(d))
  }
  return cols
}

const CF_PREFIX = 'cf.'
function fieldToColumn(d: FieldDef): ColumnDef {
  const typeMap: Record<FieldType, ColumnDef['type']> = { text: 'text', textarea: 'text', integer: 'integer', decimal: 'decimal', date: 'date', select: 'select', multiselect: 'multiselect', boolean: 'boolean', image: 'text' }
  return { key: CF_PREFIX + d.code, title: d.label, type: typeMap[d.type], required: d.required, options: d.options }
}
const headerOf = (c: ColumnDef) => (c.required ? `${c.title}*` : c.title)

export interface RowError {
  row: number
  reason: string
}
export interface ImportPreview {
  sessionId: string
  object: ImportObject
  total: number
  valid: number
  invalid: number
  errors: RowError[]
}
interface Session {
  object: ImportObject
  tenantId: string
  update: boolean
  rows: { row: number; values: Record<string, CellValue>; raw: string[] }[]
  errors: RowError[]
  headers: string[]
  rawErrorRows: { row: number; raw: string[]; reason: string }[]
}

export class ImportExportService {
  constructor(
    private db: Db,
    private kv: Kv,
    private files: FileService,
    private cf: CustomFieldService,
    private perms: PermissionService,
    private products: ProductService,
    private partners: PartnerService,
    private inventory: InventoryService,
    private audit: AuditService,
  ) {}

  /* ───────────── 模板 ───────────── */

  /** 模板:首行列标题(系统字段 + 启用的 Custom_Field),必填列带 *,单选/多选列附带可选项(数据验证)(需求 21.2) */
  async template(ctx: Ctx, obj: ImportObject): Promise<Buffer> {
    this.perms.require(ctx, `${IMPORT_PERM[obj]}:create`)
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const cols = await columnsFor(obj, this.cf, tx)
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('导入')
        ws.addRow(cols.map(headerOf))
        ws.getRow(1).font = { bold: true }
        const hint = wb.addWorksheet('说明')
        hint.addRow(['列', '必填', '可选项'])
        cols.forEach((c, i) => {
          hint.addRow([c.title, c.required ? '是' : '否', (c.options ?? []).join(' / ')])
          if (c.options?.length) {
            for (let r = 2; r <= 1001; r++) ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.options.map((o) => o.replace(/"/g, '""')).join(',')}"`] }
          }
        })
        return Buffer.from(await wb.xlsx.writeBuffer())
      },
      { readOnly: true },
    )
  }

  /* ───────────── 导入:校验 → 预览 → 确认 ───────────── */

  /** 文件检查:xlsx 魔数、≤ 10 MB、1–50,000 行、列标题与当前模板一致(需求 21.9) */
  async preview(ctx: Ctx, obj: ImportObject, data: Buffer, opts: { updateExisting?: boolean } = {}): Promise<ImportPreview> {
    if (!IMPORT_OBJECTS.includes(obj)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'object', reason: '不支持的导入对象' }])
    // 导入需要新增权限;选择"编码已存在时更新"还需编辑权限(需求 21.10)
    this.perms.require(ctx, `${IMPORT_PERM[obj]}:create`)
    if (opts.updateExisting) this.perms.require(ctx, `${IMPORT_PERM[obj]}:edit`)
    if (data.length > MAX_IMPORT_BYTES) throw new AppError('IMPORT_FILE_INVALID', '文件大小超过 10 MB', [{ field: 'file', reason: '文件大小超过 10 MB' }])
    if (data.length < 4 || !XLSX_MAGIC.every((b, i) => data[i] === b)) throw new AppError('IMPORT_FILE_INVALID', '文件不是 xlsx 格式', [{ field: 'file', reason: '文件不是 xlsx 格式' }])
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(data as never)
    } catch {
      throw new AppError('IMPORT_FILE_INVALID', '文件已损坏或不是有效的 xlsx', [{ field: 'file', reason: '文件已损坏或不是有效的 xlsx' }])
    }
    const ws = wb.worksheets[0]
    if (!ws) throw new AppError('IMPORT_FILE_INVALID', '文件没有工作表')

    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const cols = await columnsFor(obj, this.cf, tx)
        const expected = cols.map(headerOf)
        const got = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? '').trim())
        if (got.length !== expected.length || got.some((h, i) => h !== expected[i])) {
          throw new AppError('IMPORT_FILE_INVALID', '列标题与当前导入模板不一致,请重新下载模板', [{ field: 'header', reason: `期望:${expected.join('、')}` }])
        }
        const dataRows: { row: number; raw: string[] }[] = []
        ws.eachRow({ includeEmpty: false }, (row, n) => {
          if (n === 1) return
          const raw = cols.map((_, i) => cellText(row.getCell(i + 1).value))
          if (raw.every((x) => x === '')) return
          dataRows.push({ row: n, raw })
        })
        if (dataRows.length === 0) throw new AppError('IMPORT_FILE_INVALID', '文件没有数据行', [{ field: 'file', reason: '数据行为 0' }])
        if (dataRows.length > MAX_IMPORT_ROWS) throw new AppError('IMPORT_FILE_INVALID', `数据行超过 ${MAX_IMPORT_ROWS} 行`, [{ field: 'file', reason: `数据行超过 ${MAX_IMPORT_ROWS}` }])

        const session = await this.validate(tx, ctx, obj, cols, dataRows, !!opts.updateExisting)
        session.headers = expected
        const sessionId = uuidv7()
        await this.kv.set(`import:${sessionId}`, JSON.stringify(session), 1800) // 30 分钟
        return { sessionId, object: obj, total: dataRows.length, valid: session.rows.length, invalid: session.errors.length, errors: session.errors }
      },
      { readOnly: true },
    )
  }

  /** 逐行校验(写入前):必填、类型与精度、可选项、文件内编码不重复、引用在本租户存在(需求 21.3) */
  private async validate(tx: Tx, ctx: Ctx, obj: ImportObject, cols: ColumnDef[], rows: { row: number; raw: string[] }[], update: boolean): Promise<Session> {
    const session: Session = { object: obj, tenantId: ctx.tenantId, update, rows: [], errors: [], headers: [], rawErrorRows: [] }
    const fail = (r: { row: number; raw: string[] }, reason: string) => {
      session.errors.push({ row: r.row, reason })
      session.rawErrorRows.push({ row: r.row, raw: r.raw, reason })
    }
    const settings = await this.db.withTenant(ctx.tenantId, async (t) => t.one('SELECT qty_scale, price_scale, amount_scale FROM tenant_settings'))
    const keyCol = obj === 'opening_stock' ? null : obj === 'opening_balance' ? 'partnerCode' : 'code'
    const seen = new Set<string>()
    const existing = new Set<string>()
    if (obj === 'product') for (const r of await tx.rows<{ v: string }>('SELECT value AS v FROM code_registry WHERE kind=$1', ['code'])) existing.add(r.v)
    if (obj === 'partner') for (const r of await tx.rows<{ v: string }>('SELECT code AS v FROM partner')) existing.add(r.v)
    const skuByCode = new Map((await tx.rows('SELECT code, id FROM sku')).map((s) => [s.code, s.id]))
    const whByCode = new Map((await tx.rows('SELECT code, id FROM warehouse')).map((s) => [s.code, s.id]))
    const partnerByCode = new Map((await tx.rows('SELECT code, id FROM partner')).map((s) => [s.code, s.id]))
    const cfDefs = CF_OBJECT[obj] ? await this.cf.enabledDefs(tx, CF_OBJECT[obj]!) : []
    const cfSchema = buildValueSchema(cfDefs)

    for (const r of rows) {
      const values: Record<string, CellValue> = {}
      const errs: string[] = []
      cols.forEach((c, i) => {
        const text = r.raw[i]
        try {
          const v = parseCell(c, text === '' ? null : text)
          if (v === null) {
            if (c.required) errs.push(`${c.title}不能为空`)
          } else {
            if (c.options?.length && (c.type === 'select' ? !c.options.includes(v as string) : (v as string[]).some((x) => !c.options!.includes(x)))) errs.push(`${c.title}的取值不在可选项中`)
            // 数量与金额精度(需求 21.3)
            if (c.type === 'decimal' && c.scale) {
              const limit = { qty: settings.qty_scale, price: settings.price_scale, amount: settings.amount_scale }[c.scale]
              if (dec(v as string).decimalPlaces() > limit) errs.push(`${c.title}最多 ${limit} 位小数`)
            }
            values[c.key] = v
          }
        } catch (e) {
          errs.push(`${c.title}:${(e as Error).message}`)
        }
      })
      if (keyCol) {
        const key = String(values[keyCol] ?? '')
        if (key) {
          if (seen.has(key)) errs.push(`文件内编码重复:${key}`)
          seen.add(key)
          if (obj !== 'opening_balance' && existing.has(key) && !update) errs.push('编码已存在')
          if (obj === 'opening_balance' && !partnerByCode.has(key)) errs.push(`往来单位不存在:${key}`)
        }
      }
      if (obj === 'opening_stock') {
        if (values.skuCode && !skuByCode.has(String(values.skuCode))) errs.push(`SKU 不存在:${values.skuCode}`)
        if (values.warehouseCode && !whByCode.has(String(values.warehouseCode))) errs.push(`仓库不存在:${values.warehouseCode}`)
        const k = `${values.skuCode}|${values.warehouseCode}`
        if (seen.has(k)) errs.push('文件内 SKU 与仓库组合重复')
        seen.add(k)
        if (values.qty !== undefined && dec(values.qty as string).isNegative()) errs.push('期初数量不能为负')
      }
      // 自定义字段取值按字段类型约束校验(需求 6.9)
      if (cfDefs.length) {
        const custom: Record<string, unknown> = {}
        for (const d of cfDefs) if (values[CF_PREFIX + d.code] !== undefined) custom[d.code] = values[CF_PREFIX + d.code]
        const parsed = cfSchema.safeParse(custom)
        if (!parsed.success) for (const i of parsed.error.issues) errs.push(`${cfDefs.find((d) => d.code === String(i.path[0]))?.label ?? i.path[0]}:${i.message}`)
      }
      if (errs.length) fail(r, errs.join(';'))
      else session.rows.push({ row: r.row, values, raw: r.raw })
    }
    return session
  }

  /** 错误行文件:保留错误行的原始数据并在末列标注错误原因(需求 21.4) */
  async errorFile(ctx: Ctx, sessionId: string): Promise<Buffer> {
    const s = await this.session(ctx, sessionId)
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('错误行')
    ws.addRow([...s.headers, '错误原因'])
    for (const e of s.rawErrorRows) ws.addRow([...e.raw, e.reason])
    return Buffer.from(await wb.xlsx.writeBuffer())
  }

  private async session(ctx: Ctx, id: string): Promise<Session> {
    const raw = await this.kv.get(`import:${id}`)
    if (!raw) throw new AppError('NOT_FOUND', '导入会话已过期,请重新上传')
    const s = JSON.parse(raw) as Session
    if (s.tenantId !== ctx.tenantId) throw new AppError('NOT_FOUND', '导入会话已过期,请重新上传') // 跨租户 = 不存在
    return s
  }

  /**
   * 确认导入:仅导入正确行(默认)或取消;全部写入在单个事务内,失败整体回滚(需求 21.4、21.11)。
   * 超过 5,000 行时建议走后台任务(调用方据 preview.total 判断)。
   */
  async commit(ctx: Ctx, sessionId: string, choice: 'valid_only' | 'cancel'): Promise<{ imported: number; updated: number; skipped: number }> {
    const s = await this.session(ctx, sessionId)
    await this.kv.del(`import:${sessionId}`)
    if (choice === 'cancel') return { imported: 0, updated: 0, skipped: s.errors.length }
    this.perms.require(ctx, `${IMPORT_PERM[s.object]}:create`)
    if (s.update) this.perms.require(ctx, `${IMPORT_PERM[s.object]}:edit`)
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      let imported = 0
      let updated = 0
      for (const r of s.rows) {
        const res = await this.writeRow(tx, ctx, s, r.values)
        if (res === 'created') imported++
        else updated++
      }
      await this.audit.log(tx, ctx, 'import.commit', { type: s.object, id: sessionId, detail: { imported, updated, skipped: s.errors.length } })
      return { imported, updated, skipped: s.errors.length }
    })
  }

  private custom(defs: FieldDef[], values: Record<string, CellValue>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const d of defs) if (values[CF_PREFIX + d.code] !== undefined) out[d.code] = values[CF_PREFIX + d.code]
    return out
  }

  private async writeRow(tx: Tx, ctx: Ctx, s: Session, v: Record<string, CellValue>): Promise<'created' | 'updated'> {
    if (s.object === 'product') {
      const defs = await this.cf.enabledDefs(tx, 'product')
      const input = { ...pick(v, ['code', 'name', 'baseUnit', 'spec', 'barcode', 'refCostPrice', 'refSalePrice', 'wholesalePrice', 'stockMin', 'stockMax', 'remark']), custom: this.custom(defs, v) } as Record<string, unknown>
      const old = await tx.maybeOne<{ id: string }>(`SELECT owner_id AS id FROM code_registry WHERE kind='code' AND value=$1 AND owner_type='product'`, [v.code])
      if (old && s.update) {
        // 仅用非空单元格覆盖原值,空单元格保留原值(需求 21.5)
        const cur = await this.products.get(tx, old.id)
        const merged = { ...productToInput(cur), ...input, custom: { ...cur.custom, ...(input.custom as object) } }
        await this.products.update(tx, ctx, old.id, merged)
        return 'updated'
      }
      await this.products.create(tx, ctx, input)
      return 'created'
    }
    if (s.object === 'partner') {
      const cType = v.kind === 'supplier' ? 'supplier' : 'customer'
      const defs = await this.cf.enabledDefs(tx, cType)
      const input = { ...pick(v, ['code', 'name', 'kind', 'category', 'contact', 'phone', 'address', 'taxNo', 'bank', 'bankAccount', 'openingAr', 'openingAp', 'creditLimit', 'remark']), custom: this.custom(defs, v) } as Record<string, unknown>
      const old = await tx.maybeOne<{ id: string }>('SELECT id FROM partner WHERE code=$1', [v.code])
      if (old && s.update) {
        const cur = await this.partners.get(tx, old.id)
        await this.partners.update(tx, ctx, old.id, { ...partnerToInput(cur), ...input, custom: { ...cur.custom, ...(input.custom as object) } })
        return 'updated'
      }
      await this.partners.create(tx, ctx, input)
      return 'created'
    }
    if (s.object === 'opening_stock') {
      const sku = (await tx.one<{ id: string }>('SELECT id FROM sku WHERE code=$1', [v.skuCode])).id
      const wh = (await tx.one<{ id: string }>('SELECT id FROM warehouse WHERE code=$1', [v.warehouseCode])).id
      await this.inventory.setOpening(tx, ctx, sku, wh, String(v.qty), String(v.unitCost))
      return 'created'
    }
    // opening_balance:更新期初应收应付,同步当前余额
    const p = await tx.one('SELECT id, opening_ar, opening_ap FROM partner WHERE code=$1 FOR UPDATE', [v.partnerCode])
    const ar = v.openingAr === undefined ? p.opening_ar : String(v.openingAr)
    const ap = v.openingAp === undefined ? p.opening_ap : String(v.openingAp)
    await tx.query('UPDATE partner SET opening_ar=$2, opening_ap=$3 WHERE id=$1', [p.id, ar, ap])
    await tx.query('UPDATE partner_balance SET ar_balance = ar_balance + ($2::numeric - $4::numeric), ap_balance = ap_balance + ($3::numeric - $5::numeric) WHERE partner_id=$1', [p.id, ar, ap, p.opening_ar, p.opening_ap])
    return 'updated'
  }

  /* ───────────── 导出 ───────────── */

  /**
   * 导出:复用列表的同一查询与列定义,不分页;按 Data_Scope 过滤;无成本权限时去除成本列(需求 21.6、21.10)。
   * 单元格统一写成字符串,避免 Excel 自动转换日期与小数(需求 21.7)。
   */
  async export(ctx: Ctx, obj: 'product' | 'partner', f: { keyword?: string } = {}): Promise<{ data: Buffer; rows: number }> {
    this.perms.require(ctx, `${IMPORT_PERM[obj]}:export`)
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const all = await columnsFor(obj, this.cf, tx)
        const vis = visibilityOf(ctx.perms)
        const cols = all.filter((c) => columnVisible(c.key, vis) && !(c.sensitive && !vis[c.sensitive]))
        const rows: Record<string, CellValue>[] = []
        // 数据库按存储精度保存(如价格 6 位),导出必须还原为该字段的录入精度,否则导出文件无法被自己重新导入
        const inputScale: Record<string, number> = { refCostPrice: 2, refSalePrice: 2, wholesalePrice: 2, stockMin: 4, stockMax: 4, openingAr: 2, openingAp: 2, creditLimit: 2 }
        const normalize = (r: Record<string, CellValue>) => {
          for (const [k, sc] of Object.entries(inputScale)) if (typeof r[k] === 'string') r[k] = trimTrailingZeros(r[k] as string, sc)
          return r
        }
        if (obj === 'product') {
          const list = await this.collect((page) => this.products.list(tx, { keyword: f.keyword, page, pageSize: 100 }))
          for (const p of list) rows.push(normalize({ ...pick(p as never, ['code', 'name', 'baseUnit', 'spec', 'barcode', 'refCostPrice', 'refSalePrice', 'wholesalePrice', 'stockMin', 'stockMax', 'remark']), ...cfCells(p.custom) }))
        } else {
          const list = await this.collect((page) => this.partners.list(tx, { keyword: f.keyword, page, pageSize: 100 }))
          for (const p of list) rows.push(normalize({ ...pick(p as never, ['code', 'name', 'kind', 'category', 'contact', 'phone', 'address', 'taxNo', 'bank', 'bankAccount', 'openingAr', 'openingAp', 'creditLimit', 'remark']), ...cfCells(p.custom) }))
        }
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('导出')
        ws.addRow(cols.map(headerOf))
        for (const r of rows) ws.addRow(cols.map((c) => formatCell(c, r[c.key] as CellValue | undefined)))
        return { data: Buffer.from(await wb.xlsx.writeBuffer()), rows: rows.length }
      },
      { readOnly: true },
    )
  }

  private async collect<T>(page: (n: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> {
    const out: T[] = []
    for (let n = 1; ; n++) {
      const r = await page(n)
      out.push(...r.items)
      if (out.length >= r.total || r.items.length === 0) return out
    }
  }

  /* ───────────── 后台任务(> 5,000 条;结果文件保留 7 天) ───────────── */

  async createJob(ctx: Ctx, kind: 'import' | 'export', obj: string, params: unknown): Promise<string> {
    const id = uuidv7()
    await this.db.withTenant(ctx.tenantId, (tx) => tx.query(`INSERT INTO io_job (id, tenant_id, kind, object_type, status, params, created_by) VALUES ($1,$2,$3,$4,'queued',$5,$6)`, [id, ctx.tenantId, kind, obj, JSON.stringify(params ?? {}), ctx.tenantUserId]))
    return id
  }

  async listJobs(ctx: Ctx) {
    return this.db.withTenant(ctx.tenantId, (tx) => tx.rows('SELECT id, kind, object_type, status, result_file_id, error, created_at, finished_at FROM io_job ORDER BY created_at DESC LIMIT 100'), { readOnly: true })
  }

  /** 执行导出任务,成功后存结果文件;失败记录原因(任务表在失败时不回滚,便于展示) */
  async runExportJob(ctx: Ctx, jobId: string): Promise<void> {
    await this.db.withTenant(ctx.tenantId, (tx) => tx.query(`UPDATE io_job SET status='running' WHERE id=$1`, [jobId]))
    try {
      const job = await this.db.withTenant(ctx.tenantId, (tx) => tx.one('SELECT object_type, params FROM io_job WHERE id=$1', [jobId]))
      const out = await this.export(ctx, job.object_type, job.params ?? {})
      await this.db.withTenant(ctx.tenantId, async (tx) => {
        const fileId = await this.files.putBlob(tx, ctx.tenantId, out.data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', ctx.tenantUserId)
        await tx.query(`UPDATE io_job SET status='succeeded', result_file_id=$2, finished_at=now() WHERE id=$1`, [jobId, fileId])
      })
    } catch (e) {
      await this.db.withTenant(ctx.tenantId, (tx) => tx.query(`UPDATE io_job SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [jobId, (e as Error).message]))
    }
  }

  /** 清理超过 7 天的结果文件 */
  async purgeExpiredResults(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 7 * 86_400_000)
    return this.db.withPlatform(async (tx) => {
      const rows = await tx.rows<{ id: string; tenant_id: string; result_file_id: string }>(`SELECT id, tenant_id, result_file_id FROM io_job WHERE result_file_id IS NOT NULL AND finished_at < $1`, [cutoff])
      for (const r of rows) {
        await this.files.deleteBlob(tx, r.result_file_id)
        await tx.query('UPDATE io_job SET result_file_id=NULL WHERE id=$1', [r.id])
      }
      return rows.length
    })
  }
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('text' in v) return String((v as { text: unknown }).text)
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if ('result' in v) return String((v as { result: unknown }).result ?? '')
  }
  return String(v)
}

function pick<T extends Record<string, unknown>>(o: T, keys: string[]): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null && v !== '') out[k] = v as CellValue
  }
  return out
}

/** 把存储精度的小数字符串还原为录入精度:保留 scale 位,多余的末尾 0 去掉 */
function trimTrailingZeros(v: string, scale: number): string {
  return dec(v).toDecimalPlaces(scale).toFixed(scale)
}
function cfCells(custom: Record<string, unknown>): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  for (const [k, v] of Object.entries(custom)) out[CF_PREFIX + k] = v as CellValue
  return out
}

function productToInput(p: Awaited<ReturnType<ProductService['get']>>): Record<string, unknown> {
  return {
    code: p.code,
    name: p.name,
    categoryId: p.categoryId,
    spec: p.spec,
    baseUnit: p.baseUnit,
    barcode: p.barcode,
    refCostPrice: dec(p.refCostPrice).toFixed(2),
    refSalePrice: dec(p.refSalePrice).toFixed(2),
    wholesalePrice: p.wholesalePrice === null ? null : dec(p.wholesalePrice).toFixed(2),
    stockMin: p.stockMin,
    stockMax: p.stockMax,
    images: p.images,
    remark: p.remark,
    units: p.units,
  }
}
function partnerToInput(p: Awaited<ReturnType<PartnerService['get']>>): Record<string, unknown> {
  return { code: p.code, name: p.name, kind: p.kind, category: p.category, contact: p.contact, phone: p.phone, address: p.address, taxNo: p.taxNo, bank: p.bank, bankAccount: p.bankAccount, openingAr: p.openingAr, openingAp: p.openingAp, priceLevel: p.priceLevel, creditLimit: p.creditLimit, remark: p.remark }
}

