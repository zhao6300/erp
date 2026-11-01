import { BrandingService } from './config/branding.service'
import { CustomFieldService } from './config/customFields.service'
import { ConfigPackageService } from './config/packages.service'
import { PrintService } from './config/print.service'
import { PrintRenderer } from './config/print-renderer'
import { NumberingService, SettingsService } from './config/settings.service'
import type { AppConfig } from './config'
import { AuditService } from './core/audit'
import { AuthService, HttpWechatClient, WechatClient } from './core/auth/auth.service'
import { UserService } from './core/auth/user.service'
import { ConfigCache } from './core/cache'
import { Db, createPool } from './core/db'
import { EventService, PluginRegistry } from './core/events'
import { FileService, LocalDiskStorage, StorageDriver } from './core/files.service'
import { Kv, MemoryKv, createRedisKv } from './core/kv'
import { LicenseService } from './core/license.service'
import { ModuleService } from './core/module.service'
import { PermissionService } from './core/permission/permission.service'
import { Clock, systemClock } from './core/time'
import { DocumentService } from './docs/document.service'
import { InventoryService } from './docs/inventory.service'
import { PostingService } from './docs/posting.service'
import { ReportService } from './reports/report.service'
import { FundService } from './master/fund.service'
import { PartnerService } from './master/partner.service'
import { ProductService } from './master/product.service'
import { WarehouseService } from './master/warehouse.service'
import { ImportExportService } from './io/import-export.service'
import { TenantManager } from './platform/tenant.service'

/** 全部服务的装配。服务是无 DI 框架依赖的普通类,便于测试直接构造 */
export interface Container {
  config: AppConfig
  db: Db
  kv: Kv
  cache: ConfigCache
  clock: Clock
  audit: AuditService
  license: LicenseService
  modules: ModuleService
  perms: PermissionService
  auth: AuthService
  users: UserService
  settings: SettingsService
  numbering: NumberingService
  customFields: CustomFieldService
  files: FileService
  branding: BrandingService
  print: PrintService
  packages: ConfigPackageService
  products: ProductService
  partners: PartnerService
  warehouses: WarehouseService
  funds: FundService
  events: EventService
  plugins: PluginRegistry
  posting: PostingService
  documents: DocumentService
  inventory: InventoryService
  reports: ReportService
  io: ImportExportService
  tenants: TenantManager
  close(): Promise<void>
}

export interface ContainerOverrides {
  kv?: Kv
  clock?: Clock
  wechat?: WechatClient | null
  storage?: StorageDriver
  db?: Db
  pluginTimeoutMs?: number
  renderer?: PrintRenderer
}

export async function createContainer(config: AppConfig, o: ContainerOverrides = {}): Promise<Container> {
  const db = o.db ?? new Db(createPool(config.DATABASE_APP_URL, 20), createPool(config.DATABASE_PLATFORM_URL, 10))
  const kv = o.kv ?? (config.REDIS_URL ? await createRedisKv(config.REDIS_URL) : new MemoryKv())
  const clock = o.clock ?? systemClock
  const cache = new ConfigCache(kv)
  await cache.start()
  const audit = new AuditService()
  const license = new LicenseService(db, cache, clock, config.TZ)
  const modules = new ModuleService(db, cache, license, audit)
  const perms = new PermissionService(db, kv, audit)
  const wechat = o.wechat !== undefined ? o.wechat : config.WECHAT_APPID && config.WECHAT_SECRET ? new HttpWechatClient(config.WECHAT_APPID, config.WECHAT_SECRET) : null
  const auth = new AuthService(db, kv, audit, clock, wechat, config.WECHAT_APPID)
  const users = new UserService(db, license, auth, perms, audit)
  const settings = new SettingsService(db, cache, audit)
  const numbering = new NumberingService()
  const customFields = new CustomFieldService(db, cache, audit)
  const files = new FileService(db, o.storage ?? new LocalDiskStorage(config.FILE_STORAGE_DIR), config.BACKUP_HMAC_SECRET)
  const branding = new BrandingService(db, files, audit)
  const renderer = o.renderer ?? new PrintRenderer({ executablePath: config.CHROMIUM_PATH, noSandbox: config.CHROMIUM_NO_SANDBOX })
  const print = new PrintService(db, settings, customFields, audit, files, renderer)
  const packages = new ConfigPackageService(files, audit, cache)
  const products = new ProductService(settings, customFields, audit)
  const partners = new PartnerService(customFields, audit)
  const warehouses = new WarehouseService(license, customFields, audit)
  const funds = new FundService(audit)
  const plugins = new PluginRegistry()
  const events = new EventService(db, cache, plugins, audit, o.pluginTimeoutMs)
  const posting = new PostingService({ db, settings, numbering, perms, audit, events, clock, tz: config.TZ })
  const documents = new DocumentService({ db, settings, numbering, cf: customFields, perms, audit, events, posting, clock, tz: config.TZ })
  const inventory = new InventoryService(db, perms, audit)
  const reports = new ReportService(db, perms, modules, customFields, settings, inventory, clock, config.TZ)
  const io = new ImportExportService(db, kv, files, customFields, perms, products, partners, inventory, audit)
  const tenants = new TenantManager(db, config.DEPLOYMENT_MODE, {
    settings,
    perms,
    print,
    packages,
    license,
    auth,
    audit,
    cache,
    clock,
    tz: config.TZ,
    adminUrl: config.DATABASE_ADMIN_URL,
    licensePublicKey: config.LICENSE_PUBLIC_KEY,
  })
  return {
    config,
    db,
    kv,
    cache,
    clock,
    audit,
    license,
    modules,
    perms,
    auth,
    users,
    settings,
    numbering,
    customFields,
    files,
    branding,
    print,
    packages,
    products,
    partners,
    warehouses,
    funds,
    events,
    plugins,
    posting,
    documents,
    inventory,
    reports,
    io,
    tenants,
    async close() {
      await renderer.close()
      await db.close()
      await kv.close()
    },
  }
}
