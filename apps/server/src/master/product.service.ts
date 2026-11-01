import { AppError, ProductInput, productSchema, isValidUnitRatio } from '@erp/shared'
import type { CustomFieldService, FieldFilter } from '../config/customFields.service'
import type { SettingsService } from '../config/settings.service'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Tx } from '../core/db'
import { uuidv7 } from '../core/ids'

export const MAX_CATEGORY_LEVEL = 5
export const MAX_SKUS_PER_PRODUCT = 200

export interface ProductView {
  id: string
  code: string
  name: string
  categoryId: string | null
  spec: string
  baseUnit: string
  barcode: string
  refCostPrice: string
  refSalePrice: string
  wholesalePrice: string | null
  stockMin: string | null
  stockMax: string | null
  images: string[]
  remark: string
  specDims: unknown
  enabled: boolean
  custom: Record<string, unknown>
  version: number
  units: { unitName: string; ratio: number }[]
  skus: { id: string; code: string; barcode: string; specValues: Record<string, string> | null; isDefault: boolean; enabled: boolean }[]
}

const toView = (p: any, units: any[], skus: any[]): ProductView => ({
  id: p.id,
  code: p.code,
  name: p.name,
  categoryId: p.category_id,
  spec: p.spec,
  baseUnit: p.base_unit,
  barcode: p.barcode,
  refCostPrice: p.ref_cost_price,
  refSalePrice: p.ref_sale_price,
  wholesalePrice: p.wholesale_price,
  stockMin: p.stock_min,
  stockMax: p.stock_max,
  images: p.images,
  remark: p.remark,
  specDims: p.spec_dims,
  enabled: p.enabled,
  custom: p.custom,
  version: p.version,
  units: units.filter((u) => u.product_id === p.id).map((u) => ({ unitName: u.unit_name, ratio: u.ratio })),
  skus: skus.filter((s) => s.product_id === p.id).map((s) => ({ id: s.id, code: s.code, barcode: s.barcode, specValues: s.spec_values, isDefault: s.is_default, enabled: s.enabled })),
})

export class ProductService {
  constructor(
    private settings: SettingsService,
    private cf: CustomFieldService,
    private audit: AuditService,
  ) {}

  private parse(input: unknown): ProductInput {
    const r = productSchema.safeParse(input)
    if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', reason: i.message })))
    const v = r.data
    const issues: { field: string; reason: string }[] = []
    if (v.stockMin != null && v.stockMax != null && Number(v.stockMax) < Number(v.stockMin)) issues.push({ field: 'stockMax', reason: '库存上限不能小于库存下限' })
    for (const [f, val] of [['stockMin', v.stockMin], ['stockMax', v.stockMax]] as const) if (val != null && Number(val) > 999_999_999) issues.push({ field: f, reason: '取值范围 0 至 999,999,999' })
    if (issues.length) throw new AppError('VALIDATION_FAILED', undefined, issues)
    return v
  }

