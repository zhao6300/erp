import {
  AppError,
  FieldDef,
  FieldType,
  ObjectType,
  OBJECT_TYPES,
  buildValueSchema,
  mergeCustom,
  sortFieldDefs,
  validateFieldDefinition,
} from '@erp/shared'
import { AuditService } from '../core/audit'
import type { ConfigCache } from '../core/cache'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import { uuidv7 } from '../core/ids'

const rowToDef = (r: any): FieldDef & { id: string } => ({
  id: r.id,
  code: r.code,
  label: r.label,
  type: r.field_type as FieldType,
  required: r.required,
  defaultValue: r.default_value ?? undefined,
  options: r.options ?? undefined,
  displayOrder: r.display_order,
  showInList: r.show_in_list,
  filterable: r.filterable,
  enabled: r.enabled,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
})

export type FieldFilter = { text?: string; min?: string; max?: string; values?: string[]; bool?: boolean }

export class CustomFieldService {
  constructor(
    private db: Db,
    private cache: ConfigCache,
    private audit: AuditService,
  ) {}

  /** 字段定义(缓存 + 失效广播;客户端下次加载时拉取;需求 6.3) */
  async defsFor(tenantId: string, objectType: ObjectType): Promise<(FieldDef & { id: string })[]> {
    return this.cache.get(`cf:${tenantId}:${objectType}`, () => this.db.withTenant(tenantId, (tx) => this.list(tx, objectType)))
  }

  async list(tx: Tx, objectType: ObjectType, opts: { onlyEnabled?: boolean } = {}): Promise<(FieldDef & { id: string })[]> {
    const rows = await tx.rows('SELECT * FROM custom_field_def WHERE object_type=$1', [objectType])
    const defs = sortFieldDefs(rows.map(rowToDef))
    return opts.onlyEnabled ? defs.filter((d) => d.enabled) : defs
  }

  private assertAdmin(ctx: Ctx) {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
  }

