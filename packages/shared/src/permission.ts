/** 权限码:菜单 menu:<key>;操作 <objectType>:<action>;字段 field:cost / field:profit */

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'audit', 'unaudit', 'void', 'print', 'export'] as const
export type Action = (typeof ACTIONS)[number]

export const FIELD_PERMS = { cost: 'field:cost', profit: 'field:profit' } as const

export type DataScope = { type: 'all' } | { type: 'warehouses'; ids: string[] } | { type: 'own' }

export interface RoleLike {
  permissions: string[]
  dataScope: DataScope
}

export interface EffectivePermission {
  /** Tenant_Admin:全部权限 */
  isAdmin: boolean
  permissions: string[]
  dataScope: { all: boolean; warehouseIds: string[]; own: boolean }
}

/** 多 Role 取并集;无 Role 的非管理员为空权限(需求 10.5) */
export function mergeRoles(roles: RoleLike[], isTenantAdmin: boolean): EffectivePermission {
  if (isTenantAdmin) return { isAdmin: true, permissions: [], dataScope: { all: true, warehouseIds: [], own: false } }
  const perms = new Set<string>()
  const wh = new Set<string>()
  let all = false
  let own = false
  for (const r of roles) {
    r.permissions.forEach((p) => perms.add(p))
    if (r.dataScope.type === 'all') all = true
    else if (r.dataScope.type === 'own') own = true
    else r.dataScope.ids.forEach((id) => wh.add(id))
  }
  return { isAdmin: false, permissions: [...perms].sort(), dataScope: { all, warehouseIds: [...wh].sort(), own } }
}

export function hasPermission(eff: EffectivePermission, code: string): boolean {
  return eff.isAdmin || eff.permissions.includes(code)
}
export const canViewCost = (eff: EffectivePermission) => hasPermission(eff, FIELD_PERMS.cost)
export const canViewProfit = (eff: EffectivePermission) => hasPermission(eff, FIELD_PERMS.profit)

export interface FieldVisibility {
  cost: boolean
  profit: boolean
}
export const visibilityOf = (eff: EffectivePermission): FieldVisibility => ({ cost: canViewCost(eff), profit: canViewProfit(eff) })

/**
 * 敏感字段表:字段名 → 需要同时具备的字段级权限。
 * 毛利同时受“进价与成本”和“利润”两项权限约束(需求 10.4、10.11)。
 */
export const SENSITIVE_FIELDS: Record<string, ('cost' | 'profit')[]> = {
  // 进价、成本、库存成本金额
  refCostPrice: ['cost'],
  costPrice: ['cost'],
  costAmount: ['cost'],
  unitCost: ['cost'],
  avgCost: ['cost'],
  stockAmount: ['cost'],
  inventoryAmount: ['cost'],
  stockValue: ['cost'],
  totalCost: ['cost'],
  cost: ['cost'],
  // 毛利(两者皆需)
  grossProfit: ['cost', 'profit'],
  lineProfit: ['cost', 'profit'],
  // 利润类
  grossMargin: ['profit'],
  grossProfitRate: ['profit'],
  profit: ['profit'],
  profitRate: ['profit'],
  netProfit: ['profit'],
  todayGrossProfit: ['cost', 'profit'],
  monthGrossProfit: ['cost', 'profit'],
}

/** 普通对象,含无原型对象(Object.create(null));Date、Decimal 等类实例不在此列 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hidden(field: string, vis: FieldVisibility, map: Record<string, ('cost' | 'profit')[]>): boolean {
  const need = map[field]
  if (!need) return false
  return need.some((n) => !vis[n])
}

/** 去除没有权限查看的敏感字段(递归处理对象与数组),其余字段保持不变 */
export function maskFields<T>(dto: T, vis: FieldVisibility, map: Record<string, ('cost' | 'profit')[]> = SENSITIVE_FIELDS): T {
  if (Array.isArray(dto)) return dto.map((x) => maskFields(x, vis, map)) as unknown as T
  if (isPlainObject(dto)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(dto as Record<string, unknown>)) {
      if (hidden(k, vis, map)) continue
      out[k] = maskFields(v, vis, map)
    }
    return out as T
  }
  return dto
}

/** 报表/导出列定义的敏感性检查 */
export function columnVisible(columnKey: string, vis: FieldVisibility): boolean {
  return !hidden(columnKey, vis, SENSITIVE_FIELDS)
}