  /** 编码与条码在租户内唯一,Product 与 SKU 共用命名空间(含停用)(需求 11.2) */
  private async register(tx: Tx, kind: 'code' | 'barcode', value: string, ownerType: 'product' | 'sku', ownerId: string) {
    if (!value) return
    const n = await tx.exec(`INSERT INTO code_registry (tenant_id, kind, value, owner_type, owner_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tx.tenantId, kind, value, ownerType, ownerId])
    if (n === 0) {
      // 条码与编码可相同的情况仅限同一对象自身
      const cur = await tx.maybeOne('SELECT owner_id FROM code_registry WHERE kind=$1 AND value=$2', [kind, value])
      if (cur?.owner_id === ownerId) return
      throw new AppError('VALIDATION_FAILED', kind === 'code' ? '编码重复' : '条码重复', [{ field: kind === 'code' ? 'code' : 'barcode', reason: kind === 'code' ? '编码与其他商品或规格重复' : '条码与其他商品或规格重复' }])
    }
  }

  private async relations(tx: Tx, v: ProductInput, settings: { multiUnit: boolean; multiSku: boolean }) {
    if (v.categoryId) {
      const c = await tx.maybeOne('SELECT 1 FROM product_category WHERE id=$1', [v.categoryId])
      if (!c) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'categoryId', reason: '关联记录不存在' }])
    }
    if (v.units?.length) {
      if (!settings.multiUnit) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'units', reason: '未启用多单位参数' }])
      const names = new Set<string>([v.baseUnit])
      for (const u of v.units) {
        if (!isValidUnitRatio(u.ratio)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'units', reason: `辅助单位“${u.unitName}”的换算比例须为 2 至 100000 的整数` }])
        if (names.has(u.unitName)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'units', reason: `辅助单位“${u.unitName}”与基本单位或其他辅助单位重名` }])
        names.add(u.unitName)
      }
    }
    if (v.specDims?.length && !settings.multiSku) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'specDims', reason: '未启用多规格 SKU 参数' }])
  }

  async create(tx: Tx, ctx: Ctx, input: unknown): Promise<ProductView> {
    const v = this.parse(input)
    const s = await this.settings.read(tx)
    await this.relations(tx, v, s)
    const custom = await this.cf.validateNew(tx, 'product', v.custom)
    const id = uuidv7()
    await tx.query(
      `INSERT INTO product (id, tenant_id, code, name, category_id, spec, base_unit, barcode, ref_cost_price, ref_sale_price, wholesale_price, stock_min, stock_max, images, remark, spec_dims, custom, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
      [id, ctx.tenantId, v.code, v.name, v.categoryId ?? null, v.spec, v.baseUnit, v.barcode, v.refCostPrice, v.refSalePrice, v.wholesalePrice ?? null, v.stockMin ?? null, v.stockMax ?? null, v.images, v.remark, v.specDims ? JSON.stringify(v.specDims) : null, JSON.stringify(custom), ctx.tenantUserId],
    )
    await this.register(tx, 'code', v.code, 'product', id)
    await this.register(tx, 'barcode', v.barcode, 'product', id)

    if (s.multiSku && v.specDims?.length) {
      const combos = v.specDims.reduce<Record<string, string>[]>((acc, dim) => acc.flatMap((a) => dim.values.map((val) => ({ ...a, [dim.name]: val }))), [{}])
      if (combos.length > MAX_SKUS_PER_PRODUCT) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'specDims', reason: `单个商品的规格组合不能超过 ${MAX_SKUS_PER_PRODUCT} 个(当前 ${combos.length})` }])
      let n = 0
      for (const combo of combos) {
        const sid = uuidv7()
        const code = `${v.code}-${++n}`
        await this.register(tx, 'code', code, 'sku', sid)
        await tx.query('INSERT INTO sku (id, tenant_id, product_id, code, barcode, spec_values, is_default) VALUES ($1,$2,$3,$4,$5,$6,false)', [sid, ctx.tenantId, id, code, '', JSON.stringify(combo)])
      }
    } else {
      // 未启用多规格时每个 Product 恰有 1 个默认 SKU,编码与条码与 Product 相同
      await tx.query('INSERT INTO sku (id, tenant_id, product_id, code, barcode, is_default) VALUES ($1,$2,$3,$4,$5,true)', [uuidv7(), ctx.tenantId, id, v.code, v.barcode])
    }
    for (const u of v.units ?? []) await tx.query('INSERT INTO product_unit (id, tenant_id, product_id, unit_name, ratio) VALUES ($1,$2,$3,$4,$5)', [uuidv7(), ctx.tenantId, id, u.unitName, u.ratio])
    const view = await this.get(tx, id)
    await this.audit.log(tx, ctx, 'product.create', { type: 'product', id, no: v.code, before: null, after: { ...flat(view) } })
    return view
  }

  async update(tx: Tx, ctx: Ctx, id: string, input: unknown, version?: number): Promise<ProductView> {
    const old = await tx.maybeOne('SELECT * FROM product WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    if (version !== undefined && version !== old.version) throw new AppError('DOC_STATUS_CHANGED', '记录已被他人修改,请刷新后重试')
    const before = await this.get(tx, id)
    const v = this.parse(input)
    const s = await this.settings.read(tx)
    await this.relations(tx, v, s)
    const custom = await this.cf.validateAndMerge(tx, 'product', old.custom, v.custom)
    if (v.code !== old.code) {
      await tx.query(`DELETE FROM code_registry WHERE kind='code' AND owner_id=$1 AND owner_type='product'`, [id])
      await this.register(tx, 'code', v.code, 'product', id)
    }
    if (v.barcode !== old.barcode) {
      await tx.query(`DELETE FROM code_registry WHERE kind='barcode' AND owner_id=$1 AND owner_type='product'`, [id])
      await this.register(tx, 'barcode', v.barcode, 'product', id)
    }
    await tx.query(
      `UPDATE product SET code=$2, name=$3, category_id=$4, spec=$5, base_unit=$6, barcode=$7, ref_cost_price=$8, ref_sale_price=$9, wholesale_price=$10, stock_min=$11, stock_max=$12,
         images=$13, remark=$14, custom=$15, version=version+1, updated_at=now(), updated_by=$16 WHERE id=$1`,
      [id, v.code, v.name, v.categoryId ?? null, v.spec, v.baseUnit, v.barcode, v.refCostPrice, v.refSalePrice, v.wholesalePrice ?? null, v.stockMin ?? null, v.stockMax ?? null, v.images, v.remark, JSON.stringify(custom), ctx.tenantUserId],
    )
    // 默认 SKU 的编码与条码跟随 Product
    await tx.query('UPDATE sku SET code=$2, barcode=$3 WHERE product_id=$1 AND is_default', [id, v.code, v.barcode])
    if (v.units) {
      await tx.query('DELETE FROM product_unit WHERE product_id=$1', [id])
      for (const u of v.units) await tx.query('INSERT INTO product_unit (id, tenant_id, product_id, unit_name, ratio) VALUES ($1,$2,$3,$4,$5)', [uuidv7(), ctx.tenantId, id, u.unitName, u.ratio])
    }
    const after = await this.get(tx, id)
    await this.audit.log(tx, ctx, 'product.update', { type: 'product', id, no: v.code, before: flat(before), after: flat(after) })
    return after
  }

  /** 停用后隐藏于新建单据的选择列表,历史单据仍显示(需求 11.10) */
  async setEnabled(tx: Tx, ctx: Ctx, id: string, enabled: boolean): Promise<void> {
    const old = await tx.maybeOne('SELECT code, enabled FROM product WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    await tx.query('UPDATE product SET enabled=$2, version=version+1, updated_at=now() WHERE id=$1', [id, enabled])
    await tx.query('UPDATE sku SET enabled=$2 WHERE product_id=$1', [id, enabled])
    await this.audit.log(tx, ctx, enabled ? 'product.enable' : 'product.disable', { type: 'product', id, no: old.code, before: { enabled: old.enabled }, after: { enabled } })
  }

  /** 已被任意状态(含草稿)单据引用时拒绝删除,提示改为停用(需求 11.9) */
  async delete(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    const old = await tx.maybeOne('SELECT code FROM product WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    const used = await tx.maybeOne('SELECT 1 FROM document_line dl JOIN sku s ON s.tenant_id = dl.tenant_id AND s.id = dl.sku_id WHERE s.product_id=$1 LIMIT 1', [id])
    const stock = await tx.maybeOne('SELECT 1 FROM stock_balance sb JOIN sku s ON s.tenant_id = sb.tenant_id AND s.id = sb.sku_id WHERE s.product_id=$1 LIMIT 1', [id])
    if (used || stock) throw new AppError('VALIDATION_FAILED', '该商品已被单据引用,无法删除,请改为停用', [{ field: 'id', reason: '已被单据引用,请改为停用' }])
    await tx.query('DELETE FROM product_unit WHERE product_id=$1', [id])
    await tx.query('DELETE FROM sku WHERE product_id=$1', [id])
    await tx.query(`DELETE FROM code_registry WHERE owner_id=$1 OR owner_id IN (SELECT id FROM sku WHERE product_id=$1)`, [id])
    await tx.query('DELETE FROM product WHERE id=$1', [id])
    await this.audit.log(tx, ctx, 'product.delete', { type: 'product', id, no: old.code, before: { code: old.code }, after: null })
  }

  async get(tx: Tx, id: string): Promise<ProductView> {
    const p = await tx.maybeOne('SELECT * FROM product WHERE id=$1', [id])
    if (!p) throw new AppError('NOT_FOUND')
    // 同一事务连接上的查询必须顺序执行
    const units = await tx.rows('SELECT * FROM product_unit WHERE product_id=$1 ORDER BY ratio', [id])
    const skus = await tx.rows('SELECT * FROM sku WHERE product_id=$1 ORDER BY code', [id])
    return toView(p, units, skus)
  }

  async list(tx: Tx, f: { keyword?: string; categoryId?: string; enabled?: boolean; cf?: Record<string, FieldFilter>; page?: number; pageSize?: number }) {
    const params: unknown[] = []
    const where: string[] = []
    if (f.keyword) {
      params.push(`%${f.keyword.replace(/[\\%_]/g, '\\$&')}%`)
      where.push(`(p.code ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.barcode ILIKE $${params.length} OR EXISTS (SELECT 1 FROM sku s WHERE s.product_id = p.id AND (s.code ILIKE $${params.length} OR s.barcode ILIKE $${params.length})))`)
    }
    if (f.categoryId) {
      params.push(f.categoryId)
      where.push(`p.category_id IN (SELECT id FROM product_category WHERE id = $${params.length} OR path LIKE (SELECT path FROM product_category WHERE id = $${params.length}) || '/%')`)
    }
    if (f.enabled !== undefined) {
      params.push(f.enabled)
      where.push(`p.enabled = $${params.length}`)
    }
    where.push(...(await this.cf.buildFilters(tx, 'product', f.cf, 'p', params)))
    const pageSize = Math.min(f.pageSize ?? 20, 100)
    const page = Math.max(f.page ?? 1, 1)
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM product p ${w}`, params)).n
    const rows = await tx.rows(`SELECT p.* FROM product p ${w} ORDER BY p.code LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)
    const ids = rows.map((r) => r.id)
    const units = ids.length ? await tx.rows('SELECT * FROM product_unit WHERE product_id = ANY($1::uuid[])', [ids]) : []
    const skus = ids.length ? await tx.rows('SELECT * FROM sku WHERE product_id = ANY($1::uuid[]) ORDER BY code', [ids]) : []
    return { items: rows.map((r) => toView(r, units, skus)), total, page, pageSize }
  }

  /** 新建单据的商品选择:仅启用商品及其 SKU(需求 11.10) */
  async search(tx: Tx, keyword: string, limit = 30) {
    const like = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`
    return this.searchBy(tx, '(s.code ILIKE $1 OR s.barcode ILIKE $1 OR p.name ILIKE $1 OR p.code ILIKE $1)', [like], limit)
  }

  private async searchBy(tx: Tx, cond: string, params: unknown[], limit: number) {
    const rows = await tx.rows(
      `SELECT s.id AS sku_id, s.code AS sku_code, s.barcode, s.spec_values, p.id AS product_id, p.name, p.spec, p.base_unit, p.ref_cost_price, p.ref_sale_price, p.wholesale_price
       FROM sku s JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
       WHERE s.enabled AND p.enabled AND ${cond} ORDER BY s.code LIMIT ${Math.min(limit, 100)}`,
      params,
    )
    const pids = [...new Set(rows.map((r) => r.product_id))]
    const units = pids.length ? await tx.rows('SELECT * FROM product_unit WHERE product_id = ANY($1::uuid[])', [pids]) : []
    return rows.map((r) => ({
      skuId: r.sku_id,
      skuCode: r.sku_code,
      barcode: r.barcode,
      specValues: r.spec_values,
      productId: r.product_id,
      name: r.name,
      spec: r.spec,
      baseUnit: r.base_unit,
      refCostPrice: r.ref_cost_price,
      refSalePrice: r.ref_sale_price,
      wholesalePrice: r.wholesale_price,
      units: units.filter((u) => u.product_id === r.product_id).map((u) => ({ unitName: u.unit_name, ratio: u.ratio })),
    }))
  }

  /** 扫码:条码与启用状态 SKU 完全一致(需求 11.7、11.8) */
  async findByBarcode(tx: Tx, barcode: string) {
    if (!barcode) return null
    return (await this.searchBy(tx, 's.barcode = $1', [barcode], 1))[0] ?? null
  }

  /** 小程序本地条码索引:启用 SKU 的条码 → SKU 信息,客户端缓存 10 分钟 */
  async barcodeIndex(tx: Tx) {
    return tx.rows(
      `SELECT s.barcode, s.id AS "skuId", s.code AS "skuCode", p.name, p.base_unit AS "baseUnit", p.ref_sale_price AS "refSalePrice"
       FROM sku s JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id WHERE s.enabled AND p.enabled AND s.barcode <> ''`,
    )
  }

  /* ───────── 分类(最多 5 级) ───────── */

  async listCategories(tx: Tx) {
    return tx.rows('SELECT id, parent_id AS "parentId", name, level, path FROM product_category ORDER BY path')
  }

  async createCategory(tx: Tx, ctx: Ctx, name: string, parentId?: string | null) {
    name = (name ?? '').trim()
    if (!name || name.length > 50) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'name', reason: '分类名称为 1 至 50 个字符' }])
    let level = 1
    let parentPath = ''
    if (parentId) {
      const p = await tx.maybeOne('SELECT level, path FROM product_category WHERE id=$1', [parentId])
      if (!p) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'parentId', reason: '关联记录不存在' }])
      level = p.level + 1
      parentPath = p.path
    }
    if (level > MAX_CATEGORY_LEVEL) throw new AppError('VALIDATION_FAILED', '分类层级上限为 5 级', [{ field: 'parentId', reason: '分类层级上限为 5 级' }])
    const id = uuidv7()
    await tx.query('INSERT INTO product_category (id, tenant_id, parent_id, name, level, path) VALUES ($1,$2,$3,$4,$5,$6)', [id, ctx.tenantId, parentId ?? null, name, level, `${parentPath}/${id}`])
    await this.audit.log(tx, ctx, 'product_category.create', { type: 'product_category', id, no: name, before: null, after: { name, level } })
    return { id, name, level, parentId: parentId ?? null }
  }

  /** 移动分类:整棵子树的最深层级不得超过 5 级,且不得移入自身子树 */
  async moveCategory(tx: Tx, ctx: Ctx, id: string, newParentId: string | null) {
    const c = await tx.maybeOne('SELECT * FROM product_category WHERE id=$1 FOR UPDATE', [id])
    if (!c) throw new AppError('NOT_FOUND')
    let level = 1
    let parentPath = ''
    if (newParentId) {
      const p = await tx.maybeOne('SELECT level, path FROM product_category WHERE id=$1', [newParentId])
      if (!p) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'parentId', reason: '关联记录不存在' }])
      if (p.path === c.path || p.path.startsWith(c.path + '/')) throw new AppError('VALIDATION_FAILED', '不能移动到自身或其子分类下', [{ field: 'parentId', reason: '不能移动到自身或其子分类下' }])
      level = p.level + 1
      parentPath = p.path
    }
    const deepest = (await tx.one<{ m: number }>(`SELECT max(level)::int AS m FROM product_category WHERE path = $1 OR path LIKE $1 || '/%'`, [c.path])).m
    const shift = level - c.level
    if (deepest + shift > MAX_CATEGORY_LEVEL) throw new AppError('VALIDATION_FAILED', '分类层级上限为 5 级', [{ field: 'parentId', reason: '分类层级上限为 5 级' }])
    const newPath = `${parentPath}/${id}`
    await tx.query(`UPDATE product_category SET path = $2 || substr(path, length($1) + 1), level = level + $3 WHERE path = $1 OR path LIKE $1 || '/%'`, [c.path, newPath, shift])
    await tx.query('UPDATE product_category SET parent_id=$2 WHERE id=$1', [id, newParentId])
    await this.audit.log(tx, ctx, 'product_category.move', { type: 'product_category', id, no: c.name, before: { parentId: c.parent_id }, after: { parentId: newParentId } })
  }
}

function flat(v: ProductView): Record<string, any> {
  const { skus, units, ...rest } = v
  return { ...rest, units: units.map((u) => `${u.unitName}=${u.ratio}`), skuCount: skus.length }
}
