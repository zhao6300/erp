<script setup lang="ts">
import { onMounted } from 'vue'
import { api } from './lib/api'
import { applyBranding } from './stores/session'

// 登录前也要按自定义域名显示品牌(需求 5.3、5.9)
onMounted(async () => {
  try {
    applyBranding(await api.branding())
  } catch {
    /* 品牌加载失败时使用默认外观 */
  }
})
</script>

<template>
  <router-view />
</template>
