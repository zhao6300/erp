import { D, Dec, DecValue, dec, sum } from './decimal'

/** Partner 的未核销项。期初应收/应付作为日期最早的虚拟项(设计 D7) */
export interface OpenItem {
  /** 唯一键:期初项用 'opening',单据用单据 id */
  key: string
  type: 'opening' | 'document'
  /** 单据日期 YYYY-MM-DD;期初项忽略 */
  date: string
  docNo: string
  unsettled: DecValue
}

export interface Allocation {
  key: string
  targetType: 'opening' | 'document'
  targetDocId?: string
  amount: Dec
  kind: 'manual' | 'fifo'
}

export interface ExplicitAllocation {
  key: string
  amount: DecValue
}

export interface AllocationIssue {
  key?: string
  reason: string
  /** 该项可核销金额,或该 Partner 全部未核销合计 */
  available?: Dec
}
export interface AllocationError {
  error: true
  issues: AllocationIssue[]
}

export function isAllocationError(r: Allocation[] | AllocationError): r is AllocationError {
  return !Array.isArray(r)
}

/** 先进先出的排序:期初最早,其后按 (单据日期, 单据编号) 升序 */
export function fifoOrder(items: OpenItem[]): OpenItem[] {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'opening' ? -1 : 1
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.docNo !== b.docNo) return a.docNo < b.docNo ? -1 : 1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

/**
 * 收付款核销(需求 17.4、17.5):
 * 先保留用户指定的分配,再把剩余金额按先进先出分配到其余未核销金额。
 */
export function allocateSettlement(amount: DecValue, explicit: ExplicitAllocation[], openItems: OpenItem[]): Allocation[] | AllocationError {
  const total = dec(amount)
  const byKey = new Map(openItems.map((o) => [o.key, o]))
  const issues: AllocationIssue[] = []
  const explicitSum = new Map<string, Dec>()

  for (const e of explicit) {
    const item = byKey.get(e.key)
    const a = dec(e.amount)
    if (!item) {
      issues.push({ key: e.key, reason: '指定的核销单据不存在或已核销完毕', available: new D(0) })
      continue
    }
    if (!a.gt(0)) {
      issues.push({ key: e.key, reason: '核销金额必须大于 0', available: dec(item.unsettled) })
      continue
    }
    explicitSum.set(e.key, (explicitSum.get(e.key) ?? new D(0)).plus(a))
  }
  for (const [key, s] of explicitSum) {
    const item = byKey.get(key)!
    if (s.gt(dec(item.unsettled))) issues.push({ key, reason: '核销金额大于该单据的未核销金额', available: dec(item.unsettled) })
  }

  const openTotal = sum(openItems.map((o) => o.unsettled))
  if (total.gt(openTotal)) issues.push({ reason: '金额大于该往来单位全部未核销金额合计', available: openTotal })
  const explicitTotal = sum([...explicitSum.values()])
  if (explicitTotal.gt(total)) issues.push({ reason: '指定核销金额合计大于收付款金额', available: total })
  if (issues.length > 0) return { error: true, issues }

  const result: Allocation[] = []
  for (const e of explicit) {
    const item = byKey.get(e.key)!
    result.push({
      key: item.key,
      targetType: item.type,
      targetDocId: item.type === 'document' ? item.key : undefined,
      amount: dec(e.amount),
      kind: 'manual',
    })
  }

  let remaining = total.minus(explicitTotal)
  for (const item of fifoOrder(openItems)) {
    if (!remaining.gt(0)) break
    const capacity = dec(item.unsettled).minus(explicitSum.get(item.key) ?? 0)
    if (!capacity.gt(0)) continue
    const take = D.min(capacity, remaining)
    result.push({
      key: item.key,
      targetType: item.type,
      targetDocId: item.type === 'document' ? item.key : undefined,
      amount: take,
      kind: 'fifo',
    })
    remaining = remaining.minus(take)
  }
  return result
}
