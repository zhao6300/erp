import { describe, expect, it, vi } from 'vitest'
import { ApiClient, DraftStore, Storage } from '@erp/api-client'
import { BARCODE_INDEX_TTL_MS, SalesSession, SkuInfo } from '../src/core/salesSession'
import { uniFetch, uniStorage } from '../src/core/platform'

const mem = (): Storage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) }
}
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

const SKUS: SkuInfo[] = [
  { skuId: 's1', skuCode: 'A001', name: '可乐', baseUnit: '瓶', refSalePrice: '3.50', wholesalePrice: '3.00', barcode: '690001' },
  { skuId: 's2', skuCode: 'A002', name: '雪碧', baseUnit: '瓶', refSalePrice: '3.20', wholesalePrice: null, barcode: '690002' },
]

/** 构造一个由路由表驱动的假后端 */
function backend(routes: Record<string, (req: { path: string; query: URLSearchParams; body: any }) => Response | Promise<Response>>) {
  const calls: string[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x')
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
    const h = routes[`${init?.method ?? 'GET'} ${u.pathname}`]
    if (!h) return res(404, { code: 'NOT_FOUND', message: 'no route' })
    return h({ path: u.pathname, query: u.searchParams, body: init?.body ? JSON.parse(init.body as string) : undefined })
  }) as typeof fetch
  const storage = mem()
  const api = new ApiClient({ baseUrl: 'https://erp.test', storage, fetch: fetchFn, client: 'miniapp' })
  return { api, calls, storage }
}

const indexRoute = () => res(200, SKUS.map((s) => ({ barcode: s.barcode, skuId: s.skuId, skuCode: s.skuCode, name: s.name, baseUnit: s.baseUnit, refSalePrice: s.refSalePrice })))

describe('扫码加行(需求 11.7、11.8)', () => {
  it('命中本地索引:以数量 1 加入;已有该 SKU 的行数量 +1', async () => {
    const { api } = backend({ 'GET /api/products/barcode-index': indexRoute })
    const s = new SalesSession({ api, drafts: new DraftStore(mem()) }, '2026-09-30', 'w1')
    const a = await s.scan('690001')
    expect(a.kind).toBe('added')
    expect(s.form.lines).toHaveLength(1)
    expect(s.form.lines[0]).toMatchObject({ skuId: 's1', qty: '1' })
    await s.scan('690001')
    expect(s.form.lines).toHaveLength(1)
    expect(s.form.lines[0].qty).toBe('2')
    await s.scan('690002')
    expect(s.form.lines.map((l) => l.skuId)).toEqual(['s1', 's2'])
  })

  it('条码索引只拉取一次并缓存 10 分钟,过期后重新拉取', async () => {
    let now = 1_000_000
    const { api, calls } = backend({ 'GET /api/products/barcode-index': indexRoute })
    const s = new SalesSession({ api, drafts: new DraftStore(mem()), now: () => now }, '2026-09-30', 'w1')
    await s.scan('690001')
    await s.scan('690002')
    now += BARCODE_INDEX_TTL_MS - 1
    await s.scan('690001')
    expect(calls.filter((c) => c.endsWith('barcode-index'))).toHaveLength(1)
    now += 2
    await s.scan('690001')
    expect(calls.filter((c) => c.endsWith('barcode-index'))).toHaveLength(2)
  })

  it('未命中本地索引:调用一次后端条码查询兜底;仍未命中提示"未找到该条码对应的商品"且明细不变', async () => {
    const { api, calls } = backend({
      'GET /api/products/barcode-index': indexRoute,
      'GET /api/products/by-barcode': ({ query }) => res(200, { item: query.get('barcode') === '690999' ? { skuId: 's9', skuCode: 'A009', name: '新品', baseUnit: '个', refSalePrice: '9.00' } : null }),
    })
    const s = new SalesSession({ api, drafts: new DraftStore(mem()) }, '2026-09-30', 'w1')
    await s.scan('690001')
    const before = JSON.stringify(s.form.lines)
    expect((await s.scan('690999')).kind).toBe('added') // 本地索引没有(新增商品),后端兜底命中
    expect(s.form.lines.map((l) => l.skuId)).toEqual(['s1', 's9'])
    const miss = await s.scan('000000')
    expect(miss).toEqual({ kind: 'not_found', message: '未找到该条码对应的商品' })
    expect(s.form.lines).toHaveLength(2)
    expect(calls.filter((c) => c.endsWith('by-barcode'))).toHaveLength(2) // 每次未命中只兜底一次
    expect(before).not.toBe('') // 保持引用
    expect((await s.scan(null)).kind).toBe('cancelled')
    expect(s.form.lines).toHaveLength(2)
  })
})

