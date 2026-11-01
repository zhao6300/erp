<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ApiError } from '@erp/api-client'
import { api } from '../lib/api'

const router = useRouter()
const route = useRoute()
const form = reactive({ login: '', password: '' })
const busy = ref(false)
const tenants = ref<{ id: string; name: string }[]>([])
const ticket = ref('')

async function done() {
  await router.replace((route.query.redirect as string) || '/')
}
async function submit() {
  busy.value = true
  try {
    const r = await api.login(form.login, form.password)
    if (r.status === 'ok') return await done()
    if (r.status === 'select_tenant') {
      // 同一手机号对应多个 Tenant:进入首页前列出供选择(需求 9.4)
      tenants.value = r.tenants
      ticket.value = r.selectTicket
    }
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '登录失败')
  } finally {
    busy.value = false
  }
}
async function choose(id: string) {
  try {
    const r = await api.selectTenant(ticket.value, id)
    if (r.status === 'ok') await done()
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '进入失败')
  }
}
</script>

<template>
  <div style="min-height: 100%; display: flex; align-items: center; justify-content: center; background: var(--el-color-primary-light-9)">
    <el-card style="width: min(92vw, 380px)">
      <h2 style="margin-top: 0">登录</h2>
      <el-form v-if="!tenants.length" @submit.prevent="submit">
        <el-form-item><el-input v-model="form.login" placeholder="手机号或用户名" autocomplete="username" /></el-form-item>
        <el-form-item><el-input v-model="form.password" type="password" placeholder="密码" show-password autocomplete="current-password" @keyup.enter="submit" /></el-form-item>
        <el-button type="primary" :loading="busy" style="width: 100%" @click="submit">登录</el-button>
      </el-form>
      <div v-else>
        <p>请选择要进入的企业:</p>
        <el-button v-for="t in tenants" :key="t.id" style="display: block; width: 100%; margin: 0 0 8px" @click="choose(t.id)">{{ t.name }}</el-button>
      </div>
    </el-card>
  </div>
</template>
