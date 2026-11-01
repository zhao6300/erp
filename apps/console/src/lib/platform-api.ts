import { ERROR_MESSAGE, ErrorBody } from '@erp/shared'

const KEY = 'erp.platform.token'

export class PlatformError extends Error {
  constructor(
    public status: number,
    public body: Partial<ErrorBody>,
  ) {
    super(body.message ?? ERROR_MESSAGE[body.code as keyof typeof ERROR_MESSAGE] ?? '请求失败')
  }
}

/** 平台管理员会话独立于租户会话 */
export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem(KEY)
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    if (res.status === 401) localStorage.removeItem(KEY)
    throw new PlatformError(res.status, json ?? {})
  }
  return json as T
}
export const saveToken = (t: string) => localStorage.setItem(KEY, t)
export const hasToken = () => !!localStorage.getItem(KEY)
export const clearToken = () => localStorage.removeItem(KEY)

/** 开通表单校验:一次性返回全部未通过字段(与后端同一规则;需求 1.7) */
export function validateTenantForm(f: { name: string; contact: string; phone: string; expireDate: string; modules: string[]; maxUsers: number; maxWarehouses: number }): Record<string, string> {
  const e: Record<string, string> = {}
  const name = f.name.trim()
  if (!name || name.length > 100) e.name = '企业名称为 1–100 个字符'
  if (!f.contact.trim() || f.contact.trim().length > 50) e.contact = '联系人为 1–50 个字符'
  if (!/^1[3-9]\d{9}$/.test(f.phone)) e.phone = '手机号须为 11 位中国大陆手机号'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.expireDate)) e.expireDate = '请选择截止日期'
  if (!f.modules.length) e.modules = '至少授权 1 个模块'
  if (!Number.isInteger(f.maxUsers) || f.maxUsers < 1 || f.maxUsers > 9999) e.maxUsers = '最大用户数为 1–9999'
  if (!Number.isInteger(f.maxWarehouses) || f.maxWarehouses < 1 || f.maxWarehouses > 999) e.maxWarehouses = '最大仓库数为 1–999'
  return e
}
