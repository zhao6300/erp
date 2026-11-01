import type { Bootstrap } from '@erp/api-client'
import { describe, expect, it } from 'vitest'
import { visibleEntries } from '../src/core/entries'

const boot = (perms: string[], modules: string[], isAdmin = false): Bootstrap => ({ permissions: { isAdmin, permissions: perms, dataScope: { all: true, warehouseIds: [], own: false } }, modules }) as unknown as Bootstrap
const keys = (b: Bootstrap) => visibleEntries(b).map((e) => e.key)

describe('小程序首页入口(需求 19.4)', () => {
  it('需要同时满足模块启用与菜单权限', () => {
    expect(keys(boot(['menu:sales_out', 'menu:purchase_in'], ['sales']))).toEqual(['sales_out', 'docs'])
    expect(keys(boot([], ['sales', 'purchase']))).toEqual([])
  })
  it('管理员看到全部已启用模块的入口;模块被关闭则入口隐藏', () => {
    expect(keys(boot([], ['sales', 'purchase', 'finance', 'inventory', 'product', 'report'], true))).toEqual(['sales_out', 'purchase_in', 'receipt', 'stock', 'product', 'docs', 'report'])
    expect(keys(boot([], ['sales'], true))).toEqual(['sales_out', 'docs'])
  })
  it('单据查询入口只依赖单据类菜单权限,不依赖模块', () => {
    expect(keys(boot(['menu:receipt'], []))).toEqual(['docs'])
  })
})
