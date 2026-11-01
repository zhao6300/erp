import { describe, expect, it } from 'vitest'
import { SharePlatform, safeFileName, shareDocument } from '../src/core/share'

const api = (token: string | null = 'tok') => ({ token: async () => token, printUrl: (id: string, fmt = 'pdf') => `https://erp.test/api/documents/${id}/print?format=${fmt}&download=1` })

function fake(over: Partial<SharePlatform> = {}) {
  const calls: { kind: string; arg: unknown }[] = []
  const p: SharePlatform = {
    download: async (o) => (calls.push({ kind: 'download', arg: o }), { statusCode: 200, tempFilePath: 'wxfile://tmp/a' }),
    shareFile: async (o) => void calls.push({ kind: 'shareFile', arg: o }),
    shareImage: async (path) => void calls.push({ kind: 'shareImage', arg: path }),
    ...over,
  }
  return { p, calls }
}

describe('单据分享(需求 20.8)', () => {
  it('PDF:带令牌下载服务端生成的文件,再以单号命名发送', async () => {
    const { p, calls } = fake()
    expect(await shareDocument(api(), p, { id: 'd1', docNo: 'XSCK202609300001' }, 'pdf')).toEqual({ ok: true })
    expect(calls).toEqual([
      { kind: 'download', arg: { url: 'https://erp.test/api/documents/d1/print?format=pdf&download=1', header: { Authorization: 'Bearer tok' } } },
      { kind: 'shareFile', arg: { filePath: 'wxfile://tmp/a', fileName: 'XSCK202609300001.pdf' } },
    ])
  })

  it('图片:走图片转发菜单,请求 format=png', async () => {
    const { p, calls } = fake()
    expect(await shareDocument(api(), p, { id: 'd1', docNo: 'A1' }, 'png')).toEqual({ ok: true })
    expect(calls.map((c) => c.kind)).toEqual(['download', 'shareImage'])
    expect((calls[0].arg as { url: string }).url).toContain('format=png')
  })

  it('服务端返回错误状态码时不发送(错误响应体也会被存成临时文件,不能当 PDF 发出去)', async () => {
    for (const [code, text] of [[401, '登录已过期'], [403, '没有该单据的打印权限'], [404, '单据不存在'], [500, '生成单据文件失败'], [422, '生成单据文件失败']] as const) {
      const { p, calls } = fake({ download: async () => ({ statusCode: code, tempFilePath: 'wxfile://tmp/error-body' }) })
      const r = await shareDocument(api(), p, { id: 'd1', docNo: 'A1' }, 'pdf')
      expect(r).toMatchObject({ ok: false })
      expect((r as { message: string }).message).toContain(text)
      expect(calls.filter((c) => c.kind.startsWith('share'))).toEqual([])
    }
  })

  it('未登录:不发请求;网络失败:给出明确提示', async () => {
    const a = fake()
    expect(await shareDocument(api(null), a.p, { id: 'd1' }, 'pdf')).toMatchObject({ ok: false })
    expect(a.calls).toEqual([])
    const b = fake({ download: async () => { throw new Error('request:fail') } })
    expect(await shareDocument(api(), b.p, { id: 'd1' }, 'pdf')).toEqual({ ok: false, message: '网络异常,下载单据失败' })
  })

  it('用户在微信发送界面取消不算失败;其他错误才提示', async () => {
    const cancel = fake({ shareFile: async () => { throw { errMsg: 'shareFileMessage:fail cancel' } } })
    expect(await shareDocument(api(), cancel.p, { id: 'd1', docNo: 'A' }, 'pdf')).toEqual({ ok: false, message: '已取消', cancelled: true })
    const broken = fake({ shareFile: async () => { throw { errMsg: 'shareFileMessage:fail system error' } } })
    expect(await shareDocument(api(), broken.p, { id: 'd1', docNo: 'A' }, 'pdf')).toEqual({ ok: false, message: '调起微信发送失败' })
  })

  it('文件名:去掉路径与特殊字符;草稿没有单号时用默认名', () => {
    expect(safeFileName('A/B\\C:1', 'pdf')).toBe('A_B_C_1.pdf')
    expect(safeFileName(null, 'pdf')).toBe('单据.pdf')
    expect(safeFileName('', 'png')).toBe('单据.png')
  })
})
