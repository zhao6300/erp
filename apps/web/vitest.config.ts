import { defineConfig } from 'vitest/config'

// 纯逻辑测试不需要 Vue 插件;与 vite.config.ts 分开,避免 vitest 自带的 vite 版本与应用的 vite 版本类型冲突
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
