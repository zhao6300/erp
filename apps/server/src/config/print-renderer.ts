import { AppError, PAPERS, PaperCode } from '@erp/shared'
import type { Browser } from 'playwright-core'

export type RenderFormat = 'pdf' | 'png'

export interface RendererOptions {
  /** 系统浏览器路径(Docker 镜像里是 /usr/bin/chromium);缺省使用 Playwright 自带下载的 Chromium */
  executablePath?: string
  /** 容器内以 root 运行时 Chromium 沙箱不可用,需要关闭 */
  noSandbox?: boolean
  /** 同时渲染的页面数上限,其余排队 */
  concurrency?: number
  /** 排队上限,超出直接失败,避免打印请求堆积拖垮进程 */
  maxQueue?: number
  /** 单次渲染超时 */
  timeoutMs?: number
}

const MM_TO_PX = 96 / 25.4

/**
 * 把打印 HTML 渲染为 PDF 或图片(需求 20.8)。
 * - 一个共享浏览器进程,按需启动,崩溃后下次调用自动重启
 * - 每次渲染使用独立的无痕上下文,禁用 JavaScript,并拦截除 data: 之外的所有请求:
 *   打印 HTML 含租户配置的文本,不允许它触发任何网络访问(SSRF)或执行脚本
 * - PDF 版式与浏览器打印共用同一份 HTML 和 @page 尺寸,分页由 renderPrintHtml 决定
 */
export class PrintRenderer {
  private browser: Promise<Browser> | null = null
  private active = 0
  private waiting: (() => void)[] = []
  private readonly o: Required<Omit<RendererOptions, 'executablePath'>> & { executablePath?: string }

  constructor(opts: RendererOptions = {}) {
    this.o = { executablePath: opts.executablePath, noSandbox: opts.noSandbox ?? false, concurrency: opts.concurrency ?? 2, maxQueue: opts.maxQueue ?? 20, timeoutMs: opts.timeoutMs ?? 20_000 }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) {
      const b = await this.browser.catch(() => null)
      if (b?.isConnected()) return b
      this.browser = null
    }
    this.browser = (async () => {
      const { chromium } = await import('playwright-core')
      const b = await chromium.launch({ headless: true, executablePath: this.o.executablePath, args: this.o.noSandbox ? ['--no-sandbox'] : [] })
      b.on('disconnected', () => {
        this.browser = null
      })
      return b
    })()
    try {
      return await this.browser
    } catch (e) {
      this.browser = null
      throw e
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.o.concurrency) {
      this.active++
      return
    }
    if (this.waiting.length >= this.o.maxQueue) throw new AppError('PRINT_FAILED', '打印任务过多,请稍后重试')
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next() // 名额直接转交给排队者
    else this.active--
  }

  async render(html: string, paper: PaperCode, format: RenderFormat): Promise<Buffer> {
    await this.acquire()
    try {
      return await Promise.race([this.renderNow(html, paper, format), new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('render timeout')), this.o.timeoutMs).unref())])
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError('PRINT_FAILED', `生成${format === 'pdf' ? ' PDF ' : '图片'}失败`, [{ reason: (e as Error).message }])
    } finally {
      this.release()
    }
  }

  private async renderNow(html: string, paper: PaperCode, format: RenderFormat): Promise<Buffer> {
    const spec = PAPERS[paper]
    const widthPx = Math.ceil(spec.w * MM_TO_PX)
    const browser = await this.getBrowser()
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: widthPx, height: Math.ceil((spec.h ?? 297) * MM_TO_PX) }, deviceScaleFactor: format === 'png' ? 2 : 1 })
    try {
      await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()))
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      if (format === 'png') return await page.screenshot({ type: 'png', fullPage: true })
      if (spec.h !== null) return await page.pdf({ preferCSSPageSize: true, printBackground: true })
      // 80mm 小票:长度随内容。JS 已禁用,通过 CDP 取内容高度
      const cdp = await context.newCDPSession(page)
      const m = (await cdp.send('Page.getLayoutMetrics')) as { cssContentSize: { height: number } }
      return await page.pdf({ width: `${spec.w}mm`, height: `${Math.ceil(m.cssContentSize.height)}px`, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } })
    } finally {
      await context.close().catch(() => {})
    }
  }

  async close(): Promise<void> {
    const b = this.browser
    this.browser = null
    if (b) await (await b.catch(() => null))?.close().catch(() => {})
  }
}
