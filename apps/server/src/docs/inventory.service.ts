import { AppError, D, dec } from '@erp/shared'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import type { PermissionService } from '../core/permission/permission.service'
import type { AuditService } from '../core/audit'

/** 库存查询:余额、流水明细、预警(需求 14.9、14.10) */
export class InventoryService {
  constructor(
    private db: Db,
    private perms: PermissionService,
    private audit: AuditService,
  ) {}

  /**
   * 库存余额:截至结束日的 On_Hand_Quantity 与库存金额 = 期初 + Σ流水(发生时间 ≤ 结束日 23:59:59)。
   * 不带结束日时直接取当前余额缓存。
   */
  async balances(
    ctx: Ctx,
    f: { skuId?: string; warehouseId?: string; categoryId?: string; keyword?: string; asOf?: string; tz?: string; page?: number; pageSize?: number },
  ) {
    this.perms.require(ctx, 'stock:view')
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const params: unknown[] = []
        const where: string[] = []
        const add = (sql: string, v: unknown) => {
          params.push(v)
          where.push(sql.replaceAll('?', `$${params.length}`))
        }
        if (f.skuId) add('sb.sku_id = ?', f.skuId)
        if (f.warehouseId) add('sb.warehouse_id = ?', f.warehouseId)
        if (f.categoryId) add(`p.category_id IN (SELECT id FROM product_category WHERE id = ? OR path LIKE (SELECT path FROM product_category WHERE id = ?) || '/%')`, f.categoryId)
        if (f.keyword) add('(s.code ILIKE ? OR p.name ILIKE ?)', `%${f.keyword.replace(/[\\%_]/g, '\\$&')}%`)
        where.push(this.perms.stockFilter(ctx, 'sb.warehouse_id', params))
        const pageSize = Math.min(f.pageSize ?? 50, 100)
        const page = Math.max(f.page ?? 1, 1)
        // 截至日的数量与金额由流水还原;审核时刻即流水 occurred_at
        const asOfSql = f.asOf
          ? (() => {
              params.push(f.asOf, f.tz ?? 'Asia/Shanghai')
              const d = `$${params.length - 1}`
              const z = `$${params.length}`
              return `((${d}::date + 1)::timestamp AT TIME ZONE ${z})`
            })()
          : null
        const qtyExpr = asOfSql ? `sb.opening_qty + COALESCE((SELECT sum(l.qty_delta) FROM stock_ledger l WHERE l.sku_id = sb.sku_id AND l.warehouse_id = sb.warehouse_id AND l.occurred_at < ${asOfSql}), 0)` : 'sb.qty'
        const amtExpr = asOfSql ? `sb.opening_amount + COALESCE((SELECT sum(l.amount_delta) FROM stock_ledger l WHERE l.sku_id = sb.sku_id AND l.warehouse_id = sb.warehouse_id AND l.occurred_at < ${asOfSql}), 0)` : 'sb.amount'
        const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
        const from = `FROM stock_balance sb JOIN sku s ON s.tenant_id = sb.tenant_id AND s.id = sb.sku_id JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id JOIN warehouse wh ON wh.tenant_id = sb.tenant_id AND wh.id = sb.warehouse_id`
        // count 语句不引用 asOf 占位符,因此使用不含 asOf 参数的副本,避免参数个数不匹配
        const countParams = params.slice(0, params.length - (f.asOf ? 2 : 0))
        const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n ${from} ${w}`, countParams)).n
        const rows = await tx.rows(
          `SELECT sb.sku_id, s.code AS sku_code, p.name, p.spec, p.base_unit, sb.warehouse_id, wh.name AS warehouse_name, (${qtyExpr})::text AS qty, (${amtExpr})::text AS amount, sb.avg_cost
           ${from} ${w} ORDER BY s.code, wh.code LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
          params,
        )
        const showCost = this.perms.canViewCost(ctx)
        return {
          items: rows.map((r) => ({
            skuId: r.sku_id,
            skuCode: r.sku_code,
            name: r.name,
            spec: r.spec,
            baseUnit: r.base_unit,
            warehouseId: r.warehouse_id,
            warehouseName: r.warehouse_name,
            qty: r.qty,
            // 库存成本金额与单位成本属于敏感字段,无权限不返回(需求 10.4)
            ...(showCost ? { amount: r.amount, avgCost: r.avg_cost } : {}),
          })),
          total,
          page,
          pageSize,
        }
      },
      { readOnly: true },
    )
  }

  /** 流水明细:发生时间在区间内(含起止日),按发生时间升序(需求 14.10) */
  async ledger(ctx: Ctx, f: { skuId?: string; warehouseId?: string; from?: string; to?: string; tz?: string; page?: number; pageSize?: number }) {
    this.perms.require(ctx, 'stock:view')
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const params: unknown[] = []
        const where: string[] = []
        const tz = f.tz ?? 'Asia/Shanghai'
        if (f.skuId) {
          params.push(f.skuId)
          where.push(`l.sku_id = $${params.length}`)
        }
        if (f.warehouseId) {
          params.push(f.warehouseId)
          where.push(`l.warehouse_id = $${params.length}`)
        }
        if (f.from) {
          params.push(f.from, tz)
          where.push(`l.occurred_at >= ($${params.length - 1}::date::timestamp AT TIME ZONE $${params.length})`)
        }
        if (f.to) {
          params.push(f.to, tz)
          where.push(`l.occurred_at < (($${params.length - 1}::date + 1)::timestamp AT TIME ZONE $${params.length})`)
        }
        where.push(this.perms.stockFilter(ctx, 'l.warehouse_id', params))
        const pageSize = Math.min(f.pageSize ?? 50, 100)
        const page = Math.max(f.page ?? 1, 1)
        const w = 'WHERE ' + where.join(' AND ')
        const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM stock_ledger l ${w}`, params)).n
        const rows = await tx.rows(
          `SELECT l.id, l.doc_type, l.doc_no, l.sku_id, s.code AS sku_code, l.warehouse_id, l.qty_delta, l.balance_after, l.unit_cost, l.amount_delta, l.occurred_at, l.reversal_of
           FROM stock_ledger l JOIN sku s ON s.tenant_id = l.tenant_id AND s.id = l.sku_id ${w} ORDER BY l.occurred_at ASC, l.seq ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
          params,
        )
        const showCost = this.perms.canViewCost(ctx)
        return {
          items: rows.map((r) => ({
            id: r.id,
            docType: r.doc_type,
            docNo: r.doc_no,
            skuId: r.sku_id,
            skuCode: r.sku_code,
            warehouseId: r.warehouse_id,
            qtyDelta: r.qty_delta,
            balanceAfter: r.balance_after,
            occurredAt: r.occurred_at.toISOString(),
            reversalOf: r.reversal_of,
            ...(showCost ? { unitCost: r.unit_cost, amountDelta: r.amount_delta } : {}),
          })),
          total,
          page,
          pageSize,
        }
      },
      { readOnly: true },
    )
  }

  /**
   * 库存预警:SKU 在全部仓库合计数量严格小于下限或严格大于上限(未设置的限值不参与)
   * (需求 14.9)。合计回到区间内(含两端)后不再出现。
   */
  async alerts(ctx: Ctx) {
    this.perms.require(ctx, 'stock:view')
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const params: unknown[] = []
        const scope = this.perms.stockFilter(ctx, 'sb.warehouse_id', params)
        const rows = await tx.rows(
          `SELECT s.id AS sku_id, s.code AS sku_code, p.name, p.stock_min, p.stock_max, COALESCE(sum(sb.qty), 0)::text AS total
           FROM sku s JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
           LEFT JOIN stock_balance sb ON sb.tenant_id = s.tenant_id AND sb.sku_id = s.id AND ${scope}
           WHERE s.enabled AND p.enabled AND (p.stock_min IS NOT NULL OR p.stock_max IS NOT NULL)
           GROUP BY s.id, s.code, p.name, p.stock_min, p.stock_max
           HAVING (p.stock_min IS NOT NULL AND COALESCE(sum(sb.qty), 0) < p.stock_min) OR (p.stock_max IS NOT NULL AND COALESCE(sum(sb.qty), 0) > p.stock_max)
           ORDER BY s.code`,
          params,
        )
        return rows.map((r) => {
          const total = dec(r.total)
          const below = r.stock_min !== null && total.lt(r.stock_min)
          return {
            skuId: r.sku_id,
            skuCode: r.sku_code,
            name: r.name,
            totalQty: total.toFixed(4),
            stockMin: r.stock_min,
            stockMax: r.stock_max,
            kind: below ? ('below' as const) : ('above' as const),
            // 超出限值的差额(低于下限为负、高于上限为正)
            diff: (below ? total.minus(r.stock_min) : total.minus(r.stock_max)).toFixed(4),
          }
        })
      },
      { readOnly: true },
    )
  }

  /** 销售开单提示:当前仓库库存 + 该客户最近一次已审核出库单价(无则 null;需求 16.5) */
  async salesHints(ctx: Ctx, f: { skuId: string; warehouseId: string; partnerId?: string }) {
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const stockParams: unknown[] = [f.skuId, f.warehouseId]
        const scope = this.perms.stockFilter(ctx, 'warehouse_id', stockParams)
        const s = await tx.maybeOne(`SELECT qty FROM stock_balance WHERE sku_id=$1 AND warehouse_id=$2 AND ${scope}`, stockParams)
        let lastPrice: string | null = null
        if (f.partnerId) {
          const r = await tx.maybeOne(
            `SELECT dl.price FROM document_line dl JOIN document d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
             WHERE d.doc_type='sales_out' AND d.status='audited' AND d.partner_id=$1 AND dl.sku_id=$2 ORDER BY d.audited_at DESC, d.id DESC LIMIT 1`,
            [f.partnerId, f.skuId],
          )
          lastPrice = r?.price ?? null
        }
        return { onHandQty: s?.qty ?? '0.0000', lastPrice }
      },
      { readOnly: true },
    )
  }

  /**
   * 设置期初库存(导入期初库存使用)。仅当该组合没有任何流水时允许,保证 数量 = 期初 + Σ流水。
   */
  async setOpening(tx: Tx, ctx: Ctx, skuId: string, warehouseId: string, qty: string, unitCost: string): Promise<void> {
    const has = await tx.maybeOne('SELECT 1 FROM stock_ledger WHERE sku_id=$1 AND warehouse_id=$2 LIMIT 1', [skuId, warehouseId])
    if (has) throw new AppError('VALIDATION_FAILED', '该商品在该仓库已有库存流水,不能再设置期初库存', [{ field: 'qty', reason: '已有库存流水' }])
    const amount = dec(qty).times(unitCost).toDecimalPlaces(2, D.ROUND_HALF_UP)
    await tx.query(
      `INSERT INTO stock_balance (tenant_id, sku_id, warehouse_id, opening_qty, opening_amount, qty, amount, avg_cost) VALUES ($1,$2,$3,$4,$5,$4,$5,$6)
       ON CONFLICT (tenant_id, sku_id, warehouse_id) DO UPDATE SET opening_qty=$4, opening_amount=$5, qty=$4, amount=$5, avg_cost=$6`,
      [ctx.tenantId, skuId, warehouseId, dec(qty).toFixed(4), amount.toFixed(2), dec(unitCost).toFixed(6)],
    )
    await this.audit.log(tx, ctx, 'stock.opening', { type: 'stock', id: skuId, no: skuId, before: null, after: { warehouseId, qty, unitCost } })
  }
}
