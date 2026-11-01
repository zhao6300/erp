import { Bootstrap, can, menuVisible } from '@erp/api-client'

export interface Entry {
  key: string
  label: string
  url: string
  /** 所属模块;未启用时入口隐藏 */
  module?: string
}

/** 首页入口:受模块启用状态与权限约束(需求 19.4)。key 与菜单权限码 menu:<key> 对应 */
export const ENTRIES: readonly Entry[] = [
  { key: 'sales_out', label: '销售开单', url: '/pages/sales/new', module: 'sales' },
  { key: 'purchase_in', label: '采购开单', url: '/pages/purchase/new', module: 'purchase' },
  { key: 'receipt', label: '收付款', url: '/pages/finance/new', module: 'finance' },
  { key: 'stock', label: '库存查询', url: '/pages/stock/index', module: 'inventory' },
  { key: 'product', label: '商品查询', url: '/pages/stock/index?tab=product', module: 'product' },
  { key: 'docs', label: '单据查询与审核', url: '/pages/docs/list' },
  { key: 'report', label: '常用报表', url: '/pages/report/index', module: 'report' },
]

/** 单据查询入口:持有任一单据菜单权限即可见 */
const DOC_MENUS = ['sales_out', 'purchase_in', 'receipt', 'sales_order', 'purchase_order']

export function visibleEntries(b: Bootstrap): Entry[] {
  return ENTRIES.filter((e) => (e.key === 'docs' ? DOC_MENUS.some((m) => can(b, `menu:${m}`)) : menuVisible(b, e.key, e.module)))
}
