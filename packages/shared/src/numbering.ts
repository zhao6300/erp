import type { LocalDate } from './types'
import type { ValidationIssue } from './errors'

export type DateFormat = 'YMD' | 'YM' | 'NONE'
export type ResetCycle = 'daily' | 'monthly' | 'yearly' | 'never'

export interface NumberingRule {
  prefix: string
  dateFormat: DateFormat
  seqDigits: number
  reset: ResetCycle
}

const p2 = (n: number) => String(n).padStart(2, '0')
const p4 = (n: number) => String(n).padStart(4, '0')

/** 流水号所属周期标识:按日 20260930,按月 202609,按年 2026,不重置 '-'(设计 D4) */
export function periodKey(rule: Pick<NumberingRule, 'reset'>, today: LocalDate): string {
  switch (rule.reset) {
    case 'daily':
      return `${p4(today.y)}${p2(today.m)}${p2(today.d)}`
    case 'monthly':
      return `${p4(today.y)}${p2(today.m)}`
    case 'yearly':
      return p4(today.y)
    case 'never':
      return '-'
  }
}

export function dateSegment(format: DateFormat, today: LocalDate): string {
  switch (format) {
    case 'YMD':
      return `${p4(today.y)}${p2(today.m)}${p2(today.d)}`
    case 'YM':
      return `${p4(today.y)}${p2(today.m)}`
    case 'NONE':
      return ''
  }
}

/** 前缀 + 日期段 + 左侧补零的流水号;超出位数时按实际位数(需求 7.3) */
export function formatDocNo(rule: NumberingRule, today: LocalDate, seq: number): string {
  return `${rule.prefix}${dateSegment(rule.dateFormat, today)}${String(seq).padStart(rule.seqDigits, '0')}`
}

/** 校验编号规则(需求 7.2、7.7) */
export function validateNumberingRule(rule: NumberingRule): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof rule.prefix !== 'string' || !/^[A-Z0-9-]{0,10}$/.test(rule.prefix))
    issues.push({ field: 'prefix', reason: '前缀为 0 至 10 个字符,仅限大写英文字母、数字与连字符' })
  if (!Number.isInteger(rule.seqDigits) || rule.seqDigits < 3 || rule.seqDigits > 8)
    issues.push({ field: 'seqDigits', reason: '流水号位数须为 3 至 8 的整数' })
  if (!['YMD', 'YM', 'NONE'].includes(rule.dateFormat)) issues.push({ field: 'dateFormat', reason: '日期格式须为年月日、年月或无' })
  if (!['daily', 'monthly', 'yearly', 'never'].includes(rule.reset)) issues.push({ field: 'reset', reason: '重置周期须为按日、按月、按年或不重置' })
  if (issues.length === 0) {
    if (rule.dateFormat === 'NONE' && rule.reset !== 'never')
      issues.push({ field: 'reset', reason: '日期格式为无时,重置周期仅允许不重置' })
    if (rule.dateFormat === 'YM' && rule.reset === 'daily')
      issues.push({ field: 'reset', reason: '日期格式为年月时,重置周期不允许按日' })
  }
  return issues
}
