<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ApiError } from '@erp/api-client'
import { api } from '../lib/api'

interface Def { key: string; label: string }
const defs = ref<Def[]>([])
const current = ref('')
const range = ref<[string, string] | null>(null)
const groupBy = ref('product')
const rows = ref<any[]>([])
const totals = ref<Record<string, string> | null>(null)
const loading = ref(false)
const partnerId = ref('')
const partners = ref<any[]>([])
const URL: Record<string, string> = {
  sales_summary: '/api/reports/sales-summary', purchase_summary: '/api/reports/purchase-summary', stock_inout: '/api/reports/stock-inout', product_profit: '/api/reports/product-profit',
  ar_summary: '/api/reports/receivables', ar_detail: '/api/reports/receivables', ap_summary: '/api/reports/payables', ap_detail: '/api/reports/payables', fund_flow: '/api/reports/fund-flow',
}
const summaryLike = computed(() => ['sales_summary', 'purchase_summary'].includes(current.value))
onMounted(async () => {
  defs.value = await api.get<Def[]>('/api/reports')
  partners.value = (await api.get<{ items: any[] }>('/api/partners', { pageSize: 100 })).items
  if (defs.value.length) {
    current.value = defs.value[0].key
    await run()
  }
})
async function run() {
  loading.value = true
  try {
    const detail = current.value.endsWith('_detail')
    const r = await api.get<any>(URL[current.value], { from: range.value?.[0], to: range.value?.[1], groupBy: summaryLike.value ? groupBy.value : undefined, detail: detail ? 'true' : undefined, partnerId: partnerId.value || undefined })
    rows.value = r.items ?? []
    totals.value = r.totals ?? (r.total ? { total: r.total } : null)
  } catch (e) {
    // 日期区间不合法或超时:保留已填写的筛选条件
    ElMessage.error((e as ApiError).message)
  } finally {
    loading.value = false
  }
}
const columns = computed(() => (rows.value[0] ? Object.keys(rows.value[0]).filter((k) => !/Id$|^key$/.test(k)) : []))
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <el-select v-model="current" style="width: 200px" @change="run"><el-option v-for="d in defs" :key="d.key" :label="d.label" :value="d.key" /></el-select>
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="起始" end-placeholder="结束" @change="run" />
      <el-select v-if="summaryLike" v-model="groupBy" style="width: 130px" @change="run"><el-option label="按商品" value="product" /><el-option label="按往来单位" value="partner" /><el-option label="按销售员" value="salesperson" /><el-option label="按日期" value="date" /></el-select>
      <el-select v-if="current.endsWith('_detail')" v-model="partnerId" placeholder="往来单位" filterable style="width: 180px" @change="run"><el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" /></el-select>
    </div>
    <div v-loading="loading" class="table-wrap">
      <el-table :data="rows" border><el-table-column v-for="c in columns" :key="c" :prop="c" :label="c" min-width="120" /></el-table>
    </div>
    <div v-if="totals" class="total-bar"><span v-for="(v, k) in totals" :key="k">{{ k }}:<b>{{ v }}</b></span></div>
  </div>
</template>
