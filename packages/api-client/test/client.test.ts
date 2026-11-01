import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, DraftStore, Storage, can, menuVisible, newClientRequestId, themeShades } from '../src'

const memory = (): Storage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('ApiClient', () => {
  it('携带令牌;错误按 code 映射;422 保留表单并按 field/row 定位', async () => {
    const storage = memory()
    storage.data.set('erp.token', 'T')
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer T')
      return json(422, { code: 'VALIDATION_FAILED', message: '未通过校验', details: [{ field: 'qty', row: 2, reason: '数量必须大于 0' }, { field: 'partnerId', reason: '请选择客户' }] })
    })
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage, fetch: f as never })
    const e = (await api.post('/api/documents', {}).catch((x) => x)) as ApiError
    expect(e).toBeInstanceOf(ApiError)
    expect(e.status).toBe(422)
    expect(e.keepsForm).toBe(true)
    expect(e.fieldErrors()).toEqual({ 'qty@2': '数量必须大于 0', partnerId: '请选择客户' })
  })

  it('401 UNAUTHENTICATED:清除本地令牌并通知跳转登录页', async () => {
    const storage = memory()
    storage.data.set('erp.token', 'EXPIRED')
    const onUnauthenticated = vi.fn()
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage, onUnauthenticated, fetch: (async () => json(401, { code: 'UNAUTHENTICATED', message: '请先登录' })) as never })
    await expect(api.get('/api/products')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(storage.data.has('erp.token')).toBe(false)
    expect(onUnauthenticated).toHaveBeenCalledTimes(1)
  })

  it('登录成功保存令牌;选择租户的响应不保存', async () => {
    const storage = memory()
    let n = 0
    const api = new ApiClient({
      baseUrl: 'https://erp.test',
      storage,
      fetch: (async () => (++n === 1 ? json(200, { status: 'select_tenant', selectTicket: 'x', tenants: [{ id: 'a', name: 'A' }] }) : json(200, { status: 'ok', token: 'NEW', tenant: { id: 'a', name: 'A' }, user: { id: 'u', name: 'U', isTenantAdmin: true }, mustChangePassword: false }))) as never,
    })
    expect((await api.login('13800000000', 'pw')).status).toBe('select_tenant')
    expect(storage.data.has('erp.token')).toBe(false)
    await api.selectTenant('x', 'a')
    expect(storage.data.get('erp.token')).toBe('NEW')
  })

  it('网络中断与 15 秒超时分别抛出 NETWORK / TIMEOUT', async () => {
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage: memory(), fetch: (async () => { throw new TypeError('Failed to fetch') }) as never })
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'NETWORK' })
    const slow = new ApiClient({ baseUrl: 'https://erp.test', storage: memory(), timeoutMs: 20, fetch: ((_u: unknown, init?: RequestInit) => new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as never })
    await expect(slow.get('/x')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('信用额度需要确认', async () => {
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage: memory(), fetch: (async () => json(409, { code: 'CREDIT_CONFIRM_REQUIRED', message: '超出信用额度', details: [{ reason: '超出', excess: '50' }] })) as never })
    const e = (await api.post('/api/documents/x/audit', {}).catch((x) => x)) as ApiError
    expect(e.needsCreditConfirm).toBe(true)
    expect(e.keepsForm).toBe(true)
  })
})

