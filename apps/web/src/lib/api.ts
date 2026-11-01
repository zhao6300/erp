import { ApiClient, Storage } from '@erp/api-client'
import { router } from '../router'

const storage: Storage = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
}

/** 全局 API 客户端:401 清除令牌并跳转登录页(需求 9.7) */
export const api = new ApiClient({
  baseUrl: '',
  storage,
  client: 'web',
  onUnauthenticated: () => {
    if (router.currentRoute.value.path !== '/login') void router.replace({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
  },
})
