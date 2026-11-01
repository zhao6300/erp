import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest'
import { uuidv7 } from '../src/core/ids'
import { MigrationError, listMigrations, runMigrations } from '../src/core/migrate'
import { TestDb, createTestDb } from './support/db'

let t: TestDb
const A = uuidv7()
const B = uuidv7()

beforeAll(async () => {
  t = await createTestDb(inject('pgAdminUrl'))
  // 用平台角色(BYPASSRLS)准备两个租户的数据
  await t.db.withPlatform(async (tx) => {
    for (const [id, name] of [[A, 'A公司'], [B, 'B公司']]) {
      await tx.query(`INSERT INTO tenant (id, name, contact, phone) VALUES ($1,$2,'x','13800000000')`, [id, name])
      await tx.query(`INSERT INTO partner (id, tenant_id, code, name, kind) VALUES ($1,$2,'C001','共用编码','customer')`, [uuidv7(), id])
      await tx.query(`INSERT INTO warehouse (id, tenant_id, code, name) VALUES ($1,$2,'W1','主仓')`, [uuidv7(), id])
    }
  })
})
afterAll(async () => {
  await t.drop()
})

describe('迁移(需求 23.5、23.8)', () => {
  it('全部迁移已在单个事务内执行并登记版本', async () => {
    const admin = await t.admin()
    const r = await admin.query('SELECT version FROM schema_migrations ORDER BY version')
    await admin.end()
    expect(r.rows.map((x) => x.version)).toEqual(listMigrations().map((m) => m.name))
  })

  it('再次执行是幂等的(无待执行迁移)', async () => {
    expect((await runMigrations(t.adminUrl)).applied).toEqual([])
  })

  it('失败的迁移整体回滚:结构与数据恢复到迁移前,并指明失败的迁移文件名', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mig-'))
    for (const m of listMigrations()) writeFileSync(path.join(dir, m.name), m.sql)
    writeFileSync(path.join(dir, '002_good.sql'), 'CREATE TABLE should_not_exist (id int);')
    writeFileSync(path.join(dir, '003_bad.sql'), 'ALTER TABLE should_not_exist ADD COLUMN x int; SELECT * FROM table_that_is_missing;')
    await expect(runMigrations(t.adminUrl, dir)).rejects.toSatisfy((e: unknown) => e instanceof MigrationError && e.file === '003_bad.sql')
    const admin = await t.admin()
    expect((await admin.query(`SELECT to_regclass('should_not_exist') AS r`)).rows[0].r).toBeNull()
    expect((await admin.query(`SELECT version FROM schema_migrations WHERE version LIKE '00_%good%' OR version LIKE '003%'`)).rowCount).toBe(0)
    // 既有数据完整
    expect((await admin.query('SELECT count(*)::int AS n FROM tenant')).rows[0].n).toBe(2)
    await admin.end()
  })
})

