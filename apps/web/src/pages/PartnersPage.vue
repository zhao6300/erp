<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ApiError } from '@erp/api-client'
import CustomFieldRenderer from '../components/CustomFieldRenderer.vue'
import { api } from '../lib/api'
import { initialCustom } from '@erp/shared'
import { useSession } from '../stores/session'

interface Pt { id: string; code: string; name: string; kind: string; phone: string; contact: string; arBalance?: string; apBalance?: string; enabled: boolean; version: number; creditLimit: string | null; priceLevel: { type: string; rate?: string }; openingAr: string; openingAp: string; custom: Record<string, unknown> }
const session = useSession()
const rows = ref<Pt[]>([])
const total = ref(0)
const q = reactive({ keyword: '', kind: '', page: 1, pageSize: 20 })
const dlg = ref(false)
const detail = ref<{ partner: Pt; recentDocuments: { id: string; docNo: string; docType: string; docDate: string; amount: string }[] } | null>(null)
const editing = ref<Pt | null>(null)
const form = reactive<Record<string, any>>({})
const errors = ref<Record<string, string>>({})
const defs = computed(() => session.boot?.customFields[form.kind === 'supplier' ? 'supplier' : 'customer'] ?? [])

async function load() {
  const r = await api.get<{ items: Pt[]; total: number }>('/api/partners', q)
  rows.value = r.items
  total.value = r.total
}
onMounted(load)
function open(p?: Pt) {
  editing.value = p ?? null
  errors.value = {}
  Object.keys(form).forEach((k) => delete form[k])
  Object.assign(form, p ? { code: p.code, name: p.name, kind: p.kind, contact: p.contact, phone: p.phone, openingAr: p.openingAr, openingAp: p.openingAp, creditLimit: p.creditLimit, priceLevelType: p.priceLevel.type, priceRate: p.priceLevel.rate ?? '', custom: { ...p.custom } } : { kind: 'customer', openingAr: '0', openingAp: '0', priceLevelType: 'retail', custom: initialCustom(defs.value as never, null) })
  dlg.value = true
}
async function save() {
  const priceLevel = form.priceLevelType === 'discount' ? { type: 'discount', rate: form.priceRate } : { type: form.priceLevelType }
  const body: Record<string, any> = { ...form, priceLevel, creditLimit: form.creditLimit === '' ? null : form.creditLimit }
  delete body.priceLevelType
  delete body.priceRate
  try {
    if (editing.value) await api.put(`/api/partners/${editing.value.id}`, body, { version: editing.value.version })
    else await api.post('/api/partners', body)
    dlg.value = false
    ElMessage.success('已保存')
    await load()
  } catch (e) {
    errors.value = (e as ApiError).fieldErrors()
    ElMessage.error((e as ApiError).message)
  }
}
async function show(p: Pt) {
  detail.value = await api.get(`/api/partners/${p.id}`)
}
async function toggle(p: Pt) {
  await api.post(`/api/partners/${p.id}/${p.enabled ? 'disable' : 'enable'}`)
  await load()
}
const KIND: Record<string, string> = { customer: '客户', supplier: '供应商', both: '客户+供应商' }
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <el-button v-if="session.can('partner:create')" type="primary" @click="open()">新增往来单位</el-button>
      <el-input v-model="q.keyword" placeholder="编码 / 名称 / 电话" clearable style="width: 220px" @change="load" />
      <el-select v-model="q.kind" clearable placeholder="类型" style="width: 120px" @change="load"><el-option label="客户" value="customer" /><el-option label="供应商" value="supplier" /></el-select>
    </div>
    <div class="table-wrap">
      <el-table :data="rows" border>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column label="名称" min-width="160"><template #default="{ row }"><el-link type="primary" @click="show(row)">{{ row.name }}</el-link></template></el-table-column>
        <el-table-column label="类型" width="110"><template #default="{ row }">{{ KIND[row.kind] }}</template></el-table-column>
        <el-table-column prop="phone" label="电话" width="130" />
        <el-table-column prop="arBalance" label="应收余额" width="110" align="right" />
        <el-table-column prop="apBalance" label="应付余额" width="110" align="right" />
        <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="140" fixed="right"><template #default="{ row }"><el-button v-if="session.can('partner:edit')" link type="primary" @click="open(row)">编辑</el-button><el-button v-if="session.can('partner:edit')" link @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button></template></el-table-column>
      </el-table>
    </div>
    <el-pagination v-model:current-page="q.page" :page-size="q.pageSize" :total="total" layout="total, prev, pager, next" style="margin-top: 12px" @current-change="load" />

    <el-dialog v-model="dlg" :title="editing ? '编辑往来单位' : '新增往来单位'" width="720px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="编码" required :error="errors.code"><el-input v-model="form.code" maxlength="32" /></el-form-item>
          <el-form-item label="名称" required :error="errors.name"><el-input v-model="form.name" maxlength="100" /></el-form-item>
          <el-form-item label="类型" required><el-select v-model="form.kind"><el-option v-for="(l, k) in KIND" :key="k" :label="l" :value="k" /></el-select></el-form-item>
          <el-form-item label="联系人"><el-input v-model="form.contact" /></el-form-item>
          <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
          <el-form-item label="期初应收" :error="errors.openingAr"><el-input v-model="form.openingAr" /></el-form-item>
          <el-form-item label="期初应付" :error="errors.openingAp"><el-input v-model="form.openingAp" /></el-form-item>
          <template v-if="form.kind !== 'supplier'">
            <el-form-item label="价格等级"><el-select v-model="form.priceLevelType"><el-option label="零售价" value="retail" /><el-option label="批发价" value="wholesale" /><el-option label="自定义折扣率" value="discount" /></el-select></el-form-item>
            <el-form-item v-if="form.priceLevelType === 'discount'" label="折扣率(1–100)" :error="errors.priceLevel"><el-input v-model="form.priceRate" /></el-form-item>
            <el-form-item label="信用额度(空为不限)" :error="errors.creditLimit"><el-input v-model="form.creditLimit" /></el-form-item>
          </template>
        </div>
        <CustomFieldRenderer v-if="defs.length" v-model="form.custom" :defs="defs" :errors="errors" />
      </el-form>
      <template #footer><el-button @click="dlg = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>

    <el-drawer :model-value="!!detail" size="min(92vw, 520px)" :title="detail?.partner.name" @close="detail = null">
      <div v-if="detail">
        <p>当前应收余额:<b>{{ detail.partner.arBalance }}</b>　当前应付余额:<b>{{ detail.partner.apBalance }}</b></p>
        <h4>最近 20 条已审核单据</h4>
        <div v-for="d in detail.recentDocuments" :key="d.id" class="card-item"><div class="row"><b>{{ d.docNo }}</b><span>{{ d.docDate }}</span></div><div class="row"><span class="k">{{ d.docType }}</span><span>{{ d.amount }}</span></div></div>
      </div>
    </el-drawer>
  </div>
</template>