describe('取价与金额(需求 12.4、16.2)', () => {
  it('按客户价格等级取价;换客户时重新取价,手工改过的行保持不变', async () => {
    const { api } = backend({ 'GET /api/products/barcode-index': indexRoute })
    const s = new SalesSession({ api, drafts: new DraftStore(mem()) }, '2026-09-30', 'w1')
    s.setCustomer('c1', { type: 'wholesale' })
    s.addSku(SKUS[0])
    s.addSku(SKUS[1])
    expect(s.form.lines.map((l) => l.price)).toEqual(['3.0000', '3.2000']) // 批发价;未设批发价取参考售价
    s.setPrice(1, '3.1')
    s.setCustomer('c2', { type: 'discount', rate: '90' })
    expect(s.form.lines.map((l) => l.price)).toEqual(['3.1500', '3.1']) // 第 2 行手改过,不被覆盖
  })

  it('实时合计 = 逐行四舍五入后求和;本单已收上限为总金额', () => {
    const { api } = backend({})
    const s = new SalesSession({ api, drafts: new DraftStore(mem()) }, '2026-09-30', 'w1')
    s.setCustomer('c1', { type: 'retail' })
    s.addSku(SKUS[0])
    s.setQty(0, '3')
    expect(s.sum.total).toBe('10.50')
    expect(s.paidMax).toBe('10.50')
    s.setPaid('10.51', 'f1')
    expect(s.validate().byKey.paidAmount).toBeTruthy() // 超过总额
    s.setPaid('10.50', 'f1')
    expect(s.validate().issues).toHaveLength(0)
  })
})

describe('保存并审核(需求 16.9、16.12)', () => {
  const ready = (routes: Parameters<typeof backend>[0]) => {
    const b = backend({ 'GET /api/products/barcode-index': indexRoute, ...routes })
    const store = new DraftStore(b.storage)
    const s = new SalesSession({ api: b.api, drafts: store }, '2026-09-30', 'w1')
    s.setCustomer('c1', { type: 'retail' })
    s.addSku(SKUS[0])
    s.setPaid('1.00', 'f1')
    return { ...b, s, store }
  }

  it('成功:一次请求完成保存并审核,携带 clientRequestId 与 autoAudit', async () => {
    const seen: any[] = []
    const { s, store } = ready({ 'POST /api/documents': ({ body }) => (seen.push(body), res(200, { doc: { id: 'd', docNo: 'XSCK1', status: 'audited', version: 2, totalAmount: '3.50' }, replayed: false })) })
    const r = await s.submit()
    expect(r).toEqual({ status: 'ok', docNo: 'XSCK1', audited: true })
    expect(seen[0]).toMatchObject({ docType: 'sales_out', partnerId: 'c1', autoAudit: true, clientRequestId: s.clientRequestId, paidAmount: '1.00' })
    expect(await store.list()).toHaveLength(0)
  })

  it('审核失败(库存不足/信用额度):单据已保存为草稿,保留全部已录入内容并在当前页显示原因', async () => {
    const { s } = ready({ 'POST /api/documents': () => res(200, { doc: { id: 'd', docNo: 'XSCK2', status: 'draft', version: 1, totalAmount: '3.50' }, replayed: false, auditError: { code: 'INSUFFICIENT_STOCK', message: '库存不足:A001 当前 0,需出库 1' } }) })
    const r = await s.submit()
    expect(r).toMatchObject({ status: 'audit_failed', docNo: 'XSCK2', reason: expect.stringContaining('库存不足'), needsCreditConfirm: false })
    expect(s.form.lines).toHaveLength(1) // 内容保留
    expect(s.form.partnerId).toBe('c1')
  })

  it('超出信用额度:提示需要确认;确认后以 confirmCredit 重新提交', async () => {
    const bodies: any[] = []
    let n = 0
    const { s } = ready({
      'POST /api/documents': ({ body }) => {
        bodies.push(body)
        return res(200, ++n === 1 ? { doc: { id: 'd', docNo: 'X3', status: 'draft', version: 1, totalAmount: '3.50' }, replayed: false, auditError: { code: 'CREDIT_CONFIRM_REQUIRED', message: '超出客户信用额度' } } : { doc: { id: 'd', docNo: 'X3', status: 'audited', version: 2, totalAmount: '3.50' }, replayed: true })
      },
    })
    const first = await s.submit()
    expect(first).toMatchObject({ status: 'audit_failed', needsCreditConfirm: true })
    const second = await s.submit({ confirmCredit: true })
    expect(second).toEqual({ status: 'ok', docNo: 'X3', audited: true })
    expect(bodies[1].confirmCredit).toBe(true)
    expect(bodies[0].clientRequestId).toBe(bodies[1].clientRequestId) // 幂等:同一单据
  })

  it('前端预校验失败:不发请求,按行号标出问题', async () => {
    const { s, calls } = ready({})
    s.setQty(0, '0')
    const r = await s.submit()
    expect(r).toMatchObject({ status: 'invalid' })
    expect((r as { errors: Record<string, string> }).errors['qty@1']).toBeTruthy()
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0)
  })

  it('后端 422:保留内容并按字段定位', async () => {
    const { s } = ready({ 'POST /api/documents': () => res(422, { code: 'VALIDATION_FAILED', message: '客户已停用', details: [{ field: 'partnerId', reason: '所选往来单位已停用' }] }) })
    const r = await s.submit()
    expect(r).toMatchObject({ status: 'rejected', errors: { partnerId: '所选往来单位已停用' } })
    expect(s.form.lines).toHaveLength(1)
  })
})

