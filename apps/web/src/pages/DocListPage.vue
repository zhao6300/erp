<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ApiError } from '@erp/api-client'
import type { DocType } from '@erp/shared'
import { api } from '../lib/api'
import { DOC_STATUS_LABEL, DOC_TYPE_LABEL, FULFILL_LABEL, PUSH_TARGETS, statusTag } from '../lib/docMeta'
import { layoutFor } from '../lib/layout'
import { useSession } from '../stores/session'

interface Row { id: string; docNo: string; docDate: string; status: string; partnerName: string | null; totalAmount: string; grossProfit?: string | null; fulfillment: string | null; version: number }
const route = useRoute()
const router = useRouter()
const session = useSession()
const type = computed(() => route.params.type as DocType)
const rows = ref<Row[]>([])
const total = ref(0)
const q = ref({ keyword: '', status: '', from: '', to: '', page: 1, pageSize: 20 })
const loading = ref(false)
const cards = computed(() => layoutFor(window.innerWidth).tableAs === 'cards')

async function load() {
  loading.value = true
  try {
    const r = await api.get<{ items: Row[]; total: number }>('/api/documents', { docType: type.value, ...q.value })
    rows.value = r.items
    total.value = r.total
  } catch (e) {
    ElMessage.error((e as ApiError).message)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(type, () => {
  q.value.page = 1
  void load()
})

async function act(row: Row, action: 'audit' | 'unaudit' | 'void') {
  const label = { audit: '审核', unaudit: '反审核', void: '作废' }[action]
  await ElMessageBox.confirm(`确认${label}单据 ${row.docNo}?`, label)
  try {
    await api.post(`/api/documents/${row.id}/${action}`, { version: row.version })
    ElMessage.success(`${label}成功`)
  } catch (e) {
    const err = e as ApiError
    if (err.needsCreditConfirm) {
      // 超出信用额度:确认后带 confirmCredit=true 重新提交;取消则保持草稿(需求 12.5)
      await ElMessageBox.confirm(`${err.message}(超出 ${String(err.details[0]?.excess ?? '')}),是否继续审核?`, '信用额度')
      await api.post(`/api/documents/${row.id}/audit`, { version: row.version, confirmCredit: true })
      ElMessage.success('审核成功')
    } else ElMessage.error(err.message)
  }
  await load()
}
async function push(row: Row) {
  const target = PUSH_TARGETS[type.value]!
  try {
    const d = await api.post<{ id: string }>(`/api/documents/${row.id}/generate`, { targetType: target })
    router.push(`/docs/${target}/${d.id}`)
  } catch (e) {
    ElMessage.error((e as ApiError).message)
  }
}
const printUrl = (id: string) => `/api/documents/${id}/print`
async function print(row: Row) {
  const html = await fetch(printUrl(row.id), { headers: { authorization: `Bearer ${await api.token()}` } }).then((r) => r.text())
  const w = window.open('', '_blank')
  if (w) {
    w.document.write(html)
    w.document.close()
    w.focus()
    w.print()
  }
}
</script>

<template>
  <div class="page">
    <h3 style="margin-top: 0">{{ DOC_TYPE_LABEL[type] }}</h3>
    <div class="toolbar">
      <el-button v-if="session.can(`${type}:create`)" type="primary" @click="router.push(`/docs/${type}/new`)">新建</el-button>
      <el-input v-model="q.keyword" placeholder="单据编号" clearable style="width: 160px" @change="load" />
      <el-select v-model="q.status" placeholder="状态" clearable style="width: 110px" @change="load">
        <el-option v-for="(l, k) in DOC_STATUS_LABEL" :key="k" :label="l" :value="k" />
      </el-select>
      <el-date-picker v-model="q.from" type="date" value-format="YYYY-MM-DD" placeholder="起始日期" style="width: 140px" @change="load" />
      <el-date-picker v-model="q.to" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width: 140px" @change="load" />
    </div>
    <div class="table-wrap" :class="{ 'as-cards': cards }">
      <el-table v-loading="loading" :data="rows" border>
        <el-table-column prop="docNo" label="单据编号" min-width="160"><template #default="{ row }"><el-link type="primary" @click="router.push(`/docs/${type}/${row.id}`)">{{ row.docNo }}</el-link></template></el-table-column>
        <el-table-column prop="docDate" label="日期" width="110" />
        <el-table-column prop="partnerName" label="往来单位" min-width="120" />
        <el-table-column prop="totalAmount" label="金额" width="110" align="right" />
        <el-table-column v-if="rows.some((r) => r.grossProfit !== undefined)" prop="grossProfit" label="毛利" width="100" align="right" />
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="statusTag(row.status)">{{ DOC_STATUS_LABEL[row.status as 'draft'] }}</el-tag></template></el-table-column>
        <el-table-column v-if="type.endsWith('_order')" label="进度" width="90"><template #default="{ row }">{{ FULFILL_LABEL[row.fulfillment ?? 'none'] }}</template></el-table-column>
        <el-table-column label="操作" min-width="260" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'draft' && session.can(`${type}:audit`)" link type="primary" @click="act(row, 'audit')">审核</el-button>
            <el-button v-if="row.status === 'audited' && session.can(`${type}:unaudit`)" link @click="act(row, 'unaudit')">反审核</el-button>
            <el-button v-if="row.status === 'draft' && session.can(`${type}:void`)" link type="danger" @click="act(row, 'void')">作废</el-button>
            <el-button v-if="row.status === 'audited' && PUSH_TARGETS[type]" link @click="push(row)">下推</el-button>
            <el-button v-if="session.can(`${type}:print`)" link @click="print(row)">打印</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="cards">
        <div v-for="r in rows" :key="r.id" class="card-item" @click="router.push(`/docs/${type}/${r.id}`)">
          <div class="row"><b>{{ r.docNo }}</b><el-tag :type="statusTag(r.status)">{{ DOC_STATUS_LABEL[r.status as 'draft'] }}</el-tag></div>
          <div class="row"><span class="k">日期</span><span>{{ r.docDate }}</span></div>
          <div class="row"><span class="k">往来单位</span><span>{{ r.partnerName }}</span></div>
          <div class="row"><span class="k">金额</span><b>{{ r.totalAmount }}</b></div>
        </div>
      </div>
    </div>
    <el-pagination v-model:current-page="q.page" v-model:page-size="q.pageSize" :total="total" layout="total, prev, pager, next" style="margin-top: 12px" @current-change="load" />
  </div>
</template>
