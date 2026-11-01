import type { ValidationIssue } from './errors'
import type { FieldDef } from './customFields'
import type { DocType } from './types'

export type PaperCode = 'A4' | 'A5' | 'HALF' | 'THIRD' | 'R80'

/** 纸张规格(毫米)。R80 小票宽 80,长度随内容连续延伸(需求 20.2) */
export const PAPERS: Record<PaperCode, { label: string; w: number; h: number | null }> = {
  A4: { label: 'A4', w: 210, h: 297 },
  A5: { label: 'A5', w: 148, h: 210 },
  HALF: { label: '二等分', w: 241, h: 140 },
  THIRD: { label: '三等分', w: 241, h: 93 },
  R80: { label: '80毫米小票', w: 80, h: null },
}

export interface PrintElement {
  /** 含占位符的文本,如 "单号:{{header.docNo}}" */
  text: string
  x: number
  y: number
  fontSize: number
  visible: boolean
  align?: 'left' | 'center' | 'right'
}
export interface PrintColumn {
  /** 明细列占位符,如 "{{line.qty}}" */
  field: string
  title: string
  width: number
  fontSize: number
  visible: boolean
  align?: 'left' | 'center' | 'right'
}
export interface PrintLayout {
  metrics: {
    margin: number
    headerHeight: number
    columnTitleHeight: number
    rowHeight: number
    totalsHeight: number
    footerHeight: number
  }
  header: PrintElement[]
  columns: PrintColumn[]
  totals: PrintElement[]
  footer: PrintElement[]
}
export interface PrintTemplateLike {
  paper: PaperCode
  layout: PrintLayout
}

export interface Page {
  index: number // 从 1 开始
  total: number
  rowStart: number // 含
  rowEnd: number // 不含
  showTotals: boolean
  label: string // 第 X 页 / 共 Y 页
}

function capacity(t: PrintTemplateLike, withTotals: boolean): number {
  const paper = PAPERS[t.paper]
  const m = t.layout.metrics
  if (paper.h === null) return Number.MAX_SAFE_INTEGER
  const avail = paper.h - 2 * m.margin - m.headerHeight - m.columnTitleHeight - m.footerHeight - (withTotals ? m.totalsHeight : 0)
  return Math.max(1, Math.floor(avail / m.rowHeight))
}

/**
 * 按整行分页(需求 20.7):单个明细行不跨页拆分;每页重复表头与列标题;仅末页显示合计;页码“第 X 页 / 共 Y 页”。
 * 小票为单页连续长度。
 */
export function paginate(template: PrintTemplateLike, rows: number): Page[] {
  const cap = capacity(template, false)
  const capLast = capacity(template, true)
  const ranges: [number, number][] = []
  let start = 0
  let remaining = rows
  while (remaining > capLast) {
    // 末页要能放下合计:当剩余行数超过末页容量时,先切一页;至少给末页留 1 行
    const take = Math.min(cap, remaining - 1)
    ranges.push([start, start + take])
    start += take
    remaining -= take
  }
  ranges.push([start, start + remaining])
  const total = ranges.length
  return ranges.map(([a, b], i) => ({
    index: i + 1,
    total,
    rowStart: a,
    rowEnd: b,
    showTotals: i === total - 1,
    label: `第 ${i + 1} 页 / 共 ${total} 页`,
  }))
}

/* ───────────────────────── 占位符 ───────────────────────── */

const COMMON_HEADER = ['docNo', 'docDate', 'status', 'partnerName', 'handlerName', 'createdByName', 'remark', 'warehouseName', 'totalAmount', 'docDiscount', 'paidAmount', 'fundAccountName', 'printTime']
const HEADER_BY_TYPE: Partial<Record<DocType, string[]>> = {
  transfer: ['toWarehouseName'],
  sales_out: ['grossProfit', 'receivableAmount'],
  sales_return: ['upstreamNo'],
  purchase_in: ['payableAmount'],
  purchase_return: ['upstreamNo'],
  receipt: ['categoryName'],
  payment: ['categoryName'],
  other_income: ['categoryName'],
  other_expense: ['categoryName'],
}
const COMMON_LINE = ['lineNo', 'skuCode', 'productName', 'spec', 'unitName', 'qty', 'price', 'discountRate', 'amount', 'warehouseName', 'barcode']
const LINE_BY_TYPE: Partial<Record<DocType, string[]>> = {
  sales_out: ['costPrice', 'lineProfit'],
  stocktake: ['snapshotQty', 'countedQty', 'diffQty'],
}

