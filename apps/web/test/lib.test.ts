import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Bootstrap } from '@erp/api-client'
import { DEFAULT_SCALES, FieldDef, computeDocAmounts, calcLineAmount, dec, addOrIncrement, emptyForm, fieldsForForm, initialCustom, newLine, precheck, repriceLines, toInput, totals } from '@erp/shared'
import { layoutFor } from '../src/lib/layout'
import { MENU, routeGuard, visibleMenu } from '../src/lib/menu'

const boot = (o: { modules: string[]; perms?: string[]; admin?: boolean }): Bootstrap =>
  ({
    user: { id: 'u', name: 'u', isTenantAdmin: !!o.admin, mustChangePassword: false },
    permissions: { isAdmin: !!o.admin, permissions: o.perms ?? [], dataScope: { all: true, warehouseIds: [], own: false } },
    modules: o.modules,
  }) as unknown as Bootstrap

const keys = (items: ReturnType<typeof visibleMenu>): string[] => items.flatMap((i) => (i.children ? keys(i.children) : [i.key]))

describe('菜单:按模块与权限显隐(需求 4.5、10.9)', () => {
  it('模块关闭 → 该模块的全部菜单项与报表入口隐藏,整组无可见项时分组也隐藏', () => {
    const all = ['product', 'inventory', 'purchase', 'sales', 'finance', 'report']
    const perms = MENU.flatMap((g) => g.children ?? [g]).map((i) => `menu:${i.key}`)
    const full = keys(visibleMenu(boot({ modules: all, perms })))
    expect(full).toContain('sales_out')
    expect(full).toContain('report')
    const noSales = keys(visibleMenu(boot({ modules: all.filter((m) => m !== 'sales'), perms })))
    expect(noSales).not.toContain('sales_out')
    expect(noSales).not.toContain('sales_order')
    expect(noSales).toContain('purchase_in')
    const onlyProduct = visibleMenu(boot({ modules: ['product'], perms }))
    expect(onlyProduct.map((g) => g.key)).not.toContain('g-sales')
    expect(onlyProduct.map((g) => g.key)).not.toContain('g-finance')
  })

  it('无菜单权限的入口隐藏;系统设置仅 Tenant_Admin 可见;首页所有人可见', () => {
    const b = boot({ modules: ['sales', 'product', 'inventory'], perms: ['menu:sales_out'] })
    expect(keys(visibleMenu(b)).sort()).toEqual(['dashboard', 'sales_out'])
    expect(keys(visibleMenu(b))).not.toContain('settings')
    const admin = keys(visibleMenu(boot({ modules: ['product'], admin: true })))
    expect(admin).toEqual(expect.arrayContaining(['dashboard', 'product', 'settings', 'roles', 'audit']))
    expect(admin).not.toContain('sales_out') // 管理员也受模块开关约束
  })

  it('直接输入地址访问未启用模块:只提示"模块未启用"', () => {
    expect(routeGuard(boot({ modules: ['product'] }), 'sales')).toBe('module_disabled')
    expect(routeGuard(boot({ modules: ['product', 'sales'] }), 'sales')).toBe('ok')
    expect(routeGuard(boot({ modules: [] }), undefined)).toBe('ok')
  })
})

describe('响应式布局(需求 19.2、19.3、19.11)', () => {
  it('≥1280 完整布局;769–1279 保留全部入口且表格内部滚动;375–768 单列卡片;任何宽度都不出现页面级横向滚动', () => {
    expect(layoutFor(1280)).toMatchObject({ mode: 'desktop', sidebar: 'expanded', tableAs: 'table' })
    expect(layoutFor(1279)).toMatchObject({ mode: 'tablet', sidebar: 'collapsible', tableAs: 'table', tableOverflowX: 'auto', allEntriesAvailable: true })
    expect(layoutFor(769).mode).toBe('tablet')
    expect(layoutFor(768)).toMatchObject({ mode: 'mobile', singleColumn: true, tableAs: 'cards' })
    expect(layoutFor(375).mode).toBe('mobile')
    fc.assert(fc.property(fc.integer({ min: 320, max: 3840 }), (w) => layoutFor(w).pageOverflowX === 'hidden' && layoutFor(w).allEntriesAvailable))
  })
})

