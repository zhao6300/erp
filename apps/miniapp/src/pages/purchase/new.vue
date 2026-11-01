<script setup lang="ts">
import { reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { newClientRequestId } from '@erp/api-client'
import { DocFormState, addOrIncrement, emptyForm, newLine, precheck, toInput, totals } from '@erp/shared'
import { api, bootstrap, drafts } from '../../core/runtime'

declare const uni: any

// 采购开单:与销售开单相同的表单规则(@erp/shared/docForm),支持本地草稿与幂等重提交
const form = reactive<DocFormState>(emptyForm('purchase_in', new Date().toISOString().slice(0, 10)))
const suppliers = ref<{ id: string; name: string }[]>([])
const keyword = ref('')
const hits = ref<any[]>([])
const errors = ref<Record<string, string>>({})
const sum = ref({ total: '0.00', lines: [] as { amount: string }[] })
const requestId = newClientRequestId()
let scales = { qtyScale: 2, priceScale: 4, amountScale: 2 }

onLoad(async () => {
  const b = await bootstrap()
  scales = b.settings
  suppliers.value = (await api.get<{ items: any[] }>('/api/partners', { kind: 'supplier', enabled: true, pageSize: 100 })).items
  form.warehouseId = (await api.get<any[]>('/api/warehouses', { enabled: true }))[0]?.id ?? null
})
const recalc = () => (sum.value = totals(form, scales))
async function search() {
  hits.value = keyword.value ? await api.get<any[]>('/api/products/search', { keyword: keyword.value }) : []
}
function pick(h: any) {
  form.lines = addOrIncrement(form.lines, newLine({ skuId: h.skuId, label: `${h.skuCode} ${h.name}` }, String(Number(h.refCostPrice ?? h.refSalePrice)), form.warehouseId))
  hits.value = []
  recalc()
}
async function submit(autoAudit: boolean) {
  recalc()
  const pre = precheck(form, scales)
  errors.value = pre.byKey
  if (pre.issues.length) return
  const r = await drafts.submit(api, { clientRequestId: requestId, savedAt: Date.now(), input: toInput(form) as never, form: { ...form }, autoAudit })
  if (r.ok) uni.showToast({ title: r.response.auditError ? '已保存为草稿' : '已提交' })
  else uni.showToast({ title: '提交失败,内容已保存在本机', icon: 'none' })
}
</script>

<template>
  <view>
    <view class="card"><picker :range="suppliers" range-key="name" @change="form.partnerId = suppliers[$event.detail.value].id"><view class="row"><text>供应商</text><text>{{ suppliers.find((s) => s.id === form.partnerId)?.name ?? '请选择' }}</text></view></picker><text v-if="errors.partnerId" class="err">{{ errors.partnerId }}</text></view>
    <view class="card"><input v-model="keyword" placeholder="搜索商品" @input="search" /><view v-for="h in hits" :key="h.skuId" class="row" @tap="pick(h)"><text>{{ h.skuCode }} {{ h.name }}</text></view></view>
    <view v-for="(l, i) in form.lines" :key="l.skuId" class="card">
      <view class="row"><text>{{ l.skuLabel }}</text></view>
      <view class="row"><text>数量</text><input v-model="l.qty" type="digit" @input="recalc" /></view>
      <view class="row"><text>单价</text><input v-model="l.price" type="digit" @input="recalc" /></view>
      <text v-if="errors[`qty@${i + 1}`]" class="err">{{ errors[`qty@${i + 1}`] }}</text>
    </view>
    <view class="card"><view class="row"><text>总金额</text><text>{{ sum.total }}</text></view></view>
    <view class="btn" @tap="submit(false)">保存</view>
    <view class="btn" @tap="submit(true)">保存并审核</view>
  </view>
</template>
