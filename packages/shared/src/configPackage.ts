import { findNodeAtLocation, parse as parseJsonc, parseTree, ParseError as JsoncError, printParseErrorCode } from 'jsonc-parser'
import { z } from 'zod'
import { FIELD_TYPES, FieldDef, MAX_FIELDS_PER_OBJECT, OBJECT_TYPES, ObjectType } from './customFields'
import { closureOfDeps, dependentsOf } from './modules'
import type { NumberingRule } from './numbering'
import type { DataScope } from './permission'
import { DOC_TYPES, DocType, MODULE_CODES, ModuleCode } from './types'

export const CONFIG_FORMAT_VERSION = 1
export const MAX_CONFIG_PACKAGE_BYTES = 10 * 1024 * 1024

/* ───────────────────────── 类型 ───────────────────────── */

export interface TenantSettingsData {
  qtyScale: number
  priceScale: number
  amountScale: number
  allowNegativeStock: boolean
  requireAudit: boolean
  multiUnit: boolean
  multiSku: boolean
  barcodeEnabled: boolean
}

export const DEFAULT_SETTINGS: TenantSettingsData = {
  qtyScale: 2,
  priceScale: 4,
  amountScale: 2,
  allowNegativeStock: false,
  requireAudit: true,
  multiUnit: false,
  multiSku: false,
  barcodeEnabled: false,
}

export interface ConfigFieldDef extends FieldDef {
  objectType: ObjectType
}
export interface ConfigNumberingRule extends NumberingRule {
  docType: DocType
}
/** 配置包中的数据权限:指定仓库不可移植,导出时降级为本人单据 */
export type PortableScope = { type: 'all' } | { type: 'own' }
export interface ConfigRoleTemplate {
  name: string
  permissions: string[]
  dataScope: PortableScope
}
export interface ConfigPrintTemplate {
  docType: DocType
  name: string
  paper: 'A4' | 'A5' | 'HALF' | 'THIRD' | 'R80'
  layout: unknown
  isDefault: boolean
}
export interface ImageAsset {
  mime: 'image/png' | 'image/jpeg' | 'image/svg+xml'
  base64: string
}
export interface ConfigBranding {
  systemName?: string
  logo?: ImageAsset | null
  themeColor?: string
  loginBg?: ImageAsset | null
  copyright?: string
}

export interface TenantConfig {
  modules: { code: ModuleCode; enabled: boolean }[]
  customFields: ConfigFieldDef[]
  settings: TenantSettingsData
  numberingRules: ConfigNumberingRule[]
  roleTemplates: ConfigRoleTemplate[]
  printTemplates: ConfigPrintTemplate[]
  branding: ConfigBranding | null
}

export function emptyConfig(): TenantConfig {
  return { modules: [], customFields: [], settings: { ...DEFAULT_SETTINGS }, numberingRules: [], roleTemplates: [], printTemplates: [], branding: null }
}

/* ───────────────────────── 规范化 ───────────────────────── */

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeysDeep(o[k])
    return out
  }
  return v
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function normField(f: ConfigFieldDef): ConfigFieldDef {
  const out: any = {
    objectType: f.objectType,
    code: f.code,
    label: f.label,
    type: f.type,
    required: !!f.required,
    displayOrder: f.displayOrder,
    showInList: !!f.showInList,
    filterable: !!f.filterable,
    enabled: f.enabled !== false,
  }
  if (f.defaultValue !== null && f.defaultValue !== undefined && f.defaultValue !== '') out.defaultValue = f.defaultValue
  if ((f.type === 'select' || f.type === 'multiselect') && f.options) out.options = [...f.options]
  return out
}

function normBranding(b: ConfigBranding | null | undefined): ConfigBranding | null {
  if (!b) return null
  const out: ConfigBranding = {}
  if (b.systemName !== undefined) out.systemName = b.systemName
  if (b.logo) out.logo = { mime: b.logo.mime, base64: b.logo.base64 }
  if (b.themeColor !== undefined) out.themeColor = b.themeColor
  if (b.loginBg) out.loginBg = { mime: b.loginBg.mime, base64: b.loginBg.base64 }
  if (b.copyright !== undefined) out.copyright = b.copyright
  return Object.keys(out).length ? out : null
}

