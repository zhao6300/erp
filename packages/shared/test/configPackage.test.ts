import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ColumnType,
  ConfigFieldDef,
  DOC_TYPES,
  FIELD_TYPES,
  MODULE_CODES,
  OBJECT_TYPES,
  PAPERS,
  PaperCode,
  TenantConfig,
  availablePlaceholders,
  defaultPrintLayout,
  diffConfig,
  emptyConfig,
  formatCell,
  mergeConfig,
  normalizeConfig,
  paginate,
  parseCell,
  parseConfigPackage,
  renderPrintHtml,
  serializeConfigPackage,
  validatePrintTemplate,
  exportNotices,
  CellValue,
} from '../src'

/* ───────── 生成器 ───────── */

const fieldDefArb: fc.Arbitrary<ConfigFieldDef> = fc
  .tuple(
    fc.constantFrom(...OBJECT_TYPES),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,10}$/),
    fc.constantFrom(...FIELD_TYPES),
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.record({ required: fc.boolean(), showInList: fc.boolean(), filterable: fc.boolean(), enabled: fc.boolean(), displayOrder: fc.integer({ min: 0, max: 9999 }) }),
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 }),
  )
  .map(([objectType, code, type, label, flags, options]) => ({
    objectType,
    code,
    type,
    label,
    ...flags,
    options: type === 'select' || type === 'multiselect' ? options : undefined,
    defaultValue: undefined,
  }))

const imageArb = fc.option(
  fc.record({ mime: fc.constantFrom('image/png' as const, 'image/jpeg' as const, 'image/svg+xml' as const), base64: fc.base64String({ minLength: 4, maxLength: 40 }) }),
  { nil: undefined },
)

const layoutArb = fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean(), fc.array(fc.integer(), { maxLength: 3 })), { maxKeys: 4 })

const configArb: fc.Arbitrary<TenantConfig> = fc
  .record({
    modules: fc.uniqueArray(fc.record({ code: fc.constantFrom(...MODULE_CODES), enabled: fc.boolean() }), { selector: (m) => m.code, maxLength: 6 }),
    customFields: fc.uniqueArray(fieldDefArb, { selector: (f) => `${f.objectType}.${f.code}`, maxLength: 5 }),
    settings: fc.record({
      qtyScale: fc.integer({ min: 0, max: 4 }),
      priceScale: fc.integer({ min: 0, max: 6 }),
      amountScale: fc.integer({ min: 0, max: 2 }),
      allowNegativeStock: fc.boolean(),
      requireAudit: fc.boolean(),
      multiUnit: fc.boolean(),
      multiSku: fc.boolean(),
      barcodeEnabled: fc.boolean(),
    }),
    numberingRules: fc.uniqueArray(
      fc.record({
        docType: fc.constantFrom(...DOC_TYPES),
        prefix: fc.stringMatching(/^[A-Z0-9-]{0,10}$/),
        dateFormat: fc.constantFrom('YMD' as const, 'YM' as const, 'NONE' as const),
        seqDigits: fc.integer({ min: 3, max: 8 }),
        reset: fc.constantFrom('daily' as const, 'monthly' as const, 'yearly' as const, 'never' as const),
      }),
      { selector: (r) => r.docType, maxLength: 5 },
    ),
    roleTemplates: fc.uniqueArray(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 30 }),
        permissions: fc.array(fc.stringMatching(/^[a-z_]{1,8}:[a-z]{1,6}$/), { maxLength: 5 }),
        dataScope: fc.constantFrom({ type: 'all' as const }, { type: 'own' as const }),
      }),
      { selector: (r) => r.name, maxLength: 4 },
    ),
    printTemplates: fc.uniqueArray(
      fc.record({
        docType: fc.constantFrom(...DOC_TYPES),
        name: fc.string({ minLength: 1, maxLength: 10 }),
        paper: fc.constantFrom<PaperCode>('A4', 'A5', 'HALF', 'THIRD', 'R80'),
        layout: layoutArb,
        isDefault: fc.boolean(),
      }),
      { selector: (p) => `${p.docType}.${p.name}`, maxLength: 5 },
    ),
    branding: fc.option(
      fc.record({
        systemName: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
        logo: imageArb,
        themeColor: fc.option(fc.stringMatching(/^#[0-9A-F]{6}$/), { nil: undefined }),
        loginBg: imageArb,
        copyright: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
      }),
      { nil: null },
    ),
  })
  .map((c) => c as TenantConfig)

const SECRET = '\u2603BIZ-SECRET\u2603'

