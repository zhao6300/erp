import { ErrorBody, ErrorCode, ERROR_MESSAGE, ErrorDetail } from '@erp/shared'

/**
 * Web 端与小程序共用的 HTTP 客户端。
 * - 统一拦截错误,按 code 映射提示文案;details 里的 field/row 用于定位表单字段或导入行
 * - 401 UNAUTHENTICATED:清除本地令牌并通知跳转登录页(需求 9.7)
 * - 422/409:不吞掉响应,调用方保留用户已录入的内容(需求 19.10)
 * - 单据保存携带 clientRequestId 保证幂等(需求 19.8)
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | 'NETWORK' | 'TIMEOUT',
    message: string,
    public readonly details: ErrorDetail[] = [],
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
  /** 422/409 等"业务拒绝":应保留表单内容 */
  get keepsForm(): boolean {
    return this.status === 422 || this.status === 409
  }
  /** 按 field/row 定位错误 */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const d of this.details) if (d.field && !(d.field in out)) out[d.row !== undefined ? `${d.field}@${d.row}` : d.field] = d.reason
    return out
  }
  /** 需要用户确认后带 confirmCredit=true 重新提交 */
  get needsCreditConfirm(): boolean {
    return this.code === 'CREDIT_CONFIRM_REQUIRED'
  }
}

/** 请求超时与无网络:小程序据此把单据保存为本地草稿并提供重新提交入口(需求 19.7、19.9) */
export const REQUEST_TIMEOUT_MS = 15_000

export interface Storage {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  remove(key: string): void | Promise<void>
}

export interface ClientOptions {
  baseUrl: string
  storage: Storage
  fetch?: typeof fetch
  /** 收到 401 时回调(跳转登录页) */
  onUnauthenticated?: () => void
  timeoutMs?: number
  client?: 'web' | 'miniapp'
}

const TOKEN_KEY = 'erp.token'

export class ApiClient {
  private f: typeof fetch
  constructor(private o: ClientOptions) {
    this.f = o.fetch ?? ((...a) => fetch(...a))
  }

  async token(): Promise<string | null> {
    return this.o.storage.get(TOKEN_KEY)
  }
  /** 单据打印文件的下载地址(PDF/图片由服务端渲染;需要 Authorization 头,所以调用方要自带令牌下载) */
  printUrl(docId: string, format: 'pdf' | 'png' | 'html' = 'pdf', opts: { templateId?: string; download?: boolean } = {}): string {
    const q = new URLSearchParams({ format })
    if (opts.templateId) q.set('templateId', opts.templateId)
    if (opts.download ?? true) q.set('download', '1')
    return `${this.o.baseUrl.replace(/\/$/, '')}/api/documents/${encodeURIComponent(docId)}/print?${q}`
  }

  async setToken(t: string | null): Promise<void> {
    if (t) await this.o.storage.set(TOKEN_KEY, t)
    else await this.o.storage.remove(TOKEN_KEY)
  }

