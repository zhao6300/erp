import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@erp/shared'
import type { Db, Tx } from './db'
import { uuidv7 } from './ids'

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/svg+xml'

/** 存储驱动抽象:本地磁盘/MinIO/OSS/COS 共用接口,对象键以 tenant_id/ 为前缀 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

export class LocalDiskStorage implements StorageDriver {
  constructor(private root: string) {}
  private resolve(key: string) {
    const p = path.resolve(this.root, key)
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('invalid object key')
    return p
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, data)
  }
  async get(key: string) {
    return readFile(this.resolve(key))
  }
  async delete(key: string) {
    await rm(this.resolve(key), { force: true })
  }
}

/** 按文件头魔数判断格式,不信任客户端声明的 Content-Type(需求 5.5) */
export function sniffImage(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase()
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg')) && buf.toString('utf8').toLowerCase().includes('<svg')) return 'image/svg+xml'
  return null
}

/** SVG 净化:去除脚本、事件属性、外部引用与 foreignObject */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*script[^>]*\/\s*>/gi, '')
    .replace(/<\s*foreignObject[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '')
}

export class FileService {
  constructor(
    private db: Db,
    private storage: StorageDriver,
    private signSecret: string,
  ) {}

  /** 上传图片(Logo、背景图、商品图片、自定义字段图片):格式 PNG/JPG/SVG,大小 ≤ 2 MB */
  async uploadImage(tx: Tx, tenantId: string, data: Buffer, opts: { allowSvg?: boolean; ownerType?: string; ownerId?: string; createdBy?: string } = {}): Promise<{ id: string; mime: ImageMime; size: number }> {
    if (data.length > MAX_IMAGE_BYTES) throw new AppError('VALIDATION_FAILED', '图片大小不能超过 2 MB', [{ field: 'file', reason: '允许格式 PNG、JPG、SVG,大小不超过 2 MB' }])
    const mime = sniffImage(data)
    if (!mime || (mime === 'image/svg+xml' && opts.allowSvg === false)) throw new AppError('VALIDATION_FAILED', '图片格式不支持,允许 PNG、JPG、SVG,大小不超过 2 MB', [{ field: 'file', reason: '允许格式 PNG、JPG、SVG,大小不超过 2 MB' }])
    const body = mime === 'image/svg+xml' ? Buffer.from(sanitizeSvg(data.toString('utf8'))) : data
    const id = uuidv7()
    const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'svg'
    const key = `${tenantId}/${new Date().getUTCFullYear()}/${id}.${ext}`
    await this.storage.put(key, body)
    try {
      await tx.query('INSERT INTO attachment (id, tenant_id, object_key, mime, size, owner_type, owner_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, tenantId, key, mime, body.length, opts.ownerType ?? null, opts.ownerId ?? null, opts.createdBy ?? null])
    } catch (e) {
      await this.storage.delete(key) // 数据库失败时不留孤儿文件
      throw e
    }
    // 事务回滚时清理已落盘的文件
    return { id, mime, size: body.length }
  }

  /** 已通过 RLS 查询得到对象键之后读取内容(配置包导出等内部使用) */
  async readByKey(objectKey: string, mime: string): Promise<{ data: Buffer; mime: string }> {
    return { data: await this.storage.get(objectKey), mime }
  }

  /** 读取附件:必须先经 RLS 查询 attachment(跨租户即不存在) */
  async read(tx: Tx, id: string): Promise<{ data: Buffer; mime: string }> {
    const a = await tx.maybeOne('SELECT object_key, mime FROM attachment WHERE id=$1', [id])
    if (!a) throw new AppError('NOT_FOUND')
    return { data: await this.storage.get(a.object_key), mime: a.mime }
  }

  /** 5 分钟有效的访问链接签名(HMAC) */
  signUrl(tenantId: string, id: string, now = Date.now()): { path: string; expires: number; sig: string } {
    const expires = Math.floor(now / 1000) + 300
    const sig = createHmac('sha256', this.signSecret).update(`${tenantId}.${id}.${expires}`).digest('hex')
    return { path: `/files/${tenantId}/${id}`, expires, sig }
  }

  verifySignature(tenantId: string, id: string, expires: number, sig: string, now = Date.now()): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(now / 1000)) return false
    const expect = createHmac('sha256', this.signSecret).update(`${tenantId}.${id}.${expires}`).digest()
    const got = Buffer.from(sig, 'hex')
    return got.length === expect.length && timingSafeEqual(got, expect)
  }

  async readSigned(tenantId: string, id: string): Promise<{ data: Buffer; mime: string }> {
    return this.db.withTenant(tenantId, (tx) => this.read(tx, id), { readOnly: true })
  }

  /** 结果文件(导入导出)等非图片内容 */
  async putBlob(tx: Tx, tenantId: string, data: Buffer, mime: string, ext: string, createdBy?: string): Promise<string> {
    const id = uuidv7()
    const key = `${tenantId}/${new Date().getUTCFullYear()}/${id}.${ext}`
    await this.storage.put(key, data)
    await tx.query('INSERT INTO attachment (id, tenant_id, object_key, mime, size, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, tenantId, key, mime, data.length, createdBy ?? null])
    return id
  }

  async deleteBlob(tx: Tx, id: string): Promise<void> {
    const a = await tx.maybeOne('SELECT object_key FROM attachment WHERE id=$1', [id])
    if (!a) return
    await this.storage.delete(a.object_key)
    await tx.query('DELETE FROM attachment WHERE id=$1', [id])
  }
}
