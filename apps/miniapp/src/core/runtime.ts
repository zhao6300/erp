import { ApiClient, Bootstrap, DraftStore, themeShades } from '@erp/api-client'
import { uniFetch, uniStorage } from './platform'

declare const uni: any

/** 后端地址在 manifest 之外配置:构建时通过环境变量注入 */
const BASE_URL = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? 'https://erp.example.com'

const storage = uniStorage(uni)
export const api = new ApiClient({
  baseUrl: BASE_URL,
  storage,
  fetch: uniFetch(uni),
  client: 'miniapp',
  // 401:清除令牌并回到登录页(需求 9.7)
  onUnauthenticated: () => uni.reLaunch({ url: '/pages/login/login' }),
})
export const drafts = new DraftStore(storage)

let boot: Bootstrap | null = null
export async function bootstrap(force = false): Promise<Bootstrap> {
  if (!boot || force) boot = await api.bootstrap()
  return boot
}

/** 品牌:主题色通过根节点 CSS 变量与导航栏颜色应用(需求 5.2) */
export async function applyBrand() {
  try {
    const b = await api.branding()
    uni.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: themeShades(b.themeColor)[''] })
    uni.setNavigationBarTitle({ title: b.systemName })
    return b
  } catch {
    return null
  }
}

export { ENTRIES, visibleEntries } from './entries'
