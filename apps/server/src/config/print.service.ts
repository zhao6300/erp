import {
  AppError,
  DOC_TYPES,
  DOC_STATUS_LABEL,
  DocType,
  PAPERS,
  PaperCode,
  PrintData,
  PrintLayout,
  defaultPrintLayout,
  dec,
  max0,
  maskFields,
  paginate,
  renderPrintHtml,
  validatePrintTemplate,
  visibilityOf,
  FieldDef,
  FieldValue,
  decodeFieldValue,
  fixed,
} from '@erp/shared'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import { uuidv7 } from '../core/ids'
import type { CustomFieldService } from './customFields.service'
import type { SettingsService } from './settings.service'
import { DOC_META } from '../docs/document.model'
import { mustLoadDoc } from '../docs/document.repo'

export interface PrintTemplateRow {
  id: string
  docType: DocType
  name: string
  paper: PaperCode
  layout: PrintLayout
  isDefault: boolean
  isBuiltin: boolean
  version: number
}
const toRow = (r: any): PrintTemplateRow => ({ id: r.id, docType: r.doc_type, name: r.name, paper: r.paper, layout: r.layout, isDefault: r.is_default, isBuiltin: r.is_builtin, version: r.version })

export class PrintService {
  constructor(
    private db: Db,
    private settings: SettingsService,
    private cf: CustomFieldService,
    private audit: AuditService,
  ) {}

  /** 每种单据类型一个内置默认模板(需求 20.1) */
  async seedDefaults(tx: Tx, tenantId: string): Promise<void> {
    for (const t of DOC_TYPES) {
      await tx.query(`INSERT INTO print_template (id, tenant_id, doc_type, name, paper, layout, is_default, is_builtin) VALUES ($1,$2,$3,'默认模板','A4',$4,true,true)`, [uuidv7(), tenantId, t, JSON.stringify(defaultPrintLayout(t))])
    }
  }

  async list(tx: Tx, docType?: DocType): Promise<PrintTemplateRow[]> {
    const rows = docType ? await tx.rows('SELECT * FROM print_template WHERE doc_type=$1 ORDER BY is_default DESC, name', [docType]) : await tx.rows('SELECT * FROM print_template ORDER BY doc_type, is_default DESC, name')
    return rows.map(toRow)
  }

  async get(tx: Tx, id: string): Promise<PrintTemplateRow> {
    const r = await tx.maybeOne('SELECT * FROM print_template WHERE id=$1', [id])
    if (!r) throw new AppError('NOT_FOUND')
    return toRow(r)
  }

