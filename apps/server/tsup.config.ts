import { cpSync } from 'node:fs'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { main: 'src/main.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // 工作区包以 TS 源码形式发布,需打进产物;第三方依赖保持外部(镜像内 pnpm install --prod)
  noExternal: [/^@erp\//],
  async onSuccess() {
    cpSync('src/migrations', 'dist/migrations', { recursive: true })
  },
})
