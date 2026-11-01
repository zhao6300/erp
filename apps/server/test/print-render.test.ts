import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PAPERS, PaperCode } from '@erp/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { PrintRenderer } from '../src/config/print-renderer'
import { buildApp } from '../src/http/app'
import { TenantFixture, TestApp, World, createTestApp } from './support/app'

// PDF/图片输出(需求 20.8)。使用真实的 Chromium:需要先执行 `npx playwright-core install chromium-headless-shell`,
// 容器里以 root 运行时设置 CHROMIUM_NO_SANDBOX=true。生成中文需要系统里有 CJK 字体(见 deploy/Dockerfile)。

const HTTPS = { 'x-forwarded-proto': 'https' }
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![\w])/g) ?? []).length
const pngSize = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) })
const noSandbox = process.getuid?.() === 0

let app: TestApp
let f: TenantFixture
let w: World
let server: FastifyInstance
let token: string
let renderer: PrintRenderer
let sku: string

async function salesDoc(lines: number): Promise<{ id: string; docNo: string; version: number }> {
  const customer = await w.partner('P' + Math.random().toString(36).slice(2, 8), 'customer')
  const r = await w.save(w.doc('sales_out', { partnerId: customer, lines: Array.from({ length: lines }, () => w.line(sku, '1', '10')) }))
  return { id: r.doc.id, docNo: r.doc.docNo!, version: r.doc.version }
}

beforeAll(async () => {
  renderer = new PrintRenderer({ noSandbox })
  app = await createTestApp(inject('pgAdminUrl'), { renderer })
  f = await app.newTenant()
  w = new World(app, f)
  sku = await w.product('PR1')
  // 出库需要库存
  const sup = await w.partner('PRS', 'supplier')
  await w.saveAudit(w.doc('purchase_in', { partnerId: sup, lines: [w.line(sku, '500', '5')] }))
  server = await buildApp(app.c)
  const login = await app.c.auth.loginByPassword(f.adminPhone, f.adminPassword, 'web')
  if (login.status !== 'ok') throw new Error('login failed')
  token = login.token
})
afterAll(async () => {
  await server.close()
  await app.close() // 容器关闭时一并关闭渲染器的浏览器
})

describe('打印渲染:PDF 与图片', () => {
  it('PDF:是有效的 PDF,页数等于排版分页数;多页单据按分页输出', async () => {
    for (const lines of [3, 80]) {
      const d = await salesDoc(lines)
      const html = await app.c.print.renderHtml(f.admin, d.id)
      const out = await app.c.print.renderDocument(f.admin, d.id, 'pdf')
      const pdf = out.body as Buffer
      expect(out.mime).toBe('application/pdf')
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdfPages(pdf)).toBe(html.pages)
      if (lines === 80) expect(html.pages).toBeGreaterThan(1)
    }
  })

  it('PNG:宽度等于纸张宽度(2 倍像素密度),高度不为 0', async () => {
    const d = await salesDoc(2)
    const out = await app.c.print.renderDocument(f.admin, d.id, 'png')
    const png = out.body as Buffer
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    const { w: width, h } = pngSize(png)
    expect(width).toBe(Math.ceil(PAPERS.A4.w * (96 / 25.4)) * 2)
    expect(h).toBeGreaterThan(0)
  })

  it('每种纸张规格都能输出 PDF,包含 80mm 小票(长度随内容)', async () => {
    const d = await salesDoc(5)
    const { html } = await app.c.print.renderHtml(f.admin, d.id)
    for (const paper of Object.keys(PAPERS) as PaperCode[]) {
      const pdf = await renderer.render(html, paper, 'pdf')
      expect(pdf.subarray(0, 5).toString(), paper).toBe('%PDF-')
      expect(pdfPages(pdf), paper).toBeGreaterThanOrEqual(1)
    }
  })

  it('渲染时不执行脚本、不发起任何网络请求(SSRF 防护)', async () => {
    const hits: string[] = []
    const probe = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_1X1)
    })
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
    try {
      const html = `<!doctype html><html><head><link rel="stylesheet" href="${base}/css"><script src="${base}/js"></script></head>
        <body><img src="${base}/img"><iframe src="${base}/frame"></iframe><script>new Image().src='${base}/inline-script'</script></body></html>`
      const pdf = await renderer.render(html, 'A4', 'pdf')
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      await new Promise((r) => setTimeout(r, 300))
      expect(hits).toEqual([])
    } finally {
      probe.close()
    }
  })

  it('脚本不会执行:带"隐藏页面"脚本的页面与不带脚本的页面渲染结果完全一致', async () => {
    const page = (script: string) => `<!doctype html><html><body style="margin:0"><h1 style="font-size:40px">hello</h1>${script}</body></html>`
    const plain = await renderer.render(page(''), 'A5', 'png')
    const withScript = await renderer.render(page('<script>document.body.style.display="none"</script>'), 'A5', 'png')
    expect(withScript.equals(plain)).toBe(true)
    // 对照:确认这个检测方法本身能发现差异(内容不同则字节不同)
    const different = await renderer.render(page('<p style="font-size:40px">more</p>'), 'A5', 'png')
    expect(different.equals(plain)).toBe(false)
  })

  it('data: 图片可以正常渲染', async () => {
    const png = await renderer.render(`<html><body style="margin:0"><img src="data:image/png;base64,${PNG_1X1.toString('base64')}" style="width:50px;height:50px"></body></html>`, 'A5', 'png')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })

  it('排队超限时直接失败为 PRINT_FAILED,不会无限堆积', async () => {
    const tight = new PrintRenderer({ noSandbox, concurrency: 1, maxQueue: 0 })
    try {
      const slow = tight.render('<html><body>a</body></html>', 'A4', 'pdf')
      await expect(tight.render('<html><body>b</body></html>', 'A4', 'pdf')).rejects.toMatchObject({ code: 'PRINT_FAILED' })
      expect((await slow).subarray(0, 5).toString()).toBe('%PDF-')
      // 名额已释放,之后可以继续渲染
      expect((await tight.render('<html><body>c</body></html>', 'A4', 'pdf')).length).toBeGreaterThan(100)
    } finally {
      await tight.close()
    }
  })

  it('超时会返回 PRINT_FAILED 而不是一直挂起', async () => {
    const t = new PrintRenderer({ noSandbox, timeoutMs: 1 })
    try {
      await expect(t.render('<html><body>x</body></html>', 'A4', 'pdf')).rejects.toMatchObject({ code: 'PRINT_FAILED' })
    } finally {
      await t.close()
    }
  })

  it('浏览器进程崩溃后下一次渲染自动恢复', async () => {
    const r = new PrintRenderer({ noSandbox })
    try {
      await r.render('<html><body>1</body></html>', 'A4', 'pdf')
      const b = await (r as unknown as { browser: Promise<{ close(): Promise<void> }> }).browser
      await b.close() // 模拟进程消失
      const pdf = await r.render('<html><body>2</body></html>', 'A4', 'pdf')
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    } finally {
      await r.close()
    }
  })
})

