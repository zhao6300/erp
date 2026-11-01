import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 平台后台与租户端分开打包与部署域名,白标交付时不暴露运营入口
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/platform': 'http://localhost:3000' } },
  build: { chunkSizeWarningLimit: 1500 },
})
