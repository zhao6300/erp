import { z } from 'zod'
import type { ValidationIssue } from './errors'
import { isValidCalendarDate } from './types'

export const FIELD_TYPES = ['text', 'textarea', 'integer', 'decimal', 'date', 'select', 'multiselect', 'boolean', 'image'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  integer: '整数',
  decimal: '小数',
  date: '日期',
  select: '单选',
  multiselect: '多选',
  boolean: '是否',
  image: '图片',
}

export const OBJECT_TYPES = ['product', 'customer', 'supplier', 'warehouse', 'purchase_doc', 'sales_doc'] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]
export const MAX_FIELDS_PER_OBJECT = 50

export interface FieldDef {
  code: string
  label: string
  type: FieldType
  required: boolean
  defaultValue?: unknown
  options?: string[]
  displayOrder: number
  showInList: boolean
  filterable: boolean
  enabled: boolean
  createdAt?: string
}

/** 字段值:text/textarea/select/date/decimal → string;integer → number;boolean → boolean;multiselect/image → string[] */
export type FieldValue = string | number | boolean | string[] | null

const len = (s: string) => Array.from(s).length
const INT_MIN = -999_999_999
const INT_MAX = 999_999_999

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/** 校验单个非空取值;返回 null 表示合法,否则返回原因(需求 6.5) */
export function validateFieldValue(def: Pick<FieldDef, 'type' | 'options'>, v: unknown): string | null {
  switch (def.type) {
    case 'text':
      return typeof v === 'string' && len(v) <= 200 ? null : '单行文本不超过 200 个字符'
    case 'textarea':
      return typeof v === 'string' && len(v) <= 2000 ? null : '多行文本不超过 2000 个字符'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) && v >= INT_MIN && v <= INT_MAX ? null : '整数范围为 -999,999,999 至 999,999,999'
    case 'decimal': {
      if (typeof v !== 'string') return '小数须为数字字符串'
      const m = /^-?(\d+)(?:\.(\d+))?$/.exec(v)
      if (!m) return '小数格式不正确'
      if (m[1].length > 12) return '小数的整数部分不超过 12 位'
      if ((m[2] ?? '').length > 6) return '小数部分不超过 6 位'
      return null
    }
    case 'date':
      return typeof v === 'string' && isValidCalendarDate(v) ? null : '日期格式应为有效的 YYYY-MM-DD'
    case 'select':
      return typeof v === 'string' && (def.options ?? []).includes(v) ? null : '取值不在可选项中'
    case 'multiselect':
      return Array.isArray(v) && v.every((x) => typeof x === 'string' && (def.options ?? []).includes(x)) ? null : '取值不在可选项中'
    case 'boolean':
      return typeof v === 'boolean' ? null : '应为是或否'
    case 'image':
      return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0) && v.length <= 9 ? null : '图片最多 9 张'
  }
}

/** 校验字段定义本身(需求 6.1、6.2、6.4、6.10、6.11)。originalCode 存在表示编辑已保存的定义 */
export function validateFieldDefinition(def: FieldDef, existing: FieldDef[], opts: { original?: FieldDef } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (field: string, reason: string) => issues.push({ field, reason })

  if (typeof def.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(def.code)) add('code', '字段编码为 1 至 32 个字符,以英文字母开头,仅含英文字母、数字与下划线')
  if (typeof def.label !== 'string' || len(def.label) < 1 || len(def.label) > 20) add('label', '显示名称为 1 至 20 个字符')
  if (!FIELD_TYPES.includes(def.type)) add('type', '不支持的字段类型')
  if (typeof def.required !== 'boolean') add('required', '是否必填应为布尔值')
  if (!Number.isInteger(def.displayOrder) || def.displayOrder < 0 || def.displayOrder > 9999) add('displayOrder', '显示顺序为 0 至 9999 的整数')

  const isChoice = def.type === 'select' || def.type === 'multiselect'
  if (isChoice) {
    const o = def.options ?? []
    if (o.length < 1 || o.length > 50) add('options', '可选项为 1 至 50 项')
    else if (o.some((x) => typeof x !== 'string' || len(x) < 1 || len(x) > 32)) add('options', '每个可选项为 1 至 32 个字符')
    else if (new Set(o).size !== o.length) add('options', '可选项不能重复')
  } else if (def.options && def.options.length > 0) {
    add('options', '仅单选与多选字段可设置可选项')
  }

  if (def.type === 'image' && def.filterable) add('filterable', '图片字段不可作为筛选条件')

  if (!isEmptyValue(def.defaultValue) && FIELD_TYPES.includes(def.type)) {
    const r = validateFieldValue(def, def.defaultValue)
    if (r) add('defaultValue', `默认值不合法:${r}`)
  }

  const others = opts.original ? existing.filter((e) => e.code.toLowerCase() !== opts.original!.code.toLowerCase()) : existing
  if (typeof def.code === 'string' && others.some((e) => e.code.toLowerCase() === def.code.toLowerCase())) add('code', '字段编码重复')
  if (!opts.original && existing.length >= MAX_FIELDS_PER_OBJECT) add('code', `每个业务对象最多 ${MAX_FIELDS_PER_OBJECT} 个自定义字段(含停用)`)
  if (opts.original) {
    if (opts.original.code !== def.code) add('code', '字段编码保存后不可修改')
    if (opts.original.type !== def.type) add('type', '字段类型保存后不可修改')
  }
  return issues
}