function normScope(s: DataScope | PortableScope | undefined): PortableScope {
  if (s && s.type === 'all') return { type: 'all' }
  return { type: 'own' }
}

/**
 * 只保留配置包允许的内容并规范化排序。业务数据、账号、Role 分配、License、流水号当前值
 * 不在白名单中,因此永远不会被导出(需求 8.2)。
 */
export function normalizeConfig(cfg: TenantConfig): TenantConfig {
  const s = cfg.settings
  return {
    modules: [...cfg.modules].map((m) => ({ code: m.code, enabled: !!m.enabled })).sort((a, b) => cmp(a.code, b.code)),
    customFields: cfg.customFields.map(normField).sort((a, b) => cmp(a.objectType, b.objectType) || cmp(a.code, b.code)),
    settings: {
      qtyScale: s.qtyScale,
      priceScale: s.priceScale,
      amountScale: s.amountScale,
      allowNegativeStock: !!s.allowNegativeStock,
      requireAudit: !!s.requireAudit,
      multiUnit: !!s.multiUnit,
      multiSku: !!s.multiSku,
      barcodeEnabled: !!s.barcodeEnabled,
    },
    numberingRules: cfg.numberingRules
      .map((r) => ({ docType: r.docType, prefix: r.prefix, dateFormat: r.dateFormat, seqDigits: r.seqDigits, reset: r.reset }))
      .sort((a, b) => cmp(a.docType, b.docType)),
    roleTemplates: cfg.roleTemplates
      .map((r) => ({ name: r.name, permissions: [...new Set(r.permissions)].sort(), dataScope: normScope(r.dataScope) }))
      .sort((a, b) => cmp(a.name, b.name)),
    printTemplates: cfg.printTemplates
      .map((p) => ({ docType: p.docType, name: p.name, paper: p.paper, layout: sortKeysDeep(p.layout), isDefault: !!p.isDefault }))
      .sort((a, b) => cmp(a.docType, b.docType) || cmp(a.name, b.name)),
    branding: normBranding(cfg.branding),
  }
}

/** 导出时被降级的 Role(指定仓库的数据权限无法移植),用于预览提示 */
export function exportNotices(cfg: { roleTemplates: { name: string; dataScope: DataScope | PortableScope }[] }): string[] {
  return cfg.roleTemplates.filter((r) => r.dataScope.type === 'warehouses').map((r) => `角色“${r.name}”的指定仓库数据权限不可移植,已降级为“本人单据”`)
}

/* ───────────────────────── 序列化 ───────────────────────── */

export function serializeConfigPackage(cfg: TenantConfig, exportedAt: string): string {
  const n = normalizeConfig(cfg)
  const doc = {
    formatVersion: CONFIG_FORMAT_VERSION,
    exportedAt,
    modules: n.modules,
    customFields: n.customFields,
    settings: n.settings,
    numberingRules: n.numberingRules,
    roleTemplates: n.roleTemplates,
    printTemplates: n.printTemplates,
    branding: n.branding,
    assets: {},
  }
  return JSON.stringify(sortKeysDeep(doc), null, 2)
}

/* ───────────────────────── 解析 ───────────────────────── */