describe('租户 Logo', () => {
  it('Logo 内联到打印 HTML 中(data URI),未设置 Logo 时占位符为空', async () => {
    const d = await salesDoc(1)
    // 默认模板不一定包含 branding.logo,这里把它加进表头
    const tpl = (await app.c.db.withTenant(f.id, (tx) => app.c.print.list(tx, 'sales_out'))).find((t) => t.isDefault)!
    const layout = { ...tpl.layout, header: [...tpl.layout.header, { text: '{{branding.logo}}', x: 150, y: 2, fontSize: 10, visible: true }] }
    await app.c.db.withTenant(f.id, (tx) => app.c.print.update(tx, f.admin, tpl.id, { paper: tpl.paper, layout }))

    expect((await app.c.print.renderHtml(f.admin, d.id)).html).not.toContain('data:image')

    await app.c.db.withTenant(f.id, async (tx) => {
      const up = await app.c.branding.uploadImage(tx, f.admin, PNG_1X1)
      await app.c.branding.save(tx, f.admin, f.id, { systemName: '品牌A', logoFileId: up.id })
    })
    const html = (await app.c.print.renderHtml(f.admin, d.id)).html
    expect(html).toContain(`<img src="data:image/png;base64,${PNG_1X1.toString('base64')}"`)
    // 带 Logo 的单据同样可以输出 PDF
    const pdf = (await app.c.print.renderDocument(f.admin, d.id, 'pdf')).body as Buffer
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})

describe('GET /api/documents/:id/print', () => {
  const auth = () => ({ ...HTTPS, authorization: `Bearer ${token}` })

  it('format=pdf / png 返回对应类型;download=1 时带附件文件名', async () => {
    const d = await salesDoc(2)
    const pdf = await server.inject({ method: 'GET', url: `/api/documents/${d.id}/print?format=pdf&download=1`, headers: auth() })
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="${d.docNo}.pdf"`)
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')

    const png = await server.inject({ method: 'GET', url: `/api/documents/${d.id}/print?format=png`, headers: auth() })
    expect(png.headers['content-type']).toBe('image/png')
    expect(png.headers['content-disposition']).toBeUndefined()
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG')

    const html = await server.inject({ method: 'GET', url: `/api/documents/${d.id}/print`, headers: auth() })
    expect(html.headers['content-type']).toContain('text/html')
  })

  it('format 非法返回 422;未登录返回 401', async () => {
    const d = await salesDoc(1)
    const bad = await server.inject({ method: 'GET', url: `/api/documents/${d.id}/print?format=exe`, headers: auth() })
    expect(bad.statusCode).toBe(422)
    expect((await server.inject({ method: 'GET', url: `/api/documents/${d.id}/print?format=pdf`, headers: HTTPS })).statusCode).toBe(401)
  })

  it('另一个租户读取不到本租户的单据(PDF 也不例外)', async () => {
    const d = await salesDoc(1)
    const other = await app.newTenant()
    const login = await app.c.auth.loginByPassword(other.adminPhone, other.adminPassword, 'web')
    if (login.status !== 'ok') throw new Error('login failed')
    const res = await server.inject({ method: 'GET', url: `/api/documents/${d.id}/print?format=pdf`, headers: { ...HTTPS, authorization: `Bearer ${login.token}` } })
    expect(res.statusCode).toBe(404)
  })
})
