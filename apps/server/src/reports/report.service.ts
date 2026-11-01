import { AppError, ModuleCode, ObjectType, dec, maskFields, visibilityOf, D, Dec } from '@erp/shared'
import type { CustomFieldService, FieldFilter } from '../config/customFields.service'
import type { SettingsService } from '../config/settings.service'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import type { ModuleService } from '../core/module.service'
import type { PermissionService } from '../core/permission/permission.service'
import { Clock, todayStr } from '../core/time'
import type { InventoryService } from '../docs/inventory.service'

export interface ReportFilters {
  from?: string
  to?: string
  warehouseId?: string
  partnerId?: string
  categoryId?: string
  skuId?: string
  /** 单据上的自定义字段筛选(sales_doc / purchase_doc)与商品自定义字段筛选 */
  docCf?: Record<string, FieldFilter>
  productCf?: Record<string, FieldFilter>
  groupBy?: 'product' | 'partner' | 'salesperson' | 'date'
  page?: number
  pageSize?: number
}

export interface ReportDef {
  key: string
  label: string
  /** 数据来源模块;全部启用时报表才可用(需求 4.1) */
  sources: ModuleCode[]
  requireProfit?: boolean
}

export const REPORTS: ReportDef[] = [
  { key: 'sales_summary', label: '销售汇总', sources: ['sales'] },
  { key: 'purchase_summary', label: '采购汇总', sources: ['purchase'] },
  { key: 'stock_balance', label: '库存余额表', sources: ['inventory'] },
  { key: 'stock_inout', label: '库存收发存汇总表', sources: ['inventory'] },
  { key: 'product_profit', label: '商品毛利表', sources: ['sales'], requireProfit: true },
  { key: 'ar_summary', label: '应收账款汇总', sources: ['sales', 'finance'] },
  { key: 'ar_detail', label: '应收账款明细', sources: ['sales', 'finance'] },
  { key: 'ap_summary', label: '应付账款汇总', sources: ['purchase', 'finance'] },
  { key: 'ap_detail', label: '应付账款明细', sources: ['purchase', 'finance'] },
  { key: 'fund_flow', label: '资金账户收支流水', sources: ['finance'] },
]

export interface SummaryRow {
  key: string
  label: string
  qty: string
  amount: string
  totalCost?: string
  grossProfit?: string
}

export class ReportService {
  constructor(
    private db: Db,
    private perms: PermissionService,
    private modules: ModuleService,
    private cf: CustomFieldService,
    private settings: SettingsService,
    private inventory: InventoryService,
    private clock: Clock,
    private tz: string,
  ) {}

  /** 当前租户可用的报表(模块启用 + 权限) */
  async available(ctx: Ctx): Promise<ReportDef[]> {
    const enabled = await this.modules.visible(ctx.tenantId)
    return REPORTS.filter((r) => this.modules.reportAvailable(enabled, r.sources) && this.perms.can(ctx, 'report:view') && (!r.requireProfit || this.perms.canViewProfit(ctx)))
  }

  /** 日期区间默认当月 1 日至当日;起始晚于结束返回 INVALID_DATE_RANGE(需求 18.2、18.10) */
  range(f: ReportFilters): { from: string; to: string } {
    const today = todayStr(this.tz, this.clock())
    const from = f.from ?? `${today.slice(0, 8)}01`
    const to = f.to ?? today
    if (from > to) throw new AppError('INVALID_DATE_RANGE', undefined, [{ field: 'from', reason: '起始日期不能晚于结束日期' }])
    return { from, to }
  }

  private async guard(ctx: Ctx, key: string) {
    const def = REPORTS.find((r) => r.key === key)
    if (!def) throw new AppError('NOT_FOUND')
    this.perms.require(ctx, 'report:view')
    if (def.requireProfit && !this.perms.canViewProfit(ctx)) throw new AppError('NO_PERMISSION') // 需求 18.8
    const enabled = await this.modules.visible(ctx.tenantId)
    if (!this.modules.reportAvailable(enabled, def.sources)) throw new AppError('MODULE_DISABLED')
    return def
  }