  async request<T>(method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : this.o.baseUrl.replace(/\/$/, '') + path, 'http://placeholder')
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { accept: 'application/json' }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const token = opts.auth === false ? null : await this.token()
    if (token) headers.authorization = `Bearer ${token}`

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await this.f(this.o.baseUrl.startsWith('http') ? url.toString().replace('http://placeholder', '') : url.pathname + url.search, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      })
    } catch (e) {
      throw (e as Error).name === 'AbortError' ? new ApiError(0, 'TIMEOUT', '请求超时,请检查网络后重试') : new ApiError(0, 'NETWORK', '网络不可用,请检查网络后重试')
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (res.ok) return json as T

    const body = (json ?? {}) as Partial<ErrorBody>
    const code = (body.code ?? 'INTERNAL_ERROR') as ErrorCode
    const err = new ApiError(res.status, code, body.message || ERROR_MESSAGE[code] || '请求失败', body.details ?? [], body.requestId)
    if (res.status === 401 && code === 'UNAUTHENTICATED') {
      await this.setToken(null)
      this.o.onUnauthenticated?.()
    }
    throw err
  }

  get = <T>(path: string, query?: Record<string, unknown>) => this.request<T>('GET', path, { query })
  post = <T>(path: string, body?: unknown, query?: Record<string, unknown>) => this.request<T>('POST', path, { body: body ?? {}, query })
  put = <T>(path: string, body?: unknown, query?: Record<string, unknown>) => this.request<T>('PUT', path, { body: body ?? {}, query })
  delete = <T>(path: string) => this.request<T>('DELETE', path)

  /* ───────── 会话 ───────── */
  async login(login: string, password: string) {
    const r = await this.request<LoginResponse>('POST', '/api/auth/login', { body: { login, password, client: this.o.client ?? 'web' }, auth: false })
    if (r.status === 'ok') await this.setToken(r.token)
    return r
  }
  async selectTenant(selectTicket: string, tenantId: string) {
    const r = await this.request<LoginResponse>('POST', '/api/auth/select-tenant', { body: { selectTicket, tenantId }, auth: false })
    if (r.status === 'ok') await this.setToken(r.token)
    return r
  }
  async logout() {
    await this.request('POST', '/api/auth/logout', { body: {} }).catch(() => {})
    await this.setToken(null)
  }
  bootstrap = () => this.get<Bootstrap>('/api/session/bootstrap')
  branding = () => this.request<PublicBranding>('GET', '/api/public/branding', { auth: false })

  /* ───────── 单据:幂等提交 ───────── */

  /**
   * 保存/保存并审核。clientRequestId 随请求提交;超时或断网时抛出 ApiError(NETWORK|TIMEOUT),
   * 调用方应保留本地草稿(含同一个 clientRequestId)并提供重新提交入口。
   */
  saveDocument(input: Record<string, unknown>, opts: { clientRequestId?: string; autoAudit?: boolean; confirmCredit?: boolean; version?: number } = {}) {
    return this.post<SaveDocumentResponse>('/api/documents', { ...input, clientRequestId: opts.clientRequestId, autoAudit: opts.autoAudit, confirmCredit: opts.confirmCredit, version: opts.version })
  }
}

export function newClientRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  // 小程序环境无 crypto.randomUUID:退回到随机串(仅用于幂等去重,不涉及安全)
  const r = () => Math.random().toString(16).slice(2, 10)
  return `${Date.now().toString(16)}-${r()}-${r()}-${r()}`
}

/* ───────── 离线草稿(小程序) ───────── */

export interface LocalDraft {
  clientRequestId: string
  savedAt: number
  /** 提交给后端的单据载荷 */
  input: Record<string, unknown>
  /** 页面表单快照(含界面状态),用于重新打开小程序后恢复编辑;可选 */
  form?: unknown
  autoAudit: boolean
  error?: string
}
const DRAFT_KEY = 'erp.drafts'

/** 本地草稿箱:单据内容与 clientRequestId 持久化,直至提交成功或用户主动删除;重启后仍可恢复(需求 19.7) */
export class DraftStore {
  constructor(private storage: Storage) {}
  async list(): Promise<LocalDraft[]> {
    const raw = await this.storage.get(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as LocalDraft[]) : []
  }
  private async write(list: LocalDraft[]) {
    await this.storage.set(DRAFT_KEY, JSON.stringify(list))
  }
  async put(d: LocalDraft) {
    const list = (await this.list()).filter((x) => x.clientRequestId !== d.clientRequestId)
    await this.write([d, ...list])
  }
  async remove(clientRequestId: string) {
    await this.write((await this.list()).filter((x) => x.clientRequestId !== clientRequestId))
  }

