import { applyInbound, applyOutbound, applyReverseInbound, applyReverseOutbound, CostBalance, emptyBalance, stockKey } from './cost'
import { D, Dec, DecValue, dec, roundHalfUp, sum } from './decimal'
import { netLineAmounts } from './amount'
import { ErrorCode, ErrorDetail } from './errors'
import type { Direction, DocType, FundSource, Scales } from './types'

/* ───────────────────────── 输入类型 ───────────────────────── */

export interface DocLine {
  id: string
  skuId: string
  /** 行仓库;调拨单为调出仓库 */
  warehouseId: string
  /** 基本单位数量(正数);盘点单忽略 */
  baseQty: DecValue
  /** 行金额(已含行折扣,未扣整单优惠) */
  amount: DecValue
  /** 盘点数量(基本单位),仅盘点单 */
  countedQty?: DecValue | null
  /** 销售退货:关联出库行的出库单位成本 */
  returnUnitCost?: DecValue | null
}

export interface PlannedAllocation {
  targetType: 'opening' | 'document'
  targetDocId?: string | null
  amount: DecValue
}

export interface DocumentSnapshot {
  id: string
  docType: DocType
  docNo: string
  docDate: string
  partnerId?: string | null
  warehouseId?: string | null
  toWarehouseId?: string | null
  fundAccountId?: string | null
  docDiscount: DecValue
  /** 本单已收/已付 */
  paidAmount: DecValue
  /** 单据总金额;收付款与其他收支单为单据金额 */
  totalAmount: DecValue
  lines: DocLine[]
  /** 收款单、付款单保存时计算出的核销分配 */
  allocations?: PlannedAllocation[]
}

export interface FundState {
  balance: DecValue
  enabled: boolean
}

export interface PostingContext {
  scales: Scales
  allowNegativeStock: boolean
  /** 当前 (sku|warehouse) 成本结存快照;缺失视为空 */
  stock: Map<string, CostBalance>
  funds: Map<string, FundState>
  /** 销售出库单信用额度检查 */
  credit?: { limit: DecValue | null; arBalance: DecValue; confirmed: boolean }
  /** 退货单关联原单的未核销金额(用于退货冲抵核销) */
  upstreamUnsettled?: DecValue | null
  /** 收付款单核销目标当前未核销金额,key 为 'opening' 或单据 id;提供时审核前复核 */
  settlementTargets?: Map<string, DecValue>
}

/* ───────────────────────── 输出类型 ───────────────────────── */

export interface StockEntry {
  lineId?: string
  skuId: string
  warehouseId: string
  kind: 'in' | 'out'
  qtyDelta: Dec
  unitCost: Dec
  amountDelta: Dec
  balanceAfter: Dec
  reversalOf?: string
}

export interface PartnerEntry {
  partnerId: string
  direction: Direction
  amountDelta: Dec
  /** self=单据本身;inline=本单收付款生成的记录 */
  role: 'self' | 'inline'
  reversalOf?: string
}

export interface FundEntry {
  fundAccountId: string
  source: FundSource
  amountDelta: Dec
  role: 'self' | 'inline'
  reversalOf?: string
}

export interface LineCost {
  lineId: string
  costPrice: Dec
  costAmount: Dec
  lineProfit?: Dec
}

export interface PostingPlan {
  rejected?: false
  stockEntries: StockEntry[]
  /** 受影响组合过账后的成本结存 */
  stockBalances: Map<string, CostBalance>
  partnerEntries: PartnerEntry[]
  fundEntries: FundEntry[]
  /** 收付款单审核时需要落到被核销单据上的分配 */
  settlementApply: PlannedAllocation[]
  /** 退货冲抵核销(关联原单) */
  returnOffset: Dec
  /** 本单收付款:需要生成的内联收付款记录 */
  inline?: { kind: 'receipt' | 'payment'; amount: Dec; fundAccountId: string; partnerId: string }
  lineCosts: LineCost[]
  grossProfit?: Dec
}

export interface PostingRejection {
  rejected: true
  code: ErrorCode
  message?: string
  details: ErrorDetail[]
}

