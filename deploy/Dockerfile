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
# 单据 PDF/图片由服务端用无头 Chromium 渲染(需求 20.8)。必须带 CJK 字体,否则中文显示为空白。
# 容器内以 root 运行,Chromium 沙箱不可用;渲染器已禁用 JavaScript 并拦截除 data: 外的全部请求。
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium CHROMIUM_NO_SANDBOX=true
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
