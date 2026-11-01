# 注意:此文件在开发沙箱中无法验证(沙箱没有 Docker),首次构建请在有 Docker 的环境确认。
# 构建上下文为仓库根目录:  docker build -f deploy/Dockerfile --target server -t lite-erp-server .

FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @erp/server build \
 && pnpm --filter @erp/web build \
 && pnpm --filter @erp/console build

# 服务端镜像(API 与 Worker 共用,由 ROLE 环境变量区分)
FROM node:22-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production
# 第三方依赖保持外部(tsup 仅打包 @erp/* 工作区包),因此需要带上 node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY plugins ./plugins
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/main.js"]

# 反向代理镜像:Caddy + 前端静态资源
FROM caddy:2 AS proxy
COPY --from=build /app/apps/web/dist /srv/web
COPY --from=build /app/apps/console/dist /srv/console
COPY deploy/Caddyfile /etc/caddy/Caddyfile