export function isRejection(r: PostingPlan | PostingRejection): r is PostingRejection {
  return r.rejected === true
}

const reject = (code: ErrorCode, details: ErrorDetail[], message?: string): PostingRejection => ({ rejected: true, code, details, message })

/* ───────────────────────── 内部:库存移动 ───────────────────────── */

interface Move {
  lineId?: string
  skuId: string
  warehouseId: string
  kind: 'in' | 'out'
  qty: Dec
  /** 入库金额;出库按移动加权平均成本 */
  inAmount?: Dec
  /** 来自出库单位成本的入库(调入) */
  fromOutOf?: number
}

function getBal(map: Map<string, CostBalance>, skuId: string, whId: string): CostBalance {
  return map.get(stockKey(skuId, whId)) ?? emptyBalance()
}

/** 在工作副本上顺序执行移动,产生流水与成本 */
function runMoves(moves: Move[], ctx: PostingContext): { entries: StockEntry[]; balances: Map<string, CostBalance>; outAmounts: Map<number, { unitCost: Dec; amount: Dec }> } {
  const work = new Map<string, CostBalance>()
  const touched = new Map<string, CostBalance>()
  const get = (s: string, w: string) => work.get(stockKey(s, w)) ?? getBal(ctx.stock, s, w)
  const entries: StockEntry[] = []
  const outAmounts = new Map<number, { unitCost: Dec; amount: Dec }>()
  moves.forEach((m, idx) => {
    const key = stockKey(m.skuId, m.warehouseId)
    const bal = get(m.skuId, m.warehouseId)
    if (m.kind === 'out') {
      const r = applyOutbound(bal, m.qty, ctx.scales)
      work.set(key, r.bal)
      touched.set(key, r.bal)
      outAmounts.set(idx, { unitCost: r.unitCost, amount: r.amount })
      entries.push({
        lineId: m.lineId,
        skuId: m.skuId,
        warehouseId: m.warehouseId,
        kind: 'out',
        qtyDelta: m.qty.negated(),
        unitCost: r.unitCost,
        amountDelta: r.amount.negated(),
        balanceAfter: r.bal.qty,
      })
    } else {
      const amount = m.fromOutOf !== undefined ? outAmounts.get(m.fromOutOf)!.amount : (m.inAmount ?? new D(0))
      const nb = applyInbound(bal, m.qty, amount, ctx.scales)
      work.set(key, nb)
      touched.set(key, nb)
      entries.push({
        lineId: m.lineId,
        skuId: m.skuId,
        warehouseId: m.warehouseId,
        kind: 'in',
        qtyDelta: m.qty,
        // 调拨调入:单位成本等于调出单位成本(需求 14.6);其余入库按 金额/数量 反推
        unitCost:
          m.fromOutOf !== undefined
            ? outAmounts.get(m.fromOutOf)!.unitCost
            : m.qty.gt(0)
              ? roundHalfUp(amount.div(m.qty), ctx.scales.priceScale)
              : new D(0),
        amountDelta: amount,
        balanceAfter: nb.qty,
      })
    }
  })
  return { entries, balances: touched, outAmounts }
}

/** 负库存检查:按 (sku, 仓库) 合并同一单据多行后,净减少且结存将小于 0 的组合 */
function negativeStockViolations(deltas: Map<string, Dec>, ctx: PostingContext): ErrorDetail[] {
  const out: ErrorDetail[] = []
  for (const [key, delta] of deltas) {
    if (!delta.isNegative()) continue
    const [skuId, warehouseId] = key.split('|')
    const cur = getBal(ctx.stock, skuId, warehouseId).qty
    if (cur.plus(delta).isNegative()) {
      out.push({
        skuId,
        warehouseId,
        reason: '库存不足',
        currentQty: cur.toString(),
        requiredQty: delta.negated().toString(),
      })
    }
  }
  return out
}

