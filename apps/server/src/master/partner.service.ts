import { AppError, PartnerInput, partnerSchema } from '@erp/shared'
import type { CustomFieldService, FieldFilter } from '../config/customFields.service'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Tx } from '../core/db'
import { uuidv7 } from '../core/ids'

export interface PartnerView {
  id: string
  code: string
  name: string
  kind: 'customer' | 'supplier' | 'both'
  category: string
  contact: string
  phone: string
  address: string
  taxNo: string
  bank: string
  bankAccount: string
  openingAr: string
  openingAp: string
  priceLevel: unknown
  creditLimit: string | null
  remark: string
  enabled: boolean
  custom: Record<string, unknown>
  version: number
  arBalance?: string
  apBalance?: string
}

const toView = (r: any): PartnerView => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  category: r.category,
  contact: r.contact,
  phone: r.phone,
  address: r.address,
  taxNo: r.tax_no,
  bank: r.bank,
  bankAccount: r.bank_account,
  openingAr: r.opening_ar,
  openingAp: r.opening_ap,
  priceLevel: r.price_level,
  creditLimit: r.credit_limit,
  remark: r.remark,
  enabled: r.enabled,
  custom: r.custom,
  version: r.version,
  ...(r.ar_balance !== undefined ? { arBalance: r.ar_balance, apBalance: r.ap_balance } : {}),
})

export class PartnerService {
  constructor(
    private cf: CustomFieldService,
    private audit: AuditService,
  ) {}

