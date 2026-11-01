import { AppError, FundState, assertScale, dec, fundAccountSchema, isDecimalString, isValidCalendarDate, planTransfer } from '@erp/shared'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Tx } from '../core/db'
import { uuidv7 } from '../core/ids'

export interface FundAccountView {
  id: string
  name: string
  type: string
  openingBalance: string
  balance: string
  enabled: boolean
  version: number
}
const toView = (r: any): FundAccountView => ({ id: r.id, name: r.name, type: r.type, openingBalance: r.opening_balance, balance: r.balance, enabled: r.enabled, version: r.version })

export class FundService {
  constructor(private audit: AuditService) {}

  private parse(input: unknown) {
    const r = fundAccountSchema.safeParse(input)
    if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', reason: i.message })))
    return r.data
  }

  private dup(e: unknown): unknown {
    if ((e as { code?: string }).code === '23505') return new AppError('VALIDATION_FAILED', '账户名称已存在', [{ field: 'name', reason: '账户名称已存在' }])
    return e
  }

  async createAccount(tx: Tx, ctx: Ctx, input: unknown): Promise<FundAccountView> {
    const v = this.parse(input)
    const id = uuidv7()
    try {
      await tx.query('INSERT INTO fund_account (id, tenant_id, name, type, opening_balance, balance) VALUES ($1,$2,$3,$4,$5,$5)', [id, ctx.tenantId, v.name, v.type, v.openingBalance])
    } catch (e) {
      throw this.dup(e)
    }
    const view = toView(await tx.one('SELECT * FROM fund_account WHERE id=$1', [id]))
    await this.audit.log(tx, ctx, 'fund_account.create', { type: 'fund_account', id, no: v.name, before: null, after: view })
    return view
  }

  /** 已被已审核单据引用(存在资金流水)后,期初余额不可修改(需求 17.12) */
  async updateAccount(tx: Tx, ctx: Ctx, id: string, input: unknown): Promise<FundAccountView> {
    const v = this.parse(input)
    const old = await tx.maybeOne('SELECT * FROM fund_account WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    if (Number(v.openingBalance) !== Number(old.opening_balance)) {
      const used = await tx.maybeOne('SELECT 1 FROM fund_ledger WHERE fund_account_id=$1 LIMIT 1', [id])
      if (used) throw new AppError('VALIDATION_FAILED', '该账户已被已审核单据引用,期初余额不可修改', [{ field: 'openingBalance', reason: '该账户已被已审核单据引用,期初余额不可修改' }])
    }
    try {
      await tx.query('UPDATE fund_account SET name=$2, type=$3, opening_balance=$4, balance = balance + ($4::numeric - $5::numeric), version=version+1 WHERE id=$1', [id, v.name, v.type, v.openingBalance, old.opening_balance])
    } catch (e) {
      throw this.dup(e)
    }
    const view = toView(await tx.one('SELECT * FROM fund_account WHERE id=$1', [id]))
    await this.audit.log(tx, ctx, 'fund_account.update', { type: 'fund_account', id, no: view.name, before: toView(old), after: view })
    return view
  }