function netDeltas(moves: { skuId: string; warehouseId: string; kind: 'in' | 'out'; qty: Dec }[]): Map<string, Dec> {
  const m = new Map<string, Dec>()
  for (const mv of moves) {
    const k = stockKey(mv.skuId, mv.warehouseId)
    m.set(k, (m.get(k) ?? new D(0)).plus(mv.kind === 'in' ? mv.qty : mv.qty.negated()))
  }
  return m
}

/* ───────────────────────── planPosting ───────────────────────── */

const STOCK_IN_DOCS: DocType[] = ['purchase_in', 'sales_return']
const STOCK_OUT_DOCS: DocType[] = ['purchase_return', 'sales_out']

export function planPosting(doc: DocumentSnapshot, ctx: PostingContext): PostingPlan | PostingRejection {
  const { scales } = ctx
  const total = dec(doc.totalAmount)
  const paid = dec(doc.paidAmount)

  const plan: PostingPlan = {
    stockEntries: [],
    stockBalances: new Map(),
    partnerEntries: [],
    fundEntries: [],
    settlementApply: [],
    returnOffset: new D(0),
    lineCosts: [],
  }

  // 订单类单据只改变状态,不产生任何变动(需求 13.2)
  if (doc.docType === 'purchase_order' || doc.docType === 'sales_order') return plan

  /* 1. 展开库存移动 */
  const moves: Move[] = []
  // 盘点需要顺序模拟当前结存
  const simQty = new Map<string, Dec>()
  const simGet = (s: string, w: string) => simQty.get(stockKey(s, w)) ?? getBal(ctx.stock, s, w).qty

  if (STOCK_IN_DOCS.includes(doc.docType) || STOCK_OUT_DOCS.includes(doc.docType)) {
    const nets = doc.docType === 'purchase_in' ? netLineAmounts(doc.lines.map((l) => l.amount), doc.docDiscount, scales.amountScale) : []
    doc.lines.forEach((l, i) => {
      const qty = dec(l.baseQty)
      if (!qty.gt(0)) return
      if (doc.docType === 'purchase_in') {
        moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, kind: 'in', qty, inAmount: nets[i] })
      } else if (doc.docType === 'sales_return') {
        // 取关联出库行的出库单位成本;未关联时取当前 avg_cost(需求 14.3)
        const unit = l.returnUnitCost !== null && l.returnUnitCost !== undefined ? dec(l.returnUnitCost) : getBal(ctx.stock, l.skuId, l.warehouseId).avgCost
        moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, kind: 'in', qty, inAmount: roundHalfUp(qty.times(unit), scales.amountScale) })
      } else {
        moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, kind: 'out', qty })
      }
    })
  } else if (doc.docType === 'transfer') {
    if (!doc.toWarehouseId)
      return reject('VALIDATION_FAILED' as ErrorCode, [{ field: 'toWarehouseId', reason: '调拨单缺少调入仓库' }])
    for (const l of doc.lines) {
      const qty = dec(l.baseQty)
      if (!qty.gt(0)) continue
      const outIdx = moves.length
      moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, kind: 'out', qty })
      moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: doc.toWarehouseId, kind: 'in', qty, fromOutOf: outIdx })
    }
  } else if (doc.docType === 'stocktake') {
    for (const l of doc.lines) {
      if (l.countedQty === null || l.countedQty === undefined) continue
      const diff = dec(l.countedQty).minus(simGet(l.skuId, l.warehouseId))
      simQty.set(stockKey(l.skuId, l.warehouseId), dec(l.countedQty))
      if (diff.isZero()) continue
      if (diff.gt(0)) {
        const avg = getBal(ctx.stock, l.skuId, l.warehouseId).avgCost
        moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, kind: 'in', qty: diff, inAmount: roundHalfUp(diff.times(avg), scales.amountScale) })
      } else {
        moves.push({ lineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, kind: 'out', qty: diff.negated() })
      }
    }
  }

  /* 2. 负库存检查 */
  if (!ctx.allowNegativeStock && moves.length > 0) {
    const viol = negativeStockViolations(netDeltas(moves), ctx)
    if (viol.length > 0) return reject('INSUFFICIENT_STOCK', viol)
  }

  /* 3. 执行库存移动 */
  if (moves.length > 0) {
    const r = runMoves(moves, ctx)
    plan.stockEntries = r.entries
    plan.stockBalances = r.balances
    // 行成本
    const costByLine = new Map<string, { qty: Dec; cost: Dec }>()
    r.entries.forEach((e, i) => {
      const mv = moves[i]
      if (!mv.lineId) return
      // 调拨:行成本取调出
      if (doc.docType === 'transfer' && e.kind === 'in') return
      const cur = costByLine.get(mv.lineId) ?? { qty: new D(0), cost: new D(0) }
      costByLine.set(mv.lineId, { qty: cur.qty.plus(e.qtyDelta.abs()), cost: cur.cost.plus(e.amountDelta.abs()) })
    })
    for (const l of doc.lines) {
      const c = costByLine.get(l.id)
      if (!c) continue
      const lc: LineCost = {
        lineId: l.id,
        costPrice: c.qty.gt(0) ? roundHalfUp(c.cost.div(c.qty), scales.priceScale) : new D(0),
        costAmount: c.cost,
      }
      if (doc.docType === 'sales_out') lc.lineProfit = dec(l.amount).minus(c.cost)
      plan.lineCosts.push(lc)
    }
    if (doc.docType === 'sales_out') plan.grossProfit = total.minus(sum(plan.lineCosts.map((x) => x.costAmount)))
    if (doc.docType === 'sales_return') plan.grossProfit = total.minus(sum(plan.lineCosts.map((x) => x.costAmount))).negated()
  }

  /* 4. 往来 / 资金 */
  const needPartner = () => {
    if (!doc.partnerId) return reject('VALIDATION_FAILED' as ErrorCode, [{ field: 'partnerId', reason: '缺少往来单位' }])
    return null
  }
  const fundEntries: FundEntry[] = []
  const fundOut = (id: string | null | undefined, source: FundSource, amount: Dec, role: 'self' | 'inline') => {
    fundEntries.push({ fundAccountId: id as string, source, amountDelta: amount.negated(), role })
  }
  const fundIn = (id: string | null | undefined, source: FundSource, amount: Dec, role: 'self' | 'inline') => {
    fundEntries.push({ fundAccountId: id as string, source, amountDelta: amount, role })
  }
  const P = (direction: Direction, amountDelta: Dec, role: 'self' | 'inline' = 'self') => {
    plan.partnerEntries.push({ partnerId: doc.partnerId as string, direction, amountDelta, role })
  }

  switch (doc.docType) {
    case 'purchase_in': {
      const bad = needPartner()
      if (bad) return bad
      P('AP', total)
      if (paid.gt(0)) {
        P('AP', paid.negated(), 'inline')
        fundOut(doc.fundAccountId, 'payment', paid, 'inline')
        plan.inline = { kind: 'payment', amount: paid, fundAccountId: doc.fundAccountId as string, partnerId: doc.partnerId as string }
      }
      break
    }
    case 'purchase_return': {
      const bad = needPartner()
      if (bad) return bad
      P('AP', total.negated())
      plan.returnOffset = offsetOf(total, ctx.upstreamUnsettled)
      break
    }
    case 'sales_out': {
      const bad = needPartner()
      if (bad) return bad
      P('AR', total)
      if (paid.gt(0)) {
        P('AR', paid.negated(), 'inline')
        fundIn(doc.fundAccountId, 'receipt', paid, 'inline')
        plan.inline = { kind: 'receipt', amount: paid, fundAccountId: doc.fundAccountId as string, partnerId: doc.partnerId as string }
      }
      break
    }
    case 'sales_return': {
      const bad = needPartner()
      if (bad) return bad
      P('AR', total.negated())
      plan.returnOffset = offsetOf(total, ctx.upstreamUnsettled)
      break
    }
    case 'receipt':
    case 'payment': {
      const bad = needPartner()
      if (bad) return bad
      const allocs = doc.allocations ?? []
      const allocSum = sum(allocs.map((a) => a.amount))
      if (!allocSum.eq(total))
        return reject('VALIDATION_FAILED', [{ field: 'allocations', reason: '核销金额合计与单据金额不一致' }])
      if (ctx.settlementTargets) {
        const bads: ErrorDetail[] = []
        for (const a of allocs) {
          const key = a.targetType === 'opening' ? 'opening' : (a.targetDocId as string)
          const open = ctx.settlementTargets.get(key)
          if (open === undefined || dec(a.amount).gt(dec(open)))
            bads.push({ field: 'allocations', reason: '被核销项的未核销金额已变化', targetDocId: a.targetDocId ?? null, available: (open ?? 0).toString() })
        }
        if (bads.length) return reject('VALIDATION_FAILED', bads)
      }
      plan.settlementApply = allocs
      if (doc.docType === 'receipt') {
        fundIn(doc.fundAccountId, 'receipt', total, 'self')
        P('AR', total.negated())
      } else {
        fundOut(doc.fundAccountId, 'payment', total, 'self')
        P('AP', total.negated())
      }
      break
    }
    case 'other_income':
      fundIn(doc.fundAccountId, 'other_in', total, 'self')
      break
    case 'other_expense':
      fundOut(doc.fundAccountId, 'other_out', total, 'self')
      break
    default:
      break
  }
  plan.fundEntries = fundEntries

  /* 5. 资金检查 */
  const fundCheck = checkFunds(fundEntries, ctx, true)
  if (fundCheck) return fundCheck

  /* 6. 信用额度(最后检查,避免用户确认后再因库存或资金失败) */
  if (doc.docType === 'sales_out' && ctx.credit && ctx.credit.limit !== null && ctx.credit.limit !== undefined && !ctx.credit.confirmed) {
    const thisAr = total.minus(paid)
    const excess = dec(ctx.credit.arBalance).plus(thisAr).minus(dec(ctx.credit.limit))
    if (excess.gt(0)) return reject('CREDIT_CONFIRM_REQUIRED', [{ reason: '超出信用额度', excess: excess.toString() }])
  }

  return plan
}