const imageAsset = z.object({ mime: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']), base64: z.string() })
const fieldDefSchema = z.object({
  objectType: z.enum(OBJECT_TYPES),
  code: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  defaultValue: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  displayOrder: z.number().int(),
  showInList: z.boolean(),
  filterable: z.boolean(),
  enabled: z.boolean(),
})
const settingsSchema = z.object({
  qtyScale: z.number().int().min(0).max(4),
  priceScale: z.number().int().min(0).max(6),
  amountScale: z.number().int().min(0).max(2),
  allowNegativeStock: z.boolean(),
  requireAudit: z.boolean(),
  multiUnit: z.boolean(),
  multiSku: z.boolean(),
  barcodeEnabled: z.boolean(),
})
const numberingSchema = z.object({
  docType: z.enum(DOC_TYPES),
  prefix: z.string().regex(/^[A-Z0-9-]{0,10}$/),
  dateFormat: z.enum(['YMD', 'YM', 'NONE']),
  seqDigits: z.number().int().min(3).max(8),
  reset: z.enum(['daily', 'monthly', 'yearly', 'never']),
})

export const configPackageSchema = z.object({
  formatVersion: z.literal(CONFIG_FORMAT_VERSION),
  exportedAt: z.string(),
  modules: z.array(z.object({ code: z.enum(MODULE_CODES), enabled: z.boolean() })),
  customFields: z.array(fieldDefSchema),
  settings: settingsSchema,
  numberingRules: z.array(numberingSchema),
  roleTemplates: z.array(
    z.object({
      name: z.string().min(1).max(30),
      permissions: z.array(z.string()),
      dataScope: z.union([z.object({ type: z.literal('all') }), z.object({ type: z.literal('own') })]),
    }),
  ),
  printTemplates: z.array(
    z.object({
      docType: z.enum(DOC_TYPES),
      name: z.string().min(1),
      paper: z.enum(['A4', 'A5', 'HALF', 'THIRD', 'R80']),
      layout: z.unknown(),
      isDefault: z.boolean(),
    }),
  ),
  branding: z
    .object({
      systemName: z.string().optional(),
      logo: imageAsset.nullable().optional(),
      themeColor: z.string().optional(),
      loginBg: imageAsset.nullable().optional(),
      copyright: z.string().optional(),
    })
    .nullable(),
  assets: z.record(z.unknown()).optional(),
})

export interface ConfigParseIssue {
  /** JSON 路径,如 $.customFields[0].code */
  path: string
  line: number
  reason: string
}
export type ConfigParseResult =
  | { ok: true; config: TenantConfig; formatVersion: number; exportedAt: string }
  | { ok: false; issues: ConfigParseIssue[] }

function jsonPath(path: (string | number)[]): string {
  return '$' + path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')
}
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** 解析配置包:大小 ≤ 10 MB → JSON 语法 → zod 结构,错误带 JSON 路径与行号(需求 8.4) */
export function parseConfigPackage(text: string): ConfigParseResult {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_CONFIG_PACKAGE_BYTES) return { ok: false, issues: [{ path: '$', line: 1, reason: '文件大于 10 MB' }] }

  const errors: JsoncError[] = []
  const value = parseJsonc(text, errors, { allowTrailingComma: false, disallowComments: true })
  if (errors.length > 0) {
    return {
      ok: false,
      issues: errors.slice(0, 20).map((e) => ({ path: '$', line: lineAt(text, e.offset), reason: `JSON 语法错误:${printParseErrorCode(e.error)}` })),
    }
  }
  const r = configPackageSchema.safeParse(value)
  if (!r.success) {
    const root = parseTree(text)
    const issues = r.error.issues.slice(0, 50).map((i) => {
      let node = root ? findNodeAtLocation(root, i.path) : undefined
      let p = [...i.path]
      while (!node && root && p.length > 0) {
        p = p.slice(0, -1)
        node = findNodeAtLocation(root, p)
      }
      const msg = i.path[0] === 'formatVersion' ? `格式版本号不受支持(支持版本 ${CONFIG_FORMAT_VERSION})` : i.message
      return { path: jsonPath(i.path), line: node ? lineAt(text, node.offset) : 1, reason: msg }
    })
    return { ok: false, issues }
  }
  const d = r.data
  const config: TenantConfig = normalizeConfig({
    modules: d.modules,
    customFields: d.customFields as ConfigFieldDef[],
    settings: d.settings,
    numberingRules: d.numberingRules,
    roleTemplates: d.roleTemplates,
    printTemplates: d.printTemplates as ConfigPrintTemplate[],
    branding: d.branding as ConfigBranding | null,
  })
  return { ok: true, config, formatVersion: d.formatVersion, exportedAt: d.exportedAt }
}

/* ───────────────────────── 预览与合并 ───────────────────────── */

export type ConfigCategory = 'module' | 'customField' | 'settings' | 'numberingRule' | 'role' | 'printTemplate' | 'branding'
export interface PreviewItem {
  category: ConfigCategory
  key: string
  action: 'add' | 'overwrite'
}
export interface SkippedItem {
  category: ConfigCategory
  key: string
  reason: string
}

/** 预览清单:每项属于“新增”或“覆盖”(需求 8.3) */
export function diffConfig(target: TenantConfig, pkg: TenantConfig): PreviewItem[] {
  const items: PreviewItem[] = []
  const tm = new Set(target.modules.map((m) => m.code))
  pkg.modules.forEach((m) => items.push({ category: 'module', key: m.code, action: tm.has(m.code) ? 'overwrite' : 'add' }))
  const tf = new Set(target.customFields.map((f) => `${f.objectType}.${f.code}`))
  pkg.customFields.forEach((f) => items.push({ category: 'customField', key: `${f.objectType}.${f.code}`, action: tf.has(`${f.objectType}.${f.code}`) ? 'overwrite' : 'add' }))
  items.push({ category: 'settings', key: 'settings', action: 'overwrite' })
  const tn = new Set(target.numberingRules.map((r) => r.docType))
  pkg.numberingRules.forEach((r) => items.push({ category: 'numberingRule', key: r.docType, action: tn.has(r.docType) ? 'overwrite' : 'add' }))
  const tr = new Set(target.roleTemplates.map((r) => r.name))
  pkg.roleTemplates.forEach((r) => items.push({ category: 'role', key: r.name, action: tr.has(r.name) ? 'overwrite' : 'add' }))
  const tp = new Set(target.printTemplates.map((p) => `${p.docType}.${p.name}`))
  pkg.printTemplates.forEach((p) => items.push({ category: 'printTemplate', key: `${p.docType}.${p.name}`, action: tp.has(`${p.docType}.${p.name}`) ? 'overwrite' : 'add' }))
  if (pkg.branding) items.push({ category: 'branding', key: 'branding', action: target.branding ? 'overwrite' : 'add' })
  return items
}

export interface MergeOptions {
  /** 目标 Tenant 中该自定义字段是否已有业务数据(需求 8.10) */
  fieldHasData?: (objectType: ObjectType, code: string) => boolean
}
export interface MergeResult {
  cfg: TenantConfig
  skipped: SkippedItem[]
}

/**
 * 以标识匹配覆盖,包里没有的目标项保持不变;未授权模块跳过;
 * 类型冲突且已有数据的自定义字段跳过(需求 8.5、8.8、8.10)。
 */
export function mergeConfig(target: TenantConfig, pkg: TenantConfig, license: { modules: ModuleCode[] }, opts: MergeOptions = {}): MergeResult {
  const skipped: SkippedItem[] = []
  const lic = new Set(license.modules)

  /* 模块 */
  const enabled = new Set(target.modules.filter((m) => m.enabled).map((m) => m.code))
  const known = new Set<ModuleCode>(target.modules.map((m) => m.code))
  for (const m of pkg.modules) known.add(m.code)
  for (const m of pkg.modules.filter((x) => x.enabled)) {
    const closure = closureOfDeps(m.code)
    const missing = closure.filter((c) => !lic.has(c))
    if (missing.length > 0) {
      skipped.push({ category: 'module', key: m.code, reason: `模块未授权:${missing.join('、')}` })
      continue
    }
    closure.forEach((c) => {
      enabled.add(c)
      known.add(c)
    })
  }
  // 关闭:求"可安全关闭的最大集合"——集合内每个模块仍启用的依赖方也必须在集合内。
  // 逐个按顺序处理会让结果依赖处理顺序,导致重复导入结果不同(幂等性被破坏)。
  const toDisable = new Set(pkg.modules.filter((x) => !x.enabled).map((x) => x.code))
  for (let changed = true; changed; ) {
    changed = false
    for (const code of [...toDisable]) {
      if (dependentsOf(code, enabled).some((d) => !toDisable.has(d))) {
        toDisable.delete(code)
        changed = true
      }
    }
  }
  for (const m of pkg.modules.filter((x) => !x.enabled)) {
    if (toDisable.has(m.code)) enabled.delete(m.code)
    else if (enabled.has(m.code)) {
      const deps = dependentsOf(m.code, enabled).filter((d) => !toDisable.has(d))
      skipped.push({ category: 'module', key: m.code, reason: `仍被已启用模块依赖:${deps.join('、')}` })
    }
  }
  const modules = [...known].map((code) => ({ code, enabled: enabled.has(code) }))

  /* 自定义字段 */
  const fields = new Map(target.customFields.map((f) => [`${f.objectType}.${f.code}`, f]))
  const perObject = new Map<ObjectType, number>()
  for (const f of fields.values()) perObject.set(f.objectType, (perObject.get(f.objectType) ?? 0) + 1)
  for (const f of pkg.customFields) {
    const key = `${f.objectType}.${f.code}`
    const old = fields.get(key)
    if (old) {
      if (old.type !== f.type && opts.fieldHasData?.(f.objectType, f.code)) {
        skipped.push({ category: 'customField', key, reason: '字段类型不同且目标租户已有该字段的业务数据' })
        continue
      }
      fields.set(key, f)
    } else {
      if ((perObject.get(f.objectType) ?? 0) >= MAX_FIELDS_PER_OBJECT) {
        skipped.push({ category: 'customField', key, reason: `该业务对象已有 ${MAX_FIELDS_PER_OBJECT} 个自定义字段` })
        continue
      }
      fields.set(key, f)
      perObject.set(f.objectType, (perObject.get(f.objectType) ?? 0) + 1)
    }
  }

  /* 编号规则 / 角色 / 打印模板 */
  const rules = new Map(target.numberingRules.map((r) => [r.docType, r]))
  pkg.numberingRules.forEach((r) => rules.set(r.docType, r))
  const roles = new Map(target.roleTemplates.map((r) => [r.name, r]))
  pkg.roleTemplates.forEach((r) => roles.set(r.name, r))
  const prints = new Map(target.printTemplates.map((p) => [`${p.docType}.${p.name}`, p]))
  const pkgDefaultKey = new Map<DocType, string>()
  for (const p of pkg.printTemplates) {
    prints.set(`${p.docType}.${p.name}`, p)
    if (p.isDefault) pkgDefaultKey.set(p.docType, `${p.docType}.${p.name}`)
  }
  // 每种单据类型有且仅有一个默认模板:配置包指定的默认优先
  const byDoc = new Map<DocType, ConfigPrintTemplate[]>()
  for (const p of prints.values()) byDoc.set(p.docType, [...(byDoc.get(p.docType) ?? []), p])
  for (const [docType, list] of byDoc) {
    const sorted = list.sort((a, b) => cmp(a.name, b.name))
    const chosen = pkgDefaultKey.get(docType) ?? `${docType}.${(sorted.find((x) => x.isDefault) ?? sorted[0]).name}`
    for (const p of sorted) prints.set(`${p.docType}.${p.name}`, { ...p, isDefault: `${p.docType}.${p.name}` === chosen })
  }

  const cfg = normalizeConfig({
    modules,
    customFields: [...fields.values()],
    settings: { ...target.settings, ...pkg.settings },
    numberingRules: [...rules.values()],
    roleTemplates: [...roles.values()],
    printTemplates: [...prints.values()],
    branding: pkg.branding ? normBranding({ ...(target.branding ?? {}), ...pkg.branding }) : target.branding,
  })
  return { cfg, skipped }
}
