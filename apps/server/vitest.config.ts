import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 每个测试文件使用独立数据库;文件间可并行
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4 } },
  },
  esbuild: {
    target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
  },
})
