import { describe, expect, it } from 'vitest'
import { DEFAULT_SCALES, DocInput, computeDocAmounts, validateDocumentDraft } from '../src'

const base = (over: Partial<DocInput> = {}): DocInput => ({
  docType: 'sales_out',
  docDate: '2026-09-30',
  partnerId: 'P1',
  warehouseId: 'W1',
  fundAccountId: 'F1',
  docDiscount: '0',
  paidAmount: '0',
  lines: [{ skuId: 'S1', qty: '2', price: '10', discountRate: '100' }],
  ...over,
})
const fields = (d: DocInput) => validateDocumentDraft(d, DEFAULT_SCALES).map((i) => (i.row ? `${i.field}@${i.row}` : i.field))

describe('单据草稿校验', () => {
  it('合法销售单无问题', () => expect(fields(base())).toEqual([]))

  it('销售单:缺客户、0 行、数量/单价/折扣/优惠/已收的各种非法值,并指明行号', () => {
    expect(fields(base({ partnerId: null }))).toContain('partnerId')
    expect(fields(base({ lines: [] }))).toContain('lines')
    expect(fields(base({ lines: [{ skuId: 'S1', qty: '0', price: '10', discountRate: '100' }] }))).toContain('qty@1')
    expect(fields(base({ lines: [{ skuId: 'S1', qty: '1', price: '-1', discountRate: '100' }] }))).toContain('price@1')
    expect(fields(base({ lines: [{ skuId: 'S1', qty: '1', price: '1', discountRate: '101' }] }))).toContain('discountRate@1')
    expect(fields(base({ docDiscount: '-1' }))).toContain('docDiscount')
    expect(fields(base({ docDiscount: '20.01' }))).toContain('docDiscount') // 行金额之和 20
    expect(fields(base({ paidAmount: '20.01', fundAccountId: 'F1' }))).toContain('paidAmount')
    expect(fields(base({ paidAmount: '5', fundAccountId: null }))).toContain('fundAccountId')
    const multi = base({ lines: [{ skuId: 'S1', qty: '1', price: '1', discountRate: '100' }, { skuId: 'S2', qty: '-1', price: '1', discountRate: '100' }] })
    expect(fields(multi)).toContain('qty@2')
  })

  it('小数位数超出租户精度被拒绝(需求 7.9)', () => {
    expect(fields(base({ lines: [{ skuId: 'S1', qty: '1.123', price: '1', discountRate: '100' }] }))).toContain('qty@1')
    expect(fields(base({ lines: [{ skuId: 'S1', qty: '1', price: '1.12345', discountRate: '100' }] }))).toContain('price@1')
  })

  it('调拨:调出与调入仓库相同被拒;盘点:数量为空或负数被拒并标出行号', () => {
    const t: DocInput = { docType: 'transfer', docDate: '2026-09-30', warehouseId: 'W1', toWarehouseId: 'W1', lines: [{ skuId: 'S1', qty: '1', price: '0', discountRate: '100' }] }
    expect(fields(t)).toContain('toWarehouseId')
    const s: DocInput = { docType: 'stocktake', docDate: '2026-09-30', warehouseId: 'W1', lines: [{ skuId: 'S1', qty: '0', price: '0', discountRate: '100', countedQty: '' }, { skuId: 'S2', qty: '0', price: '0', discountRate: '100', countedQty: '-1' }, { skuId: 'S3', qty: '0', price: '0', discountRate: '100', countedQty: '0' }] }
    expect(fields(s)).toEqual(['countedQty@1', 'countedQty@2'])
  })

  it('收款/付款/其他收支:金额范围、账户、类别、备注长度', () => {
    const r: DocInput = { docType: 'receipt', docDate: '2026-09-30', partnerId: 'P', fundAccountId: 'F', amount: '0.01', lines: [] }
    expect(fields(r)).toEqual([])
    expect(fields({ ...r, amount: '0' })).toContain('amount')
    expect(fields({ ...r, amount: '1000000000' })).toContain('amount')
    expect(fields({ ...r, amount: '1.234' })).toContain('amount')
    expect(fields({ ...r, fundAccountId: null })).toContain('fundAccountId')
    expect(fields({ ...r, docType: 'other_income' })).toContain('fundCategoryId')
    expect(fields({ ...r, docType: 'other_expense', fundCategoryId: 'C', remark: 'x'.repeat(201) })).toContain('remark')
  })

  it('金额汇总:逐行四舍五入后求和再减整单优惠;辅助单位换算为基本单位', () => {
    const c = computeDocAmounts(
      { docType: 'purchase_in', docDiscount: '0.10', lines: [{ skuId: 'S', qty: '3', price: '0.335', discountRate: '100', ratio: 12 }, { skuId: 'S', qty: '1', price: '0.005', discountRate: '100' }] },
      DEFAULT_SCALES,
    )
    // 3 × 0.335 = 1.005 → 1.01(ROUND_HALF_UP);1 × 0.005 = 0.005 → 0.01
    expect(c.lines.map((l) => l.amount.toString())).toEqual(['1.01', '0.01'])
    expect(c.lines[0].baseQty.toString()).toBe('36')
    expect(c.total.toString()).toBe('0.92') // 1.01 + 0.01 − 0.10
  })
})
