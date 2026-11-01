import { z } from 'zod'

/**
 * 扩展插件 SDK(需求 23.1)。事件载荷由带版本号的 zod schema 定义;
 * 契约快照测试保证已发布的字段不被删除或改名,只允许新增可选字段。
 */
export const EVENT_TYPES = ['document.beforeSave', 'document.beforeAudit', 'document.afterAudit', 'document.afterUnaudit'] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** 同步事件(可拒绝,5 秒超时) */
export const SYNC_EVENTS: EventType[] = ['document.beforeSave', 'document.beforeAudit']
export const PLUGIN_TIMEOUT_MS = 5000

export const documentLineV1 = z.object({
  lineNo: z.number().int(),
  skuId: z.string(),
  unitName: z.string().nullable(),
  ratio: z.number().int(),
  qty: z.string(),
  baseQty: z.string(),
  price: z.string(),
  discountRate: z.string(),
  amount: z.string(),
  warehouseId: z.string().nullable(),
})

export const documentPayloadV1 = z.object({
  id: z.string().nullable(),
  docType: z.string(),
  docNo: z.string().nullable(),
  docDate: z.string(),
  status: z.enum(['draft', 'audited', 'voided']),
  partnerId: z.string().nullable(),
  warehouseId: z.string().nullable(),
  toWarehouseId: z.string().nullable(),
  fundAccountId: z.string().nullable(),
  docDiscount: z.string(),
  paidAmount: z.string(),
  totalAmount: z.string(),
  remark: z.string(),
  custom: z.record(z.unknown()),
  lines: z.array(documentLineV1),
})

export const eventPayloadV1 = z.object({
  version: z.literal(1),
  eventType: z.enum(EVENT_TYPES),
  tenantId: z.string(),
  docType: z.string(),
  docNo: z.string().nullable(),
  status: z.enum(['draft', 'audited', 'voided']),
  occurredAt: z.string(),
  document: documentPayloadV1,
})
export type EventPayload = z.infer<typeof eventPayloadV1>
export type DocumentPayload = z.infer<typeof documentPayloadV1>

export interface PluginContext {
  tenantId: string
  log(message: string): void
}

/** 插件返回的结果。同步事件返回 { ok:false, message } 表示校验失败 */
export type PluginResult = void | { ok: true } | { ok: false; message: string }

export interface ErpPlugin {
  name: string
  version: string
  subscribes: EventType[]
  handle(event: EventPayload, ctx: PluginContext): Promise<PluginResult> | PluginResult
}

export function definePlugin(p: ErpPlugin): ErpPlugin {
  return p
}

/** HTTP Webhook 插件签名:HMAC-SHA256(secret, `${timestamp}.${body}`) */
export const WEBHOOK_SIGNATURE_HEADER = 'x-erp-signature'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-erp-timestamp'