  /** 校验占位符:只允许当前单据类型可用集合(启用的 Custom_Field 计入),列出全部无效项(需求 20.3、20.5) */
  private async validate(tx: Tx, docType: DocType, paper: PaperCode, layout: PrintLayout) {
    if (!(PAPERS as Record<string, unknown>)[paper]) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'paper', reason: '不支持的纸张规格' }])
    const obj = DOC_META[docType].objectType
    const defs = obj ? await this.cf.enabledDefs(tx, obj) : []
    const r = validatePrintTemplate({ paper, layout }, docType, defs)
    if (r.issues.length) {
      throw new AppError('VALIDATION_FAILED', r.issues.map((i) => i.reason).join(';'), [...r.issues.map((i) => ({ field: i.field, reason: i.reason })), ...r.invalidPlaceholders.map((p) => ({ field: 'placeholders', reason: `无效占位符:${p}`, placeholder: p }))])
    }
  }

  async create(tx: Tx, ctx: Ctx, input: { docType: DocType; name: string; paper: PaperCode; layout: PrintLayout }): Promise<PrintTemplateRow> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    if (!input.name?.trim() || input.name.length > 50) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'name', reason: '模板名称为 1 至 50 个字符' }])
    await this.validate(tx, input.docType, input.paper, input.layout)
    const id = uuidv7()
    try {
      await tx.query('INSERT INTO print_template (id, tenant_id, doc_type, name, paper, layout) VALUES ($1,$2,$3,$4,$5,$6)', [id, ctx.tenantId, input.docType, input.name.trim(), input.paper, JSON.stringify(input.layout)])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VALIDATION_FAILED', '模板名称已存在', [{ field: 'name', reason: '同一单据类型下模板名称不能重复' }])
      throw e
    }
    await this.audit.log(tx, ctx, 'print_template.create', { type: 'print_template', id, no: input.name, before: null, after: { docType: input.docType, name: input.name, paper: input.paper } })
    return this.get(tx, id)
  }

  /** 保存后下一次打印即使用新版式;校验失败保持此前已保存版本不变(需求 20.4、20.5) */
  async update(tx: Tx, ctx: Ctx, id: string, input: { name?: string; paper: PaperCode; layout: PrintLayout }): Promise<PrintTemplateRow> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const old = await tx.maybeOne('SELECT * FROM print_template WHERE id=$1 FOR UPDATE', [id])
    if (!old) throw new AppError('NOT_FOUND')
    await this.validate(tx, old.doc_type, input.paper, input.layout)
    await tx.query('UPDATE print_template SET name=COALESCE($2,name), paper=$3, layout=$4, version=version+1 WHERE id=$1', [id, input.name?.trim() ?? null, input.paper, JSON.stringify(input.layout)])
    await this.audit.log(tx, ctx, 'print_template.update', { type: 'print_template', id, no: old.name, before: { paper: old.paper, layout: old.layout }, after: { paper: input.paper, layout: input.layout } })
    return this.get(tx, id)
  }

  /** 设为默认:同事务内取消原默认,保证每种类型有且仅有一个默认(需求 20.9) */
  async setDefault(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const t = await tx.maybeOne('SELECT doc_type, name FROM print_template WHERE id=$1', [id])
    if (!t) throw new AppError('NOT_FOUND')
    await tx.query('UPDATE print_template SET is_default=false WHERE doc_type=$1 AND is_default', [t.doc_type])
    await tx.query('UPDATE print_template SET is_default=true WHERE id=$1', [id])
    await this.audit.log(tx, ctx, 'print_template.set_default', { type: 'print_template', id, no: t.name })
  }

  /** 禁止删除默认模板与某类型的最后一个模板(需求 20.1) */
  async delete(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    const t = await tx.maybeOne('SELECT doc_type, name, is_default FROM print_template WHERE id=$1 FOR UPDATE', [id])
    if (!t) throw new AppError('NOT_FOUND')
    const cnt = (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM print_template WHERE doc_type=$1', [t.doc_type])).n
    if (t.is_default || cnt <= 1) throw new AppError('VALIDATION_FAILED', '不能删除默认模板或该单据类型下的最后一个模板,请先另设默认模板', [{ field: 'id', reason: '须先保留或另设默认模板' }])
    await tx.query('DELETE FROM print_template WHERE id=$1', [id])
    await this.audit.log(tx, ctx, 'print_template.delete', { type: 'print_template', id, no: t.name })
  }

  /* ───────── 渲染 ───────── */

  /** 构建打印数据:已脱敏、按精度格式化、空值为空串、停用字段为空串(需求 20.6、20.10) */
  async buildData(tx: Tx, ctx: Ctx, docId: string): Promise<{ data: PrintData; docType: DocType }> {
    const doc = await mustLoadDoc(tx, docId)
    const s = await this.settings.read(tx)
    const names = async (table: string, id: string | null, col = 'name') => (id ? ((await tx.maybeOne(`SELECT ${col} AS v FROM ${table} WHERE id=$1`, [id]))?.v ?? '') : '')
    const tenant = await tx.maybeOne('SELECT name FROM tenant WHERE id=$1', [ctx.tenantId])
    const sc = s.scales
    const total = doc.totalAmount
    const header: Record<string, string> = {
      docNo: doc.docNo,
      docDate: doc.docDate,
      status: DOC_STATUS_LABEL[doc.status],
      partnerName: await names('partner', doc.partnerId),
      handlerName: await names('tenant_user', doc.handlerId),
      createdByName: await names('tenant_user', doc.createdBy),
      remark: doc.remark,
      warehouseName: await names('warehouse', doc.warehouseId),
      toWarehouseName: await names('warehouse', doc.toWarehouseId),
      totalAmount: fixed(total, sc.amountScale),
      docDiscount: fixed(doc.docDiscount, sc.amountScale),
      paidAmount: fixed(doc.paidAmount, sc.amountScale),
      receivableAmount: fixed(max0(dec(total).minus(doc.paidAmount)), sc.amountScale),
      payableAmount: fixed(max0(dec(total).minus(doc.paidAmount)), sc.amountScale),
      fundAccountName: await names('fund_account', doc.fundAccountId),
      categoryName: await names('fund_category', doc.fundCategoryId),
      upstreamNo: doc.upstreamId ? await names('document', doc.upstreamId, 'doc_no') : '',
      printTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
      grossProfit: doc.grossProfit === null ? '' : fixed(doc.grossProfit, sc.amountScale),
    }
    const whNames = new Map((await tx.rows('SELECT id, name FROM warehouse')).map((w) => [w.id, w.name]))
    const barcodes = new Map((await tx.rows('SELECT id, barcode FROM sku WHERE id = ANY($1::uuid[])', [doc.lines.map((l) => l.skuId)])).map((x) => [x.id, x.barcode]))
    const lines = doc.lines.map((l) => ({
      lineNo: String(l.lineNo),
      skuCode: l.skuCode ?? '',
      productName: l.productName ?? '',
      spec: l.spec ?? '',
      unitName: l.unitName ?? '',
      qty: doc.docType === 'stocktake' ? '' : fixed(l.qty, sc.qtyScale),
      price: fixed(l.price, sc.priceScale),
      discountRate: fixed(l.discountRate, 2),
      amount: fixed(l.amount, sc.amountScale),
      warehouseName: whNames.get(l.warehouseId ?? '') ?? '',
      barcode: barcodes.get(l.skuId) ?? '',
      costPrice: l.costPrice === null ? '' : fixed(l.costPrice, sc.priceScale),
      lineProfit: l.lineProfit === null ? '' : fixed(l.lineProfit, sc.amountScale),
      snapshotQty: l.snapshotQty === null ? '' : fixed(l.snapshotQty, sc.qtyScale),
      countedQty: l.countedQty === null ? '' : fixed(l.countedQty, sc.qtyScale),
      diffQty: l.countedQty === null || l.snapshotQty === null ? '' : fixed(dec(l.countedQty).minus(l.snapshotQty), sc.qtyScale),
    }))
    // 无权限的敏感字段从打印数据中去除,占位符输出为空白(需求 10.4、10.11)
    const vis = visibilityOf(ctx.perms)
    const safeHeader = maskFields(header, vis)
    const safeLines = maskFields(lines, vis)

    // Custom_Field:仅启用字段,停用字段输出空白(需求 20.10)
    const custom: Record<string, string> = {}
    const obj = DOC_META[doc.docType].objectType
    if (obj) {
      const defs = await this.cf.enabledDefs(tx, obj)
      for (const d of defs) custom[d.code] = formatCustom(d, doc.custom[d.code])
    }
    return { data: { header: safeHeader, lines: safeLines, custom, tenantName: tenant?.name ?? '' }, docType: doc.docType }
  }

  /** HTML 渲染(浏览器打印与 PDF 共用同一份排版结果) */
  async renderHtml(ctx: Ctx, docId: string, templateId?: string): Promise<{ html: string; pages: number; paper: PaperCode }> {
    return this.db.withTenant(
      ctx.tenantId,
      async (tx) => {
        const { data, docType } = await this.buildData(tx, ctx, docId)
        const t = templateId ? await this.get(tx, templateId) : toRow(await tx.one('SELECT * FROM print_template WHERE doc_type=$1 AND is_default', [docType]))
        if (t.docType !== docType) throw new AppError('VALIDATION_FAILED', undefined, [{ field: 'templateId', reason: '模板与单据类型不匹配' }])
        const html = renderPrintHtml({ paper: t.paper, layout: t.layout }, data)
        return { html, pages: paginate({ paper: t.paper, layout: t.layout }, data.lines.length).length, paper: t.paper }
      },
      { readOnly: true },
    )
  }
}

function formatCustom(d: FieldDef, v: unknown): string {
  if (v === undefined || v === null) return ''
  const val = decodeFieldValue(d, v) as FieldValue
  if (Array.isArray(val)) return val.join('、')
  if (typeof val === 'boolean') return val ? '是' : '否'
  return String(val)
}