  /**
   * 提交一张草稿。成功则删除本地草稿;网络类失败保留并记录原因;
   * 业务拒绝(422/409)同样保留,让用户修改后用同一 clientRequestId 重试。
   */
  async submit(api: ApiClient, d: LocalDraft, extra: { confirmCredit?: boolean } = {}): Promise<{ ok: true; response: SaveDocumentResponse } | { ok: false; error: ApiError }> {
    try {
      const response = await api.saveDocument(d.input, { clientRequestId: d.clientRequestId, autoAudit: d.autoAudit, confirmCredit: extra.confirmCredit })
      // 保存成功即移除;保存并审核时审核失败(单据已保存为草稿)也算提交成功,原因交给页面显示
      await this.remove(d.clientRequestId)
      return { ok: true, response }
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, 'NETWORK', (e as Error).message)
      await this.put({ ...d, error: error.message })
      return { ok: false, error }
    }
  }
}

/* ───────── 类型 ───────── */

export type LoginResponse =
  | { status: 'ok'; token: string; tenant: { id: string; name: string }; user: { id: string; name: string; isTenantAdmin: boolean }; mustChangePassword: boolean }
  | { status: 'select_tenant'; selectTicket: string; tenants: { id: string; name: string }[] }
  | { status: 'need_bind'; bindTicket: string }

export interface Bootstrap {
  user: { id: string; name: string; isTenantAdmin: boolean; mustChangePassword: boolean }
  tenant: { id: string; name: string }
  permissions: { isAdmin: boolean; permissions: string[]; dataScope: { all: boolean; warehouseIds: string[]; own: boolean } }
  modules: string[]
  expired: boolean
  licenseReminder: { expireDate: string; daysLeft: number } | null
  settings: { qtyScale: number; priceScale: number; amountScale: number; allowNegativeStock: boolean; requireAudit: boolean; multiUnit: boolean; multiSku: boolean; barcodeEnabled: boolean }
  branding: { systemName: string; themeColor: string; copyright: string; logoUrl: string | null; loginBgUrl: string | null }
  customFields: Record<string, { code: string; label: string; type: string; required: boolean; options?: string[]; displayOrder: number; showInList: boolean; filterable: boolean; defaultValue?: unknown }[]>
}

export interface PublicBranding {
  systemName: string
  themeColor: string
  copyright: string
  logoUrl: string | null
  loginBgUrl: string | null
}

export interface SaveDocumentResponse {
  doc: { id: string; docNo: string; status: 'draft' | 'audited' | 'voided'; version: number; totalAmount: string; [k: string]: unknown }
  replayed: boolean
  auditError?: { code: string; message: string; details?: ErrorDetail[] }
}

/** 是否拥有权限(菜单与按钮的显隐;需求 10.9) */
export function can(b: Pick<Bootstrap, 'permissions'>, code: string): boolean {
  return b.permissions.isAdmin || b.permissions.permissions.includes(code)
}
/** 菜单是否可见:模块已启用 + 菜单权限 */
export function menuVisible(b: Bootstrap, menu: string, module?: string): boolean {
  return (!module || b.modules.includes(module)) && can(b, `menu:${menu}`)
}

/** 按主题色派生 Element Plus 的色阶(light-3/5/7/8/9、dark-2),用于白标(需求 5.2) */
export function themeShades(hex: string): Record<string, string> {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error('invalid color')
  const n = parseInt(m[1], 16)
  const rgb: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const mix = (c: number, w: number, ratio: number) => Math.round(c * (1 - ratio) + w * ratio)
  const to = (c: number[]) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('')
  const out: Record<string, string> = { '': hex.toLowerCase() }
  for (const [name, r] of [['light-3', 0.3], ['light-5', 0.5], ['light-7', 0.7], ['light-8', 0.8], ['light-9', 0.9]] as const) out[name] = to(rgb.map((c) => mix(c, 255, r)))
  out['dark-2'] = to(rgb.map((c) => mix(c, 0, 0.2)))
  return out
}