function offsetOf(total: Dec, upstreamUnsettled: DecValue | null | undefined): Dec {
  if (upstreamUnsettled === null || upstreamUnsettled === undefined) return new D(0)
  const u = dec(upstreamUnsettled)
  if (!u.gt(0)) return new D(0)
  return D.min(total, u)
}

function checkFunds(entries: FundEntry[], ctx: PostingContext, checkBalance: boolean): PostingRejection | null {
  const deltas = new Map<string, Dec>()
  for (const e of entries) deltas.set(e.fundAccountId, (deltas.get(e.fundAccountId) ?? new D(0)).plus(e.amountDelta))
  for (const [id, delta] of deltas) {
    const f = ctx.funds.get(id)
    if (!f) return reject('RELATION_NOT_FOUND', [{ field: 'fundAccountId', reason: '资金账户不存在' }])
    if (!f.enabled) return reject('FUND_ACCOUNT_DISABLED', [{ field: 'fundAccountId', reason: '资金账户已停用', fundAccountId: id }])
    if (checkBalance && delta.isNegative() && dec(f.balance).plus(delta).isNegative())
      return reject('FUND_INSUFFICIENT', [{ field: 'fundAccountId', reason: '资金账户余额不足', fundAccountId: id, balance: dec(f.balance).toString() }])
  }
  return null
}

