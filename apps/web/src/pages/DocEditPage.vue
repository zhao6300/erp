<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ApiError, newClientRequestId } from '@erp/api-client'
import type { DocType } from '@erp/shared'
import CustomFieldRenderer from '../components/CustomFieldRenderer.vue'
import { api } from '../lib/api'
import { addOrIncrement, DocFormState, emptyForm, initialCustom, newLine, precheck, toInput, totals } from '@erp/shared'
import { DOC_STATUS_LABEL, DOC_TYPE_LABEL, hasPaid, isFundDoc, isTradeDoc, partnerKind } from '../lib/docMeta'
import { useSession } from '../stores/session'

interface Opt { id: string; name: string }
interface SkuHit { skuId: string; skuCode: string; name: string; refSalePrice: string; refCostPrice: string; baseUnit: string }
const route = useRoute()
const router = useRouter()
const session = useSession()
const type = computed(() => route.params.type as DocType)
const id = computed(() => route.params.id as string | undefined)
const today = new Date().toISOString().slice(0, 10)
const form = reactive<DocFormState>(emptyForm(type.value, today))
const status = ref<'draft' | 'audited' | 'voided'>('draft')
const docNo = ref('')
const partners = ref<Opt[]>([])
const warehouses = ref<Opt[]>([])
const funds = ref<Opt[]>([])
const categories = ref<Opt[]>([])
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const search = ref('')
const hits = ref<SkuHit[]>([])
const clientRequestId = newClientRequestId() // 同一次编辑的重复提交幂等(需求 19.8)

const scales = computed(() => session.scales)
const readonly = computed(() => status.value !== 'draft')
const sum = computed(() => totals(form, scales.value))
const customDefs = computed(() => {
  const o = type.value.startsWith('purchase') ? 'purchase_doc' : type.value.startsWith('sales') ? 'sales_doc' : null
  return o ? (session.boot?.customFields[o] ?? []) : []
})

async function init() {
  const kind = partnerKind(type.value)
  const [p, w, f, c] = await Promise.all([
    kind ? api.get<{ items: { id: string; name: string }[] }>('/api/partners', { kind, enabled: true, pageSize: 100 }) : Promise.resolve({ items: [] }),
    api.get<{ id: string; name: string }[]>('/api/warehouses', { enabled: true }),
    isFundDoc(type.value) || hasPaid(type.value) ? api.get<{ id: string; name: string }[]>('/api/fund-accounts', { enabled: true }) : Promise.resolve([]),
    ['other_income', 'other_expense'].includes(type.value) ? api.get<{ id: string; name: string }[]>('/api/fund-categories', { direction: type.value === 'other_income' ? 'in' : 'out' }) : Promise.resolve([]),
  ])
  partners.value = p.items
  warehouses.value = w
  funds.value = f
  categories.value = c
  if (id.value && id.value !== 'new') {
    const d = await api.get<any>(`/api/documents/${id.value}`)
    Object.assign(form, { ...emptyForm(d.docType, d.docDate), id: d.id, version: d.version, partnerId: d.partnerId, warehouseId: d.warehouseId, toWarehouseId: d.toWarehouseId, fundAccountId: d.fundAccountId, fundCategoryId: d.fundCategoryId, upstreamId: d.upstreamId, docDiscount: d.docDiscount, paidAmount: d.paidAmount, amount: isFundDoc(d.docType) ? d.totalAmount : undefined, remark: d.remark, custom: initialCustom(customDefs.value as never, d.custom) })
    form.lines = d.lines.map((l: any) => ({ skuId: l.skuId, skuLabel: `${l.skuCode ?? ''} ${l.productName ?? ''}`, unitName: l.unitName, ratio: l.ratio, qty: l.qty, price: l.price, discountRate: l.discountRate, warehouseId: l.warehouseId, upstreamLineId: l.upstreamLineId, countedQty: l.countedQty }))
    status.value = d.status
    docNo.value = d.docNo
  } else {
    form.warehouseId = w[0]?.id ?? null
    form.custom = initialCustom(customDefs.value as never, null) // 新增页预填默认值
  }
}
onMounted(init)

async function searchSku() {
  hits.value = search.value ? await api.get<SkuHit[]>('/api/products/search', { keyword: search.value }) : []
}
function pick(h: SkuHit) {
  const price = type.value.startsWith('purchase') ? h.refCostPrice : h.refSalePrice
  form.lines = addOrIncrement(form.lines, newLine({ skuId: h.skuId, label: `${h.skuCode} ${h.name}` }, String(Number(price)), form.warehouseId))
  hits.value = []
  search.value = ''
}

