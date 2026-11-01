import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  FIELD_TYPES,
  FieldDef,
  FieldType,
  FieldValue,
  MODULE_CODES,
  ModuleCode,
  RoleLike,
  buildValueSchema,
  closureOfDeps,
  decodeFieldValue,
  dependentsOf,
  disableModule,
  enableModule,
  encodeFieldValue,
  maskFields,
  mergeRoles,
  validateFieldDefinition,
  visibilityOf,
  MAX_FIELDS_PER_OBJECT,
  hasPermission,
  SENSITIVE_FIELDS,
} from '../src'

const moduleArb = fc.constantFrom<ModuleCode>(...MODULE_CODES)

/* ───────── Property 5: 模块依赖闭包 ───────── */

// 生成对依赖封闭的已启用集合
const closedSetArb = fc.subarray([...MODULE_CODES]).map((s) => {
  const out = new Set<ModuleCode>()
  s.forEach((m) => closureOfDeps(m).forEach((d) => out.add(d)))
  return out
})
const isClosed = (set: Set<ModuleCode>) => [...set].every((m) => closureOfDeps(m).every((d) => set.has(d)))

// Feature: lite-erp, Property 5: 模块依赖闭包
describe('Property 5: 模块依赖闭包', () => {
  it('启用/关闭保持依赖封闭;拒绝时集合不变', () => {
    fc.assert(
      fc.property(closedSetArb, fc.subarray([...MODULE_CODES]), moduleArb, (enabled, licensedArr, target) => {
        const licensed = new Set(licensedArr)
        const before = [...enabled].sort()

        const en = enableModule(enabled, licensed, target)
        const closure = closureOfDeps(target)
        if (closure.every((m) => licensed.has(m))) {
          expect(en.ok).toBe(true)
          if (en.ok) {
            expect(isClosed(new Set(en.enabled))).toBe(true)
            expect(en.enabled).toContain(target)
            // 自动启用列表 = 闭包中此前未启用且非目标本身的模块
            expect(en.autoEnabled.sort()).toEqual(closure.filter((m) => m !== target && !enabled.has(m)).sort())
          }
        } else {
          expect(en.ok).toBe(false)
          if (!en.ok) expect(en.unlicensed.sort()).toEqual(closure.filter((m) => !licensed.has(m)).sort())
        }
        expect([...enabled].sort()).toEqual(before) // 输入集合未被修改

        const dis = disableModule(enabled, target)
        const deps = dependentsOf(target, enabled)
        if (deps.length > 0) {
          expect(dis.ok).toBe(false)
          if (!dis.ok) expect(dis.dependents.sort()).toEqual(deps.sort())
        } else {
          expect(dis.ok).toBe(true)
          if (dis.ok) {
            expect(isClosed(new Set(dis.enabled))).toBe(true)
            expect(dis.enabled).not.toContain(target)
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  it('固定依赖表', () => {
    expect(closureOfDeps('purchase').sort()).toEqual(['inventory', 'product', 'purchase'])
    expect(closureOfDeps('sales').sort()).toEqual(['inventory', 'product', 'sales'])
    expect(closureOfDeps('finance')).toEqual(['finance'])
    expect(closureOfDeps('report')).toEqual(['report'])
  })
})

/* ───────── 自定义字段生成器 ───────── */

const OPTIONS = ['红', '蓝', '绿', '黄', '黑']
const baseDef = (type: FieldType, over: Partial<FieldDef> = {}): FieldDef => ({
  code: 'f_' + type,
  label: type,
  type,
  required: false,
  options: type === 'select' || type === 'multiselect' ? OPTIONS : undefined,
  displayOrder: 0,
  showInList: true,
  filterable: false,
  enabled: true,
  ...over,
})

const validDate = fc
  .record({ y: fc.integer({ min: 1900, max: 2100 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) })
  .map(({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)

const digits = (n: number) => fc.stringMatching(new RegExp(`^[0-9]{${n}}$`))

/** 每种类型的合法值 */
const validValue: Record<FieldType, fc.Arbitrary<unknown>> = {
  text: fc.string({ maxLength: 200, unit: 'binary' }).filter((s) => s !== ''),
  textarea: fc.string({ minLength: 1, maxLength: 300 }),
  integer: fc.integer({ min: -999_999_999, max: 999_999_999 }),
  decimal: fc
    .tuple(fc.boolean(), fc.integer({ min: 1, max: 12 }).chain((n) => digits(n)), fc.option(fc.integer({ min: 1, max: 6 }).chain((n) => digits(n)), { nil: undefined }))
    .map(([neg, i, f]) => `${neg ? '-' : ''}${i}${f !== undefined ? '.' + f : ''}`),
  date: validDate,
  select: fc.constantFrom(...OPTIONS),
  multiselect: fc.subarray(OPTIONS, { minLength: 1 }),
  boolean: fc.boolean(),
  image: fc.array(fc.uuid(), { minLength: 1, maxLength: 9 }),
}

/** 每种类型的非法值(非空) */
const invalidValue: Record<FieldType, fc.Arbitrary<unknown>> = {
  text: fc.string({ minLength: 201, maxLength: 260 }),
  textarea: fc.string({ minLength: 2001, maxLength: 2100 }),
  integer: fc.oneof(fc.constantFrom(1_000_000_000, -1_000_000_000, 1.5, 'x' as unknown), fc.integer({ min: 1_000_000_000, max: 2_000_000_000 })),
  decimal: fc.constantFrom('1234567890123', '1.1234567', 'abc', '1.', '--1', 12 as unknown),
  date: fc.constantFrom('2026-02-30', '2026-13-01', '20260101', '2026-1-1', 'x'),
  select: fc.constantFrom('紫', '', 1 as unknown).filter((v) => v !== ''),
  multiselect: fc.constantFrom(['红', '紫'], ['x'], 'red' as unknown),
  boolean: fc.constantFrom('true' as unknown, 1 as unknown, 'yes' as unknown),
  image: fc.oneof(
    fc.array(fc.uuid(), { minLength: 10, maxLength: 12 }),
    fc.constant(['']),
    fc.constant('abc' as unknown),
  ),
}

const typeArb = fc.constantFrom<FieldType>(...FIELD_TYPES)

type Case = { type: FieldType; required: boolean; kind: 'valid' | 'invalid' | 'empty'; value: unknown }
const caseArb: fc.Arbitrary<Case> = fc.tuple(typeArb, fc.boolean(), fc.constantFrom('valid', 'invalid', 'empty') as fc.Arbitrary<Case['kind']>).chain(([type, required, kind]) => {
  const v = kind === 'valid' ? validValue[type] : kind === 'invalid' ? invalidValue[type] : fc.constantFrom<unknown>(undefined, null, '')
  return v.map((value) => ({ type, required, kind, value }))
})

// Feature: lite-erp, Property 6: 自定义字段校验
describe('Property 6: 自定义字段校验', () => {
  it('schema 接受取值当且仅当全部字段满足约束;拒绝时列出的字段恰好等于全部违规字段', () => {
    fc.assert(
      fc.property(fc.array(caseArb, { minLength: 1, maxLength: 9 }), fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }), (cases, enabledFlags) => {
        // 每种类型至多一个字段(编码按类型+序号唯一)
        const defs: FieldDef[] = cases.map((c, i) => baseDef(c.type, { code: `f${i}`, required: c.required, enabled: enabledFlags[i] }))
        const values: Record<string, unknown> = {}
        cases.forEach((c, i) => {
          if (c.value !== undefined) values[`f${i}`] = c.value
        })
        const expectedViolations = cases
          .map((c, i) => ({ c, i, enabled: enabledFlags[i] }))
          .filter(({ c, enabled }) => enabled && (c.kind === 'invalid' || (c.kind === 'empty' && c.required)))
          .map(({ i }) => `f${i}`)
          .sort()

        const r = buildValueSchema(defs).safeParse(values)
        if (expectedViolations.length === 0) {
          expect(r.success).toBe(true)
        } else {
          expect(r.success).toBe(false)
          if (!r.success) {
            const got = [...new Set(r.error.issues.map((i) => String(i.path[0])))].sort()
            expect(got).toEqual(expectedViolations)
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  const validDefArb = typeArb.map((t) => baseDef(t, { code: 'abc_1', label: '品牌', displayOrder: 10 }))

  it('合法定义无问题;违反属性约束的定义返回非空问题列表', () => {
    fc.assert(
      fc.property(validDefArb, (def) => {
        expect(validateFieldDefinition(def, [])).toHaveLength(0)
      }),
      { numRuns: 50 },
    )
    const mutations: ((d: FieldDef) => FieldDef)[] = [
      (d) => ({ ...d, code: '1abc' }),
      (d) => ({ ...d, code: '' }),
      (d) => ({ ...d, code: 'a'.repeat(33) }),
      (d) => ({ ...d, code: 'a-b' }),
      (d) => ({ ...d, label: '' }),
      (d) => ({ ...d, label: 'x'.repeat(21) }),
      (d) => ({ ...d, displayOrder: -1 }),
      (d) => ({ ...d, displayOrder: 10000 }),
      (d) => ({ ...d, displayOrder: 1.5 }),
      (d) => ({ ...d, type: 'select', options: undefined }),
      (d) => ({ ...d, type: 'select', options: ['a', 'a'] }),
      (d) => ({ ...d, type: 'select', options: Array.from({ length: 51 }, (_, i) => 'o' + i) }),
      (d) => ({ ...d, type: 'select', options: ['x'.repeat(33)] }),
      (d) => ({ ...d, type: 'text', options: ['a'] }),
      (d) => ({ ...d, type: 'image', filterable: true }),
      (d) => ({ ...d, type: 'integer', defaultValue: 1_000_000_000 }),
      (d) => ({ ...d, type: 'select', options: ['a'], defaultValue: 'b' }),
    ]
    fc.assert(
      fc.property(validDefArb, fc.constantFrom(...mutations), (def, mutate) => {
        expect(validateFieldDefinition(mutate(def), []).length).toBeGreaterThan(0)
      }),
      { numRuns: 200 },
    )
  })

  it('超出 50 个上限、编码重复(不区分大小写)被拒绝;编码与类型保存后不可修改', () => {
    const existing = Array.from({ length: MAX_FIELDS_PER_OBJECT }, (_, i) => baseDef('text', { code: 'f' + i }))
    expect(validateFieldDefinition(baseDef('text', { code: 'newone' }), existing).length).toBeGreaterThan(0)
    expect(validateFieldDefinition(baseDef('text', { code: 'F1' }), existing.slice(0, 10)).some((i) => i.reason.includes('重复'))).toBe(true)
    const orig = baseDef('text', { code: 'brand' })
    expect(validateFieldDefinition({ ...orig, label: '改名' }, [orig], { original: orig })).toHaveLength(0)
    expect(validateFieldDefinition({ ...orig, code: 'brand2' }, [orig], { original: orig }).length).toBeGreaterThan(0)
    expect(validateFieldDefinition({ ...orig, type: 'integer' }, [orig], { original: orig }).length).toBeGreaterThan(0)
  })
})

// Feature: lite-erp, Property 7: 自定义字段写读往返
describe('Property 7: 自定义字段写读往返', () => {
  it('decode(encode(v)) 与 v 相等(多选比较选项集合,小数比较数值与小数位数)', () => {
    fc.assert(
      fc.property(typeArb.chain((t) => validValue[t].map((v) => ({ t, v }))), ({ t, v }) => {
        const def = baseDef(t)
        const stored = JSON.parse(JSON.stringify(encodeFieldValue(def, v as FieldValue)))
        const back = decodeFieldValue(def, stored)
        if (t === 'multiselect') {
          expect(new Set(back as string[])).toEqual(new Set(v as string[]))
        } else if (t === 'image') {
          expect(back).toEqual(Array.from(new Set(v as string[])))
        } else {
          expect(back).toEqual(v)
          if (t === 'decimal') expect((back as string).split('.')[1]?.length ?? 0).toBe(((v as string).split('.')[1] ?? '').length)
        }
      }),
      { numRuns: 300 },
    )
  })
})

/* ───────── Property 8: 权限并集与字段脱敏 ───────── */

const PERM_POOL = ['menu:product', 'menu:sales', 'sales_out:view', 'sales_out:audit', 'product:view', 'product:create', 'field:cost', 'field:profit', 'purchase_in:view']
const roleArb: fc.Arbitrary<RoleLike> = fc.record({
  permissions: fc.subarray(PERM_POOL),
  dataScope: fc.oneof(
    fc.constant({ type: 'all' as const }),
    fc.constant({ type: 'own' as const }),
    fc.subarray(['w1', 'w2', 'w3', 'w4'], { minLength: 1 }).map((ids) => ({ type: 'warehouses' as const, ids })),
  ),
})

// Feature: lite-erp, Property 8: 权限并集与字段脱敏
describe('Property 8: 权限并集与字段脱敏', () => {
  it('mergeRoles 取并集;Tenant_Admin 全部权限;无 Role 为空', () => {
    fc.assert(
      fc.property(fc.array(roleArb, { maxLength: 5 }), (roles) => {
        const eff = mergeRoles(roles, false)
        const union = new Set(roles.flatMap((r) => r.permissions))
        expect(new Set(eff.permissions)).toEqual(union)
        expect(eff.dataScope.all).toBe(roles.some((r) => r.dataScope.type === 'all'))
        expect(eff.dataScope.own).toBe(roles.some((r) => r.dataScope.type === 'own'))
        expect(new Set(eff.dataScope.warehouseIds)).toEqual(new Set(roles.flatMap((r) => (r.dataScope.type === 'warehouses' ? r.dataScope.ids : []))))
        for (const p of PERM_POOL) expect(hasPermission(eff, p)).toBe(union.has(p))
        if (roles.length === 0) {
          expect(eff.permissions).toHaveLength(0)
          expect(eff.dataScope).toEqual({ all: false, warehouseIds: [], own: false })
        }
        const admin = mergeRoles(roles, true)
        expect(admin.isAdmin).toBe(true)
        expect(hasPermission(admin, 'anything:at_all')).toBe(true)
        expect(admin.dataScope.all).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  const normalKeys = ['id', 'code', 'name', 'qty', 'price', 'amount', 'remark', 'refSalePrice']
  const sensitiveKeys = Object.keys(SENSITIVE_FIELDS)
  const leafArb = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
  const dtoArb: fc.Arbitrary<any> = fc.letrec((tie) => ({
    obj: fc.dictionary(fc.constantFrom(...normalKeys, ...sensitiveKeys), fc.oneof(leafArb, tie('obj'), tie('arr')), { maxKeys: 8 }),
    arr: fc.array(fc.oneof(leafArb, tie('obj')), { maxLength: 3 }),
  })).obj

  const expectedMask = (v: any, vis: { cost: boolean; profit: boolean }): any => {
    if (Array.isArray(v)) return v.map((x) => expectedMask(x, vis))
    if (v && typeof v === 'object') {
      const out: any = {}
      for (const [k, x] of Object.entries(v)) {
        const need = SENSITIVE_FIELDS[k]
        if (need && need.some((n) => !vis[n])) continue
        out[k] = expectedMask(x, vis)
      }
      return out
    }
    return v
  }

  it('缺少权限时不含对应敏感字段,其余字段保持不变', () => {
    fc.assert(
      fc.property(dtoArb, fc.boolean(), fc.boolean(), (dto, cost, profit) => {
        const eff = mergeRoles([{ permissions: [...(cost ? ['field:cost'] : []), ...(profit ? ['field:profit'] : [])], dataScope: { type: 'all' } }], false)
        const vis = visibilityOf(eff)
        expect(vis).toEqual({ cost, profit })
        const out = maskFields(dto, vis)
        expect(out).toEqual(expectedMask(dto, vis))
        const flat = JSON.stringify(out)
        if (!cost) for (const k of ['refCostPrice', 'costPrice', 'costAmount', 'avgCost', 'stockAmount', 'grossProfit']) expect(flat).not.toContain(`"${k}":`)
        if (!profit) for (const k of ['grossProfit', 'grossMargin', 'profit']) expect(flat).not.toContain(`"${k}":`)
        // 不修改入参
        expect(dto).toEqual(JSON.parse(JSON.stringify(dto)))
      }),
      { numRuns: 300 },
    )
  })

  it('同时具备两项权限时原样返回', () => {
    const dto = { name: 'a', refCostPrice: '1', grossProfit: '2', grossMargin: '0.2', list: [{ costAmount: '3', qty: '1' }] }
    expect(maskFields(dto, { cost: true, profit: true })).toEqual(dto)
    expect(maskFields(dto, { cost: true, profit: false })).toEqual({ name: 'a', refCostPrice: '1', list: [{ costAmount: '3', qty: '1' }] })
    expect(maskFields(dto, { cost: false, profit: true })).toEqual({ name: 'a', grossMargin: '0.2', list: [{ qty: '1' }] })
  })
})
