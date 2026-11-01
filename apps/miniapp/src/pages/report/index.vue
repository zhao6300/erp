<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { api } from '../../core/runtime'

// 小程序常用报表:销售汇总、库存余额表、商品毛利表、应收账款汇总、应付账款汇总(需求 19.4)
const ALL = [
  { key: 'sales_summary', label: '销售汇总', url: '/api/reports/sales-summary' },
  { key: 'stock_balance', label: '库存余额表', url: '/api/stock/balances' },
  { key: 'product_profit', label: '商品毛利表', url: '/api/reports/product-profit' },
  { key: 'ar_summary', label: '应收账款汇总', url: '/api/reports/receivables' },
  { key: 'ap_summary', label: '应付账款汇总', url: '/api/reports/payables' },
]
const available = ref<typeof ALL>([])
const current = ref('')
const rows = ref<any[]>([])
const tip = ref('')

onLoad(async () => {
  const defs = await api.get<{ key: string }[]>('/api/reports')
  const keys = new Set(defs.map((d) => d.key))
  // 库存余额表属于库存模块,不在 /api/reports 列表里单独列出
  available.value = ALL.filter((r) => keys.has(r.key) || r.key === 'stock_balance')
  if (available.value[0]) await run(available.value[0].key)
})
async function run(key: string) {
  current.value = key
  tip.value = ''
  try {
    const r: any = await api.get(ALL.find((x) => x.key === key)!.url)
    rows.value = r.items ?? []
  } catch (e) {
    tip.value = (e as Error).message
  }
}
</script>

<template>
  <view>
    <view class="card" style="display: flex; flex-wrap: wrap; gap: 12rpx"><text v-for="r in available" :key="r.key" :style="{ fontWeight: r.key === current ? 'bold' : 'normal' }" @tap="run(r.key)">{{ r.label }}</text></view>
    <text v-if="tip" class="err" style="margin: 16rpx; display: block">{{ tip }}</text>
    <view v-for="(r, i) in rows" :key="i" class="card"><view v-for="(v, k) in r" :key="k" class="row"><text>{{ k }}</text><text>{{ v }}</text></view></view>
  </view>
</template>
