import type { Storage } from '@erp/api-client'

/**
 * 小程序运行时 API 的最小抽象。页面里传入 uni.*,测试里传入替身。
 * 这样业务逻辑不依赖 uni-app 编译器就能在 Node 里验证。
 */
export interface Platform {
  storage: Storage
  /** uni.scanCode 的封装:取消扫码返回 null */
  scanCode(): Promise<string | null>
  /** uni.request 的 fetch 兼容封装,供 ApiClient 使用 */
  fetch: typeof fetch
}

/** uni.setStorage / getStorage 的同步封装(小程序存储 key 需长度合规) */
export function uniStorage(uni: {
  getStorageSync(k: string): string
  setStorageSync(k: string, v: string): void
  removeStorageSync(k: string): void
}): Storage {
  return {
    get: (k) => uni.getStorageSync(k) || null,
    set: (k, v) => uni.setStorageSync(k, v),
    remove: (k) => uni.removeStorageSync(k),
  }
}

/** 把 uni.request 包装成 fetch 兼容的函数(小程序没有 fetch)。超时由 ApiClient 的 AbortController 控制 */
export function uniFetch(uni: {
  request(o: { url: string; method: string; header: Record<string, string>; data?: string; dataType: string; responseType: string; success(r: { statusCode: number; data: unknown }): void; fail(e: { errMsg: string }): void }): { abort(): void }
}): typeof fetch {
  return ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const task = uni.request({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        header: (init?.headers as Record<string, string>) ?? {},
        data: init?.body as string | undefined,
        dataType: 'text',
        responseType: 'text',
        success: (r) => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, text: async () => String(r.data ?? '') } as Response),
        fail: (e) => reject(new TypeError(e.errMsg)),
      })
      init?.signal?.addEventListener('abort', () => {
        task.abort()
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })) as typeof fetch
}

/** 分享相关的 uni/wx 调用封装(见 share.ts) */
export function uniSharePlatform(
  uni: { downloadFile(o: { url: string; header: Record<string, string>; success(r: { statusCode: number; tempFilePath: string }): void; fail(e: { errMsg: string }): void }): void },
  wx: {
    shareFileMessage(o: { filePath: string; fileName: string; success(): void; fail(e: { errMsg: string }): void }): void
    showShareImageMenu(o: { path: string; success(): void; fail(e: { errMsg: string }): void }): void
  },
): import('./share').SharePlatform {
  return {
    download: (o) => new Promise((resolve, reject) => uni.downloadFile({ ...o, success: resolve, fail: (e) => reject(new Error(e.errMsg)) })),
    shareFile: (o) => new Promise((resolve, reject) => wx.shareFileMessage({ ...o, success: () => resolve(), fail: reject })),
    shareImage: (path) => new Promise((resolve, reject) => wx.showShareImageMenu({ path, success: () => resolve(), fail: reject })),
  }
}