/* ───────────────────────── 资金转账 ───────────────────────── */

export interface TransferInput {
  fromAccountId: string
  toAccountId: string
  amount: DecValue
}

/** 资金转账规划(需求 17.11、17.14):一对转出/转入流水 */
export function planTransfer(input: TransferInput, funds: Map<string, FundState>): { fundEntries: FundEntry[] } | PostingRejection {
  const amount = dec(input.amount)
  if (input.fromAccountId === input.toAccountId) return reject('FUND_TRANSFER_SAME_ACCOUNT', [{ reason: '转出与转入账户不能相同' }])
  if (!amount.gt(0)) return reject('VALIDATION_FAILED', [{ field: 'amount', reason: '转账金额必须大于 0' }])
  const entries: FundEntry[] = [
    { fundAccountId: input.fromAccountId, source: 'transfer_out', amountDelta: amount.negated(), role: 'self' },
    { fundAccountId: input.toAccountId, source: 'transfer_in', amountDelta: amount, role: 'self' },
  ]
  const bad = checkFunds(entries, { funds } as PostingContext, true)
  if (bad) return bad
  return { fundEntries: entries }
}

/* ───────────────────────── planReversal ───────────────────────── */

export interface PostedStock {
  id: string
  lineId?: string
  skuId: string
  warehouseId: string
  qtyDelta: DecValue
  unitCost: DecValue
  amountDelta: DecValue
}
export interface PostedPartner {
  id: string
  partnerId: string
  direction: Direction
  amountDelta: DecValue
  role?: 'self' | 'inline'
}
export interface PostedFund {
  id: string
  fundAccountId: string
  source: FundSource
  amountDelta: DecValue
  role?: 'self' | 'inline'
}
export interface PostedEntries {
  stock: PostedStock[]
  partner: PostedPartner[]
  fund: PostedFund[]
}

