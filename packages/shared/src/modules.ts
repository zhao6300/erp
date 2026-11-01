import type { ModuleCode } from './types'
import { MODULE_CODES } from './types'

/** 模块固定依赖关系(需求 4.1) */
export const MODULES: Record<ModuleCode, { deps: ModuleCode[] }> = {
  product: { deps: [] },
  inventory: { deps: ['product'] },
  purchase: { deps: ['product', 'inventory'] },
  sales: { deps: ['product', 'inventory'] },
  finance: { deps: [] },
  report: { deps: [] },
}

/** 模块自身与其全部(传递)依赖 */
export function closureOfDeps(module: ModuleCode): ModuleCode[] {
  const seen = new Set<ModuleCode>()
  const visit = (m: ModuleCode) => {
    if (seen.has(m)) return
    seen.add(m)
    MODULES[m].deps.forEach(visit)
  }
  visit(module)
  return MODULE_CODES.filter((m) => seen.has(m))
}

/** 已启用集合中直接或间接依赖 module 的其他模块 */
export function dependentsOf(module: ModuleCode, enabled: Iterable<ModuleCode>): ModuleCode[] {
  const en = new Set(enabled)
  return MODULE_CODES.filter((m) => m !== module && en.has(m) && closureOfDeps(m).includes(module))
}

export type EnableResult = { ok: true; enabled: ModuleCode[]; autoEnabled: ModuleCode[] } | { ok: false; code: 'MODULE_NOT_LICENSED'; unlicensed: ModuleCode[] }
export type DisableResult = { ok: true; enabled: ModuleCode[] } | { ok: false; code: 'MODULE_DEPENDENCY'; dependents: ModuleCode[] }

/** 启用:依赖闭包中任一模块未授权则整体拒绝(需求 4.2、4.4) */
export function enableModule(enabled: Iterable<ModuleCode>, licensed: Iterable<ModuleCode>, target: ModuleCode): EnableResult {
  const en = new Set(enabled)
  const lic = new Set(licensed)
  const closure = closureOfDeps(target)
  const unlicensed = closure.filter((m) => !lic.has(m))
  if (unlicensed.length > 0) return { ok: false, code: 'MODULE_NOT_LICENSED', unlicensed }
  const autoEnabled = closure.filter((m) => m !== target && !en.has(m))
  closure.forEach((m) => en.add(m))
  return { ok: true, enabled: MODULE_CODES.filter((m) => en.has(m)), autoEnabled }
}

/** 关闭:存在已启用的依赖方则拒绝(需求 4.3) */
export function disableModule(enabled: Iterable<ModuleCode>, target: ModuleCode): DisableResult {
  const en = new Set(enabled)
  const dependents = dependentsOf(target, en)
  if (dependents.length > 0) return { ok: false, code: 'MODULE_DEPENDENCY', dependents }
  en.delete(target)
  return { ok: true, enabled: MODULE_CODES.filter((m) => en.has(m)) }
}

/** License 移除模块时:关闭该模块及依赖它的所有已启用模块(需求 4.9) */
export function enabledAfterLicenseChange(enabled: Iterable<ModuleCode>, licensed: Iterable<ModuleCode>): ModuleCode[] {
  const lic = new Set(licensed)
  const en = new Set(enabled)
  return MODULE_CODES.filter((m) => en.has(m) && closureOfDeps(m).every((d) => lic.has(d)))
}

/** 新租户未选配置包时:启用全部已授权且依赖齐全的模块(需求 4.8) */
export function defaultEnabledModules(licensed: Iterable<ModuleCode>): ModuleCode[] {
  const lic = new Set(licensed)
  return MODULE_CODES.filter((m) => lic.has(m))
}
