import { AppError } from '@erp/shared'
import type { CustomFieldService } from '../config/customFields.service'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Tx } from '../core/db'
import { uuidv7 } from '../core/ids'
import type { LicenseService } from '../core/license.service'

export interface WarehouseView {
  id: string
  code: string
  name: string
  enabled: boolean
  custom: Record<string, unknown>
  version: number
}
const toView = (r: any): WarehouseView => ({ id: r.id, code: r.code, name: r.name, enabled: r.enabled, custom: r.custom, version: r.version })

export class WarehouseService {
  constructor(
    private license: LicenseService,
    private cf: CustomFieldService,
    private audit: AuditService,
  ) {}

  private check(code: unknown, name: unknown) {
    const issues: { field: string; reason: string }[] = []
    if (typeof code !== 'string' || code.trim().length < 1 || code.trim().length > 32) issues.push({ field: 'code', reason: '仓库编码为 1 至 32 个字符' })
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50) issues.push({ field: 'name', reason: '仓库名称为 1 至 50 个字符' })
    if (issues.length) throw new AppError('VALIDATION_FAILED', undefined, issues)
  }

  /** 新建仓库前校验 License 仓库数上限(需求 3.3) */
  async create(tx: Tx, ctx: Ctx, input: { code: string; name: string; custom?: Record<string, unknown> }): Promise<WarehouseView> {
    this.check(input.code, input.name)
    await this.license.assertCanActivate(tx, ctx.tenantId, 'warehouses')
    const custom = await this.cf.validateNew(tx, 'warehouse', input.custom)
    const id = uuidv7()
    try {
      await tx.query('INSERT INTO warehouse (id, tenant_id, code, name, custom) VALUES ($1,$2,$3,$4,$5)', [id, ctx.tenantId, input.code.trim(), input.name.trim(), JSON.stringify(custom)])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VALIDATION_FAILED', '编码重复', [{ field: 'code', reason: '编码重复' }])
      throw e
    }
    const v = toView(await tx.one('SELECT * FROM warehouse WHERE id=$1', [id]))
    await this.audit.log(tx, ctx, 'warehouse.create', { type: 'warehouse', id, no: v.code, before: null, after: v })
    return v
  }

  async update(tx: Tx, ctx: Ctx, id: string, input: { code: string; name: string; custom?: Record<string, unknown> }): Promise<WarehouseView> {
    this.check(input.code, input.name)
    const old = await tx.maybeOne('SELECT * FROM warehouse WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    const custom = await this.cf.validateAndMerge(tx, 'warehouse', old.custom, input.custom)
    try {
      await tx.query('UPDATE warehouse SET code=$2, name=$3, custom=$4, version=version+1 WHERE id=$1', [id, input.code.trim(), input.name.trim(), JSON.stringify(custom)])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VALIDATION_FAILED', '编码重复', [{ field: 'code', reason: '编码重复' }])
      throw e
    }
    const v = toView(await tx.one('SELECT * FROM warehouse WHERE id=$1', [id]))
    await this.audit.log(tx, ctx, 'warehouse.update', { type: 'warehouse', id, no: v.code, before: toView(old), after: v })
    return v
  }

  /** 重新启用同样受仓库数上限约束(需求 3.3) */
  async setEnabled(tx: Tx, ctx: Ctx, id: string, enabled: boolean): Promise<void> {
    const old = await tx.maybeOne('SELECT code, enabled FROM warehouse WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    if (enabled && !old.enabled) await this.license.assertCanActivate(tx, ctx.tenantId, 'warehouses')
    await tx.query('UPDATE warehouse SET enabled=$2, version=version+1 WHERE id=$1', [id, enabled])
    await this.audit.log(tx, ctx, enabled ? 'warehouse.enable' : 'warehouse.disable', { type: 'warehouse', id, no: old.code, before: { enabled: old.enabled }, after: { enabled } })
  }

  async list(tx: Tx, f: { enabled?: boolean } = {}): Promise<WarehouseView[]> {
    const rows = f.enabled === undefined ? await tx.rows('SELECT * FROM warehouse ORDER BY code') : await tx.rows('SELECT * FROM warehouse WHERE enabled=$1 ORDER BY code', [f.enabled])
    return rows.map(toView)
  }
}