export interface ReversalContext {
  scales: Scales
  allowNegativeStock: boolean
  stock: Map<string, CostBalance>
}

/**
 * 反审核规划:对审核时写入的每条流水生成大小相等、方向相反的冲回流水(reversalOf 指向原记录)。
 * 入库类冲回会减少库存,在负库存参数关闭且会使结存小于 0 时拒绝(需求 13.10)。
 */
export function planReversal(entries: PostedEntries, ctx: ReversalContext): PostingPlan | PostingRejection {
  const plan: PostingPlan = {
    stockEntries: [],
    stockBalances: new Map(),
    partnerEntries: [],
    fundEntries: [],
    settlementApply: [],
    returnOffset: new D(0),
    lineCosts: [],
  }

  if (!ctx.allowNegativeStock && entries.stock.length > 0) {
    const deltas = new Map<string, Dec>()
    for (const e of entries.stock) {
      const k = stockKey(e.skuId, e.warehouseId)
      deltas.set(k, (deltas.get(k) ?? new D(0)).minus(dec(e.qtyDelta)))
    }
    const viol = negativeStockViolations(deltas, { stock: ctx.stock } as PostingContext)
    if (viol.length > 0) return reject('INSUFFICIENT_STOCK', viol)
  }

  // 按原写入顺序的逆序冲回
  const work = new Map<string, CostBalance>()
  for (const e of [...entries.stock].reverse()) {
    const key = stockKey(e.skuId, e.warehouseId)
    const bal = work.get(key) ?? getBal(ctx.stock, e.skuId, e.warehouseId)
    const q = dec(e.qtyDelta)
    const a = dec(e.amountDelta)
    const nb = q.gt(0) ? applyReverseInbound(bal, q, a, ctx.scales) : applyReverseOutbound(bal, q.abs(), a.abs(), ctx.scales)
    work.set(key, nb)
    plan.stockBalances.set(key, nb)
    plan.stockEntries.push({
      lineId: e.lineId,
      skuId: e.skuId,
      warehouseId: e.warehouseId,
      kind: q.gt(0) ? 'out' : 'in',
      qtyDelta: q.negated(),
      unitCost: dec(e.unitCost),
      amountDelta: a.negated(),
      balanceAfter: nb.qty,
      reversalOf: e.id,
    })
  }
  for (const p of entries.partner)
    plan.partnerEntries.push({ partnerId: p.partnerId, direction: p.direction, amountDelta: dec(p.amountDelta).negated(), role: p.role ?? 'self', reversalOf: p.id })
  for (const f of entries.fund)
    plan.fundEntries.push({ fundAccountId: f.fundAccountId, source: f.source, amountDelta: dec(f.amountDelta).negated(), role: f.role ?? 'self', reversalOf: f.id })
  return plan
}
