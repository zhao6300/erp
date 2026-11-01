import {
  AppError,
  ConfigBranding,
  ConfigCategory,
  ConfigFieldDef,
  ImageAsset,
  MODULE_CODES,
  ModuleCode,
  ObjectType,
  PreviewItem,
  SkippedItem,
  TenantConfig,
  diffConfig,
  emptyConfig,
  exportNotices,
  mergeConfig,
  normalizeConfig,
  parseConfigPackage,
  serializeConfigPackage,
} from '@erp/shared'
import { AuditService } from '../core/audit'
import type { ConfigCache } from '../core/cache'
import type { Tx } from '../core/db'
import { FileService, sniffImage } from '../core/files.service'
import { uuidv7 } from '../core/ids'

export interface ApplyResult {
  added: number
  overwritten: number
  skipped: SkippedItem[]
}

/** 业务对象 → 存放其 custom 值的表与过滤条件(判断"已有业务数据") */
const CUSTOM_TABLE: Record<ObjectType, string> = {
  product: `product`,
  customer: `partner WHERE kind IN ('customer','both')`,
  supplier: `partner WHERE kind IN ('supplier','both')`,
  warehouse: `warehouse`,
  purchase_doc: `document WHERE doc_type IN ('purchase_order','purchase_in','purchase_return')`,
  sales_doc: `document WHERE doc_type IN ('sales_order','sales_out','sales_return')`,
}

export class ConfigPackageService {
  constructor(
    private files: FileService,
    private audit: AuditService,
    private cache?: ConfigCache,
  ) {}

  /* ───────── 导出 ───────── */

  /** 读取租户当前配置。所有查询显式带 tenant_id,平台连接与租户连接均可使用 */
  async load(tx: Tx, tenantId: string): Promise<TenantConfig> {
    const cfg = emptyConfig()
    cfg.modules = (await tx.rows('SELECT module, enabled FROM tenant_module WHERE tenant_id=$1', [tenantId])).map((r) => ({ code: r.module as ModuleCode, enabled: r.enabled }))
    cfg.customFields = (await tx.rows('SELECT * FROM custom_field_def WHERE tenant_id=$1', [tenantId])).map(
      (r): ConfigFieldDef => ({
        objectType: r.object_type,
        code: r.code,
        label: r.label,
        type: r.field_type,
        required: r.required,
        defaultValue: r.default_value ?? undefined,
        options: r.options ?? undefined,
        displayOrder: r.display_order,
        showInList: r.show_in_list,
        filterable: r.filterable,
        enabled: r.enabled,
      }),
    )
    const s = await tx.one('SELECT * FROM tenant_settings WHERE tenant_id=$1', [tenantId])
    cfg.settings = {
      qtyScale: s.qty_scale,
      priceScale: s.price_scale,
      amountScale: s.amount_scale,
      allowNegativeStock: s.allow_negative_stock,
      requireAudit: s.require_audit,
      multiUnit: s.multi_unit,
      multiSku: s.multi_sku,
      barcodeEnabled: s.barcode_enabled,
    }
    cfg.numberingRules = (await tx.rows('SELECT * FROM numbering_rule WHERE tenant_id=$1', [tenantId])).map((r) => ({ docType: r.doc_type, prefix: r.prefix, dateFormat: r.date_format, seqDigits: r.seq_digits, reset: r.reset_cycle }))
    // 预置角色模板每个租户都有,不进入配置包;导出的是租户自建角色
    cfg.roleTemplates = (await tx.rows('SELECT name, permissions, data_scope FROM role WHERE tenant_id=$1 AND NOT is_template', [tenantId])).map((r) => ({ name: r.name, permissions: r.permissions, dataScope: r.data_scope }))
    cfg.printTemplates = (await tx.rows('SELECT doc_type, name, paper, layout, is_default FROM print_template WHERE tenant_id=$1', [tenantId])).map((r) => ({ docType: r.doc_type, name: r.name, paper: r.paper, layout: r.layout, isDefault: r.is_default }))
    const b = await tx.maybeOne('SELECT * FROM branding_config WHERE tenant_id=$1', [tenantId])
    if (b) {
      const branding: ConfigBranding = {}
      if (b.system_name) branding.systemName = b.system_name
      if (b.theme_color) branding.themeColor = b.theme_color
      if (b.copyright) branding.copyright = b.copyright
      // 图片内嵌为 base64,导入时不依赖任何外部文件(需求 8.1)
      if (b.logo_file_id) branding.logo = await this.embed(tx, tenantId, b.logo_file_id)
      if (b.login_bg_file_id) branding.loginBg = await this.embed(tx, tenantId, b.login_bg_file_id)
      cfg.branding = branding
    }
    return normalizeConfig(cfg)
  }