// Feature: lite-erp, Property 3: 配置包往返
describe('Property 3: 配置包往返', () => {
  it('serialize → parse → serialize 内容(除导出时间外)完全相同', () => {
    fc.assert(
      fc.property(configArb, (cfg) => {
        const first = serializeConfigPackage(cfg, '2026-09-30T10:00:00+08:00')
        const parsed = parseConfigPackage(first)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        const second = serializeConfigPackage(parsed.config, '2026-10-01T00:00:00+08:00')
        expect(JSON.parse(second)).toEqual({ ...JSON.parse(first), exportedAt: '2026-10-01T00:00:00+08:00' })
        // 同一导出时间字节级一致(确定性输出)
        expect(serializeConfigPackage(parsed.config, '2026-09-30T10:00:00+08:00')).toBe(first)
        expect(parsed.config).toEqual(normalizeConfig(cfg))
      }),
      { numRuns: 150 },
    )
  })

  it('导出文件不含业务数据、账号、Role 分配、License 与流水号当前值', () => {
    fc.assert(
      fc.property(configArb, (cfg) => {
        const polluted: any = {
          ...cfg,
          products: [{ code: SECRET }],
          documents: [{ docNo: SECRET }],
          users: [{ phone: SECRET, password_hash: SECRET }],
          userRoles: [{ u: SECRET }],
          license: { maxUsers: 9999, signature: SECRET },
          stockLedger: [SECRET],
          numberingRules: cfg.numberingRules.map((r) => ({ ...r, lastValue: SECRET, currentSeq: SECRET })),
          roleTemplates: cfg.roleTemplates.map((r) => ({ ...r, assignedUsers: [SECRET] })),
          branding: cfg.branding ? { ...cfg.branding, customDomain: SECRET } : null,
        }
        const text = serializeConfigPackage(polluted, 'now')
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain('password')
        expect(text).not.toContain('license')
        expect(text).not.toContain('lastValue')
      }),
      { numRuns: 100 },
    )
  })

  it('指定仓库的数据权限降级为本人单据并给出提示', () => {
    const cfg = emptyConfig()
    const roles: any = [{ name: '仓管', permissions: [], dataScope: { type: 'warehouses', ids: ['w1'] } }]
    cfg.roleTemplates = roles
    expect(exportNotices(cfg)).toHaveLength(1)
    const parsed = parseConfigPackage(serializeConfigPackage(cfg, 'now'))
    expect(parsed.ok && parsed.config.roleTemplates[0].dataScope).toEqual({ type: 'own' })
  })

  it('错误定位:非法 JSON、结构错误、版本号、超大文件', () => {
    const good = JSON.parse(serializeConfigPackage(emptyConfig(), 'now'))
    const bad1 = parseConfigPackage('{"formatVersion": 1,\n "modules": [}')
    expect(bad1.ok).toBe(false)
    if (!bad1.ok) expect(bad1.issues[0].line).toBeGreaterThanOrEqual(2)

    const withField = { ...good, customFields: [{ objectType: 'product', code: 'a', label: 'x', type: 'nope', required: false, displayOrder: 0, showInList: true, filterable: false, enabled: true }] }
    const bad2 = parseConfigPackage(JSON.stringify(withField, null, 2))
    expect(bad2.ok).toBe(false)
    if (!bad2.ok) {
      expect(bad2.issues[0].path).toBe('$.customFields[0].type')
      expect(bad2.issues[0].line).toBeGreaterThan(1)
    }

    const bad3 = parseConfigPackage(JSON.stringify({ ...good, formatVersion: 99 }))
    expect(bad3.ok).toBe(false)
    if (!bad3.ok) expect(bad3.issues[0].path).toBe('$.formatVersion')

    const bad4 = parseConfigPackage('x'.repeat(10 * 1024 * 1024 + 1))
    expect(bad4.ok).toBe(false)
    expect(parseConfigPackage('[]').ok).toBe(false)
  })
})

