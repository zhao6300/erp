# Lite ERP

面向中小企业的精简进销存与基础财务系统。pnpm + TypeScript monorepo,支持 SaaS 多租户与独立部署两种模式。

## 目录

```
apps/
  server/    Fastify API + Worker(PostgreSQL 16 行级安全、事务内过账)
  web/       租户端 Web(Vue 3 + Element Plus + Pinia)
  console/   平台运营后台(独立打包、独立域名)
  miniapp/   微信小程序(uni-app, 仅 mp-weixin)。业务逻辑在 src/core,页面在 src/pages
packages/
  shared/      纯函数与类型:金额/数量(decimal.js)、定价、编号、成本、过账计划、配置包、权限、校验 schema
  api-client/  Web 与小程序共用的 HTTP 客户端、离线草稿、菜单/主题辅助
  plugin-sdk/  扩展插件接口与带版本号的事件载荷
plugins/     独立部署的客户定制(见 plugins/README.md)
deploy/      Dockerfile、docker-compose.yml、Caddyfile、.env.example
docs/        open-api-v1.md
```

## 开发与测试

需要 Node ≥ 20(开发时用 22)和 pnpm。

```bash
pnpm install
pnpm --filter @erp/server setup:browser   # 下载 PDF/图片渲染测试用的无头 Chromium(一次即可)
pnpm test        # 全部包的测试
pnpm typecheck   # tsc / vue-tsc
pnpm lint
pnpm build       # server(tsup)、web、console
```

单据 PDF/图片(`GET /api/documents/:id/print?format=html|pdf|png`)由服务端用 Playwright + 无头 Chromium 渲染,
和浏览器打印共用同一份 HTML 与分页结果。渲染时禁用 JavaScript、拦截除 `data:` 外的所有请求(租户 Logo 以 data URI 内联)。
服务器需要安装 CJK 字体,否则中文显示为空白(`deploy/Dockerfile` 已安装 `fonts-noto-cjk`);
容器内以 root 运行时设置 `CHROMIUM_NO_SANDBOX=true`,系统浏览器路径用 `CHROMIUM_PATH` 指定。
`test/print-render.test.ts` 需要 Chromium;本机没有中文字体时测试仍能通过,但生成的中文是空白。

服务端集成测试连接**真实的 PostgreSQL 16**:默认用 `embedded-postgres` 在本机起一个实例(root 用户下自动降权到 nobody);
设置 `TEST_DATABASE_ADMIN_URL=postgres://postgres:pw@host:5432/postgres` 可改用外部库(例如 CI 里的 `postgres:16` 容器)。
每个测试文件使用独立数据库。

本地运行服务端(需要一个空的 PostgreSQL 16 库和超级用户连接串):

```bash
cd apps/server
DEPLOYMENT_MODE=standalone \
DATABASE_ADMIN_URL=postgres://postgres:pw@localhost:5432/erp \
DATABASE_APP_URL=postgres://erp_app:apppw@localhost:5432/erp \
DATABASE_PLATFORM_URL=postgres://erp_platform:platpw@localhost:5432/erp \
pnpm start
```

启动顺序:校验环境变量(`DEPLOYMENT_MODE` 缺失或非法 → 非零退出)→ 按连接串里的口令创建 `erp_app`(无 BYPASSRLS)和 `erp_platform` 角色
→ 在一个事务里执行迁移(失败整体回滚并指出失败文件)→ 独立部署模式下创建默认租户和 30 天试用 License → 监听。

## 部署

见 `deploy/`。`cp deploy/.env.example deploy/.env`,改口令和域名后 `docker compose up -d --build`。
Caddy 负责 HTTPS、HTTP→HTTPS 301 和自定义域名按需证书(`/internal/tls-ask` 只放行已登记的域名,且不对外暴露)。
`/api`、`/files`、`/open`、`/platform` 转发给服务端,其余为前端静态资源。

## 已知偏离与未完成项

对照设计/需求/任务文档,以下与文档不一致或没有完成:

**与设计文档不同的技术选择**
- **没有使用 NestJS,直接用 Fastify**;服务是 `container.ts` 里组装的普通类。
- **没有使用 Drizzle**。数据库访问用 `pg` + 手写 SQL,迁移是 `apps/server/src/migrations/*.sql`(事务内整体执行)。
- **Redis 与 BullMQ 没有实际用上**。缓存/限流/锁走 `Kv` 接口:`MemoryKv` 有测试;`createRedisKv`(ioredis)已写但**没有对真实 Redis 测过**。
  异步事件投递是 Worker 轮询 `event_outbox` 表(`FOR UPDATE SKIP LOCKED`,最多 3 次)。`bullmq` 虽在依赖里但未使用。
- **没有使用 Testcontainers**(沙箱无 Docker),改用 embedded-postgres 的真实 PG16;`TEST_DATABASE_ADMIN_URL` 可接入 Testcontainers。
- 开放接口的访问密钥哈希使用 `BACKUP_HMAC_SECRET`,更换该变量会让所有密钥失效。

**功能缺口**
- 小程序页面(`apps/miniapp/src/pages`)**从未用 uni-app 工具链编译或在微信开发者工具里运行过**。
  只做了类型检查(`vue-tsc` + 本地 shim),`src/core` 里的业务逻辑有单元测试。
  单据"分享"(下载服务端生成的 PDF/图片 → `wx.shareFileMessage` / `wx.showShareImageMenu`)的下载与状态码处理有单元测试,
  但这两个微信接口本身只在真机/开发者工具里才能验证。
  `package.json` 里没有 `@dcloudio/*` 依赖,需要联网运行 `npx @dcloudio/uvm@latest` 对齐版本后再 `pnpm add -D`;装好工具链后删除 `src/uni-shim.d.ts`。
- 自定义域名(`customDomain`)不包含在配置包导出里;配置包导入时,仓库范围的角色会降级为"仅本人"。
- 反向冲销收款/其他收入可能让资金账户余额为负(规格只要求审核付款/转账时检查)。
- **没有做**任务文档 27.x 的 Playwright 端到端、miniprogram-automator 和性能脚本。
- `deploy/` 下的 Dockerfile、compose、Caddyfile **没有在 Docker/Caddy 里运行过**(沙箱没有 Docker)。
  特别是镜像里用 apt 安装的 Debian `chromium` 与 `playwright-core` 版本是否兼容,需要在真实镜像里确认一次 PDF 输出;
  只验证了 compose YAML 可解析、服务端 tsup 产物能在空库上完成角色创建→迁移→默认租户→`/healthz`(`BOOT_ENTRY=dist` 的 `test/boot.test.ts`)。

**属性测试的运行次数**:文档要求每个属性 `numRuns ≥ 100`。纯函数属性基本满足;
涉及真实数据库的集成属性为控制耗时使用了较少次数:Property 1 = 15、2 = 25、9 = 30、20 = 25、25 = 20、26 = 25、过账模型(13/18/19/22)= 40。
`packages/shared/test/inventory.test.ts` 中一个嵌套属性是 20×20。
