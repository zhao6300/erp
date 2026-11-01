<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ApiError } from '@erp/api-client'
import { api } from '../../core/runtime'

declare const uni: any
const form = reactive({ login: '', password: '' })
const tenants = ref<{ id: string; name: string }[]>([])
const ticket = ref('')
const bind = reactive({ ticket: '', phone: '', password: '' })
const tip = ref('')

function enter() {
  uni.reLaunch({ url: '/pages/index/index' })
}
async function passwordLogin() {
  try {
    const r = await api.login(form.login, form.password)
    if (r.status === 'ok') return enter()
    if (r.status === 'select_tenant') {
      tenants.value = r.tenants
      ticket.value = r.selectTicket
    }
  } catch (e) {
    tip.value = e instanceof ApiError ? e.message : '登录失败'
  }
}
async function choose(id: string) {
  const r = await api.selectTenant(ticket.value, id)
  if (r.status === 'ok') enter()
}
/** 微信登录:wx.login 取 code;未绑定时要求输入手机号与密码完成绑定(需求 9.2、9.3) */
async function wechatLogin() {
  const { code } = await new Promise<{ code: string }>((resolve, reject) => uni.login({ provider: 'weixin', success: resolve, fail: reject }))
  try {
    const r: any = await api.post('/api/auth/wechat', { code })
    if (r.status === 'ok') {
      await api.setToken(r.token)
      return enter()
    }
    if (r.status === 'need_bind') bind.ticket = r.bindTicket
    if (r.status === 'select_tenant') {
      tenants.value = r.tenants
      ticket.value = r.selectTicket
    }
  } catch (e) {
    tip.value = e instanceof ApiError ? e.message : '微信登录失败'
  }
}
async function doBind() {
  try {
    const r: any = await api.post('/api/auth/wechat/bind', { bindTicket: bind.ticket, phone: bind.phone, password: bind.password })
    if (r.status === 'ok') {
      await api.setToken(r.token)
      enter()
    }
  } catch (e) {
    tip.value = e instanceof ApiError ? e.message : '绑定失败' // 连续错误会锁定账号,提示剩余分钟
  }
}
</script>

<template>
  <view class="card">
    <view v-if="tenants.length">
      <text>请选择企业</text>
      <view v-for="t in tenants" :key="t.id" class="btn" @tap="choose(t.id)">{{ t.name }}</view>
    </view>
    <view v-else-if="bind.ticket">
      <text>首次使用微信登录,请绑定已有账号</text>
      <input v-model="bind.phone" placeholder="手机号" />
      <input v-model="bind.password" password placeholder="密码" />
      <view class="btn" @tap="doBind">绑定并登录</view>
    </view>
    <view v-else>
      <input v-model="form.login" placeholder="手机号或用户名" />
      <input v-model="form.password" password placeholder="密码" />
      <view class="btn" @tap="passwordLogin">登录</view>
      <view class="btn" style="background: #07c160" @tap="wechatLogin">微信一键登录</view>
    </view>
    <text v-if="tip" class="err">{{ tip }}</text>
  </view>
</template>