// Feature: lite-erp, Property 4: 配置包导入幂等
describe('Property 4: 配置包导入幂等', () => {
  it('merge 两次等于一次;第二次预览“新增”项为 0;同标识取包内值,包内没有的目标项不变', () => {
    fc.assert(
      fc.property(configArb, configArb, fc.subarray([...MODULE_CODES]), (target, pkg, licensed) => {
        const t = normalizeConfig(target)
        const p = normalizeConfig(pkg)
        const license = { modules: licensed }
        const once = mergeConfig(t, p, license)
        const twice = mergeConfig(once.cfg, p, license)
        expect(twice.cfg).toEqual(once.cfg)
        expect(diffConfig(once.cfg, p).filter((i) => i.action === 'add')).toHaveLength(0)

        // 同标识取包内值
        for (const f of p.customFields) {
          const got = once.cfg.customFields.find((x) => x.objectType === f.objectType && x.code === f.code)
          expect(got).toEqual(f)
        }
        for (const r of p.numberingRules) expect(once.cfg.numberingRules.find((x) => x.docType === r.docType)).toEqual(r)
        for (const r of p.roleTemplates) expect(once.cfg.roleTemplates.find((x) => x.name === r.name)).toEqual(r)
        expect(once.cfg.settings).toEqual(p.settings)
        // 包里没有的目标项保持不变
        for (const f of t.customFields) {
          if (!p.customFields.some((x) => x.objectType === f.objectType && x.code === f.code)) expect(once.cfg.customFields).toContainEqual(f)
        }
        for (const r of t.numberingRules) if (!p.numberingRules.some((x) => x.docType === r.docType)) expect(once.cfg.numberingRules).toContainEqual(r)
        for (const r of t.roleTemplates) if (!p.roleTemplates.some((x) => x.name === r.name)) expect(once.cfg.roleTemplates).toContainEqual(r)
        // 未授权模块不会被启用
        for (const m of once.cfg.modules) if (m.enabled && !t.modules.find((x) => x.code === m.code)?.enabled) expect(licensed).toContain(m.code)
        // 每种单据类型的默认打印模板至多一个
        const defaults = new Map<string, number>()
        once.cfg.printTemplates.filter((x) => x.isDefault).forEach((x) => defaults.set(x.docType, (defaults.get(x.docType) ?? 0) + 1))
        for (const n of defaults.values()) expect(n).toBe(1)
      }),
      { numRuns: 200 },
    )
  })

  it('类型冲突且目标已有业务数据的自定义字段被跳过;未授权模块被跳过', () => {
    const target = emptyConfig()
    const f = (type: any): ConfigFieldDef => ({ objectType: 'product', code: 'brand', label: '品牌', type, required: false, displayOrder: 0, showInList: true, filterable: false, enabled: true })
    target.customFields = [f('text')]
    const pkg = emptyConfig()
    pkg.customFields = [f('integer')]
    pkg.modules = [{ code: 'sales', enabled: true }]
    const r = mergeConfig(target, pkg, { modules: ['product'] }, { fieldHasData: () => true })
    expect(r.cfg.customFields[0].type).toBe('text')
    expect(r.skipped.map((s) => s.category).sort()).toEqual(['customField', 'module'])
    expect(r.cfg.modules.find((m) => m.code === 'sales')?.enabled).toBe(false)
    const r2 = mergeConfig(target, pkg, { modules: ['product', 'inventory', 'sales'] }, { fieldHasData: () => false })
    expect(r2.cfg.customFields[0].type).toBe('integer')
    expect(r2.cfg.modules.filter((m) => m.enabled).map((m) => m.code).sort()).toEqual(['inventory', 'product', 'sales'])
  })
})

/* ───────── Property 26(纯函数部分): 单元格往返 ───────── */