  async setAccountEnabled(tx: Tx, ctx: Ctx, id: string, enabled: boolean): Promise<void> {
    const old = await tx.maybeOne('SELECT name, enabled FROM fund_account WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    await tx.query('UPDATE fund_account SET enabled=$2, version=version+1 WHERE id=$1', [id, enabled])
    await this.audit.log(tx, ctx, enabled ? 'fund_account.enable' : 'fund_account.disable', { type: 'fund_account', id, no: old.name, before: { enabled: old.enabled }, after: { enabled } })
  }

  /** 停用的账户不出现在新建单据的选择列表,但历史与余额仍可查询(需求 17.1) */
  async listAccounts(tx: Tx, f: { enabled?: boolean } = {}): Promise<FundAccountView[]> {
    const rows = f.enabled === undefined ? await tx.rows('SELECT * FROM fund_account ORDER BY name') : await tx.rows('SELECT * FROM fund_account WHERE enabled=$1 ORDER BY name', [f.enabled])
    return rows.map(toView)
  }

  /* ───────── 收支类别 ───────── */

  async createCategory(tx: Tx, ctx: Ctx, direction: 'in' | 'out', name: string) {
    name = (name ?? '').trim()
    if (!['in', 'out'].includes(direction)) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'direction', reason: '收支方向须为收入或支出' }])
    if (name.length < 1 || name.length > 30) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'name', reason: '类别名称为 1 至 30 个字符' }])
    const id = uuidv7()
    try {
      await tx.query('INSERT INTO fund_category (id, tenant_id, direction, name) VALUES ($1,$2,$3,$4)', [id, ctx.tenantId, direction, name])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VALIDATION_FAILED', '类别名称已存在', [{ field: 'name', reason: '同一收支方向内类别名称不能重复' }])
      throw e
    }
    await this.audit.log(tx, ctx, 'fund_category.create', { type: 'fund_category', id, no: name, before: null, after: { direction, name } })
    return { id, direction, name, enabled: true }
  }

  async updateCategory(tx: Tx, ctx: Ctx, id: string, patch: { name?: string; enabled?: boolean }) {
    const old = await tx.maybeOne('SELECT * FROM fund_category WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    const name = patch.name !== undefined ? patch.name.trim() : old.name
    if (name.length < 1 || name.length > 30) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'name', reason: '类别名称为 1 至 30 个字符' }])
    try {
      await tx.query('UPDATE fund_category SET name=$2, enabled=$3 WHERE id=$1', [id, name, patch.enabled ?? old.enabled])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VALIDATION_FAILED', '类别名称已存在', [{ field: 'name', reason: '同一收支方向内类别名称不能重复' }])
      throw e
    }
    await this.audit.log(tx, ctx, 'fund_category.update', { type: 'fund_category', id, no: name, before: { name: old.name, enabled: old.enabled }, after: { name, enabled: patch.enabled ?? old.enabled } })
  }

  async listCategories(tx: Tx, direction?: 'in' | 'out') {
    return direction
      ? tx.rows('SELECT id, direction, name, enabled FROM fund_category WHERE direction=$1 ORDER BY name', [direction])
      : tx.rows('SELECT id, direction, name, enabled FROM fund_category ORDER BY direction, name')
  }

  /* ───────── 资金转账(不走草稿与审核,一次提交即生效;需求 17.11) ───────── */

  async transfer(tx: Tx, ctx: Ctx, input: { fromAccountId: string; toAccountId: string; amount: string; transferDate: string; remark?: string }) {
    const issues: { field: string; reason: string }[] = []
    if (!isDecimalString(input.amount) || dec(input.amount).lt('0.01') || dec(input.amount).gt('999999999.99')) issues.push({ field: 'amount', reason: '金额须为 0.01 至 999,999,999.99' })
    else if (!assertScale(input.amount, 2)) issues.push({ field: 'amount', reason: '金额最多 2 位小数' })
    if (!isValidCalendarDate(input.transferDate)) issues.push({ field: 'transferDate', reason: '转账日期不合法' })
    if ((input.remark ?? '').length > 200) issues.push({ field: 'remark', reason: '备注不超过 200 个字符' })
    if (issues.length) throw new AppError('VALIDATION_FAILED', undefined, issues)
    if (input.fromAccountId === input.toAccountId) throw new AppError('FUND_TRANSFER_SAME_ACCOUNT')

    // 按 id 升序加锁,避免死锁;持有行锁后判断余额
    const ids = [input.fromAccountId, input.toAccountId].sort()
    const rows = await tx.rows('SELECT * FROM fund_account WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
    if (rows.length !== 2) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: 'fundAccountId', reason: '关联记录不存在' }])
    const funds = new Map<string, FundState>(rows.map((r) => [r.id, { balance: r.balance, enabled: r.enabled }]))
    const plan = planTransfer({ fromAccountId: input.fromAccountId, toAccountId: input.toAccountId, amount: input.amount }, funds)
    if ('rejected' in plan) throw new AppError(plan.code, plan.message, plan.details)

    const id = uuidv7()
    await tx.query('INSERT INTO fund_transfer (id, tenant_id, from_account_id, to_account_id, amount, transfer_date, remark, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      id,
      ctx.tenantId,
      input.fromAccountId,
      input.toAccountId,
      input.amount,
      input.transferDate,
      input.remark ?? '',
      ctx.tenantUserId,
    ])
    for (const e of plan.fundEntries) {
      await tx.query('INSERT INTO fund_ledger (id, tenant_id, fund_account_id, source, source_id, role, amount_delta) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uuidv7(), ctx.tenantId, e.fundAccountId, e.source, id, e.role, e.amountDelta.toFixed(2)])
      await tx.query('UPDATE fund_account SET balance = balance + $2 WHERE id=$1', [e.fundAccountId, e.amountDelta.toFixed(2)])
    }
    await this.audit.log(tx, ctx, 'fund_transfer.create', { type: 'fund_transfer', id, no: id, before: null, after: { from: input.fromAccountId, to: input.toAccountId, amount: input.amount, date: input.transferDate } })
    return { id }
  }
}
