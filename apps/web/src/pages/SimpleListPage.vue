<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ApiError } from '@erp/api-client'
import { api } from '../lib/api'
import { useSession } from '../stores/session'

const props = defineProps<{ kind: 'warehouse' | 'fund' }>()
const session = useSession()
const rows = ref<any[]>([])
const dlg = ref(false)
const form = reactive<Record<string, any>>({})
const editing = ref<any>(null)
const url = props.kind === 'warehouse' ? '/api/warehouses' : '/api/fund-accounts'
const perm = props.kind === 'warehouse' ? 'warehouse' : 'fund_account'
const transfer = reactive({ show: false, from: '', to: '', amount: '', date: new Date().toISOString().slice(0, 10) })
const load = async () => (rows.value = await api.get<any[]>(url))
onMounted(load)
function open(r?: any) {
  editing.value = r ?? null
  Object.keys(form).forEach((k) => delete form[k])
  Object.assign(form, r ? { ...r } : props.kind === 'fund' ? { type: 'cash', openingBalance: '0' } : {})
  dlg.value = true
}
async function save() {
  try {
    editing.value ? await api.put(`${url}/${editing.value.id}`, form) : await api.post(url, form)
    dlg.value = false
    await load()
  } catch (e) {
    ElMessage.error((e as ApiError).message)
  }
}
async function toggle(r: any) {
  try {
    await api.post(`${url}/${r.id}/${r.enabled ? 'disable' : 'enable'}`)
    await load()
  } catch (e) {
    ElMessage.error((e as ApiError).message) // 例如:已达到授权仓库数上限(需求 3.3)
  }
}
async function doTransfer() {
  try {
    await api.post('/api/fund-transfers', { fromAccountId: transfer.from, toAccountId: transfer.to, amount: transfer.amount, transferDate: transfer.date })
    transfer.show = false
    ElMessage.success('转账成功')
    await load()
  } catch (e) {
    ElMessage.error((e as ApiError).message)
  }
}
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <el-button v-if="session.can(`${perm}:create`)" type="primary" @click="open()">新增</el-button>
      <el-button v-if="kind === 'fund' && session.can('fund_transfer:create')" @click="transfer.show = true">资金转账</el-button>
    </div>
    <div class="table-wrap">
      <el-table :data="rows" border>
        <el-table-column prop="code" v-if="kind === 'warehouse'" label="编码" width="130" />
        <el-table-column prop="name" label="名称" min-width="160" />
        <template v-if="kind === 'fund'"><el-table-column prop="type" label="类型" width="100" /><el-table-column prop="balance" label="当前余额" width="130" align="right" /></template>
        <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="140"><template #default="{ row }"><el-button v-if="session.can(`${perm}:edit`)" link type="primary" @click="open(row)">编辑</el-button><el-button v-if="session.can(`${perm}:edit`)" link @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button></template></el-table-column>
      </el-table>
    </div>
    <el-dialog v-model="dlg" :title="editing ? '编辑' : '新增'" width="460px">
      <el-form label-position="top">
        <el-form-item v-if="kind === 'warehouse'" label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" maxlength="50" /></el-form-item>
        <template v-if="kind === 'fund'">
          <el-form-item label="类型"><el-select v-model="form.type"><el-option v-for="t in ['cash', 'bank', 'wechat', 'alipay', 'other']" :key="t" :label="t" :value="t" /></el-select></el-form-item>
          <el-form-item label="期初余额"><el-input v-model="form.openingBalance" /></el-form-item>
        </template>
      </el-form>
      <template #footer><el-button @click="dlg = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="transfer.show" title="资金转账" width="420px">
      <el-form label-position="top">
        <el-form-item label="转出账户"><el-select v-model="transfer.from"><el-option v-for="r in rows.filter((x) => x.enabled)" :key="r.id" :label="`${r.name}(${r.balance})`" :value="r.id" /></el-select></el-form-item>
        <el-form-item label="转入账户"><el-select v-model="transfer.to"><el-option v-for="r in rows.filter((x) => x.enabled)" :key="r.id" :label="r.name" :value="r.id" /></el-select></el-form-item>
        <el-form-item label="金额"><el-input v-model="transfer.amount" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="transfer.show = false">取消</el-button><el-button type="primary" @click="doTransfer">转账</el-button></template>
    </el-dialog>
  </div>
</template>