describe('租户隔离:数据库层(需求 2,设计 D1)', () => {
  it('erp_app 角色无 BYPASSRLS、不是表所有者', async () => {
    const admin = await t.admin()
    const r = await admin.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='erp_app'`)
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false })
    const owner = await admin.query(`SELECT tableowner FROM pg_tables WHERE tablename='partner'`)
    expect(owner.rows[0].tableowner).not.toBe('erp_app')
    await admin.end()
  })

  it('故意不带 WHERE tenant_id 的查询也只返回当前租户的数据', async () => {
    const a = await t.db.withTenant(A, (tx) => tx.rows('SELECT * FROM partner'))
    const b = await t.db.withTenant(B, (tx) => tx.rows('SELECT * FROM partner'))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].tenant_id).toBe(A)
    expect(b[0].tenant_id).toBe(B)
    expect(a[0].id).not.toBe(b[0].id)
  })

  it('不设置租户上下文时看不到任何租户数据', async () => {
    const c = await t.db.appPool.connect()
    try {
      const r = await c.query('SELECT count(*)::int AS n FROM partner')
      expect(r.rows[0].n).toBe(0)
    } finally {
      c.release()
    }
  })

  it('连接池复用连接不会串租户(SET LOCAL 随事务结束重置)', async () => {
    const small = new pg.Pool({ connectionString: t.appUrl, max: 1 })
    const { Db } = await import('../src/core/db')
    const db = new Db(small, small)
    const first = await db.withTenant(A, (tx) => tx.rows('SELECT tenant_id FROM partner'))
    const c = await small.connect()
    const leaked = await c.query(`SELECT current_setting('app.tenant_id', true) AS v`)
    const second = await c.query('SELECT count(*)::int AS n FROM partner')
    c.release()
    await small.end()
    expect(first).toHaveLength(1)
    expect(leaked.rows[0].v === '' || leaked.rows[0].v === null).toBe(true)
    expect(second.rows[0].n).toBe(0)
  })

  it('跨租户记录不可见:按他租户 id 查询与不存在的 id 结果完全相同', async () => {
    const bId = (await t.db.withTenant(B, (tx) => tx.one('SELECT id FROM partner'))).id
    const byOther = await t.db.withTenant(A, (tx) => tx.rows('SELECT * FROM partner WHERE id=$1', [bId]))
    const byMissing = await t.db.withTenant(A, (tx) => tx.rows('SELECT * FROM partner WHERE id=$1', [uuidv7()]))
    expect(byOther).toEqual(byMissing)
    // 跨租户 UPDATE 命中 0 行,B 的数据不变
    const n = await t.db.withTenant(A, (tx) => tx.exec(`UPDATE partner SET name='被篡改' WHERE id=$1`, [bId]))
    expect(n).toBe(0)
    expect((await t.db.withTenant(B, (tx) => tx.one('SELECT name FROM partner'))).name).toBe('共用编码')
  })

  it('WITH CHECK:不能写入其他租户的数据', async () => {
    await expect(t.db.withTenant(A, (tx) => tx.query(`INSERT INTO partner (id, tenant_id, code, name, kind) VALUES ($1,$2,'X','x','customer')`, [uuidv7(), B]))).rejects.toThrow(/row-level security/)
  })

  it('不同租户允许相同编码,同租户重复被唯一约束拒绝(需求 2.2)', async () => {
    await expect(t.db.withTenant(A, (tx) => tx.query(`INSERT INTO partner (id, tenant_id, code, name, kind) VALUES ($1,$2,'C001','重复','customer')`, [uuidv7(), A]))).rejects.toThrow(/duplicate key/)
  })

  it('复合外键:无法引用其他租户的记录(需求 2.7)', async () => {
    const bPartner = (await t.db.withTenant(B, (tx) => tx.one('SELECT id FROM partner'))).id
    // 即便绕过 RLS(平台角色),复合外键 (tenant_id, partner_id) 也拒绝跨租户引用
    await expect(
      t.db.withPlatform((tx) =>
        tx.query(`INSERT INTO document (id, tenant_id, doc_type, doc_no, doc_date, partner_id) VALUES ($1,$2,'sales_out','X1','2026-01-01',$3)`, [uuidv7(), A, bPartner]),
      ),
    ).rejects.toThrow(/foreign key/)
  })

  it('tenant_id 不可修改(需求 2.6)', async () => {
    await expect(t.db.withPlatform((tx) => tx.query(`UPDATE warehouse SET tenant_id=$1 WHERE tenant_id=$2`, [B, A]))).rejects.toThrow(/immutable/)
  })

  it('流水表与审计日志对应用角色只追加(需求 14.1、22.4)', async () => {
    const wh = (await t.db.withTenant(A, (tx) => tx.one('SELECT id FROM warehouse'))).id
    const prod = uuidv7()
    const sku = uuidv7()
    await t.db.withTenant(A, async (tx) => {
      await tx.query(`INSERT INTO product (id, tenant_id, code, name, base_unit) VALUES ($1,$2,'P1','p','个')`, [prod, A])
      await tx.query(`INSERT INTO sku (id, tenant_id, product_id, code) VALUES ($1,$2,$3,'P1')`, [sku, A, prod])
      await tx.query(`INSERT INTO stock_ledger (id, tenant_id, doc_type, doc_id, doc_no, sku_id, warehouse_id, qty_delta, balance_after) VALUES ($1,$2,'x',$3,'N',$4,$5,1,1)`, [uuidv7(), A, uuidv7(), sku, wh])
      await tx.query(`INSERT INTO audit_log (id, tenant_id, action) VALUES ($1,$2,'t')`, [uuidv7(), A])
    })
    for (const table of ['stock_ledger', 'audit_log']) {
      await expect(t.db.withTenant(A, (tx) => tx.query(`UPDATE ${table} SET tenant_id = tenant_id`))).rejects.toThrow(/permission denied/)
      await expect(t.db.withTenant(A, (tx) => tx.query(`DELETE FROM ${table}`))).rejects.toThrow(/permission denied/)
    }
    // 应用角色不能直接访问审计日志分区(会绕过父表 RLS)
    await expect(t.db.withTenant(A, (tx) => tx.query('SELECT * FROM audit_log_default'))).rejects.toThrow(/permission denied/)
  })

  it('审计日志按租户隔离,应用角色看不到其他租户与无租户事件', async () => {
    await t.db.withPlatform((tx) => tx.query(`INSERT INTO audit_log (id, tenant_id, action) VALUES ($1,NULL,'login.fail'), ($2,$3,'b.event')`, [uuidv7(), uuidv7(), B]))
    const rows = await t.db.withTenant(A, (tx) => tx.rows('SELECT action FROM audit_log'))
    expect(rows.map((r) => r.action)).toEqual(['t'])
  })

  it('应用角色不能修改平台表', async () => {
    await expect(t.db.withTenant(A, (tx) => tx.query(`UPDATE tenant SET name='x'`))).rejects.toThrow(/permission denied/)
    await expect(t.db.withTenant(A, (tx) => tx.query(`INSERT INTO account (id, phone, password_hash) VALUES ($1,'13900000000','x')`, [uuidv7()]))).rejects.toThrow(/permission denied/)
  })
})
