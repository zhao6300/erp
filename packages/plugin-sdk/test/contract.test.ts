import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EVENT_TYPES, PLUGIN_TIMEOUT_MS, SYNC_EVENTS, documentLineV1, documentPayloadV1, eventPayloadV1 } from '../src'

/**
 * 契约快照测试(需求 23.1):已发布事件载荷(v1)的字段不得被删除或改名。
 * 新增字段是允许的——此时只需在 PUBLISHED 中追加,不能移除已有项。
 * CI 中此测试失败即表示破坏了对已发布插件的兼容。
 */
const PUBLISHED_V1 = {
  event: ['version', 'eventType', 'tenantId', 'docType', 'docNo', 'status', 'occurredAt', 'document'],
  document: ['id', 'docType', 'docNo', 'docDate', 'status', 'partnerId', 'warehouseId', 'toWarehouseId', 'fundAccountId', 'docDiscount', 'paidAmount', 'totalAmount', 'remark', 'custom', 'lines'],
  line: ['lineNo', 'skuId', 'unitName', 'ratio', 'qty', 'baseQty', 'price', 'discountRate', 'amount', 'warehouseId'],
  events: ['document.beforeSave', 'document.beforeAudit', 'document.afterAudit', 'document.afterUnaudit'],
}

const keys = (s: z.ZodObject<z.ZodRawShape>) => Object.keys(s.shape)

describe('插件事件载荷契约(v1)', () => {
  it('已发布的字段全部保留(只允许新增,不允许删除或改名)', () => {
    for (const k of PUBLISHED_V1.event) expect(keys(eventPayloadV1), `事件字段 ${k}`).toContain(k)
    for (const k of PUBLISHED_V1.document) expect(keys(documentPayloadV1), `单据字段 ${k}`).toContain(k)
    for (const k of PUBLISHED_V1.line) expect(keys(documentLineV1), `明细字段 ${k}`).toContain(k)
    for (const e of PUBLISHED_V1.events) expect(EVENT_TYPES).toContain(e)
  })

  it('同步事件仅限保存前与审核前,超时为 5 秒', () => {
    expect([...SYNC_EVENTS].sort()).toEqual(['document.beforeAudit', 'document.beforeSave'])
    expect(PLUGIN_TIMEOUT_MS).toBe(5000)
  })

  it('一个符合 v1 的载荷能通过校验,版本号固定为 1', () => {
    const ok = {
      version: 1,
      eventType: 'document.afterAudit',
      tenantId: 't',
      docType: 'sales_out',
      docNo: 'XS001',
      status: 'audited',
      occurredAt: '2026-09-30T00:00:00Z',
      document: {
        id: 'd',
        docType: 'sales_out',
        docNo: 'XS001',
        docDate: '2026-09-30',
        status: 'audited',
        partnerId: null,
        warehouseId: null,
        toWarehouseId: null,
        fundAccountId: null,
        docDiscount: '0',
        paidAmount: '0',
        totalAmount: '10.00',
        remark: '',
        custom: {},
        lines: [{ lineNo: 1, skuId: 's', unitName: '个', ratio: 1, qty: '1', baseQty: '1', price: '10', discountRate: '100', amount: '10.00', warehouseId: null }],
      },
    }
    expect(eventPayloadV1.safeParse(ok).success).toBe(true)
    expect(eventPayloadV1.safeParse({ ...ok, version: 2 }).success).toBe(false)
  })
})
