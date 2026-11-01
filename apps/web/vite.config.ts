import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000', '/files': 'http://localhost:3000' } },
  build: { chunkSizeWarningLimit: 1500 },
})
