import {
  AppError,
  DOC_TYPES,
  DOC_TYPE_PREFIX,
  DocType,
  LocalDate,
  NumberingRule,
  Scales,
  TenantSettingsData,
  DEFAULT_SETTINGS,
  periodKey,
  formatDocNo,
  settingsSchema,
  validateNumberingRule,
} from '@erp/shared'
import { AuditService } from '../core/audit'
import type { ConfigCache } from '../core/cache'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'

export interface TenantSettings extends TenantSettingsData {
  scales: Scales
}

const toSettings = (r: any): TenantSettings => ({
  qtyScale: r.qty_scale,
  priceScale: r.price_scale,
  amountScale: r.amount_scale,
  allowNegativeStock: r.allow_negative_stock,
  requireAudit: r.require_audit,
  multiUnit: r.multi_unit,
  multiSku: r.multi_sku,
  barcodeEnabled: r.barcode_enabled,
  scales: { qtyScale: r.qty_scale, priceScale: r.price_scale, amountScale: r.amount_scale },
})

export interface NumberingRuleRow extends NumberingRule {
  docType: DocType
}

export class SettingsService {
  constructor(
    private db: Db,
    private cache: ConfigCache,
    private audit: AuditService,
  ) {}

  /** 业务参数(进程内缓存 + 失效广播,保存后下一次查询起生效;需求 7.6) */
  async get(tenantId: string): Promise<TenantSettings> {
    return this.cache.get(`set:${tenantId}`, () => this.db.withTenant(tenantId, (tx) => this.read(tx)))
  }

  async read(tx: Tx): Promise<TenantSettings> {
    return toSettings(await tx.one('SELECT * FROM tenant_settings'))
  }

  async update(tx: Tx, ctx: Ctx, input: unknown): Promise<TenantSettings> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const r = settingsSchema.safeParse(input)
    if (!r.success) {
      throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.'), reason: this.rangeMessage(i.path[0] as string, i.message) })))
    }
    const before = await this.read(tx)
    const v = r.data
    // 修改精度参数只影响录入限制与显示,不改动已存储值(设计 D10)
    await tx.query(
      `UPDATE tenant_settings SET qty_scale=$2, price_scale=$3, amount_scale=$4, allow_negative_stock=$5, require_audit=$6, multi_unit=$7, multi_sku=$8, barcode_enabled=$9 WHERE tenant_id=$1`,
      [ctx.tenantId, v.qtyScale, v.priceScale, v.amountScale, v.allowNegativeStock, v.requireAudit, v.multiUnit, v.multiSku, v.barcodeEnabled],
    )
    const after = await this.read(tx)
    tx.onCommit(() => this.cache.invalidate(`set:${ctx.tenantId}`))
    const strip = (s: TenantSettings) => {
      const { scales: _s, ...rest } = s
      return rest
    }
    await this.audit.log(tx, ctx, 'settings.update', { type: 'settings', id: ctx.tenantId, before: strip(before), after: strip(after) })
    return after
  }

  private rangeMessage(field: string, fallback: string): string {
    const ranges: Record<string, string> = { qtyScale: '数量小数位数允许 0 至 4', priceScale: '单价小数位数允许 0 至 6', amountScale: '金额小数位数允许 0 至 2' }
    return ranges[field] ?? fallback
  }

  /* ───────── 编号规则 ───────── */

  async listRules(tx: Tx): Promise<NumberingRuleRow[]> {
    const rows = await tx.rows('SELECT doc_type, prefix, date_format, seq_digits, reset_cycle FROM numbering_rule ORDER BY doc_type')
    return rows.map((r) => ({ docType: r.doc_type, prefix: r.prefix, dateFormat: r.date_format, seqDigits: r.seq_digits, reset: r.reset_cycle }))
  }

  async updateRule(tx: Tx, ctx: Ctx, docType: DocType, rule: NumberingRule): Promise<NumberingRuleRow> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    if (!DOC_TYPES.includes(docType)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'docType', reason: '未知的单据类型' }])
    const issues = validateNumberingRule(rule)
    if (issues.length) throw new AppError('VALIDATION_FAILED', undefined, issues.map((i) => ({ field: i.field, reason: i.reason })))
    const before = (await this.listRules(tx)).find((r) => r.docType === docType)
    await tx.query(
      `INSERT INTO numbering_rule (tenant_id, doc_type, prefix, date_format, seq_digits, reset_cycle) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, doc_type) DO UPDATE SET prefix=$3, date_format=$4, seq_digits=$5, reset_cycle=$6`,
      [ctx.tenantId, docType, rule.prefix, rule.dateFormat, rule.seqDigits, rule.reset],
    )
    await this.audit.log(tx, ctx, 'numbering_rule.update', { type: 'numbering_rule', id: docType, no: docType, before: before ?? null, after: { docType, ...rule } })
    return { docType, ...rule }
  }

  /** 创建 Tenant 时写入默认业务参数与每种单据类型一条默认编号规则(需求 7.1、7.2) */
  async seedDefaults(tx: Tx, tenantId: string): Promise<void> {
    const s = DEFAULT_SETTINGS
    await tx.query(
      `INSERT INTO tenant_settings (tenant_id, qty_scale, price_scale, amount_scale, allow_negative_stock, require_audit, multi_unit, multi_sku, barcode_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, s.qtyScale, s.priceScale, s.amountScale, s.allowNegativeStock, s.requireAudit, s.multiUnit, s.multiSku, s.barcodeEnabled],
    )
    for (const d of DOC_TYPES) {
      await tx.query(`INSERT INTO numbering_rule (tenant_id, doc_type, prefix, date_format, seq_digits, reset_cycle) VALUES ($1,$2,$3,'YMD',4,'daily')`, [tenantId, d, DOC_TYPE_PREFIX[d]])
    }
  }
}

/** 单据编号生成(需求 7.3、7.4,设计 D4) */
export class NumberingService {
  /**
   * 同一租户同一单据类型串行取号:UPSERT 的行锁保证并发安全;
   * 规则修改后新格式可能与旧编号碰撞,继续递增直到得到未占用编号,唯一索引是最终保障。
   */
  async next(tx: Tx, tenantId: string, docType: DocType, today: LocalDate): Promise<string> {
    const r = await tx.maybeOne('SELECT prefix, date_format, seq_digits, reset_cycle FROM numbering_rule WHERE doc_type=$1', [docType])
    const rule: NumberingRule = r
      ? { prefix: r.prefix, dateFormat: r.date_format, seqDigits: r.seq_digits, reset: r.reset_cycle }
      : { prefix: DOC_TYPE_PREFIX[docType], dateFormat: 'YMD', seqDigits: 4, reset: 'daily' }
    const key = periodKey(rule, today)
    for (let i = 0; i < 10_000; i++) {
      const seq = (
        await tx.one<{ last_value: number }>(
          `INSERT INTO number_sequence (tenant_id, doc_type, period_key, last_value) VALUES ($1,$2,$3,1)
           ON CONFLICT (tenant_id, doc_type, period_key) DO UPDATE SET last_value = number_sequence.last_value + 1 RETURNING last_value`,
          [tenantId, docType, key],
        )
      ).last_value
      const no = formatDocNo(rule, today, seq)
      const used = await tx.maybeOne('SELECT 1 FROM document WHERE doc_type=$1 AND doc_no=$2', [docType, no])
      if (!used) return no
    }
    throw new Error('无法生成可用的单据编号')
  }
}
