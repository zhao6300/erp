import { AppError, brandingSchema } from '@erp/shared'
import { AuditService } from '../core/audit'
import type { Ctx } from '../core/context'
import type { Db, Tx } from '../core/db'
import type { FileService } from '../core/files.service'

export interface BrandingView {
  systemName: string
  logoFileId: string | null
  themeColor: string
  loginBgFileId: string | null
  copyright: string
  customDomain: string | null
  /** 每一项是否来自租户配置(其余为平台默认值;需求 5.4) */
  configured: Record<'systemName' | 'logo' | 'themeColor' | 'loginBg' | 'copyright', boolean>
}

export const DEFAULT_BRANDING = { systemName: 'Lite ERP', themeColor: '#1677FF', copyright: '', logoFileId: null, loginBgFileId: null } as const

const resolve = (r: any | null): BrandingView => ({
  systemName: r?.system_name || DEFAULT_BRANDING.systemName,
  logoFileId: r?.logo_file_id ?? null,
  themeColor: r?.theme_color || DEFAULT_BRANDING.themeColor,
  loginBgFileId: r?.login_bg_file_id ?? null,
  copyright: r?.copyright ?? DEFAULT_BRANDING.copyright,
  customDomain: r?.custom_domain ?? null,
  configured: { systemName: !!r?.system_name, logo: !!r?.logo_file_id, themeColor: !!r?.theme_color, loginBg: !!r?.login_bg_file_id, copyright: !!r?.copyright },
})

export class BrandingService {
  constructor(
    private db: Db,
    private files: FileService,
    private audit: AuditService,
  ) {}

  async get(tx: Tx): Promise<BrandingView> {
    return resolve(await tx.maybeOne('SELECT * FROM branding_config'))
  }

  /** 公开接口:按请求 Host 查找;未命中返回平台默认值(需求 5.3、5.9) */
  async byHost(host: string): Promise<BrandingView & { tenantId: string | null }> {
    const h = host.toLowerCase().replace(/:\d+$/, '')
    return this.db.withPlatform(async (tx) => {
      const r = await tx.maybeOne('SELECT * FROM branding_config WHERE lower(custom_domain) = $1', [h])
      return { ...resolve(r), tenantId: r?.tenant_id ?? null }
    })
  }

  /** Caddy on-demand TLS 的 ask 端点:只放行已保存在 Branding_Config 中的域名 */
  async isRegisteredDomain(domain: string): Promise<boolean> {
    const h = domain.toLowerCase()
    return this.db.withPlatform(async (tx) => !!(await tx.maybeOne('SELECT 1 FROM branding_config WHERE lower(custom_domain) = $1', [h])))
  }

  /** 上传 Logo/背景图:PNG/JPG/SVG,≤ 2 MB;失败时保留原图(需求 5.5) */
  async uploadImage(tx: Tx, ctx: Ctx, data: Buffer) {
    if (!ctx.isTenantAdmin) throw new AppError('NO_PERMISSION')
    return this.files.uploadImage(tx, ctx.tenantId, data, { ownerType: 'branding', createdBy: ctx.tenantUserId })
  }

  /** 整份校验,任一项不合规则不保存,保留原配置(需求 5.7、5.8) */
  async save(tx: Tx, ctx: Pick<Ctx, 'tenantId' | 'isTenantAdmin' | 'tenantUserId' | 'name' | 'client' | 'actorType' | 'ip'>, tenantId: string, input: unknown, asPlatform = false): Promise<BrandingView> {
    if (!ctx.isTenantAdmin && !asPlatform) throw new AppError('NO_PERMISSION', '无权限修改品牌配置')
    const r = brandingSchema.safeParse(input)
    if (!r.success) throw new AppError('VALIDATION_FAILED', undefined, r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', reason: i.message })))
    const v = r.data
    for (const [f, id] of [['logoFileId', v.logoFileId], ['loginBgFileId', v.loginBgFileId]] as const) {
      if (id) {
        const a = await tx.maybeOne('SELECT mime FROM attachment WHERE tenant_id=$1 AND id=$2', [tenantId, id])
        if (!a || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(a.mime)) throw new AppError('RELATION_NOT_FOUND', undefined, [{ field: f, reason: '图片不存在' }])
      }
    }
    const before = await tx.maybeOne('SELECT * FROM branding_config WHERE tenant_id=$1', [tenantId])
    try {
      await tx.query(
        `INSERT INTO branding_config (tenant_id, system_name, logo_file_id, theme_color, login_bg_file_id, copyright, custom_domain) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id) DO UPDATE SET system_name=$2, logo_file_id=$3, theme_color=$4, login_bg_file_id=$5, copyright=$6, custom_domain=$7`,
        [tenantId, v.systemName, v.logoFileId ?? null, v.themeColor ?? null, v.loginBgFileId ?? null, v.copyright ?? '', v.customDomain?.toLowerCase() ?? null],
      )
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('VALIDATION_FAILED', '自定义域名已被其他租户使用', [{ field: 'customDomain', reason: '自定义域名已被其他租户使用' }])
      throw e
    }
    const after = await tx.one('SELECT * FROM branding_config WHERE tenant_id=$1', [tenantId])
    await this.audit.write(tx, {
      tenantId,
      actorId: ctx.tenantUserId,
      actorType: ctx.actorType,
      actorName: ctx.name,
      client: ctx.client,
      ip: ctx.ip,
      action: 'branding.update',
      objectType: 'branding',
      objectId: tenantId,
      before: before ?? null,
      after,
    })
    return resolve(after)
  }
}
