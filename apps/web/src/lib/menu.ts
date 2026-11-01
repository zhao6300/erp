import { Bootstrap, can, menuVisible } from '@erp/api-client'

export interface MenuItem {
  key: string
  label: string
  path: string
  module?: string
  children?: MenuItem[]
}

/** 完整菜单定义。是否显示由 bootstrap 返回的"已启用且已授权的模块"与"菜单权限"共同决定(需求 4.5、10.9) */
export const MENU: MenuItem[] = [
  { key: 'dashboard', label: '首页', path: '/' },
  {
    key: 'g-basic',
    label: '基础资料',
    path: '',
    children: [
      { key: 'product', label: '商品', path: '/products', module: 'product' },
      { key: 'partner', label: '往来单位', path: '/partners' },
      { key: 'warehouse', label: '仓库', path: '/warehouses' },
    ],
  },
  {
    key: 'g-purchase',
    label: '采购',
    path: '',
    children: [
      { key: 'purchase_order', label: '采购订单', path: '/docs/purchase_order', module: 'purchase' },
      { key: 'purchase_in', label: '采购入库', path: '/docs/purchase_in', module: 'purchase' },
      { key: 'purchase_return', label: '采购退货', path: '/docs/purchase_return', module: 'purchase' },
    ],
  },
  {
    key: 'g-sales',
    label: '销售',
    path: '',
    children: [
      { key: 'sales_order', label: '销售订单', path: '/docs/sales_order', module: 'sales' },
      { key: 'sales_out', label: '销售出库', path: '/docs/sales_out', module: 'sales' },
      { key: 'sales_return', label: '销售退货', path: '/docs/sales_return', module: 'sales' },
    ],
  },
  {
    key: 'g-stock',
    label: '库存',
    path: '',
    children: [
      { key: 'stock', label: '库存查询', path: '/stock', module: 'inventory' },
      { key: 'transfer', label: '调拨单', path: '/docs/transfer', module: 'inventory' },
      { key: 'stocktake', label: '盘点单', path: '/docs/stocktake', module: 'inventory' },
    ],
  },
  {
    key: 'g-finance',
    label: '财务',
    path: '',
    children: [
      { key: 'receipt', label: '收款单', path: '/docs/receipt', module: 'finance' },
      { key: 'payment', label: '付款单', path: '/docs/payment', module: 'finance' },
      { key: 'other_income', label: '其他收入', path: '/docs/other_income', module: 'finance' },
      { key: 'other_expense', label: '其他支出', path: '/docs/other_expense', module: 'finance' },
      { key: 'fund_account', label: '资金账户', path: '/funds', module: 'finance' },
    ],
  },
  { key: 'report', label: '报表', path: '/reports', module: 'report' },
  {
    key: 'settings',
    label: '系统设置',
    path: '',
    children: [
      { key: 'settings', label: '业务参数', path: '/settings' },
      { key: 'modules', label: '模块与授权', path: '/settings/modules' },
      { key: 'custom-fields', label: '自定义字段', path: '/settings/custom-fields' },
      { key: 'roles', label: '角色与用户', path: '/settings/roles' },
      { key: 'branding', label: '品牌白标', path: '/settings/branding' },
      { key: 'packages', label: '配置包', path: '/settings/packages' },
      { key: 'print', label: '打印模板', path: '/settings/print' },
      { key: 'io', label: '导入导出', path: '/settings/io' },
      { key: 'audit', label: '操作日志', path: '/settings/audit' },
    ],
  },
]

/** 系统设置下的全部入口只有 Tenant_Admin 可见 */
const ADMIN_ONLY = new Set(['settings', 'modules', 'custom-fields', 'roles', 'branding', 'packages', 'print', 'io', 'audit'])

/**
 * 依据 bootstrap 过滤菜单(需求 4.5、10.9):
 *  - 首页:所有人可见
 *  - 系统设置:仅 Tenant_Admin
 *  - 其余:所属模块已启用且已授权(bootstrap.modules 已剔除未授权/未启用)+ 具备菜单权限
 * 分组下没有可见子项时整组隐藏。
 */
export function visibleMenu(b: Bootstrap, items: MenuItem[] = MENU): MenuItem[] {
  const out: MenuItem[] = []
  for (const it of items) {
    if (it.children) {
      const children = visibleMenu(b, it.children)
      if (children.length) out.push({ ...it, children })
    } else if (it.key === 'dashboard') out.push(it)
    else if (ADMIN_ONLY.has(it.key)) {
      if (b.user.isTenantAdmin) out.push(it)
    } else if (menuVisible(b, it.key, it.module)) out.push(it)
  }
  return out
}

/** 通过地址直接访问某模块页面时:模块未启用只显示"模块未启用",不显示任何业务数据(需求 4.5) */
export function routeGuard(b: Bootstrap, module: string | undefined): 'ok' | 'module_disabled' {
  return !module || b.modules.includes(module) ? 'ok' : 'module_disabled'
}

export { can }