  private async embed(tx: Tx, tenantId: string, fileId: string): Promise<ImageAsset | null> {
    const a = await tx.maybeOne('SELECT object_key, mime FROM attachment WHERE tenant_id=$1 AND id=$2', [tenantId, fileId])
    if (!a) return null
    const { data, mime } = await this.files.readByKey(a.object_key, a.mime)
    return { mime: mime as ImageAsset['mime'], base64: data.toString('base64') }
  }

  async export(tx: Tx, tenantId: string, now = new Date()): Promise<{ text: string; notices: string[] }> {
    const cfg = await this.load(tx, tenantId)
    return { text: serializeConfigPackage(cfg, now.toISOString()), notices: exportNotices(await this.rawRoles(tx, tenantId)) }
  }

  private async rawRoles(tx: Tx, tenantId: string) {
    return { roleTemplates: (await tx.rows('SELECT name, data_scope FROM role WHERE tenant_id=$1 AND NOT is_template', [tenantId])).map((r) => ({ name: r.name, dataScope: r.data_scope })) }
  }

  /* ───────── 预览 ───────── */

  private parse(text: string): TenantConfig {
    const r = parseConfigPackage(text)
    if (!r.ok) {
      throw new AppError('CONFIG_PACKAGE_INVALID', `配置包无效:${r.issues.map((i) => `${i.path}(第 ${i.line} 行)${i.reason}`).join(';')}`, r.issues.map((i) => ({ field: i.path, row: i.line, reason: i.reason })))
    }
    return r.config
  }

  /** 预览清单:逐项列出类别、标识、新增或覆盖;在确认前不修改任何配置(需求 8.3) */
  async preview(tx: Tx, tenantId: string, text: string, licensed: ModuleCode[]): Promise<{ items: PreviewItem[]; skipped: SkippedItem[] }> {
    const pkg = this.parse(text)
    const current = await this.load(tx, tenantId)
    const fieldHasData = await this.dataMap(tx, tenantId, current, pkg)
    const { skipped } = mergeConfig(current, pkg, { modules: licensed }, { fieldHasData: (o, c) => fieldHasData.has(`${o}.${c}`) })
    return { items: diffConfig(current, pkg), skipped }
  }

  /** 类型冲突且已有业务数据的自定义字段(需求 8.10)。预先异步计算,供同步的 mergeConfig 使用 */
  private async dataMap(tx: Tx, tenantId: string, current: TenantConfig, pkg: TenantConfig): Promise<Set<string>> {
    const out = new Set<string>()
    for (const f of pkg.customFields) {
      const old = current.customFields.find((x) => x.objectType === f.objectType && x.code === f.code)
      if (!old || old.type === f.type) continue
      const table = CUSTOM_TABLE[f.objectType]
      const glue = table.includes(' WHERE ') ? ' AND ' : ' WHERE '
      const hit = await tx.maybeOne(`SELECT 1 FROM ${table}${glue}tenant_id = $1 AND custom ? $2 LIMIT 1`, [tenantId, f.code])
      if (hit) out.add(`${f.objectType}.${f.code}`)
    }
    return out
  }

  /* ───────── 应用 ───────── */

