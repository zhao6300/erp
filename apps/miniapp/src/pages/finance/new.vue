<script setup lang="ts">
import { reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { ApiError, newClientRequestId } from '@erp/api-client'
import { api } from '../../core/runtime'

declare const uni: any

// 收付款:选择往来单位与账户,金额默认按先进先出自动核销(需求 17.4)
const kind = ref<'receipt' | 'payment'>('receipt')
const partners = ref<{ id: string; name: string }[]>([])
const funds = ref<{ id: string; name: string }[]>([])
const form = reactive({ partnerId: '', fundAccountId: '', amount: '', remark: '' })
const tip = ref('')
const requestId = newClientRequestId()

onLoad(async () => {
  funds.value = await api.get('/api/fund-accounts', { enabled: true })
  await loadPartners()
})
async function loadPartners() {
  partners.value = (await api.get<{ items: any[] }>('/api/partners', { kind: kind.value === 'receipt' ? 'customer' : 'supplier', enabled: true, pageSize: 100 })).items
}
async function submit() {
  tip.value = ''
  try {
    const r = await api.saveDocument({ docType: kind.value, docDate: new Date().toISOString().slice(0, 10), partnerId: form.partnerId || null, fundAccountId: form.fundAccountId || null, amount: form.amount, remark: form.remark, lines: [] }, { clientRequestId: requestId, autoAudit: true })
    if (r.auditError) tip.value = `已保存为草稿,审核未通过:${r.auditError.message}` // 如资金余额不足会显示当前余额
    else uni.showToast({ title: '已完成' })
  } catch (e) {
    tip.value = e instanceof ApiError ? e.message : '提交失败'
  }
}
</script>

<template>
  <view>
    <view class="card"><view class="row"><text :style="{ fontWeight: kind === 'receipt' ? 'bold' : 'normal' }" @tap="() => { kind = 'receipt'; loadPartners() }">收款</text><text :style="{ fontWeight: kind === 'payment' ? 'bold' : 'normal' }" @tap="() => { kind = 'payment'; loadPartners() }">付款</text></view></view>
    <view class="card">
      <picker :range="partners" range-key="name" @change="form.partnerId = partners[$event.detail.value].id"><view class="row"><text>往来单位</text><text>{{ partners.find((p) => p.id === form.partnerId)?.name ?? '请选择' }}</text></view></picker>
      <picker :range="funds" range-key="name" @change="form.fundAccountId = funds[$event.detail.value].id"><view class="row"><text>资金账户</text><text>{{ funds.find((f) => f.id === form.fundAccountId)?.name ?? '请选择' }}</text></view></picker>
      <view class="row"><text>金额</text><input v-model="form.amount" type="digit" /></view>
    </view>
    <text v-if="tip" class="err" style="margin: 16rpx; display: block">{{ tip }}</text>
    <view class="btn" @tap="submit">提交并审核</view>
  </view>
</template>