describe('离线草稿与幂等重提交(需求 19.7–19.9)', () => {
  it('断网:提示提交失败并保留本地草稿;重启后可恢复编辑;重新提交复用同一 clientRequestId 且只保存一张单据', async () => {
    let online = false
    const saved = new Map<string, { docNo: string }>()
    const posts: any[] = []
    const b = backend({
      'GET /api/products/barcode-index': indexRoute,
      'POST /api/documents': ({ body }) => {
        posts.push(body)
        if (!online) throw new TypeError('offline')
        if (!saved.has(body.clientRequestId)) saved.set(body.clientRequestId, { docNo: `XSCK${saved.size + 1}` })
        return res(200, { doc: { id: 'd', docNo: saved.get(body.clientRequestId)!.docNo, status: 'audited', version: 2, totalAmount: '3.50' }, replayed: posts.length > 1 })
      },
    })
    const store = new DraftStore(b.storage)
    const s = new SalesSession({ api: b.api, drafts: store }, '2026-09-30', 'w1')
    s.setCustomer('c1', { type: 'retail' })
    s.addSku(SKUS[0])
    s.setQty(0, '4')
    s.setPaid('2.00', 'f1')

    const off = await s.submit()
    expect(off.status).toBe('offline')
    expect((off as { message: string }).message).toContain('已保存在本机')
    expect(await store.list()).toHaveLength(1)

    // 关闭并重新打开小程序:从同一存储恢复草稿,表单内容完整
    const reopened = new DraftStore(b.storage)
    const [draft] = await reopened.list()
    const s2 = new SalesSession({ api: b.api, drafts: reopened }, '2026-09-30', 'w1', draft)
    expect(s2.clientRequestId).toBe(s.clientRequestId)
    expect(s2.form.lines[0]).toMatchObject({ skuId: 's1', qty: '4' })
    expect(s2.form.paidAmount).toBe('2.00')

    online = true
    const ok = await s2.submit()
    expect(ok).toEqual({ status: 'ok', docNo: 'XSCK1', audited: true })
    expect(await reopened.list()).toHaveLength(0)
    // 再提交一次(例如首次其实已成功但响应丢了):同一 clientRequestId → 同一单据编号
    const again = await s2.submit()
    expect(again).toMatchObject({ status: 'ok', docNo: 'XSCK1' })
    expect(saved.size).toBe(1)
    expect(new Set(posts.map((p) => p.clientRequestId)).size).toBe(1)
  })

  it('15 秒无响应同样视为失败并保留草稿', async () => {
    const b = backend({})
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage: b.storage, timeoutMs: 15, fetch: ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as never })
    const store = new DraftStore(b.storage)
    const s = new SalesSession({ api, drafts: store }, '2026-09-30', 'w1')
    s.setCustomer('c1', { type: 'retail' })
    s.addSku(SKUS[0])
    const r = await s.submit()
    expect(r.status).toBe('offline')
    expect((await store.list())[0].error).toContain('超时')
  })
})

describe('小程序运行时适配', () => {
  it('uniStorage 把同步存储 API 适配为 Storage;空值返回 null', () => {
    const data = new Map<string, string>()
    const st = uniStorage({ getStorageSync: (k) => data.get(k) ?? '', setStorageSync: (k, v) => void data.set(k, v), removeStorageSync: (k) => void data.delete(k) })
    expect(st.get('x')).toBeNull()
    st.set('x', '1')
    expect(st.get('x')).toBe('1')
    st.remove('x')
    expect(st.get('x')).toBeNull()
  })

  it('uniFetch 把 uni.request 适配为 fetch;失败抛 TypeError(被识别为断网)', async () => {
    const ok = uniFetch({ request: (o) => (o.success({ statusCode: 200, data: '{"a":1}' }), { abort() {} }) })
    const r = await ok('https://x/api', { method: 'post', headers: { a: 'b' }, body: '{}' })
    expect(r.ok).toBe(true)
    expect(await r.text()).toBe('{"a":1}')
    const bad = uniFetch({ request: (o) => (o.fail({ errMsg: 'request:fail' }), { abort() {} }) })
    await expect(bad('https://x/api')).rejects.toBeInstanceOf(TypeError)
    const abort = vi.fn()
    const ac = new AbortController()
    const hang = uniFetch({ request: () => ({ abort }) })
    const p = hang('https://x/api', { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(abort).toHaveBeenCalled()
  })
})
