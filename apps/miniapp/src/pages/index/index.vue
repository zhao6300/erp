<script setup lang="ts">
import { ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { api, bootstrap, drafts, visibleEntries } from '../../core/runtime'

declare const uni: any

const entries = ref<{ key: string; label: string; url: string }[]>([])
const dash = ref<any>(null)
const pending = ref(0)

onShow(async () => {
  try {
    const b = await bootstrap(true)
    entries.value = visibleEntries(b) as never // 隐藏未启用模块与无权限的入口(需求 19.4)
    dash.value = await api.get('/api/dashboard')
    pending.value = (await drafts.list()).length
    // 到期提醒仅对 Tenant_Admin(需求 3.4)
    if (b.licenseReminder) uni.showModal({ title: '授权到期提醒', content: `将于 ${b.licenseReminder.expireDate} 到期,剩余 ${b.licenseReminder.daysLeft} 天`, showCancel: false })
  } catch {
    /* 401 已由 ApiClient 跳转登录页 */
  }
})
const go = (url: string) => uni.navigateTo({ url })
</script>

<template>
  <view>
    <view v-if="dash" class="card">
      <view class="row"><text>今日销售额</text><text>{{ dash.today.salesAmount }}</text></view>
      <view v-if="dash.today.grossProfit !== undefined" class="row"><text>今日毛利</text><text>{{ dash.today.grossProfit }}</text></view>
      <view class="row"><text>本月销售额</text><text>{{ dash.month.salesAmount }}</text></view>
      <view class="row"><text>今日收款 / 付款</text><text>{{ dash.today.receiptAmount }} / {{ dash.today.paymentAmount }}</text></view>
      <view class="row"><text>库存预警</text><text>{{ dash.stockAlertCount }}</text></view>
      <view class="row"><text>应收合计</text><text>{{ dash.receivableTotal }}</text></view>
    </view>
    <view v-if="pending" class="card" @tap="go('/pages/docs/list?tab=drafts')"><text class="err">有 {{ pending }} 张单据待提交(提交失败,内容已保存在本机),点击查看</text></view>
    <view class="card" style="display: flex; flex-wrap: wrap"><view v-for="e in entries" :key="e.key" class="btn" style="width: 44%" @tap="go(e.url)">{{ e.label }}</view></view>
  </view>
</template>
