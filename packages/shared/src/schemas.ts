import { z } from 'zod'
import { MODULE_CODES } from './types'

/** 请求体 schema 使用 strip 模式:请求中携带的任何租户标识都会被丢弃(设计 D1) */

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, '金额最多 2 位小数').refine((s) => Number(s) <= 999_999_999.99, '金额不超过 999,999,999.99')
const trimmed = (min: number, max: number, label: string) =>
  z.string().transform((s) => s.trim()).pipe(z.string().min(min, `${label}不能为空`).max(max, `${label}不超过 ${max} 个字符`))

export const phoneSchema = z.string().regex(/^1[3-9]\d{9}$/, '手机号须为 11 位中国大陆手机号')

export const createTenantSchema = z.object({
  name: trimmed(1, 100, '企业名称'),
  contact: trimmed(1, 50, '联系人'),
  phone: phoneSchema,
  license: z.object({
    expireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '截止日期不能为空'),
    modules: z.array(z.enum(MODULE_CODES)).min(1, '至少授权 1 个模块'),
    maxUsers: z.number().int().min(1).max(9999),
    maxWarehouses: z.number().int().min(1).max(999),
  }),
  configPackageId: z.string().uuid().optional(),
})
export type CreateTenantInput = z.infer<typeof createTenantSchema>

export const licenseSchema = createTenantSchema.shape.license
export type LicenseInput = z.infer<typeof licenseSchema>

export const loginSchema = z.object({ login: z.string().min(1), password: z.string().min(1), client: z.enum(['web', 'miniapp']).default('web') })

export const brandingSchema = z.object({
  systemName: trimmed(1, 30, '系统名称'),
  logoFileId: z.string().uuid().nullable().optional(),
  themeColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, '主题色须为 6 位十六进制颜色值，如 #1677FF').optional(),
  loginBgFileId: z.string().uuid().nullable().optional(),
  copyright: z.string().max(100, '版权文字不超过 100 个字符').optional().default(''),
  customDomain: z
    .string()
    .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, '自定义域名格式不正确')
    .nullable()
    .optional(),
})
export type BrandingInput = z.infer<typeof brandingSchema>

export const settingsSchema = z.object({
  qtyScale: z.number().int().min(0).max(4),
  priceScale: z.number().int().min(0).max(6),
  amountScale: z.number().int().min(0).max(2),
  allowNegativeStock: z.boolean(),
  requireAudit: z.boolean(),
  multiUnit: z.boolean(),
  multiSku: z.boolean(),
  barcodeEnabled: z.boolean(),
})

const alnum = /^[A-Za-z0-9]*$/
export const productSchema = z.object({
  code: trimmed(1, 32, '商品编码'),
  name: trimmed(1, 100, '商品名称'),
  categoryId: z.string().uuid().nullable().optional(),
  spec: z.string().max(100, '规格型号不超过 100 个字符').optional().default(''),
  baseUnit: trimmed(1, 20, '基本单位'),
  barcode: z.string().max(32).regex(alnum, '条码仅限字母与数字').optional().default(''),
  refCostPrice: money.optional().default('0'),
  refSalePrice: money.optional().default('0'),
  wholesalePrice: money.nullable().optional(),
  stockMin: z.string().regex(/^\d+(\.\d+)?$/).nullable().optional(),
  stockMax: z.string().regex(/^\d+(\.\d+)?$/).nullable().optional(),
  images: z.array(z.string().uuid()).max(5, '图片最多 5 张').optional().default([]),
  remark: z.string().max(500, '备注不超过 500 个字符').optional().default(''),
  custom: z.record(z.unknown()).optional(),
  units: z.array(z.object({ unitName: trimmed(1, 20, '辅助单位'), ratio: z.number().int().min(2).max(100000) })).max(3).optional(),
  specDims: z.array(z.object({ name: trimmed(1, 20, '规格维度'), values: z.array(trimmed(1, 30, '规格值')).min(1).max(30) })).max(2).optional(),
})
export type ProductInput = z.infer<typeof productSchema>

export const partnerSchema = z.object({
  code: trimmed(1, 32, '编码'),
  name: trimmed(1, 100, '名称'),
  kind: z.enum(['customer', 'supplier', 'both']),
  category: z.string().max(50).optional().default(''),
  contact: z.string().max(50).optional().default(''),
  phone: z.string().max(30).optional().default(''),
  address: z.string().max(200).optional().default(''),
  taxNo: z.string().max(50).optional().default(''),
  bank: z.string().max(100).optional().default(''),
  bankAccount: z.string().max(50).optional().default(''),
  openingAr: money.optional().default('0'),
  openingAp: money.optional().default('0'),
  priceLevel: z
    .union([z.object({ type: z.literal('retail') }), z.object({ type: z.literal('wholesale') }), z.object({ type: z.literal('discount'), rate: z.string().regex(/^\d+(\.\d+)?$/) })])
    .optional(),
  creditLimit: money.nullable().optional(),
  remark: z.string().max(500).optional().default(''),
  custom: z.record(z.unknown()).optional(),
})
export type PartnerInput = z.infer<typeof partnerSchema>

export const fundAccountSchema = z.object({
  name: trimmed(1, 50, '账户名称'),
  type: z.enum(['cash', 'bank', 'wechat', 'alipay', 'other']),
  openingBalance: money.optional().default('0'),
})

export const roleSchema = z.object({
  name: trimmed(1, 30, '角色名称'),
  permissions: z.array(z.string()),
  dataScope: z
    .union([z.object({ type: z.literal('all') }), z.object({ type: z.literal('own') }), z.object({ type: z.literal('warehouses'), ids: z.array(z.string().uuid()).min(1) })])
    .default({ type: 'own' }),
})

/** 分页参数 */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
})