  /**
   * 确认导入:在传入的单个事务内写入,任一配置项失败即抛出 CONFIG_PACKAGE_APPLY_FAILED,
   * 调用方的事务随之整体回滚(需求 8.8、8.9)。
   */
  async apply(tx: Tx, tenantId: string, text: string, licensed: ModuleCode[], actor?: { id?: string | null; name?: string | null; type: 'user' | 'platform' }): Promise<ApplyResult> {
    const pkg = this.parse(text)
    const current = await this.load(tx, tenantId)
    const fieldHasData = await this.dataMap(tx, tenantId, current, pkg)
    const { cfg, skipped } = mergeConfig(current, pkg, { modules: licensed }, { fieldHasData: (o, c) => fieldHasData.has(`${o}.${c}`) })
    const preview = diffConfig(current, pkg)
    await this.write(tx, tenantId, cfg, current, skipped)
    // 提交后失效业务参数、模块、自定义字段缓存,使配置在下一次请求起生效
    tx.onCommit(async () => {
      if (!this.cache) return
      for (const k of ['set:', 'mod:', 'cf:', 'lic:']) await this.cache.invalidate(`${k}${tenantId}`)
    })
    // 被跳过的项不计入新增/覆盖
    const skippedKeys = new Set(skipped.map((s) => `${s.category}:${s.key}`))
    const counted = preview.filter((i) => !skippedKeys.has(`${i.category}:${i.key}`))
    const result: ApplyResult = { added: counted.filter((i) => i.action === 'add').length, overwritten: counted.filter((i) => i.action === 'overwrite').length, skipped }
    await this.audit.write(tx, { tenantId, actorId: actor?.id ?? null, actorType: actor?.type ?? 'platform', actorName: actor?.name ?? null, action: 'config_package.apply', objectType: 'config_package', detail: { added: result.added, overwritten: result.overwritten, skipped: result.skipped } })
    return result
  }