/** 提交。422/409 时保留页面上用户录入的全部内容,仅展示错误(需求 19.10) */
async function save(autoAudit = false, confirmCredit = false) {
  const pre = precheck(form, scales.value)
  errors.value = pre.byKey
  if (pre.issues.length) return ElMessage.error('请先修正标红的问题')
  saving.value = true
  try {
    const r = await api.saveDocument({ ...toInput(form), id: form.id }, { clientRequestId, autoAudit, confirmCredit, version: form.version })
    if (r.auditError) ElMessage.warning(`已保存为草稿,审核未通过:${r.auditError.message}`)
    else ElMessage.success(r.doc.status === 'audited' ? '已保存并审核' : '已保存')
    // 保存成功后跳到详情;新建时路由参数变化,原地重新载入数据即可,不需要整页刷新
    if (id.value !== r.doc.id) await router.replace(`/docs/${type.value}/${r.doc.id}`)
    await init()
  } catch (e) {
    const err = e as ApiError
    if (err.needsCreditConfirm) {
      await ElMessageBox.confirm(`${err.message}(超出 ${String(err.details[0]?.excess ?? '')})。确认后继续审核。`, '信用额度', { type: 'warning' })
      return save(autoAudit, true)
    }
    errors.value = err.fieldErrors()
    ElMessage.error(err.message)
  } finally {
    saving.value = false
  }
}
const removeLine = (i: number) => form.lines.splice(i, 1)
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <h3 style="margin: 0">{{ DOC_TYPE_LABEL[type] }} <small v-if="docNo">{{ docNo }}</small></h3>
      <el-tag v-if="id !== 'new' && id">{{ DOC_STATUS_LABEL[status] }}</el-tag>
      <div style="flex: 1" />
      <el-button @click="router.back()">返回</el-button>
      <template v-if="!readonly">
        <el-button :loading="saving" @click="save(false)">保存</el-button>
        <el-button v-if="session.can(`${type}:audit`)" :loading="saving" type="primary" @click="save(true)">保存并审核</el-button>
      </template>
    </div>
    <el-form label-position="top">
      <div class="form-grid">
        <el-form-item label="单据日期"><el-date-picker v-model="form.docDate" type="date" value-format="YYYY-MM-DD" :disabled="readonly" /></el-form-item>
        <el-form-item v-if="partnerKind(type)" :label="partnerKind(type) === 'customer' ? '客户' : '供应商'" :error="errors.partnerId">
          <el-select v-model="form.partnerId" filterable :disabled="readonly"><el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" /></el-select>
        </el-form-item>
        <el-form-item v-if="!isFundDoc(type)" :label="type === 'transfer' ? '调出仓库' : '仓库'" :error="errors.warehouseId">
          <el-select v-model="form.warehouseId" :disabled="readonly"><el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select>
        </el-form-item>
        <el-form-item v-if="type === 'transfer'" label="调入仓库" :error="errors.toWarehouseId">
          <el-select v-model="form.toWarehouseId" :disabled="readonly"><el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" /></el-select>
        </el-form-item>
        <el-form-item v-if="isFundDoc(type) || (hasPaid(type) && Number(form.paidAmount) > 0)" label="资金账户" :error="errors.fundAccountId">
          <el-select v-model="form.fundAccountId" :disabled="readonly"><el-option v-for="f in funds" :key="f.id" :label="f.name" :value="f.id" /></el-select>
        </el-form-item>
        <el-form-item v-if="categories.length || ['other_income', 'other_expense'].includes(type)" label="收支类别" :error="errors.fundCategoryId">
          <el-select v-model="form.fundCategoryId" :disabled="readonly"><el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" /></el-select>
        </el-form-item>
        <el-form-item v-if="isFundDoc(type)" label="金额" :error="errors.amount"><el-input v-model="form.amount" :disabled="readonly" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" maxlength="500" :disabled="readonly" /></el-form-item>
      </div>
      <CustomFieldRenderer v-if="customDefs.length" v-model="form.custom" :defs="customDefs" :errors="errors" :readonly="readonly" />

      <template v-if="!isFundDoc(type)">
        <div v-if="!readonly" class="toolbar">
          <el-input v-model="search" placeholder="输入编码/名称/条码搜索商品" style="max-width: 320px" clearable @input="searchSku" />
        </div>
        <el-card v-if="hits.length" style="margin-bottom: 8px"><div v-for="h in hits" :key="h.skuId" style="padding: 6px; cursor: pointer" @click="pick(h)">{{ h.skuCode }} {{ h.name }}</div></el-card>
        <div class="table-wrap">
          <el-table :data="form.lines" border>
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="skuLabel" label="商品" min-width="180" />
            <el-table-column v-if="type === 'stocktake'" label="盘点数量" width="130"><template #default="{ row, $index }"><el-input v-model="row.countedQty" :disabled="readonly" /><div class="err">{{ errors[`countedQty@${$index + 1}`] }}</div></template></el-table-column>
            <template v-else>
              <el-table-column label="数量" width="120"><template #default="{ row, $index }"><el-input v-model="row.qty" :disabled="readonly" /><div class="err">{{ errors[`qty@${$index + 1}`] }}</div></template></el-table-column>
              <el-table-column v-if="type !== 'transfer'" label="单价" width="120"><template #default="{ row, $index }"><el-input v-model="row.price" :disabled="readonly" /><div class="err">{{ errors[`price@${$index + 1}`] }}</div></template></el-table-column>
              <el-table-column v-if="type !== 'transfer'" label="折扣%" width="90"><template #default="{ row }"><el-input v-model="row.discountRate" :disabled="readonly" /></template></el-table-column>
              <el-table-column v-if="type !== 'transfer'" label="金额" width="110" align="right"><template #default="{ $index }">{{ sum.lines[$index]?.amount }}</template></el-table-column>
            </template>
            <el-table-column v-if="!readonly" label="" width="70"><template #default="{ $index }"><el-button link type="danger" @click="removeLine($index)">删除</el-button></template></el-table-column>
          </el-table>
        </div>
        <div v-if="isTradeDoc(type) && type !== 'purchase_order' && type !== 'sales_order'" class="form-grid" style="margin-top: 12px">
          <el-form-item label="整单优惠" :error="errors.docDiscount"><el-input v-model="form.docDiscount" :disabled="readonly" /></el-form-item>
          <el-form-item v-if="hasPaid(type)" :label="type === 'sales_out' ? '本单已收' : '本单已付'" :error="errors.paidAmount"><el-input v-model="form.paidAmount" :disabled="readonly" /></el-form-item>
        </div>
        <div v-if="isTradeDoc(type)" class="total-bar"><span>行合计:{{ sum.linesTotal }}</span><b>单据总金额:{{ sum.total }}</b></div>
      </template>
      <div v-if="errors.lines" class="err">{{ errors.lines }}</div>
    </el-form>
  </div>
</template>
