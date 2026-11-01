import type { ApiClient } from '@erp/api-client'

/**
 * 单据分享(需求 20.8):后端按默认模板生成 PDF/图片 → 下载到本地临时文件 → 调起微信发送界面。
 * 与微信相关的调用都经 SharePlatform 注入,页面里传 uni/wx,测试里传替身。
 */
export type ShareFormat = 'pdf' | 'png'

export interface SharePlatform {
  /** uni.downloadFile 的封装。网络失败时 reject;HTTP 非 200 也会 resolve,由调用方检查 statusCode */
  download(o: { url: string; header: Record<string, string> }): Promise<{ statusCode: number; tempFilePath: string }>
  /** wx.shareFileMessage:把文件发给好友/群 */
  shareFile(o: { filePath: string; fileName: string }): Promise<void>
  /** wx.showShareImageMenu:图片转发菜单 */
  shareImage(filePath: string): Promise<void>
}

export type ShareResult = { ok: true } | { ok: false; message: string; cancelled?: boolean }

const HTTP_MESSAGE: Record<number, string> = {
  401: '登录已过期,请重新登录',
  403: '没有该单据的打印权限',
  404: '单据不存在或已被删除',
  429: '操作太频繁,请稍后重试',
}

/** 文件名里不能出现路径分隔符等字符 */
export const safeFileName = (docNo: string | null | undefined, ext: string): string => `${(docNo || '单据').replace(/[\\/:*?"<>|\s]+/g, '_')}.${ext}`

export async function shareDocument(api: Pick<ApiClient, 'token' | 'printUrl'>, platform: SharePlatform, doc: { id: string; docNo?: string | null }, format: ShareFormat): Promise<ShareResult> {
  const token = await api.token()
  if (!token) return { ok: false, message: HTTP_MESSAGE[401] }

  let file: { statusCode: number; tempFilePath: string }
  try {
    file = await platform.download({ url: api.printUrl(doc.id, format), header: { Authorization: `Bearer ${token}` } })
  } catch {
    return { ok: false, message: '网络异常,下载单据失败' }
  }
  // downloadFile 在 4xx/5xx 时也会把错误响应体存成临时文件,必须先看状态码,不能把它当 PDF 发出去
  if (file.statusCode !== 200) return { ok: false, message: HTTP_MESSAGE[file.statusCode] ?? '生成单据文件失败,请稍后重试' }

  try {
    if (format === 'png') await platform.shareImage(file.tempFilePath)
    else await platform.shareFile({ filePath: file.tempFilePath, fileName: safeFileName(doc.docNo, 'pdf') })
    return { ok: true }
  } catch (e) {
    // 用户在发送界面点取消:微信返回 errMsg 含 "cancel"
    const msg = String((e as { errMsg?: string }).errMsg ?? (e as Error)?.message ?? '')
    if (/cancel/i.test(msg)) return { ok: false, message: '已取消', cancelled: true }
    return { ok: false, message: '调起微信发送失败' }
  }
}