  private async step<T>(category: ConfigCategory, key: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFIG_PACKAGE_APPLY_FAILED') throw e
      throw new AppError('CONFIG_PACKAGE_APPLY_FAILED', `应用配置包失败(${category} ${key}):${(e as Error).message},已整体回滚`, [{ field: `${category}:${key}`, reason: (e as Error).message }])
    }
  }

  private async write(tx: Tx, tenantId: string, cfg: TenantConfig, current: TenantConfig, skipped: SkippedItem[]): Promise<void> {
    const skip = new Set(skipped.map((s) => `${s.category}:${s.key}`))

    for (const m of cfg.modules) {
      if (!(MODULE_CODES as readonly string[]).includes(m.code)) continue
      await this.step('module', m.code, () => tx.query(`INSERT INTO tenant_module (tenant_id, module, enabled) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled=$3`, [tenantId, m.code, m.enabled]))
    }

    for (const f of cfg.customFields) {
      if (skip.has(`customField:${f.objectType}.${f.code}`)) continue
      const old = current.customFields.find((x) => x.objectType === f.objectType && x.code === f.code)
      if (old && JSON.stringify(old) === JSON.stringify(f)) continue
      await this.step('customField', `${f.objectType}.${f.code}`, () =>
        tx.query(
          `INSERT INTO custom_field_def (id, tenant_id, object_type, code, label, field_type, required, default_value, options, display_order, show_in_list, filterable, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (tenant_id, object_type, lower(code)) DO UPDATE SET label=$5, field_type=$6, required=$7, default_value=$8, options=$9, display_order=$10, show_in_list=$11, filterable=$12, enabled=$13`,
          [uuidv7(), tenantId, f.objectType, f.code, f.label, f.type, f.required, f.defaultValue === undefined ? null : JSON.stringify(f.defaultValue), f.options ?? null, f.displayOrder, f.showInList, f.filterable, f.enabled],
        ),
      )
    }

    await this.step('settings', 'settings', () =>
      tx.query(
        `UPDATE tenant_settings SET qty_scale=$2, price_scale=$3, amount_scale=$4, allow_negative_stock=$5, require_audit=$6, multi_unit=$7, multi_sku=$8, barcode_enabled=$9 WHERE tenant_id=$1`,
        [tenantId, cfg.settings.qtyScale, cfg.settings.priceScale, cfg.settings.amountScale, cfg.settings.allowNegativeStock, cfg.settings.requireAudit, cfg.settings.multiUnit, cfg.settings.multiSku, cfg.settings.barcodeEnabled],
      ),
    )

    // 编号规则只写规则本身,不触碰 number_sequence 的当前流水号(需求 8.2)
    for (const r of cfg.numberingRules) {
      await this.step('numberingRule', r.docType, () =>
        tx.query(
          `INSERT INTO numbering_rule (tenant_id, doc_type, prefix, date_format, seq_digits, reset_cycle) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, doc_type) DO UPDATE SET prefix=$3, date_format=$4, seq_digits=$5, reset_cycle=$6`,
          [tenantId, r.docType, r.prefix, r.dateFormat, r.seqDigits, r.reset],
        ),
      )
    }

    for (const r of cfg.roleTemplates) {
      await this.step('role', r.name, async () => {
        const ex = await tx.maybeOne('SELECT is_template FROM role WHERE tenant_id=$1 AND name=$2', [tenantId, r.name])
        if (ex?.is_template) throw new Error('与系统预置角色模板重名')
        await tx.query(
          `INSERT INTO role (id, tenant_id, name, permissions, data_scope) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, name) DO UPDATE SET permissions=$4, data_scope=$5, version=role.version+1`,
          [uuidv7(), tenantId, r.name, r.permissions, JSON.stringify(r.dataScope)],
        )
      })
    }

    // 打印模板:先清除相关类型的默认标记,再写入(部分唯一索引要求每类型至多一个默认)
    const docTypes = [...new Set(cfg.printTemplates.map((p) => p.docType))]
    if (docTypes.length) await tx.query('UPDATE print_template SET is_default=false WHERE tenant_id=$1 AND doc_type = ANY($2)', [tenantId, docTypes])
    for (const p of cfg.printTemplates) {
      await this.step('printTemplate', `${p.docType}.${p.name}`, () =>
        tx.query(
          `INSERT INTO print_template (id, tenant_id, doc_type, name, paper, layout, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, doc_type, name) DO UPDATE SET paper=$5, layout=$6, is_default=$7, version=print_template.version+1`,
          [uuidv7(), tenantId, p.docType, p.name, p.paper, JSON.stringify(p.layout), p.isDefault],
        ),
      )
    }

    if (cfg.branding && JSON.stringify(cfg.branding) !== JSON.stringify(current.branding)) {
      await this.step('branding', 'branding', async () => {
        const b = cfg.branding!
        let logoId: string | null | undefined
        let bgId: string | null | undefined
        if (b.logo) logoId = await this.storeImage(tx, tenantId, b.logo)
        if (b.loginBg) bgId = await this.storeImage(tx, tenantId, b.loginBg)
        // 自定义域名不进入配置包(全局唯一、与租户绑定),保留目标租户原值
        await tx.query(
          `INSERT INTO branding_config (tenant_id, system_name, logo_file_id, theme_color, login_bg_file_id, copyright) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id) DO UPDATE SET system_name=COALESCE($2, branding_config.system_name), logo_file_id=COALESCE($3, branding_config.logo_file_id),
             theme_color=COALESCE($4, branding_config.theme_color), login_bg_file_id=COALESCE($5, branding_config.login_bg_file_id), copyright=COALESCE($6, branding_config.copyright)`,
          [tenantId, b.systemName ?? null, logoId ?? null, b.themeColor ?? null, bgId ?? null, b.copyright ?? null],
        )
      })
    }
  }

  private async storeImage(tx: Tx, tenantId: string, a: ImageAsset): Promise<string> {
    const buf = Buffer.from(a.base64, 'base64')
    if (!sniffImage(buf)) throw new Error('内嵌图片格式无效')
    return (await this.files.uploadImage(tx, tenantId, buf, { ownerType: 'branding' })).id
  }
}
