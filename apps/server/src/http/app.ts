import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { AppError } from '@erp/shared'
import fastifyFactory, { FastifyInstance, FastifyRequest } from 'fastify'
import type { Container } from '../container'
import { Pipeline, toErrorBody } from './pipeline'
import { registerRoutes } from './routes'

/**
 * 构建 Fastify 应用。
 * - 仅接受来自受信代理且 X-Forwarded-Proto = https 的请求(需求 22.7),否则返回 HTTPS_REQUIRED,不执行任何业务逻辑
 * - 请求体 zod 校验使用 strip,请求中的任何租户标识被丢弃
 */
/** 受信代理匹配:支持精确 IP 与 CIDR(例如容器网络 172.16.0.0/12);IPv4 映射的 IPv6 地址按 IPv4 处理 */
export function trustedProxyMatcher(spec: string): (addr: string) => boolean {
  const list = new net.BlockList()
  for (const raw of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [ip, prefix] = raw.split('/')
    const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4'
    if (!net.isIP(ip)) continue
    if (prefix === undefined) list.addAddress(ip, type)
    else list.addSubnet(ip, Number(prefix), type)
  }
  return (addr) => {
    const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
    const t = net.isIP(a)
    return t !== 0 && list.check(a, t === 6 ? 'ipv6' : 'ipv4')
  }
}

export async function buildApp(c: Container, opts: { logger?: boolean; requireHttps?: boolean } = {}): Promise<FastifyInstance> {
  const isTrusted = trustedProxyMatcher(c.config.TRUSTED_PROXIES)
  const app = fastifyFactory({
    logger: opts.logger ?? false,
    // 只信任受信代理设置的转发头
    trustProxy: (addr) => isTrusted(addr),
    genReqId: () => randomUUID(),
    bodyLimit: 12 * 1024 * 1024,
  })

  const requireHttps = opts.requireHttps ?? true
  app.addHook('onRequest', async (req, res) => {
    // 证书申请的 ask 端点与健康检查只在内网使用
    if (!requireHttps || req.url === '/healthz' || req.url.startsWith('/internal/')) return
    if (req.protocol !== 'https') {
      const body = new AppError('HTTPS_REQUIRED').toBody()
      return res.status(403).send({ ...body, requestId: req.id })
    }
  })

  app.setErrorHandler((err, req, res) => {
    const { status, body } = toErrorBody(err, req.id)
    if (status >= 500) req.log.error({ err }, 'unhandled error')
    res.status(status).send(body)
  })
  app.setNotFoundHandler((req, res) => {
    res.status(404).send({ code: 'NOT_FOUND', message: '接口不存在', requestId: req.id })
  })

  app.get('/healthz', async () => ({ ok: true }))
  registerRoutes(app, c, new Pipeline(c))
  return app
}

export type Req = FastifyRequest