const CUSTOM_OBJECT_FOR_DOC: Partial<Record<DocType, 'purchase_doc' | 'sales_doc'>> = {
  purchase_order: 'purchase_doc',
  purchase_in: 'purchase_doc',
  purchase_return: 'purchase_doc',
  sales_order: 'sales_doc',
  sales_out: 'sales_doc',
  sales_return: 'sales_doc',
}

/** 当前单据类型可用的占位符集合(启用状态的 Custom_Field 计入;需求 20.3) */
export function availablePlaceholders(docType: DocType, customFields: Pick<FieldDef, 'code' | 'enabled'>[] = []): Set<string> {
  const out = new Set<string>()
  for (const k of [...COMMON_HEADER, ...(HEADER_BY_TYPE[docType] ?? [])]) out.add(`header.${k}`)
  for (const k of [...COMMON_LINE, ...(LINE_BY_TYPE[docType] ?? [])]) out.add(`line.${k}`)
  out.add('branding.logo')
  out.add('tenant.name')
  if (CUSTOM_OBJECT_FOR_DOC[docType]) for (const f of customFields) if (f.enabled) out.add(`cf.${f.code}`)
  return out
}

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

export function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1])
}

function allTexts(layout: PrintLayout): string[] {
  return [...layout.header.map((e) => e.text), ...layout.columns.map((c) => c.field), ...layout.totals.map((e) => e.text), ...layout.footer.map((e) => e.text)]
}

/** 校验模板:纸张、字号 6–72、占位符必须属于可用集合,返回全部无效占位符(需求 20.2、20.4、20.5) */
export function validatePrintTemplate(t: PrintTemplateLike, docType: DocType, customFields: Pick<FieldDef, 'code' | 'enabled'>[]): { issues: ValidationIssue[]; invalidPlaceholders: string[] } {
  const issues: ValidationIssue[] = []
  if (!PAPERS[t.paper]) issues.push({ field: 'paper', reason: '不支持的纸张规格' })
  const sizes = [...t.layout.header.map((e) => e.fontSize), ...t.layout.columns.map((c) => c.fontSize), ...t.layout.totals.map((e) => e.fontSize), ...t.layout.footer.map((e) => e.fontSize)]
  if (sizes.some((s) => !Number.isFinite(s) || s < 6 || s > 72)) issues.push({ field: 'fontSize', reason: '字体大小须为 6 至 72 磅' })
  const avail = availablePlaceholders(docType, customFields)
  const invalid = [...new Set(allTexts(t.layout).flatMap(extractPlaceholders).filter((p) => !avail.has(p)))]
  if (invalid.length > 0) issues.push({ field: 'placeholders', reason: `存在无效的占位符:${invalid.join('、')}` })
  return { issues, invalidPlaceholders: invalid }
}

/** 替换占位符;值为空时输出空白而不显示原文(需求 20.6、20.10) */
export function fillPlaceholders(text: string, resolve: (key: string) => string | null | undefined): string {
  return text.replace(PLACEHOLDER_RE, (_m, key: string) => resolve(key.trim()) ?? '')
}