describe('离线草稿与幂等重提交(需求 19.7–19.9)', () => {
  it('断网时草稿与 clientRequestId 保留;重新提交复用同一 clientRequestId;成功后删除', async () => {
    const storage = memory()
    const store = new DraftStore(storage)
    const seen: string[] = []
    let online = false
    const api = new ApiClient({
      baseUrl: 'https://erp.test',
      storage: memory(),
      fetch: (async (_u: unknown, init?: RequestInit) => {
        seen.push(JSON.parse(init!.body as string).clientRequestId)
        if (!online) throw new TypeError('offline')
        return json(200, { doc: { id: 'd', docNo: 'XS0001', status: 'audited', version: 2, totalAmount: '10.00' }, replayed: false })
      }) as never,
    })
    const draft = { clientRequestId: newClientRequestId(), savedAt: Date.now(), input: { docType: 'sales_out' }, autoAudit: true }
    const first = await store.submit(api, draft)
    expect(first.ok).toBe(false)
    expect((await store.list())).toHaveLength(1)
    // 关闭并重新打开小程序:新的 DraftStore 读取同一存储,草稿仍在
    const reopened = new DraftStore(storage)
    const [again] = await reopened.list()
    expect(again.clientRequestId).toBe(draft.clientRequestId)
    expect(again.error).toBeTruthy()
    online = true
    const second = await reopened.submit(api, again)
    expect(second.ok).toBe(true)
    expect(await reopened.list()).toHaveLength(0)
    expect(new Set(seen).size).toBe(1) // 两次提交用的是同一个 clientRequestId
  })

  it('DraftStore.submit 自身在网络失败时保留草稿(含表单快照与原因),不依赖调用方', async () => {
    const store = new DraftStore(memory())
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage: memory(), fetch: (async () => { throw new TypeError('offline') }) as never })
    const r = await store.submit(api, { clientRequestId: 'r-net', savedAt: 1, input: { docType: 'sales_out' }, form: { lines: [1, 2, 3] }, autoAudit: true })
    expect(r.ok).toBe(false)
    const [kept] = await store.list()
    expect(kept.clientRequestId).toBe('r-net')
    expect(kept.form).toEqual({ lines: [1, 2, 3] })
    expect(kept.error).toBeTruthy()
  })

  it('业务拒绝(422)同样保留草稿,用户修改后可重试', async () => {
    const store = new DraftStore(memory())
    const api = new ApiClient({ baseUrl: 'https://erp.test', storage: memory(), fetch: (async () => json(422, { code: 'VALIDATION_FAILED', message: '数量必须大于 0' })) as never })
    const r = await store.submit(api, { clientRequestId: 'r1', savedAt: 1, input: {}, autoAudit: false })
    expect(r.ok).toBe(false)
    expect((await store.list())[0].error).toBe('数量必须大于 0')
  })

  it('生成的 clientRequestId 互不相同', () => {
    expect(new Set(Array.from({ length: 200 }, newClientRequestId)).size).toBe(200)
  })
})

describe('权限与菜单、主题色', () => {
  const b = { permissions: { isAdmin: false, permissions: ['menu:sales_out', 'sales_out:view'], dataScope: { all: true, warehouseIds: [], own: false } }, modules: ['sales'] } as never
  it('菜单需要模块已启用且具备菜单权限;管理员全部可见', () => {
    expect(menuVisible(b, 'sales_out', 'sales')).toBe(true)
    expect(menuVisible(b, 'sales_out', 'purchase')).toBe(false)
    expect(menuVisible(b, 'purchase_in', 'sales')).toBe(false)
    expect(can(b, 'sales_out:audit')).toBe(false)
    expect(can({ permissions: { isAdmin: true, permissions: [], dataScope: { all: true, warehouseIds: [], own: false } } } as never, 'anything')).toBe(true)
  })
  it('主题色色阶:light 逐级变浅,dark-2 变深', () => {
    const s = themeShades('#1677FF')
    expect(s['']).toBe('#1677ff')
    expect(s['light-3']).toBe('#5ca0ff') // G: 119×0.7 + 255×0.3 = 159.8 → 160
    expect(s['light-9']).toBe('#e8f1ff')
    expect(s['dark-2']).toBe('#125fcc') // G: 119×0.8 = 95.2 → 95
    expect(() => themeShades('red')).toThrow()
  })
})

describe('printUrl', () => {
  it('拼出打印文件地址:默认下载 PDF;baseUrl 末尾斜杠与 id 特殊字符被处理', () => {
    const api = new ApiClient({ baseUrl: 'https://erp.test/', storage: memory() })
    expect(api.printUrl('abc')).toBe('https://erp.test/api/documents/abc/print?format=pdf&download=1')
    expect(api.printUrl('a/b', 'png', { templateId: 't 1', download: false })).toBe('https://erp.test/api/documents/a%2Fb/print?format=png&templateId=t+1')
  })
})