  /** 报表在事务内设置 statement_timeout = 30s,超时返回 REPORT_TIMEOUT(需求 18.11) */
  private run<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>) {
    return this.db.withTenant(ctx.tenantId, fn, { readOnly: true, statementTimeoutMs: 30_000 })
  }

  /* ───────────── 统一事实来源 ───────────── */

  /**
   * 销售/采购事实:已审核出入库行为正,已审核退货行为负。各维度汇总只是对同一事实集合做 GROUP BY,
   * 因此不同维度的合计必然一致(需求 18.1、18.6)。金额取分摊整单优惠后的行净额,合计等于单据总金额之和。
   */
  private async factQuery(ctx: Ctx, tx: Tx, kind: 'sales' | 'purchase', f: ReportFilters, params: unknown[]) {
    const { from, to } = this.range(f)
    const types = kind === 'sales' ? ['sales_out', 'sales_return'] : ['purchase_in', 'purchase_return']
    const positive = kind === 'sales' ? 'sales_out' : 'purchase_in'
    params.push(types)
    const where = [`d.status = 'audited'`, `NOT d.is_inline`, `d.doc_type = ANY($${params.length}::text[])`]
    params.push(from, to)
    where.push(`d.doc_date >= $${params.length - 1}::date`, `d.doc_date <= $${params.length}::date`)
    if (f.warehouseId) {
      params.push(f.warehouseId)
      where.push(`dl.warehouse_id = $${params.length}`)
    }
    if (f.partnerId) {
      params.push(f.partnerId)
      where.push(`d.partner_id = $${params.length}`)
    }
    if (f.skuId) {
      params.push(f.skuId)
      where.push(`dl.sku_id = $${params.length}`)
    }
    if (f.categoryId) {
      params.push(f.categoryId)
      where.push(`p.category_id IN (SELECT id FROM product_category WHERE id = $${params.length} OR path LIKE (SELECT path FROM product_category WHERE id = $${params.length}) || '/%')`)
    }
    where.push(this.perms.documentFilter(ctx, 'd', params))
    where.push(this.perms.stockFilter(ctx, 'dl.warehouse_id', params))
    const docObj: ObjectType = kind === 'sales' ? 'sales_doc' : 'purchase_doc'
    where.push(...(await this.cf.buildFilters(tx, docObj, f.docCf, 'd', params)))
    where.push(...(await this.cf.buildFilters(tx, 'product', f.productCf, 'p', params)))
    params.push(positive)
    const sign = `(CASE WHEN d.doc_type = $${params.length} THEN 1 ELSE -1 END)`
    return `
      SELECT d.id AS doc_id, d.doc_date, d.partner_id, d.handler_id, dl.sku_id, dl.warehouse_id, p.category_id,
             ${sign} * dl.base_qty AS qty, ${sign} * dl.net_amount AS amount, ${sign} * COALESCE(dl.cost_amount, 0) AS cost
      FROM document d
      JOIN document_line dl ON dl.tenant_id = d.tenant_id AND dl.document_id = d.id
      JOIN sku s ON s.tenant_id = dl.tenant_id AND s.id = dl.sku_id
      JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
      WHERE ${where.join(' AND ')}`
  }

  /** 销售汇总/采购汇总:按商品、往来单位、销售员、日期汇总 */
  async summary(ctx: Ctx, kind: 'sales' | 'purchase', f: ReportFilters) {
    await this.guard(ctx, kind === 'sales' ? 'sales_summary' : 'purchase_summary')
    const groupBy = f.groupBy ?? 'product'
    if (!['product', 'partner', 'salesperson', 'date'].includes(groupBy)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'groupBy', reason: '不支持的汇总维度' }])
    return this.run(ctx, async (tx) => {
      const params: unknown[] = []
      const fact = await this.factQuery(ctx, tx, kind, f, params)
      const dim = {
        product: { key: 'f.sku_id::text', label: `s.code || ' ' || p.name`, join: `JOIN sku s ON s.tenant_id = $T AND s.id = f.sku_id JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id` },
        partner: { key: 'f.partner_id::text', label: 'pt.name', join: `JOIN partner pt ON pt.tenant_id = $T AND pt.id = f.partner_id` },
        salesperson: { key: `COALESCE(f.handler_id::text, '-')`, label: `COALESCE(tu.name, '(无经办人)')`, join: `LEFT JOIN tenant_user tu ON tu.tenant_id = $T AND tu.id = f.handler_id` },
        date: { key: 'f.doc_date::text', label: 'f.doc_date::text', join: '' },
      }[groupBy]
      // 仅当 join 引用了租户占位符时才追加该参数,否则多余参数会让 PostgreSQL 报参数个数不匹配
      let join = dim.join
      if (join.includes('$T')) {
        params.push(ctx.tenantId)
        join = join.replaceAll('$T', `$${params.length}`)
      }
      const sql = `WITH fact AS (${fact}) SELECT ${dim.key} AS key, ${dim.label} AS label, sum(f.qty)::text AS qty, sum(f.amount)::text AS amount, sum(f.cost)::text AS total_cost, sum(f.amount - f.cost)::text AS gross_profit
                   FROM fact f ${join} GROUP BY 1, 2 ORDER BY 2`
      const rows = await tx.rows(sql, params)
      const items: SummaryRow[] = rows.map((r) => ({ key: r.key, label: r.label, qty: r.qty, amount: r.amount, ...(kind === 'sales' ? { totalCost: r.total_cost, grossProfit: r.gross_profit } : {}) }))
      const totals = items.reduce(
        (a, r) => ({ qty: a.qty.plus(r.qty), amount: a.amount.plus(r.amount), cost: a.cost.plus(r.totalCost ?? 0) }),
        { qty: new D(0) as Dec, amount: new D(0) as Dec, cost: new D(0) as Dec },
      )
      const out = { groupBy, ...this.range(f), items, totals: { qty: totals.qty.toFixed(4), amount: totals.amount.toFixed(2), ...(kind === 'sales' ? { totalCost: totals.cost.toFixed(2), grossProfit: totals.amount.minus(totals.cost).toFixed(2) } : {}) } }
      return this.mask(ctx, out)
    })
  }

  /** 商品毛利表(需要利润权限;需求 18.8) */
  async productProfit(ctx: Ctx, f: ReportFilters) {
    await this.guard(ctx, 'product_profit')
    return this.run(ctx, async (tx) => {
      const params: unknown[] = []
      const fact = await this.factQuery(ctx, tx, 'sales', f, params)
      params.push(ctx.tenantId)
      const t = `$${params.length}`
      const rows = await tx.rows(
        `WITH fact AS (${fact})
         SELECT f.sku_id, s.code AS sku_code, p.name, sum(f.qty)::text AS qty, sum(f.amount)::text AS amount, sum(f.cost)::text AS total_cost, sum(f.amount - f.cost)::text AS gross_profit
         FROM fact f JOIN sku s ON s.tenant_id = ${t} AND s.id = f.sku_id JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
         GROUP BY f.sku_id, s.code, p.name ORDER BY s.code`,
        params,
      )
      const items = rows.map((r) => ({
        skuId: r.sku_id,
        skuCode: r.sku_code,
        name: r.name,
        qty: r.qty,
        amount: r.amount,
        totalCost: r.total_cost,
        grossProfit: r.gross_profit,
        grossMargin: dec(r.amount).isZero() ? '0.00' : dec(r.gross_profit).div(r.amount).times(100).toFixed(2),
      }))
      return this.mask(ctx, { ...this.range(f), items })
    })
  }

  /**
   * 收发存:期初 = 期初库存 + 起始日前 Σ流水;本期入库/出库为区间内正/负变动之和;期末 = 期初 + 入 − 出(需求 18.7)。
   */
  async stockInOut(ctx: Ctx, f: ReportFilters) {
    await this.guard(ctx, 'stock_inout')
    const { from, to } = this.range(f)
    return this.run(ctx, async (tx) => {
      const params: unknown[] = [from, to, this.tz]
      const where: string[] = []
      if (f.skuId) {
        params.push(f.skuId)
        where.push(`sb.sku_id = $${params.length}`)
      }
      if (f.warehouseId) {
        params.push(f.warehouseId)
        where.push(`sb.warehouse_id = $${params.length}`)
      }
      if (f.categoryId) {
        params.push(f.categoryId)
        where.push(`p.category_id IN (SELECT id FROM product_category WHERE id = $${params.length} OR path LIKE (SELECT path FROM product_category WHERE id = $${params.length}) || '/%')`)
      }
      where.push(this.perms.stockFilter(ctx, 'sb.warehouse_id', params))
      const start = `($1::date::timestamp AT TIME ZONE $3)`
      const end = `(($2::date + 1)::timestamp AT TIME ZONE $3)`
      const rows = await tx.rows(
        `SELECT sb.sku_id, s.code AS sku_code, p.name, sb.warehouse_id, wh.name AS warehouse_name, sb.qty AS current_qty,
           (sb.opening_qty + COALESCE((SELECT sum(l.qty_delta) FROM stock_ledger l WHERE l.sku_id = sb.sku_id AND l.warehouse_id = sb.warehouse_id AND l.occurred_at < ${start}), 0))::text AS opening,
           COALESCE((SELECT sum(l.qty_delta) FROM stock_ledger l WHERE l.sku_id = sb.sku_id AND l.warehouse_id = sb.warehouse_id AND l.occurred_at >= ${start} AND l.occurred_at < ${end} AND l.qty_delta > 0), 0)::text AS qty_in,
           COALESCE(-sum(CASE WHEN l2.qty_delta < 0 THEN l2.qty_delta END), 0)::text AS qty_out
         FROM stock_balance sb
         JOIN sku s ON s.tenant_id = sb.tenant_id AND s.id = sb.sku_id JOIN product p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
         JOIN warehouse wh ON wh.tenant_id = sb.tenant_id AND wh.id = sb.warehouse_id
         LEFT JOIN stock_ledger l2 ON l2.tenant_id = sb.tenant_id AND l2.sku_id = sb.sku_id AND l2.warehouse_id = sb.warehouse_id AND l2.occurred_at >= ${start} AND l2.occurred_at < ${end}
         WHERE ${where.join(' AND ')}
         GROUP BY sb.sku_id, s.code, p.name, sb.warehouse_id, wh.name, sb.qty, sb.opening_qty ORDER BY s.code, wh.name`,
        params,
      )
      const today = todayStr(this.tz, this.clock())
      const items = rows.map((r) => {
        const closing = dec(r.opening).plus(r.qty_in).minus(r.qty_out)
        return { skuId: r.sku_id, skuCode: r.sku_code, name: r.name, warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, opening: dec(r.opening).toFixed(4), qtyIn: dec(r.qty_in).toFixed(4), qtyOut: dec(r.qty_out).toFixed(4), closing: closing.toFixed(4), isCurrent: to >= today }
      })
      return { from, to, items }
    })
  }

  /* ───────────── 应收/应付 ───────────── */

  /** 汇总:期初 + 范围内已审核单据产生的变动 = 当前余额;范围受限的用户只统计范围内单据(需求 18.9) */
  async receivables(ctx: Ctx, direction: 'AR' | 'AP', detail: boolean, f: ReportFilters) {
    await this.guard(ctx, direction === 'AR' ? (detail ? 'ar_detail' : 'ar_summary') : detail ? 'ap_detail' : 'ap_summary')
    const { from, to } = this.range(f)
    return this.run(ctx, async (tx) => {
      const params: unknown[] = [direction]
      const scope = this.perms.documentFilter(ctx, 'd', params)
      const full = ctx.perms.isAdmin || ctx.perms.dataScope.all
      const open = direction === 'AR' ? 'p.opening_ar' : 'p.opening_ap'
      if (!detail) {
        params.push(ctx.tenantId)
        const rows = await tx.rows(
          `SELECT p.id, p.code, p.name, ${full ? open : '0'}::text AS opening,
             COALESCE((SELECT sum(l.amount_delta) FROM partner_ledger l JOIN document d ON d.tenant_id = l.tenant_id AND d.id = l.doc_id WHERE l.partner_id = p.id AND l.direction = $1 AND ${scope}), 0)::text AS delta
           FROM partner p WHERE p.tenant_id = $${params.length} ORDER BY p.code`,
          params,
        )
        const items = rows.map((r) => ({ partnerId: r.id, code: r.code, name: r.name, opening: r.opening, balance: dec(r.opening).plus(r.delta).toFixed(2) })).filter((r) => !dec(r.balance).isZero())
        return { items, total: items.reduce((a, r) => a.plus(r.balance), new D(0) as Dec).toFixed(2) }
      }
      if (!f.partnerId) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'partnerId', reason: '请选择往来单位' }])
      params.push(f.partnerId, from, to, this.tz)
      const base = params.length - 3
      const rows = await tx.rows(
        `SELECT l.occurred_at, d.doc_no, d.doc_type, l.role, l.amount_delta FROM partner_ledger l JOIN document d ON d.tenant_id = l.tenant_id AND d.id = l.doc_id
         WHERE l.partner_id = $${base} AND l.direction = $1 AND ${scope} AND l.occurred_at >= ($${base + 1}::date::timestamp AT TIME ZONE $${base + 3}) AND l.occurred_at < (($${base + 2}::date + 1)::timestamp AT TIME ZONE $${base + 3})
         ORDER BY l.occurred_at, l.id`,
        params,
      )
      return { items: rows.map((r) => ({ occurredAt: r.occurred_at.toISOString(), docNo: r.doc_no, docType: r.doc_type, role: r.role, amountDelta: r.amount_delta })) }
    })
  }

  /** 资金账户收支流水 */
  async fundFlow(ctx: Ctx, f: ReportFilters & { fundAccountId?: string }) {
    await this.guard(ctx, 'fund_flow')
    const { from, to } = this.range(f)
    return this.run(ctx, async (tx) => {
      const params: unknown[] = [from, to, this.tz]
      const where = [`l.occurred_at >= ($1::date::timestamp AT TIME ZONE $3)`, `l.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`]
      if (f.fundAccountId) {
        params.push(f.fundAccountId)
        where.push(`l.fund_account_id = $${params.length}`)
      }
      const scope = this.perms.documentFilter(ctx, 'd', params)
      const rows = await tx.rows(
        `SELECT l.occurred_at, fa.name AS account, l.source, d.doc_no, l.amount_delta, l.reversal_of
         FROM fund_ledger l JOIN fund_account fa ON fa.tenant_id = l.tenant_id AND fa.id = l.fund_account_id
         LEFT JOIN document d ON d.tenant_id = l.tenant_id AND d.id = l.source_id
         WHERE ${where.join(' AND ')} AND (d.id IS NULL OR ${scope}) ORDER BY l.occurred_at, l.id`,
        params,
      )
      return { from, to, items: rows.map((r) => ({ occurredAt: r.occurred_at.toISOString(), account: r.account, source: r.source, docNo: r.doc_no, amountDelta: r.amount_delta, isReversal: !!r.reversal_of })) }
    })
  }

  /* ───────────── 首页指标 ───────────── */

  /** 今日/本月:销售额、毛利、收款额、付款额;库存预警 SKU 数;应收合计(需求 18.4、18.8、18.9) */
  async dashboard(ctx: Ctx) {
    const today = todayStr(this.tz, this.clock())
    const monthStart = `${today.slice(0, 8)}01`
    type Agg = { sales: string; profit: string; receipts: string; payments: string }
    const result = await this.run(ctx, async (tx) => {
      // 每个查询使用独立的参数数组:PostgreSQL 要求提供的参数个数与语句引用的个数一致
      const aggregate = (from: string) => {
        const params: unknown[] = [from, today]
        const scope = this.perms.documentFilter(ctx, 'd', params)
        return tx.one<Agg>(
          `SELECT
             COALESCE(sum(CASE WHEN d.doc_type='sales_out' THEN d.total_amount WHEN d.doc_type='sales_return' THEN -d.total_amount END), 0)::text AS sales,
             COALESCE(sum(CASE WHEN d.doc_type IN ('sales_out','sales_return') THEN d.gross_profit END), 0)::text AS profit,
             COALESCE(sum(CASE WHEN d.doc_type='receipt' THEN d.total_amount END), 0)::text AS receipts,
             COALESCE(sum(CASE WHEN d.doc_type='payment' THEN d.total_amount END), 0)::text AS payments
           FROM document d WHERE d.status='audited' AND d.doc_date >= $1::date AND d.doc_date <= $2::date AND ${scope}`,
          params,
        )
      }
      const day = await aggregate(today)
      const month = await aggregate(monthStart)
      // 应收合计:期初(仅全部数据范围计入)+ 范围内单据产生的应收变动
      const arParams: unknown[] = []
      const arScope = this.perms.documentFilter(ctx, 'd', arParams)
      const full = ctx.perms.isAdmin || ctx.perms.dataScope.all
      const ar = await tx.one<{ total: string }>(
        `SELECT (${full ? 'COALESCE((SELECT sum(opening_ar) FROM partner), 0)' : '0'}
                 + COALESCE((SELECT sum(l.amount_delta) FROM partner_ledger l JOIN document d ON d.tenant_id = l.tenant_id AND d.id = l.doc_id WHERE l.direction = 'AR' AND ${arScope}), 0))::text AS total`,
        arParams,
      )
      return { day, month, arTotal: ar.total }
    })
    const alerts = (await this.safeAlerts(ctx)).length
    const money = (v: string) => dec(v).toFixed(2)
    const shape = (r: { sales: string; profit: string; receipts: string; payments: string }) => ({ salesAmount: money(r.sales), grossProfit: money(r.profit), receiptAmount: money(r.receipts), paymentAmount: money(r.payments) })
    return maskFields({ today: shape(result.day), month: shape(result.month), stockAlertCount: alerts, receivableTotal: dec(result.arTotal).toFixed(2) }, visibilityOf(ctx.perms))
  }

  /** 预警 SKU 数:不具备库存查看权限的用户按 0 显示,不泄露库存信息 */
  private async safeAlerts(ctx: Ctx) {
    return this.perms.can(ctx, 'stock:view') ? this.inventory.alerts(ctx) : []
  }

  /** 按权限去除成本/利润字段,与列表、导出、打印共用同一脱敏函数(需求 10.4、10.11) */
  private mask<T>(ctx: Ctx, data: T): T {
    return maskFields(data, visibilityOf(ctx.perms))
  }

  async settingsScales(ctx: Ctx) {
    return (await this.settings.get(ctx.tenantId)).scales
  }
}

