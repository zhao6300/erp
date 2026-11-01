import { isValidCalendarDate } from './types'

/** Excel 列定义:导出与导入模板共用,保证往返一致(需求 21.7) */
export type ColumnType = 'text' | 'integer' | 'decimal' | 'date' | 'boolean' | 'select' | 'multiselect'
export interface ColumnDef {
  key: string
  title: string
  type: ColumnType
  required?: boolean
  options?: string[]
  sensitive?: 'cost' | 'profit'
  /** 小数列使用的租户精度参数:数量 / 单价 / 金额(需求 7.9、21.3) */
  scale?: 'qty' | 'price' | 'amount'
}

export type CellValue = string | number | boolean | string[] | null

const SEP = ','
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/,/g, '\\,')

function splitEscaped(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i]
    } else if (ch === SEP) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** 值 → 单元格文本。统一写成字符串,避免 Excel 自动转换日期、科学计数法与前导零 */
export function formatCell(col: Pick<ColumnDef, 'type'>, v: CellValue | undefined): string {
  if (v === null || v === undefined) return ''
  switch (col.type) {
    case 'boolean':
      return v === true ? '是' : '否'
    case 'multiselect':
      return (v as string[]).map(esc).join(SEP)
    case 'integer':
      return String(v)
    default:
      return String(v)
  }
}

/** 单元格文本 → 值;空白返回 null。无法解析时抛出 Error(reason) */
export function parseCell(col: Pick<ColumnDef, 'type'>, text: string | null | undefined): CellValue {
  if (text === null || text === undefined || text === '') return null
  switch (col.type) {
    case 'boolean':
      if (text === '是') return true
      if (text === '否') return false
      throw new Error('应填写“是”或“否”')
    case 'integer':
      if (!/^-?\d+$/.test(text)) throw new Error('应为整数')
      return Number(text)
    case 'decimal':
      if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error('应为数字')
      return text
    case 'date':
      if (!isValidCalendarDate(text)) throw new Error('日期格式应为 YYYY-MM-DD')
      return text
    case 'multiselect':
      return splitEscaped(text)
    default:
      return text
  }
}
