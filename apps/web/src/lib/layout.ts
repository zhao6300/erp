/**
 * 响应式布局断点(需求 19.2、19.3、19.11):
 *  - ≥ 1280  完整管理布局
 *  - 769–1279 保留全部功能入口,侧边栏可折叠,表格容器内部横向滚动,页面本身不横向滚动
 *  - 375–768  单列布局,表格切换为卡片列表
 */
export type LayoutMode = 'desktop' | 'tablet' | 'mobile'

export interface LayoutSpec {
  mode: LayoutMode
  sidebar: 'expanded' | 'collapsible'
  singleColumn: boolean
  tableAs: 'table' | 'cards'
  /** 页面级横向滚动:任何模式都禁止 */
  pageOverflowX: 'hidden'
  /** 表格容器内部横向滚动 */
  tableOverflowX: 'auto' | 'none'
  allEntriesAvailable: true
}

export function layoutFor(width: number): LayoutSpec {
  if (width >= 1280) return { mode: 'desktop', sidebar: 'expanded', singleColumn: false, tableAs: 'table', pageOverflowX: 'hidden', tableOverflowX: 'auto', allEntriesAvailable: true }
  if (width >= 769) return { mode: 'tablet', sidebar: 'collapsible', singleColumn: false, tableAs: 'table', pageOverflowX: 'hidden', tableOverflowX: 'auto', allEntriesAvailable: true }
  return { mode: 'mobile', sidebar: 'collapsible', singleColumn: true, tableAs: 'cards', pageOverflowX: 'hidden', tableOverflowX: 'none', allEntriesAvailable: true }
}