describe('开单表单:前后端金额一致(需求 15.2、16.2)', () => {
  const mkForm = () => {
    const f = emptyForm('sales_out', '2026-09-30')
    f.partnerId = 'p'
    f.warehouseId = 'w'
    f.lines = [newLine({ skuId: 's1', label: 'A' }, '9.99', 'w'), newLine({ skuId: 's2', label: 'B' }, '0.335', 'w')]
    return f
  }

  it('合计 = 逐行四舍五入后求和 − 整单优惠;与后端同一函数的结果相同', () => {
    const f = mkForm()
    f.lines[0].qty = '3'
    f.lines[1].qty = '3'
    f.lines[1].discountRate = '90'
    f.docDiscount = '1.00'
    const t = totals(f, DEFAULT_SCALES)
    expect(t.lines.map((l) => l.amount)).toEqual(['29.97', '0.90']) // 3×0.335×0.9 = 0.9045 → 0.90
    expect(t.total).toBe('29.87')
    const server = computeDocAmounts(toInput(f), DEFAULT_SCALES)
    expect(server.total.toFixed(2)).toBe(t.total)
  })

  it('随机表单:前端合计与逐行 calcLineAmount 之和一致', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ qty: fc.integer({ min: 1, max: 99 }), price: fc.integer({ min: 0, max: 99999 }), rate: fc.integer({ min: 0, max: 100 }) }), { minLength: 1, maxLength: 8 }), (rows) => {
        const f = mkForm()
        f.lines = rows.map((r, i) => ({ ...newLine({ skuId: `s${i}`, label: 'x' }, (r.price / 100).toFixed(2), 'w'), qty: String(r.qty), discountRate: String(r.rate) }))
        const sum = rows.reduce((a, r) => a.plus(calcLineAmount(r.qty, (r.price / 100).toFixed(2), r.rate, 2)), dec(0))
        expect(totals(f, DEFAULT_SCALES).total).toBe(sum.toFixed(2))
      }),
      { numRuns: 100 },
    )
  })

  it('预校验与后端同一规则:数量 ≤ 0、已收超过总额、缺客户都给出带行号的错误', () => {
    const f = mkForm()
    f.partnerId = null
    f.lines[0].qty = '0'
    f.paidAmount = '99999'
    f.fundAccountId = null
    const { byKey } = precheck(f, DEFAULT_SCALES)
    expect(byKey['partnerId']).toBeTruthy()
    expect(byKey['qty@1']).toBeTruthy()
    f.lines[0].qty = '1'
    f.partnerId = 'p'
    expect(precheck(f, DEFAULT_SCALES).byKey['paidAmount']).toBeTruthy()
  })

  it('扫码/选择已存在的 SKU 数量 +1,否则新增一行;其他仓库/单位视为不同行', () => {
    let lines = addOrIncrement([], newLine({ skuId: 's1', label: 'A' }, '1', 'w'))
    lines = addOrIncrement(lines, newLine({ skuId: 's1', label: 'A' }, '1', 'w'))
    expect(lines).toHaveLength(1)
    expect(lines[0].qty).toBe('2')
    lines = addOrIncrement(lines, newLine({ skuId: 's1', label: 'A' }, '1', 'w2'))
    expect(lines).toHaveLength(2)
  })

  it('按价格等级重新取价,手改过的行保持不变(需求 12.4)', () => {
    const f = mkForm()
    f.lines[0].price = '77'
    const products = { s1: { refSalePrice: '100', wholesalePrice: '80' }, s2: { refSalePrice: '10', wholesalePrice: null } }
    const out = repriceLines(f.lines, products, { type: 'wholesale' }, 4, new Set([0]))
    expect(out.map((l) => l.price)).toEqual(['77', '10.0000'])
    expect(repriceLines(f.lines, products, { type: 'discount', rate: '85' }, 4, new Set()).map((l) => l.price)).toEqual(['85.0000', '8.5000'])
  })
})

describe('自定义字段表单(需求 6.3)', () => {
  const def = (code: string, order: number, enabled = true, createdAt = '2026-01-01', defaultValue?: unknown): FieldDef => ({ code, label: code, type: 'text', required: false, displayOrder: order, showInList: false, filterable: false, enabled, createdAt, defaultValue })
  it('按显示顺序升序、相同则按创建时间;停用字段不渲染', () => {
    const out = fieldsForForm([def('c', 2), def('a', 1, true, '2026-02-01'), def('b', 1, true, '2026-01-01'), def('z', 0, false)])
    expect(out.map((d) => d.code)).toEqual(['b', 'a', 'c'])
  })
  it('新增页预填默认值;编辑旧记录时不回填默认值', () => {
    const defs = [def('x', 1, true, '2026-01-01', 'dflt')]
    expect(initialCustom(defs, null)).toEqual({ x: 'dflt' })
    expect(initialCustom(defs, {})).toEqual({})
  })
})
