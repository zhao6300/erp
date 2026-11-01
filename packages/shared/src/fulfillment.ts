import { D, Dec, DecValue, dec } from './decimal'

export interface UpstreamLine {
  id: string
  skuId: string
  baseQty: DecValue
}
export interface DownstreamLine {
  upstreamLineId?: string | null
  skuId: string
  baseQty: DecValue
}

/**
 * 每个上游行的剩余数量 = 上游行基本单位数量 − 引用该行的已审核下游行数量之和(最小为 0)
 * (需求 13.9、15.5、16.6)
 */
export function remainingQty(upstreamLines: UpstreamLine[], downstreamAuditedLines: DownstreamLine[]): Map<string, Dec> {
  const used = new Map<string, Dec>()
  for (const d of downstreamAuditedLines) {
    if (!d.upstreamLineId) continue
    used.set(d.upstreamLineId, (used.get(d.upstreamLineId) ?? new D(0)).plus(dec(d.baseQty)))
  }
  const out = new Map<string, Dec>()
  for (const u of upstreamLines) {
    const left = dec(u.baseQty).minus(used.get(u.id) ?? 0)
    out.set(u.id, left.isNegative() ? new D(0) : left)
  }
  return out
}

/** 按 SKU 汇总的剩余数量:Σ 上游行 − Σ 已审核下游行(最小为 0)(需求 15.7、15.9、16.7) */
export function remainingBySku(upstreamLines: UpstreamLine[], downstreamAuditedLines: DownstreamLine[]): Map<string, Dec> {
  const out = new Map<string, Dec>()
  for (const u of upstreamLines) out.set(u.skuId, (out.get(u.skuId) ?? new D(0)).plus(dec(u.baseQty)))
  for (const d of downstreamAuditedLines) out.set(d.skuId, (out.get(d.skuId) ?? new D(0)).minus(dec(d.baseQty)))
  for (const [k, v] of out) if (v.isNegative()) out.set(k, new D(0))
  return out
}

export interface OverQtyViolation {
  skuId: string
  remaining: Dec
  requested: Dec
}

/**
 * 校验本单(保存或审核时)各 SKU 的基本单位数量不超过剩余数量。
 * alreadyUsedLines 为"其他已审核"下游单据的行,本单自身不应包含在内。
 */
export function checkOverQty(upstreamLines: UpstreamLine[], alreadyUsedLines: DownstreamLine[], thisDocLines: DownstreamLine[]): OverQtyViolation[] {
  const remaining = remainingBySku(upstreamLines, alreadyUsedLines)
  const requested = new Map<string, Dec>()
  for (const l of thisDocLines) requested.set(l.skuId, (requested.get(l.skuId) ?? new D(0)).plus(dec(l.baseQty)))
  const out: OverQtyViolation[] = []
  for (const [skuId, req] of requested) {
    const rem = remaining.get(skuId) ?? new D(0)
    if (req.gt(rem)) out.push({ skuId, remaining: rem, requested: req })
  }
  return out
}

export type FulfillmentStatus = 'none' | 'partial' | 'done'

/** 订单进度(需求 15.6、16.11):全 0 → none;全部 ≥ 订购 → done;其余 partial */
export function fulfillmentStatus(ordered: DecValue[], received: DecValue[]): FulfillmentStatus {
  const o = ordered.map(dec)
  const r = received.map(dec)
  if (r.every((x) => x.lte(0))) return 'none'
  if (o.length > 0 && o.every((x, i) => (r[i] ?? new D(0)).gte(x))) return 'done'
  return 'partial'
}

export function fulfillmentLabel(status: FulfillmentStatus, kind: 'in' | 'out'): string {
  if (status === 'done') return '已完成'
  if (status === 'none') return kind === 'in' ? '未入库' : '未出库'
  return kind === 'in' ? '部分入库' : '部分出库'
}
