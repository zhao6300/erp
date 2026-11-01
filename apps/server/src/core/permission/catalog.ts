import { ACTIONS, DOC_TYPES, DocType } from '@erp/shared'
import type { DataScope } from '@erp/shared'

/** 受权限控制的业务对象类型 */
export const OBJECT_TYPES_FOR_PERM = [
  'product',
  'partner',
  'warehouse',
  'fund_account',
  'fund_category',
  'fund_transfer',
  ...DOC_TYPES,
  'stock',
  'report',
  'settings',
  'role',
  'user',
] as const

/** 菜单键 */
export const MENU_KEYS = [
  'dashboard',
  'product',
  'partner',
  'warehouse',
  'stock',
  'purchase_order',
  'purchase_in',
  'purchase_return',
  'sales_order',
  'sales_out',
  'sales_return',
  'transfer',
  'stocktake',
  'receipt',
  'payment',
  'other_income',
  'other_expense',
  'fund_account',
  'fund_transfer',
  'report',
  'settings',
] as const

export const allPerms = (objects: readonly string[], actions: readonly string[] = ACTIONS): string[] => objects.flatMap((o) => actions.map((a) => `${o}:${a}`))
const menus = (keys: readonly string[]) => keys.map((k) => `menu:${k}`)

export interface RoleTemplate {
  name: string
  permissions: string[]
  dataScope: DataScope
}

const PURCHASE: DocType[] = ['purchase_order', 'purchase_in', 'purchase_return']
const SALES: DocType[] = ['sales_order', 'sales_out', 'sales_return']
const FINANCE: DocType[] = ['receipt', 'payment', 'other_income', 'other_expense']

/** 预置角色模板:老板、仓管、采购员、销售员、财务(需求 10.2),只读,可复制 */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    name: '老板',
    dataScope: { type: 'all' },
    permissions: [
      ...menus(MENU_KEYS.filter((m) => m !== 'settings')),
      ...allPerms(OBJECT_TYPES_FOR_PERM.filter((o) => !['settings', 'role', 'user'].includes(o)), ['view', 'print', 'export', 'audit', 'unaudit']),
      'field:cost',
      'field:profit',
    ],
  },
  {
    name: '仓管',
    dataScope: { type: 'all' },
    permissions: [
      ...menus(['dashboard', 'product', 'warehouse', 'stock', 'transfer', 'stocktake', 'purchase_in', 'sales_out']),
      ...allPerms(['product', 'warehouse', 'stock', 'purchase_in', 'sales_out'], ['view', 'print']),
      ...allPerms(['transfer', 'stocktake']),
    ],
  },
  {
    name: '采购员',
    dataScope: { type: 'own' },
    permissions: [
      ...menus(['dashboard', 'product', 'partner', 'stock', ...PURCHASE, 'report']),
      ...allPerms(['product', 'partner', 'stock'], ['view']),
      ...allPerms(PURCHASE, ['view', 'create', 'edit', 'void', 'print', 'export']),
      ...allPerms(['report'], ['view']),
      'field:cost',
    ],
  },
  {
    name: '销售员',
    dataScope: { type: 'own' },
    permissions: [
      ...menus(['dashboard', 'product', 'partner', 'stock', ...SALES, 'receipt', 'report']),
      ...allPerms(['product', 'partner', 'stock'], ['view']),
      ...allPerms(SALES, ['view', 'create', 'edit', 'void', 'print', 'export']),
      ...allPerms(['receipt'], ['view', 'create', 'edit', 'print']),
      ...allPerms(['report'], ['view']),
    ],
  },
  {
    name: '财务',
    dataScope: { type: 'all' },
    permissions: [
      ...menus(['dashboard', 'partner', 'fund_account', 'fund_transfer', ...FINANCE, 'report', 'purchase_in', 'sales_out']),
      ...allPerms(['partner', 'purchase_in', 'sales_out'], ['view']),
      ...allPerms([...FINANCE, 'fund_account', 'fund_category', 'fund_transfer']),
      ...allPerms(['report'], ['view', 'export']),
      'field:cost',
      'field:profit',
    ],
  },
]
