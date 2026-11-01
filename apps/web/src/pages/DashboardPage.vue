<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../lib/api'

interface Metrics { salesAmount: string; grossProfit?: string; receiptAmount: string; paymentAmount: string }
interface Dash { today: Metrics; month: Metrics; stockAlertCount: number; receivableTotal: string }
const data = ref<Dash | null>(null)
// 首页所有人可见;指标由后端按权限(无利润权限不含毛利)和 Data_Scope 裁剪
onMounted(async () => {
  data.value = await api.get<Dash>('/api/dashboard').catch(() => null)
})
const rows = (m: Metrics) => [
  ['销售额', m.salesAmount],
  ...(m.grossProfit !== undefined ? [['毛利', m.grossProfit]] : []), // 无利润权限时不返回毛利(需求 18.8)
  ['收款额', m.receiptAmount],
  ['付款额', m.paymentAmount],
]
</script>

<template>
  <div class="page">
    <el-row v-if="data" :gutter="12">
      <el-col v-for="(m, title) in { 今日: data.today, 本月: data.month }" :key="title" :xs="24" :md="12">
        <el-card style="margin-bottom: 12px">
          <template #header>{{ title }}</template>
          <div v-for="[k, v] in rows(m)" :key="k" style="display: flex; justify-content: space-between; padding: 4px 0">
            <span>{{ k }}</span><b>{{ v }}</b>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="12"><el-card><div>库存预警 SKU 数</div><b style="font-size: 24px">{{ data.stockAlertCount }}</b></el-card></el-col>
      <el-col :xs="12" :md="12"><el-card><div>应收合计</div><b style="font-size: 24px">{{ data.receivableTotal }}</b></el-card></el-col>
    </el-row>
  </div>
</template>