  private checkType(objectType: string) {
    if (!(OBJECT_TYPES as readonly string[]).includes(objectType)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'objectType', reason: '不支持的业务对象' }])
  }

  async create(tx: Tx, ctx: Ctx, objectType: ObjectType, input: FieldDef): Promise<FieldDef & { id: string }> {
    this.assertAdmin(ctx)
    this.checkType(objectType)
    // 同一租户同一对象并发创建时用顾问锁串行,保证 50 个上限与编码唯一判断正确
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cf:${ctx.tenantId}:${objectType}`])
    const existing = await this.list(tx, objectType)
    const def: FieldDef = { ...input, enabled: true } // 新建时为启用
    const issues = validateFieldDefinition(def, existing)
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues.some((i) => i.reason === '字段编码重复') ? '字段编码重复' : undefined, issues.map((i) => ({ field: i.field, reason: i.reason })))
    const id = uuidv7()
    await tx.query(
      `INSERT INTO custom_field_def (id, tenant_id, object_type, code, label, field_type, required, default_value, options, display_order, show_in_list, filterable, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
      [id, ctx.tenantId, objectType, def.code, def.label, def.type, def.required, def.defaultValue === undefined ? null : JSON.stringify(def.defaultValue), def.options ?? null, def.displayOrder, def.showInList, def.filterable],
    )
    tx.onCommit(() => this.invalidate(ctx.tenantId, objectType))
    await this.audit.log(tx, ctx, 'custom_field.create', { type: 'custom_field', id, no: `${objectType}.${def.code}`, before: null, after: { ...def } })
    return rowToDef(await tx.one('SELECT * FROM custom_field_def WHERE id=$1', [id]))
  }

  /** 编码与类型保存后不可修改(需求 6.10) */
  async update(tx: Tx, ctx: Ctx, id: string, input: FieldDef): Promise<FieldDef & { id: string }> {
    this.assertAdmin(ctx)
    const row = await tx.maybeOne('SELECT * FROM custom_field_def WHERE id=$1 FOR UPDATE', [id])
    if (!row) throw new AppError('NOT_FOUND')
    const old = rowToDef(row)
    const existing = await this.list(tx, row.object_type)
    const issues = validateFieldDefinition({ ...input, enabled: old.enabled }, existing, { original: old })
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues.some((i) => i.reason.includes('不可修改')) ? '字段编码与字段类型保存后不可修改' : undefined, issues.map((i) => ({ field: i.field, reason: i.reason })))
    await tx.query(
      `UPDATE custom_field_def SET label=$2, required=$3, default_value=$4, options=$5, display_order=$6, show_in_list=$7, filterable=$8 WHERE id=$1`,
      [id, input.label, input.required, input.defaultValue === undefined ? null : JSON.stringify(input.defaultValue), input.options ?? null, input.displayOrder, input.showInList, input.filterable],
    )
    tx.onCommit(() => this.invalidate(ctx.tenantId, row.object_type))
    await this.audit.log(tx, ctx, 'custom_field.update', { type: 'custom_field', id, no: `${row.object_type}.${old.code}`, before: { ...old }, after: { ...input, code: old.code, type: old.type } })
    return rowToDef(await tx.one('SELECT * FROM custom_field_def WHERE id=$1', [id]))
  }

  /** 停用:隐藏并不再校验,已录入的值保留;重新启用:恢复展示、校验,值仍在(需求 6.7、6.12) */
  async setEnabled(tx: Tx, ctx: Ctx, id: string, enabled: boolean): Promise<void> {
    this.assertAdmin(ctx)
    const row = await tx.maybeOne('SELECT * FROM custom_field_def WHERE id=$1 FOR UPDATE', [id])
    if (!row) throw new AppError('NOT_FOUND')
    await tx.query('UPDATE custom_field_def SET enabled=$2 WHERE id=$1', [id, enabled])
    tx.onCommit(() => this.invalidate(ctx.tenantId, row.object_type))
    await this.audit.log(tx, ctx, enabled ? 'custom_field.enable' : 'custom_field.disable', { type: 'custom_field', id, no: `${row.object_type}.${row.code}`, before: { enabled: row.enabled }, after: { enabled } })
  }

  async invalidate(tenantId: string, objectType: ObjectType) {
    await this.cache.invalidate(`cf:${tenantId}:${objectType}`)
  }

  /**
   * 校验并合并 custom:仅校验启用字段;合并而非覆盖,避免抹掉停用字段的旧值。
   * 不合规时列出全部违规字段的显示名称(需求 6.5)。
   */
  async validateAndMerge(tx: Tx, objectType: ObjectType, existing: Record<string, unknown> | null | undefined, incoming: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const defs = await this.list(tx, objectType)
    if (incoming === undefined) return existing ?? {}
    const schema = buildValueSchema(defs)
    const r = schema.safeParse(incoming)
    if (!r.success) {
      const labelOf = new Map(defs.map((d) => [d.code, d.label]))
      const byField = new Map<string, string>()
      for (const i of r.error.issues) {
        const code = String(i.path[0])
        if (!byField.has(code)) byField.set(code, i.message)
      }
      throw new AppError(
        'VALIDATION_FAILED',
        `以下自定义字段不合规:${[...byField.keys()].map((c) => labelOf.get(c) ?? c).join('、')}`,
        [...byField].map(([code, reason]) => ({ field: `custom.${code}`, reason: `${labelOf.get(code) ?? code}:${reason}` })),
      )
    }
    return mergeCustom(existing ?? {}, defs, incoming)
  }

  /** 新增记录时先校验必填(未传字段视为空) */
  async validateNew(tx: Tx, objectType: ObjectType, incoming: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    return this.validateAndMerge(tx, objectType, {}, incoming ?? {})
  }

  /**
   * 列表筛选:cf.<编码> → SQL 条件。仅允许启用且可筛选的字段;多条件 AND(需求 6.6)。
   * 参数追加到 params,返回条件片段数组。
   */
  async buildFilters(tx: Tx, objectType: ObjectType, filters: Record<string, FieldFilter> | undefined, alias: string, params: unknown[]): Promise<string[]> {
    if (!filters) return []
    const defs = new Map((await this.list(tx, objectType, { onlyEnabled: true })).filter((d) => d.filterable).map((d) => [d.code, d]))
    const out: string[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    for (const [code, f] of Object.entries(filters)) {
      const d = defs.get(code)
      if (!d) throw new AppError('VALIDATION_FAILED', undefined, [{ field: `cf.${code}`, reason: '该字段不存在、已停用或不可作为筛选条件' }])
      const col = `${alias}.custom`
      const key = p(code)
      switch (d.type) {
        case 'text':
        case 'textarea':
          if (f.text) out.push(`${col}->>${key} ILIKE ${p('%' + f.text.replace(/[\\%_]/g, '\\$&') + '%')}`)
          break
        case 'integer':
        case 'decimal':
          if (f.min !== undefined && f.min !== '') out.push(`(${col}->>${key})::numeric >= ${p(f.min)}::numeric`)
          if (f.max !== undefined && f.max !== '') out.push(`(${col}->>${key})::numeric <= ${p(f.max)}::numeric`)
          break
        case 'date':
          if (f.min) out.push(`(${col}->>${key})::date >= ${p(f.min)}::date`)
          if (f.max) out.push(`(${col}->>${key})::date <= ${p(f.max)}::date`)
          break
        case 'select':
          if (f.values?.length) out.push(`${col}->>${key} = ANY(${p(f.values)}::text[])`)
          break
        case 'multiselect':
          if (f.values?.length) out.push(`${col}->${key} ?| ${p(f.values)}::text[]`)
          break
        case 'boolean':
          if (f.bool !== undefined) out.push(`(${col}->>${key})::boolean = ${p(f.bool)}::boolean`)
          break
        default:
          break
      }
    }
    return out
  }

  /** 导入/导出/打印使用:只提供启用字段(需求 6.9) */
  async enabledDefs(tx: Tx, objectType: ObjectType) {
    return this.list(tx, objectType, { onlyEnabled: true })
  }
}