  private parse(input: unknown): PartnerInput {
    const r = partnerSchema.safeParse(input)
    if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', reason: i.message })))
    const v = r.data
    if (v.priceLevel?.type === 'discount') {
      const rate = Number(v.priceLevel.rate)
      if (!(rate >= 1 && rate <= 100)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'priceLevel', reason: '自定义折扣率须为 1% 至 100%' }])
    }
    return v
  }

  private objectType(kind: string) {
    return kind === 'supplier' ? 'supplier' : 'customer'
  }

  private dup(e: unknown): unknown {
    if ((e as { code?: string })?.code === '23505') return new AppError('VALIDATION_FAILED', '编码重复', [{ field: 'code', reason: '编码重复' }])
    return e
  }

  async create(tx: Tx, ctx: Ctx, input: unknown): Promise<PartnerView> {
    const v = this.parse(input)
    const custom = await this.cf.validateNew(tx, this.objectType(v.kind), v.custom)
    const id = uuidv7()
    // 价格等级与信用额度只对客户/两者有意义
    const isCustomer = v.kind !== 'supplier'
    try {
      await tx.query(
        `INSERT INTO partner (id, tenant_id, code, name, kind, category, contact, phone, address, tax_no, bank, bank_account, opening_ar, opening_ap, price_level, credit_limit, remark, custom, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
        [id, ctx.tenantId, v.code, v.name, v.kind, v.category, v.contact, v.phone, v.address, v.taxNo, v.bank, v.bankAccount, v.openingAr, v.openingAp, JSON.stringify(isCustomer ? (v.priceLevel ?? { type: 'retail' }) : { type: 'retail' }), isCustomer ? (v.creditLimit ?? null) : null, v.remark, JSON.stringify(custom), ctx.tenantUserId],
      )
    } catch (e) {
      throw this.dup(e)
    }
    await tx.query('INSERT INTO partner_balance (tenant_id, partner_id, ar_balance, ap_balance) VALUES ($1,$2,$3,$4)', [ctx.tenantId, id, v.openingAr, v.openingAp])
    const view = await this.get(tx, id)
    await this.audit.log(tx, ctx, 'partner.create', { type: 'partner', id, no: v.code, before: null, after: strip(view) })
    return view
  }

  async update(tx: Tx, ctx: Ctx, id: string, input: unknown, version?: number): Promise<PartnerView> {
    const old = await tx.maybeOne('SELECT * FROM partner WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    if (version !== undefined && version !== old.version) throw new AppError('DOC_STATUS_CHANGED', '记录已被他人修改,请刷新后重试')
    const before = await this.get(tx, id)
    const v = this.parse(input)
    const custom = await this.cf.validateAndMerge(tx, this.objectType(v.kind), old.custom, v.custom)
    const bal = await tx.one('SELECT * FROM partner_balance WHERE partner_id=$1 FOR UPDATE', [id])
    // 期初金额调整后,当前余额同步变化;不得低于已核销的期初金额
    if (Number(v.openingAr) < Number(bal.opening_ar_settled) || Number(v.openingAp) < Number(bal.opening_ap_settled))
      throw new AppError('VALIDATION_FAILED', '期初金额不能低于已核销的期初金额', [{ field: 'openingAr', reason: '期初金额不能低于已核销的期初金额' }])
    const isCustomer = v.kind !== 'supplier'
    try {
      await tx.query(
        `UPDATE partner SET code=$2, name=$3, kind=$4, category=$5, contact=$6, phone=$7, address=$8, tax_no=$9, bank=$10, bank_account=$11, opening_ar=$12, opening_ap=$13,
           price_level=$14, credit_limit=$15, remark=$16, custom=$17, version=version+1, updated_at=now(), updated_by=$18 WHERE id=$1`,
        [id, v.code, v.name, v.kind, v.category, v.contact, v.phone, v.address, v.taxNo, v.bank, v.bankAccount, v.openingAr, v.openingAp, JSON.stringify(isCustomer ? (v.priceLevel ?? old.price_level) : { type: 'retail' }), isCustomer ? (v.creditLimit ?? null) : null, v.remark, JSON.stringify(custom), ctx.tenantUserId],
      )
    } catch (e) {
      throw this.dup(e)
    }
    await tx.query('UPDATE partner_balance SET ar_balance = ar_balance + ($2::numeric - $4::numeric), ap_balance = ap_balance + ($3::numeric - $5::numeric) WHERE partner_id=$1', [id, v.openingAr, v.openingAp, old.opening_ar, old.opening_ap])
    const after = await this.get(tx, id)
    await this.audit.log(tx, ctx, 'partner.update', { type: 'partner', id, no: v.code, before: strip(before), after: strip(after) })
    return after
  }

  async setEnabled(tx: Tx, ctx: Ctx, id: string, enabled: boolean): Promise<void> {
    const old = await tx.maybeOne('SELECT code, enabled FROM partner WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    await tx.query('UPDATE partner SET enabled=$2, version=version+1, updated_at=now() WHERE id=$1', [id, enabled])
    await this.audit.log(tx, ctx, enabled ? 'partner.enable' : 'partner.disable', { type: 'partner', id, no: old.code, before: { enabled: old.enabled }, after: { enabled } })
  }

  async get(tx: Tx, id: string): Promise<PartnerView> {
    const r = await tx.maybeOne('SELECT p.*, b.ar_balance, b.ap_balance FROM partner p LEFT JOIN partner_balance b ON b.tenant_id = p.tenant_id AND b.partner_id = p.id WHERE p.id=$1', [id])
    if (!r) throw new AppError('NOT_FOUND')
    return toView(r)
  }

  /** 详情:当前应收/应付余额,以及按单据日期降序的最近 20 条已审核单据(需求 12.6) */
  async detail(tx: Tx, id: string) {
    const partner = await this.get(tx, id)
    const recent = await tx.rows(
      `SELECT id, doc_no AS "docNo", doc_type AS "docType", doc_date AS "docDate", total_amount AS amount FROM document
       WHERE partner_id=$1 AND status='audited' AND NOT is_inline ORDER BY doc_date DESC, created_at DESC, id DESC LIMIT 20`,
      [id],
    )
    return { partner, recentDocuments: recent }
  }

  async list(tx: Tx, f: { keyword?: string; kind?: 'customer' | 'supplier'; enabled?: boolean; cf?: Record<string, FieldFilter>; page?: number; pageSize?: number }) {
    const params: unknown[] = []
    const where: string[] = []
    if (f.keyword) {
      params.push(`%${f.keyword.replace(/[\\%_]/g, '\\$&')}%`)
      where.push(`(p.code ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.phone ILIKE $${params.length})`)
    }
    if (f.kind) where.push(f.kind === 'customer' ? `p.kind IN ('customer','both')` : `p.kind IN ('supplier','both')`)
    if (f.enabled !== undefined) {
      params.push(f.enabled)
      where.push(`p.enabled = $${params.length}`)
    }
    if (f.cf) where.push(...(await this.cf.buildFilters(tx, f.kind === 'supplier' ? 'supplier' : 'customer', f.cf, 'p', params)))
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const pageSize = Math.min(f.pageSize ?? 20, 100)
    const page = Math.max(f.page ?? 1, 1)
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM partner p ${w}`, params)).n
    const rows = await tx.rows(`SELECT p.*, b.ar_balance, b.ap_balance FROM partner p LEFT JOIN partner_balance b ON b.tenant_id = p.tenant_id AND b.partner_id = p.id ${w} ORDER BY p.code LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)
    return { items: rows.map(toView), total, page, pageSize }
  }
}

function strip(v: PartnerView): Record<string, any> {
  const { arBalance: _a, apBalance: _b, ...rest } = v
  return rest
}