// Feature: lite-erp, Property 26: Excel 导出导入往返
describe('Property 26: 单元格往返(parseCell ∘ formatCell)', () => {
  const cases: Record<ColumnType, fc.Arbitrary<CellValue>> = {
    text: fc.string({ minLength: 1, maxLength: 60, unit: 'binary' }),
    integer: fc.integer({ min: -999_999_999, max: 999_999_999 }),
    decimal: fc.tuple(fc.integer({ min: 0, max: 10 ** 9 }), fc.integer({ min: 0, max: 6 })).map(([n, s]) => (s === 0 ? String(n) : `${Math.floor(n / 10 ** s)}.${String(n % 10 ** s).padStart(s, '0')}`)),
    date: fc.record({ y: fc.integer({ min: 1900, max: 2100 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) }).map(({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
    boolean: fc.boolean(),
    select: fc.string({ minLength: 1, maxLength: 10 }),
    multiselect: fc.array(fc.string({ minLength: 1, maxLength: 8, unit: 'binary' }), { minLength: 1, maxLength: 5 }),
  }
  it('parseCell(formatCell(v)) 等于 v,含特殊字符、前导零、逗号与反斜杠', () => {
    const typeArb = fc.constantFrom<ColumnType>('text', 'integer', 'decimal', 'date', 'boolean', 'select', 'multiselect')
    fc.assert(
      fc.property(typeArb.chain((type) => cases[type].map((v) => ({ type, v }))), ({ type, v }) => {
        expect(parseCell({ type }, formatCell({ type }, v))).toEqual(v)
      }),
      { numRuns: 500 },
    )
    expect(parseCell({ type: 'text' }, formatCell({ type: 'text' }, '00123'))).toBe('00123')
    expect(parseCell({ type: 'text' }, formatCell({ type: 'text' }, '=SUM(A1)'))).toBe('=SUM(A1)')
    expect(parseCell({ type: 'multiselect' }, formatCell({ type: 'multiselect' }, ['a,b', 'c\\d']))).toEqual(['a,b', 'c\\d'])
    expect(parseCell({ type: 'text' }, '')).toBeNull()
    expect(() => parseCell({ type: 'integer' }, '1.5')).toThrow()
  })
})

/* ───────── 打印分页 ───────── */

describe('打印分页(需求 20.7)', () => {
  const papers: PaperCode[] = ['A4', 'A5', 'HALF', 'THIRD']
  it('整行分页:每行恰好出现一次且不跨页;合计仅末页;页码正确', () => {
    fc.assert(
      fc.property(fc.constantFrom(...papers), fc.integer({ min: 0, max: 1200 }), (paper, rows) => {
        const t = { paper, layout: defaultPrintLayout('sales_out') }
        const pages = paginate(t, rows)
        expect(pages.length).toBeGreaterThanOrEqual(1)
        let next = 0
        pages.forEach((p, i) => {
          expect(p.rowStart).toBe(next)
          expect(p.rowEnd).toBeGreaterThanOrEqual(p.rowStart)
          next = p.rowEnd
          expect(p.index).toBe(i + 1)
          expect(p.total).toBe(pages.length)
          expect(p.label).toBe(`第 ${i + 1} 页 / 共 ${pages.length} 页`)
          expect(p.showTotals).toBe(i === pages.length - 1)
          const m = t.layout.metrics
          const avail = PAPERS[paper].h! - 2 * m.margin - m.headerHeight - m.columnTitleHeight - m.footerHeight - (p.showTotals ? m.totalsHeight : 0)
          expect(p.rowEnd - p.rowStart).toBeLessThanOrEqual(Math.max(1, Math.floor(avail / m.rowHeight)))
        })
        expect(next).toBe(rows)
        if (rows > 0) expect(pages[pages.length - 1].rowEnd - pages[pages.length - 1].rowStart).toBeGreaterThanOrEqual(1)
      }),
      { numRuns: 200 },
    )
  })

  it('小票为单页连续长度', () => {
    const pages = paginate({ paper: 'R80', layout: defaultPrintLayout('sales_out') }, 500)
    expect(pages).toHaveLength(1)
    expect(pages[0].showTotals).toBe(true)
  })

  it('HTML:每页重复表头与列标题,合计只出现在末页,空值输出空白', () => {
    const t = { paper: 'A5' as PaperCode, layout: defaultPrintLayout('sales_out') }
    const lines = Array.from({ length: 60 }, (_, i) => ({ lineNo: String(i + 1), productName: `商品${i}`, qty: '1.00' }))
    const html = renderPrintHtml(t, { header: { docNo: 'XS001', totalAmount: '99.00', remark: null }, lines, tenantName: '测试公司' })
    const pages = paginate(t, 60)
    expect(pages.length).toBeGreaterThan(1)
    expect((html.match(/<thead>/g) ?? []).length).toBe(pages.length)
    expect((html.match(/合计金额:99\.00/g) ?? []).length).toBe(1)
    expect(html).toContain(`第 1 页 / 共 ${pages.length} 页`)
    expect(html).toContain('备注:<')
    expect(html).not.toContain('{{')
  })

  it('占位符校验:无效占位符被列出,停用的自定义字段不可引用', () => {
    const layout = defaultPrintLayout('sales_out')
    layout.header.push({ text: '{{header.nope}} {{cf.brand}} {{cf.color}}', x: 0, y: 0, fontSize: 9, visible: true })
    const r = validatePrintTemplate({ paper: 'A4', layout }, 'sales_out', [
      { code: 'brand', enabled: true },
      { code: 'color', enabled: false },
    ])
    expect(r.invalidPlaceholders.sort()).toEqual(['cf.color', 'header.nope'])
    expect(availablePlaceholders('transfer', [{ code: 'brand', enabled: true }]).has('cf.brand')).toBe(false)
    layout.header[layout.header.length - 1].fontSize = 5
    expect(validatePrintTemplate({ paper: 'A4', layout }, 'sales_out', []).issues.some((i) => i.field === 'fontSize')).toBe(true)
  })
})
