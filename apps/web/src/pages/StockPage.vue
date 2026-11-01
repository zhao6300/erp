<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { api } from '../lib/api'

const tab = ref('balances')
const q = reactive({ keyword: '', asOf: '', warehouseId: '' })
const bal = ref<any[]>([])
const ledger = ref<any[]>([])
const alerts = ref<any[]>([])
const warehouses = ref<any[]>([])
const range = ref<[string, string] | null>(null)
async function load() {
  bal.value = (await api.get<{ items: any[] }>('/api/stock/balances', { ...q, pageSize: 100 })).items
  alerts.value = await api.get<any[]>('/api/stock/alerts')
}
async function loadLedger() {
  ledger.value = (await api.get<{ items: any[] }>('/api/stock/ledger', { warehouseId: q.warehouseId, from: range.value?.[0], to: range.value?.[1], pageSize: 100 })).items
}
onMounted(async () => {
  warehouses.value = await api.get<any[]>('/api/warehouses')
  await load()
  await loadLedger()
})
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <el-input v-model="q.keyword" placeholder="编码 / 名称" clearable style="width: 200px" @change="load" />
      <el-select v-model="q.warehouseId" clearable placeholder="仓库" style="width: 150px" @change="() => { load(); loadLedger() }"><el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select>
      <el-date-picker v-model="q.asOf" type="date" value-format="YYYY-MM-DD" placeholder="截至日期" style="width: 150px" @change="load" />
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="库存余额" name="balances">
        <div class="table-wrap"><el-table :data="bal" border>
          <el-table-column prop="skuCode" label="编码" width="130" /><el-table-column prop="name" label="名称" min-width="160" /><el-table-column prop="warehouseName" label="仓库" width="120" />
          <el-table-column prop="qty" label="数量" width="110" align="right" />
          <el-table-column v-if="bal.some((r) => r.amount !== undefined)" prop="amount" label="库存金额" width="120" align="right" />
        </el-table></div>
      </el-tab-pane>
      <el-tab-pane label="库存流水" name="ledger">
        <div class="toolbar"><el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" @change="loadLedger" /></div>
        <div class="table-wrap"><el-table :data="ledger" border>
          <el-table-column prop="occurredAt" label="时间" width="190" /><el-table-column prop="docNo" label="单据" width="170" /><el-table-column prop="skuCode" label="SKU" width="120" />
          <el-table-column prop="qtyDelta" label="变动" width="100" align="right" /><el-table-column prop="balanceAfter" label="结存" width="100" align="right" />
        </el-table></div>
      </el-tab-pane>
      <el-tab-pane :label="`库存预警(${alerts.length})`" name="alerts">
        <div class="table-wrap"><el-table :data="alerts" border>
          <el-table-column prop="skuCode" label="编码" width="130" /><el-table-column prop="name" label="名称" min-width="160" />
          <el-table-column prop="totalQty" label="合计数量" width="110" align="right" /><el-table-column prop="stockMin" label="下限" width="90" /><el-table-column prop="stockMax" label="上限" width="90" />
          <el-table-column label="超出限值" width="110" align="right"><template #default="{ row }"><span :style="{ color: row.kind === 'below' ? 'var(--el-color-danger)' : 'var(--el-color-warning)' }">{{ row.diff }}</span></template></el-table-column>
        </el-table></div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
