<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ApiError } from '@erp/api-client'
import CustomFieldRenderer from '../components/CustomFieldRenderer.vue'
import { api } from '../lib/api'
import { initialCustom } from '@erp/shared'
import { layoutFor } from '../lib/layout'
import { useSession } from '../stores/session'

interface P { id: string; code: string; name: string; spec: string; baseUnit: string; barcode: string; refCostPrice?: string; refSalePrice: string; enabled: boolean; version: number; custom: Record<string, unknown>; stockMin: string | null; stockMax: string | null; remark: string; wholesalePrice: string | null; units: { unitName: string; ratio: number }[] }
const session = useSession()
const rows = ref<P[]>([])
const total = ref(0)
const q = reactive({ keyword: '', page: 1, pageSize: 20 })
const dlg = ref(false)
const editing = ref<P | null>(null)
const form = reactive<Record<string, any>>({})
const errors = ref<Record<string, string>>({})
const defs = computed(() => session.boot?.customFields.product ?? [])
const cards = computed(() => layoutFor(window.innerWidth).tableAs === 'cards')
const showCost = computed(() => rows.value.some((r) => r.refCostPrice !== undefined))

async function load() {
  const r = await api.get<{ items: P[]; total: number }>('/api/products', q)
  rows.value = r.items
  total.value = r.total
}
onMounted(load)
function open(p?: P) {
  editing.value = p ?? null
  errors.value = {}
  Object.keys(form).forEach((k) => delete form[k])
  Object.assign(form, p ? { code: p.code, name: p.name, spec: p.spec, baseUnit: p.baseUnit, barcode: p.barcode, refCostPrice: p.refCostPrice, refSalePrice: p.refSalePrice, wholesalePrice: p.wholesalePrice, stockMin: p.stockMin, stockMax: p.stockMax, remark: p.remark, units: p.units, custom: { ...p.custom } } : { baseUnit: '个', refSalePrice: '0', refCostPrice: '0', custom: initialCustom(defs.value as never, null) })
  dlg.value = true
}
async function save() {
  try {
    const body = { ...form }
    for (const k of ['wholesalePrice', 'stockMin', 'stockMax']) if (body[k] === '' || body[k] === undefined) body[k] = null
    // 编辑时无成本权限的用户看不到进价,不应把缺失当作改成 0
    if (editing.value && body.refCostPrice === undefined) delete body.refCostPrice
    if (editing.value) await api.put(`/api/products/${editing.value.id}`, body, { version: editing.value.version })
    else await api.post('/api/products', body)
    dlg.value = false
    ElMessage.success('已保存')
    await load()
  } catch (e) {
    // 校验失败时保留已填写的内容(需求 11.2)
    errors.value = (e as ApiError).fieldErrors()
    ElMessage.error((e as ApiError).message)
  }
}
async function toggle(p: P) {
  await api.post(`/api/products/${p.id}/${p.enabled ? 'disable' : 'enable'}`)
  await load()
}
async function remove(p: P) {
  await ElMessageBox.confirm(`删除商品 ${p.code}?`, '删除')
  try {
    await api.delete(`/api/products/${p.id}`)
    await load()
  } catch (e) {
    ElMessage.error((e as ApiError).message) // 已被引用时提示改为停用(需求 11.9)
  }
}
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <el-button v-if="session.can('product:create')" type="primary" @click="open()">新增商品</el-button>
      <el-input v-model="q.keyword" placeholder="编码 / 名称 / 条码" clearable style="width: 220px" @change="load" />
    </div>
    <div class="table-wrap" :class="{ 'as-cards': cards }">
      <el-table :data="rows" border>
        <el-table-column prop="code" label="编码" width="130" />
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="spec" label="规格" width="120" />
        <el-table-column prop="baseUnit" label="单位" width="80" />
        <el-table-column prop="barcode" label="条码" width="140" />
        <el-table-column v-if="showCost" prop="refCostPrice" label="参考进价" width="110" align="right" />
        <el-table-column prop="refSalePrice" label="参考售价" width="110" align="right" />
        <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button v-if="session.can('product:edit')" link type="primary" @click="open(row)">编辑</el-button>
            <el-button v-if="session.can('product:edit')" link @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button v-if="session.can('product:delete')" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="cards">
        <div v-for="r in rows" :key="r.id" class="card-item" @click="open(r)">
          <div class="row"><b>{{ r.name }}</b><span>{{ r.code }}</span></div>
          <div class="row"><span class="k">规格</span><span>{{ r.spec }}</span></div>
          <div class="row"><span class="k">售价</span><span>{{ r.refSalePrice }}</span></div>
        </div>
      </div>
    </div>
    <el-pagination v-model:current-page="q.page" :page-size="q.pageSize" :total="total" layout="total, prev, pager, next" style="margin-top: 12px" @current-change="load" />
    <el-dialog v-model="dlg" :title="editing ? '编辑商品' : '新增商品'" width="720px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="编码" required :error="errors.code"><el-input v-model="form.code" maxlength="32" /></el-form-item>
          <el-form-item label="名称" required :error="errors.name"><el-input v-model="form.name" maxlength="100" /></el-form-item>
          <el-form-item label="规格型号"><el-input v-model="form.spec" maxlength="100" /></el-form-item>
          <el-form-item label="基本单位" required :error="errors.baseUnit"><el-input v-model="form.baseUnit" /></el-form-item>
          <el-form-item label="条码" :error="errors.barcode"><el-input v-model="form.barcode" maxlength="32" /></el-form-item>
          <el-form-item v-if="!editing || form.refCostPrice !== undefined" label="参考进价" :error="errors.refCostPrice"><el-input v-model="form.refCostPrice" /></el-form-item>
          <el-form-item label="参考售价" :error="errors.refSalePrice"><el-input v-model="form.refSalePrice" /></el-form-item>
          <el-form-item label="批发价"><el-input v-model="form.wholesalePrice" /></el-form-item>
          <el-form-item label="库存下限"><el-input v-model="form.stockMin" /></el-form-item>
          <el-form-item label="库存上限" :error="errors.stockMax"><el-input v-model="form.stockMax" /></el-form-item>
        </div>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" maxlength="500" /></el-form-item>
        <CustomFieldRenderer v-if="defs.length" v-model="form.custom" :defs="defs" :errors="errors" />
      </el-form>
      <template #footer><el-button @click="dlg = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