/** 按显示顺序、创建时间排序 */
export function sortFieldDefs<T extends Pick<FieldDef, 'displayOrder' | 'createdAt'>>(defs: T[]): T[] {
  return [...defs].sort((a, b) => a.displayOrder - b.displayOrder || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

export interface FieldIssue {
  code: string
  label: string
  reason: string
}

/** 直接校验,返回全部违规字段(只含启用字段;需求 6.5、6.7) */
export function validateCustomValues(defs: FieldDef[], values: Record<string, unknown>): FieldIssue[] {
  const out: FieldIssue[] = []
  for (const d of defs) {
    if (!d.enabled) continue
    const v = values?.[d.code]
    if (isEmptyValue(v)) {
      if (d.required) out.push({ code: d.code, label: d.label, reason: '必填' })
      continue
    }
    const r = validateFieldValue(d, v)
    if (r) out.push({ code: d.code, label: d.label, reason: r })
  }
  return out
}

/** 为启用字段生成 zod schema:校验必填与类型约束,停用字段不参与(需求 6.5、6.7) */
export function buildValueSchema(defs: FieldDef[]) {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const d of defs) {
    if (!d.enabled) continue
    shape[d.code] = z.unknown().superRefine((v, ctx) => {
      if (isEmptyValue(v)) {
        if (d.required) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '必填', params: { label: d.label } })
        return
      }
      const r = validateFieldValue(d, v)
      if (r) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r, params: { label: d.label } })
    })
  }
  return z.object(shape)
}

/** 写入存储的 JSON 编码(设计:保证写读往返) */
export function encodeFieldValue(def: Pick<FieldDef, 'type' | 'options'>, v: FieldValue): unknown {
  if (v === null || v === undefined) return null
  if (def.type === 'multiselect') {
    const set = new Set(v as string[])
    return (def.options ?? []).filter((o) => set.has(o))
  }
  if (def.type === 'image') return Array.from(new Set(v as string[])) // 去重,保留顺序
  return v
}

export function decodeFieldValue(def: Pick<FieldDef, 'type' | 'options'>, j: unknown): FieldValue {
  if (j === null || j === undefined) return null
  if (def.type === 'multiselect' || def.type === 'image') return Array.isArray(j) ? (j as string[]) : []
  return j as FieldValue
}

/** 写入时合并而非覆盖,避免抹掉停用字段的旧值(需求 6.7) */
export function mergeCustom(existing: Record<string, unknown>, defs: FieldDef[], incoming: Record<string, unknown>): Record<string, unknown> {
  const out = { ...existing }
  for (const d of defs) {
    if (!d.enabled) continue
    if (Object.prototype.hasOwnProperty.call(incoming, d.code)) {
      const v = incoming[d.code]
      if (isEmptyValue(v)) delete out[d.code]
      else out[d.code] = encodeFieldValue(d, v as FieldValue)
    }
  }
  return out
}

/** 新增页面的默认值预填(需求 6.3) */
export function defaultValues(defs: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const d of sortFieldDefs(defs)) if (d.enabled && !isEmptyValue(d.defaultValue)) out[d.code] = d.defaultValue
  return out
}