export interface PrintData {
  header: Record<string, string | null | undefined>
  lines: Record<string, string | null | undefined>[]
  custom?: Record<string, string | null | undefined>
  tenantName?: string
  logoUrl?: string | null
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 模板 + 数据 → 分页 HTML(浏览器打印与 PDF 共用同一份排版) */
export function renderPrintHtml(t: PrintTemplateLike, data: PrintData): string {
  const paper = PAPERS[t.paper]
  const m = t.layout.metrics
  const pages = paginate(t, data.lines.length)
  const resolve = (key: string): string | null | undefined => {
    if (key === 'tenant.name') return data.tenantName
    if (key === 'branding.logo') return data.logoUrl ? `\u0000IMG:${data.logoUrl}` : ''
    if (key.startsWith('header.')) return data.header[key.slice(7)]
    if (key.startsWith('cf.')) return data.custom?.[key.slice(3)]
    return undefined
  }
  const render = (e: PrintElement, extra?: (k: string) => string | null | undefined) => {
    if (!e.visible) return ''
    const raw = fillPlaceholders(e.text, (k) => extra?.(k) ?? resolve(k))
    const html = esc(raw).replace(/\u0000IMG:([^\s<]*)/g, (_x, u) => `<img src="${esc(u)}" style="max-height:${m.headerHeight}mm" alt=""/>`)
    return `<div class="el" style="left:${e.x}mm;top:${e.y}mm;font-size:${e.fontSize}pt;text-align:${e.align ?? 'left'}">${html}</div>`
  }
  const cols = t.layout.columns.filter((c) => c.visible)
  const pageHeight = paper.h === null ? 'auto' : `${paper.h}mm`
  const body = pages
    .map((p) => {
      const rows = data.lines.slice(p.rowStart, p.rowEnd)
      const head = `<tr>${cols.map((c) => `<th style="width:${c.width}mm;font-size:${c.fontSize}pt;text-align:${c.align ?? 'left'}">${esc(c.title)}</th>`).join('')}</tr>`
      const trs = rows
        .map(
          (r) =>
            `<tr style="height:${m.rowHeight}mm">${cols
              .map((c) => `<td style="font-size:${c.fontSize}pt;text-align:${c.align ?? 'left'}">${esc(fillPlaceholders(c.field, (k) => (k.startsWith('line.') ? r[k.slice(5)] : resolve(k))))}</td>`)
              .join('')}</tr>`,
        )
        .join('')
      return `<section class="page" style="width:${paper.w}mm;min-height:${pageHeight};padding:${m.margin}mm;box-sizing:border-box">
<div class="band header" style="height:${m.headerHeight}mm">${t.layout.header.map((e) => render(e)).join('')}</div>
<table class="lines"><thead>${head}</thead><tbody>${trs}</tbody></table>
${p.showTotals ? `<div class="band totals" style="height:${m.totalsHeight}mm">${t.layout.totals.map((e) => render(e)).join('')}</div>` : ''}
<div class="band footer" style="height:${m.footerHeight}mm">${t.layout.footer.map((e) => render(e)).join('')}<div class="pageno">${esc(p.label)}</div></div>
</section>`
    })
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:${paper.w}mm ${paper.h === null ? 'auto' : paper.h + 'mm'};margin:0}
body{margin:0;font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC","WenQuanYi Micro Hei",sans-serif}
.page{position:relative;page-break-after:always}
.band{position:relative}.el{position:absolute;white-space:nowrap}
table.lines{width:100%;border-collapse:collapse}table.lines th,table.lines td{border-bottom:.2mm solid #999;padding:0 1mm}
.pageno{position:absolute;right:0;bottom:0;font-size:8pt}
</style></head><body>${body}</body></html>`
}

/** 默认模板(系统内置)(需求 20.1) */
export function defaultPrintLayout(docType: DocType): PrintLayout {
  const isStocktake = docType === 'stocktake'
  const columns: PrintColumn[] = [
    { field: '{{line.lineNo}}', title: '序号', width: 12, fontSize: 9, visible: true },
    { field: '{{line.productName}}', title: '商品', width: 50, fontSize: 9, visible: true },
    { field: '{{line.spec}}', title: '规格', width: 30, fontSize: 9, visible: true },
    { field: '{{line.unitName}}', title: '单位', width: 14, fontSize: 9, visible: true },
    isStocktake ? { field: '{{line.countedQty}}', title: '盘点数量', width: 22, fontSize: 9, visible: true, align: 'right' } : { field: '{{line.qty}}', title: '数量', width: 20, fontSize: 9, visible: true, align: 'right' },
    isStocktake ? { field: '{{line.snapshotQty}}', title: '账面数量', width: 22, fontSize: 9, visible: true, align: 'right' } : { field: '{{line.price}}', title: '单价', width: 22, fontSize: 9, visible: true, align: 'right' },
    isStocktake ? { field: '{{line.diffQty}}', title: '差异', width: 20, fontSize: 9, visible: true, align: 'right' } : { field: '{{line.amount}}', title: '金额', width: 24, fontSize: 9, visible: true, align: 'right' },
  ]
  return {
    metrics: { margin: 8, headerHeight: 30, columnTitleHeight: 7, rowHeight: 7, totalsHeight: 12, footerHeight: 10 },
    header: [
      { text: '{{tenant.name}}', x: 0, y: 0, fontSize: 14, visible: true },
      { text: '单号:{{header.docNo}}', x: 0, y: 10, fontSize: 10, visible: true },
      { text: '日期:{{header.docDate}}', x: 80, y: 10, fontSize: 10, visible: true },
      { text: '往来单位:{{header.partnerName}}', x: 0, y: 17, fontSize: 10, visible: true },
      { text: '仓库:{{header.warehouseName}}', x: 80, y: 17, fontSize: 10, visible: true },
      { text: '备注:{{header.remark}}', x: 0, y: 24, fontSize: 9, visible: true },
    ],
    columns,
    totals: isStocktake ? [] : [{ text: '合计金额:{{header.totalAmount}}', x: 100, y: 2, fontSize: 10, visible: true }],
    footer: [{ text: '制单:{{header.createdByName}}', x: 0, y: 0, fontSize: 9, visible: true }],
  }
}
