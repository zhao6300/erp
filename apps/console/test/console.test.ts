import { describe, expect, it } from 'vitest'
import { validateTenantForm } from '../src/lib/platform-api'

const ok = { name: '某某公司', contact: '张三', phone: '13800000000', expireDate: '2027-01-01', modules: ['product'], maxUsers: 5, maxWarehouses: 2 }

describe('开通租户表单校验(需求 1.7、3.8)', () => {
  it('合法表单无错误', () => expect(validateTenantForm(ok)).toEqual({}))

  it('一次性标明全部未通过的字段', () => {
    const e = validateTenantForm({ name: '  ', contact: '', phone: '123', expireDate: '', modules: [], maxUsers: 0, maxWarehouses: 1000 })
    expect(Object.keys(e).sort()).toEqual(['contact', 'expireDate', 'maxUsers', 'maxWarehouses', 'modules', 'name', 'phone'])
  })

  it('边界值', () => {
    expect(validateTenantForm({ ...ok, name: 'x'.repeat(100) })).toEqual({})
    expect(validateTenantForm({ ...ok, name: 'x'.repeat(101) }).name).toBeTruthy()
    expect(validateTenantForm({ ...ok, maxUsers: 9999, maxWarehouses: 999 })).toEqual({})
    expect(validateTenantForm({ ...ok, maxUsers: 10000 }).maxUsers).toBeTruthy()
    expect(validateTenantForm({ ...ok, phone: '12800000000' }).phone).toBeTruthy()
  })
})
