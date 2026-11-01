<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ApiError } from '@erp/api-client'
import { DOC_TYPE_LABEL, FIELD_TYPES, FIELD_TYPE_LABEL, MODULE_LABEL, PAPERS, defaultPrintLayout, DocType } from '@erp/shared'
import { api } from '../lib/api'
import { useSession } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSession()
const tab = ref((route.params.tab as string) || 'basic')
watch(tab, (t) => router.replace(t === 'basic' ? '/settings' : `/settings/${t}`))
const fail = (e: unknown) => ElMessage.error((e as ApiError).message)

/* ── 业务参数 / 编号规则 ── */
const settings = reactive<Record<string, any>>({})
const rules = ref<any[]>([])
async function loadBasic() {
  Object.assign(settings, await api.get('/api/settings'))
  rules.value = await api.get('/api/numbering-rules')
}
async function saveSettings() {
  try {
    const { scales: _s, ...body } = settings
    await api.put('/api/settings', body)
    ElMessage.success('已保存,精度参数在下一次加载后生效')
    await session.load()
  } catch (e) {
    fail(e)
  }
}
async function saveRule(r: any) {
  try {
    await api.put(`/api/numbering-rules/${r.docType}`, { prefix: r.prefix, dateFormat: r.dateFormat, seqDigits: r.seqDigits, reset: r.reset })
    ElMessage.success('已保存')
  } catch (e) {
    fail(e) // 前缀含非法字符、重置周期短于日期粒度等会在此指明
  }
}

/* ── 模块 ── */
const modules = ref<any[]>([])
const loadModules = async () => (modules.value = await api.get('/api/modules'))
async function toggleModule(m: any) {
  try {
    const r: any = await api.post(`/api/modules/${m.module}/${m.enabled ? 'disable' : 'enable'}`)
    if (r.autoEnabled?.length) ElMessage.info(`因依赖自动启用:${r.autoEnabled.map((x: string) => MODULE_LABEL[x as 'sales']).join('、')}`)
  } catch (e) {
    fail(e) // 关闭被依赖模块时列出依赖方;启用未授权模块时提示"该模块未授权"
  }
  await loadModules()
  await session.load()
}

/* ── 自定义字段 ── */
const cfObject = ref('product')
const cfList = ref<any[]>([])
const cfDlg = ref(false)
const cf = reactive<Record<string, any>>({})
const cfEditing = ref<any>(null)
const OBJECTS: Record<string, string> = { product: '商品', customer: '客户', supplier: '供应商', warehouse: '仓库', purchase_doc: '采购单据', sales_doc: '销售单据' }
const loadCf = async () => (cfList.value = await api.get(`/api/custom-fields/${cfObject.value}`))
function openCf(d?: any) {
  cfEditing.value = d ?? null
  Object.keys(cf).forEach((k) => delete cf[k])
  Object.assign(cf, d ? { ...d, optionsText: (d.options ?? []).join('\n') } : { type: 'text', required: false, displayOrder: 0, showInList: false, filterable: false, optionsText: '' })
  cfDlg.value = true
}
async function saveCf() {
  const body = { code: cf.code, label: cf.label, type: cf.type, required: cf.required, displayOrder: cf.displayOrder, showInList: cf.showInList, filterable: cf.filterable, enabled: true, options: ['select', 'multiselect'].includes(cf.type) ? cf.optionsText.split('\n').map((s: string) => s.trim()).filter(Boolean) : undefined, defaultValue: cf.defaultValue || undefined }
  try {
    cfEditing.value ? await api.put(`/api/custom-fields/def/${cfEditing.value.id}`, body) : await api.post(`/api/custom-fields/${cfObject.value}`, body)
    cfDlg.value = false
    await loadCf()
    await session.load()
  } catch (e) {
    fail(e)
  }
}
async function toggleCf(d: any) {
  await api.post(`/api/custom-fields/def/${d.id}/${d.enabled ? 'disable' : 'enable'}`)
  await loadCf()
  await session.load()
}

/* ── 角色 / 用户 ── */
const roles = ref<any[]>([])
const users = ref<any[]>([])
const roleDlg = ref(false)
const role = reactive<Record<string, any>>({})
const userDlg = ref(false)
const user = reactive<Record<string, any>>({})
const permText = ref('')
async function loadRoles() {
  roles.value = await api.get('/api/roles')
  users.value = await api.get('/api/users')
}
function openRole(r?: any) {
  Object.keys(role).forEach((k) => delete role[k])
  Object.assign(role, r ? { ...r, scope: r.data_scope.type, ids: r.data_scope.ids ?? [] } : { name: '', scope: 'own', ids: [] })
  permText.value = (r?.permissions ?? []).join('\n')
  roleDlg.value = true
}
async function saveRole() {
  const dataScope = role.scope === 'warehouses' ? { type: 'warehouses', ids: role.ids } : { type: role.scope }
  const body = { name: role.name, permissions: permText.value.split('\n').map((s) => s.trim()).filter(Boolean), dataScope }
  try {
    role.id ? await api.put(`/api/roles/${role.id}`, body) : await api.post('/api/roles', body)
    roleDlg.value = false
    await loadRoles()
  } catch (e) {
    fail(e)
  }
}
async function copyRole(r: any) {
  const { value } = await ElMessageBox.prompt('新角色名称', '复制角色')
  await api.post(`/api/roles/${r.id}/copy`, { name: value }).catch(fail)
  await loadRoles()
}
async function delRole(r: any) {
  await api.delete(`/api/roles/${r.id}`).catch(fail)
  await loadRoles()
}
async function createUser() {
  try {
    const r: any = await api.post('/api/users', { name: user.name, phone: user.phone, roleIds: user.roleIds ?? [] })
    if (r.initialPassword) await ElMessageBox.alert(`初始密码:${r.initialPassword}(仅显示一次,首次登录须修改)`, '用户已创建')
    userDlg.value = false
    await loadRoles()
  } catch (e) {
    fail(e) // 已达到授权用户数上限
  }
}
async function toggleUser(u: any) {
  try {
    await api.post(`/api/users/${u.id}/${u.status === 'enabled' ? 'disable' : 'enable'}`)
  } catch (e) {
    fail(e)
  }
  await loadRoles()
}
async function setUserRoles(u: any) {
  await api.put(`/api/users/${u.id}/roles`, { roleIds: u.roleIds }).catch(fail)
  ElMessage.success('已保存,对方下一次请求起生效')
}

/* ── 品牌 ── */
const brand = reactive<Record<string, any>>({})
async function loadBrand() {
  Object.assign(brand, await api.get('/api/branding'))
}
async function upload(field: 'logoFileId' | 'loginBgFileId', f: { raw: File }) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(await f.raw.arrayBuffer())))
  try {
    brand[field] = ((await api.post('/api/branding/image', { base64 })) as any).id
  } catch (e) {
    fail(e) // 格式或大小不合规,保留原图
  }
}
async function saveBrand() {
  try {
    await api.put('/api/branding', { systemName: brand.systemName, themeColor: brand.themeColor, copyright: brand.copyright, logoFileId: brand.logoFileId, loginBgFileId: brand.loginBgFileId, customDomain: brand.customDomain || null })
    ElMessage.success('已保存,下次加载页面后显示新外观')
    await session.load()
  } catch (e) {
    fail(e)
  }
}

/* ── 配置包 ── */
const pkgText = ref('')
const preview = ref<{ items: any[]; skipped: any[] } | null>(null)
async function exportPkg() {
  const r: any = await api.get('/api/config-package/export')
  const blob = new Blob([r.text], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'config-package.json'
  a.click()
  if (r.notices?.length) ElMessage.warning(r.notices.join(';'))
}
async function readFile(f: { raw: File }) {
  pkgText.value = await f.raw.text()
  try {
    preview.value = await api.post('/api/config-package/preview', { text: pkgText.value })
  } catch (e) {
    preview.value = null
    fail(e) // 带 JSON 路径与行号
  }
}
async function applyPkg() {
  try {
    const r: any = await api.post('/api/config-package/apply', { text: pkgText.value })
    ElMessage.success(`新增 ${r.added} 项,覆盖 ${r.overwritten} 项,跳过 ${r.skipped.length} 项`)
    preview.value = null
    await session.load()
  } catch (e) {
    fail(e)
  }
}

/* ── 打印模板 ── */
const prints = ref<any[]>([])
const printDoc = ref<DocType>('sales_out')
const printEditing = ref<any>(null)
const layoutText = ref('')
const loadPrints = async () => (prints.value = await api.get('/api/print-templates', { docType: printDoc.value }))
function editPrint(t?: any) {
  printEditing.value = t ?? { name: '', paper: 'A4', docType: printDoc.value }
  layoutText.value = JSON.stringify(t?.layout ?? defaultPrintLayout(printDoc.value), null, 2)
}
async function savePrint() {
  try {
    const layout = JSON.parse(layoutText.value)
    const t = printEditing.value
    t.id ? await api.put(`/api/print-templates/${t.id}`, { name: t.name, paper: t.paper, layout }) : await api.post('/api/print-templates', { docType: printDoc.value, name: t.name, paper: t.paper, layout })
    printEditing.value = null
    await loadPrints()
  } catch (e) {
    fail(e) // 无效占位符会被逐一列出,编辑内容保留
  }
}
const setDefault = async (t: any) => (await api.post(`/api/print-templates/${t.id}/default`), loadPrints())
const delPrint = async (t: any) => (await api.delete(`/api/print-templates/${t.id}`).catch(fail), loadPrints())

/* ── 审计日志 ── */
const logs = ref<any[]>([])
const logTotal = ref(0)
const lq = reactive({ action: '', objectType: '', page: 1, pageSize: 20 })
async function loadLogs() {
  const r: any = await api.get('/api/audit-logs', lq)
  logs.value = r.items
  logTotal.value = r.total
}

const tabs = computed(() => (session.isAdmin ? ['basic', 'modules', 'custom-fields', 'roles', 'branding', 'packages', 'print', 'audit'] : ['basic']))
onMounted(async () => {
  await Promise.all([loadBasic(), loadModules(), loadCf(), loadRoles(), loadBrand(), loadPrints(), loadLogs()].map((p) => p.catch(() => {})))
})
</script>

<template>
  <div class="page">
    <el-tabs v-model="tab">
      <el-tab-pane v-if="tabs.includes('basic')" label="业务参数" name="basic">
        <el-form label-position="top" style="max-width: 520px">
          <div class="form-grid">
            <el-form-item label="数量小数位数(0–4)"><el-input-number v-model="settings.qtyScale" :min="0" :max="4" /></el-form-item>
            <el-form-item label="单价小数位数(0–6)"><el-input-number v-model="settings.priceScale" :min="0" :max="6" /></el-form-item>
            <el-form-item label="金额小数位数(0–2)"><el-input-number v-model="settings.amountScale" :min="0" :max="2" /></el-form-item>
          </div>
          <el-form-item><el-checkbox v-model="settings.allowNegativeStock">允许负库存</el-checkbox><el-checkbox v-model="settings.requireAudit">单据需要审核</el-checkbox><el-checkbox v-model="settings.multiUnit">启用多单位</el-checkbox><el-checkbox v-model="settings.multiSku">启用多规格 SKU</el-checkbox><el-checkbox v-model="settings.barcodeEnabled">启用条码</el-checkbox></el-form-item>
          <el-button v-if="session.isAdmin" type="primary" @click="saveSettings">保存</el-button>
        </el-form>
        <h4>单据编号规则</h4>
        <div class="table-wrap"><el-table :data="rules" border>
          <el-table-column label="单据" width="130"><template #default="{ row }">{{ DOC_TYPE_LABEL[row.docType as DocType] }}</template></el-table-column>
          <el-table-column label="前缀" width="140"><template #default="{ row }"><el-input v-model="row.prefix" maxlength="10" /></template></el-table-column>
          <el-table-column label="日期" width="120"><template #default="{ row }"><el-select v-model="row.dateFormat"><el-option label="年月日" value="YMD" /><el-option label="年月" value="YM" /><el-option label="无" value="NONE" /></el-select></template></el-table-column>
          <el-table-column label="流水号位数" width="130"><template #default="{ row }"><el-input-number v-model="row.seqDigits" :min="3" :max="8" /></template></el-table-column>
          <el-table-column label="重置周期" width="120"><template #default="{ row }"><el-select v-model="row.reset"><el-option label="按日" value="daily" /><el-option label="按月" value="monthly" /><el-option label="按年" value="yearly" /><el-option label="不重置" value="never" /></el-select></template></el-table-column>
          <el-table-column label="" width="90"><template #default="{ row }"><el-button v-if="session.isAdmin" link type="primary" @click="saveRule(row)">保存</el-button></template></el-table-column>
        </el-table></div>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('modules')" label="模块与授权" name="modules">
        <div class="table-wrap"><el-table :data="modules" border>
          <el-table-column prop="label" label="模块" width="140" />
          <el-table-column label="授权" width="100"><template #default="{ row }"><el-tag :type="row.licensed ? 'success' : 'info'">{{ row.licensed ? '已授权' : '未授权' }}</el-tag></template></el-table-column>
          <el-table-column label="启用" width="100"><template #default="{ row }"><el-switch :model-value="row.enabled" @change="toggleModule(row)" /></template></el-table-column>
        </el-table></div>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('custom-fields')" label="自定义字段" name="custom-fields">
        <div class="toolbar"><el-select v-model="cfObject" style="width: 140px" @change="loadCf"><el-option v-for="(l, k) in OBJECTS" :key="k" :label="l" :value="k" /></el-select><el-button type="primary" @click="openCf()">新增字段</el-button></div>
        <div class="table-wrap"><el-table :data="cfList" border>
          <el-table-column prop="code" label="编码" width="130" /><el-table-column prop="label" label="显示名称" width="130" />
          <el-table-column label="类型" width="100"><template #default="{ row }">{{ FIELD_TYPE_LABEL[row.type as 'text'] }}</template></el-table-column>
          <el-table-column prop="displayOrder" label="顺序" width="80" /><el-table-column label="必填" width="70"><template #default="{ row }">{{ row.required ? '是' : '否' }}</template></el-table-column>
          <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="150"><template #default="{ row }"><el-button link type="primary" @click="openCf(row)">编辑</el-button><el-button link @click="toggleCf(row)">{{ row.enabled ? '停用' : '启用' }}</el-button></template></el-table-column>
        </el-table></div>
        <el-dialog v-model="cfDlg" :title="cfEditing ? '编辑字段' : '新增字段'" width="520px">
          <el-form label-position="top">
            <el-form-item label="字段编码(保存后不可修改)"><el-input v-model="cf.code" :disabled="!!cfEditing" maxlength="32" /></el-form-item>
            <el-form-item label="显示名称"><el-input v-model="cf.label" maxlength="20" /></el-form-item>
            <el-form-item label="字段类型(保存后不可修改)"><el-select v-model="cf.type" :disabled="!!cfEditing"><el-option v-for="t in FIELD_TYPES" :key="t" :label="FIELD_TYPE_LABEL[t]" :value="t" /></el-select></el-form-item>
            <el-form-item v-if="['select', 'multiselect'].includes(cf.type)" label="可选项(每行一个)"><el-input v-model="cf.optionsText" type="textarea" :rows="4" /></el-form-item>
            <div class="form-grid"><el-form-item label="显示顺序"><el-input-number v-model="cf.displayOrder" :min="0" :max="9999" /></el-form-item></div>
            <el-checkbox v-model="cf.required">必填</el-checkbox><el-checkbox v-model="cf.showInList">列表显示</el-checkbox><el-checkbox v-model="cf.filterable" :disabled="cf.type === 'image'">可筛选</el-checkbox>
          </el-form>
          <template #footer><el-button @click="cfDlg = false">取消</el-button><el-button type="primary" @click="saveCf">保存</el-button></template>
        </el-dialog>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('roles')" label="角色与用户" name="roles">
        <div class="toolbar"><el-button type="primary" @click="openRole()">新增角色</el-button><el-button @click="() => { userDlg = true; Object.keys(user).forEach((k) => delete user[k]) }">新增用户</el-button></div>
        <h4>角色</h4>
        <div class="table-wrap"><el-table :data="roles" border>
          <el-table-column prop="name" label="名称" width="140" /><el-table-column label="类型" width="100"><template #default="{ row }">{{ row.is_template ? '预置模板' : '自建' }}</template></el-table-column>
          <el-table-column label="数据范围" width="130"><template #default="{ row }">{{ { all: '全部数据', own: '本人单据', warehouses: '指定仓库' }[row.data_scope.type as 'all'] }}</template></el-table-column>
          <el-table-column label="操作" min-width="200"><template #default="{ row }"><el-button v-if="!row.is_template" link type="primary" @click="openRole(row)">编辑</el-button><el-button link @click="copyRole(row)">复制</el-button><el-button v-if="!row.is_template" link type="danger" @click="delRole(row)">删除</el-button></template></el-table-column>
        </el-table></div>
        <h4>用户</h4>
        <div class="table-wrap"><el-table :data="users" border>
          <el-table-column prop="name" label="姓名" width="120" /><el-table-column prop="phone" label="手机号" width="140" />
          <el-table-column label="角色" min-width="220"><template #default="{ row }"><el-select v-model="row.roleIds" multiple style="width: 100%" :disabled="row.isTenantAdmin" @change="setUserRoles(row)"><el-option v-for="r in roles" :key="r.id" :label="r.name" :value="r.id" /></el-select></template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'enabled' ? 'success' : 'info'">{{ row.status === 'enabled' ? '启用' : '禁用' }}</el-tag></template></el-table-column>
          <el-table-column label="" width="90"><template #default="{ row }"><el-button v-if="!row.isTenantAdmin" link @click="toggleUser(row)">{{ row.status === 'enabled' ? '禁用' : '启用' }}</el-button></template></el-table-column>
        </el-table></div>
        <el-dialog v-model="roleDlg" :title="role.id ? '编辑角色' : '新增角色'" width="600px">
          <el-form label-position="top">
            <el-form-item label="名称(1–30 字符,租户内唯一)"><el-input v-model="role.name" maxlength="30" /></el-form-item>
            <el-form-item label="数据范围"><el-radio-group v-model="role.scope"><el-radio value="all">全部数据</el-radio><el-radio value="warehouses">指定仓库</el-radio><el-radio value="own">本人单据</el-radio></el-radio-group></el-form-item>
            <el-form-item label="权限码(每行一个,如 menu:sales_out、sales_out:audit、field:cost、field:profit)"><el-input v-model="permText" type="textarea" :rows="8" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="roleDlg = false">取消</el-button><el-button type="primary" @click="saveRole">保存</el-button></template>
        </el-dialog>
        <el-dialog v-model="userDlg" title="新增用户" width="440px">
          <el-form label-position="top"><el-form-item label="姓名"><el-input v-model="user.name" /></el-form-item><el-form-item label="手机号"><el-input v-model="user.phone" /></el-form-item><el-form-item label="角色"><el-select v-model="user.roleIds" multiple><el-option v-for="r in roles" :key="r.id" :label="r.name" :value="r.id" /></el-select></el-form-item></el-form>
          <template #footer><el-button @click="userDlg = false">取消</el-button><el-button type="primary" @click="createUser">创建</el-button></template>
        </el-dialog>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('branding')" label="品牌白标" name="branding">
        <el-form label-position="top" style="max-width: 520px">
          <el-form-item label="系统名称(1–30 字符)"><el-input v-model="brand.systemName" maxlength="30" /></el-form-item>
          <el-form-item label="主题色"><el-color-picker v-model="brand.themeColor" /></el-form-item>
          <el-form-item label="版权文字"><el-input v-model="brand.copyright" maxlength="100" /></el-form-item>
          <el-form-item label="自定义域名"><el-input v-model="brand.customDomain" placeholder="erp.example.com" /></el-form-item>
          <el-form-item label="Logo(PNG/JPG/SVG,≤ 2 MB)"><el-upload :auto-upload="false" :show-file-list="false" accept=".png,.jpg,.jpeg,.svg" :on-change="(f: any) => upload('logoFileId', f)"><el-button>选择图片</el-button></el-upload></el-form-item>
          <el-form-item label="登录页背景图"><el-upload :auto-upload="false" :show-file-list="false" accept=".png,.jpg,.jpeg,.svg" :on-change="(f: any) => upload('loginBgFileId', f)"><el-button>选择图片</el-button></el-upload></el-form-item>
          <el-button type="primary" @click="saveBrand">保存</el-button>
        </el-form>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('packages')" label="配置包" name="packages">
        <div class="toolbar"><el-button @click="exportPkg">导出当前配置</el-button><el-upload :auto-upload="false" :show-file-list="false" accept=".json" :on-change="readFile"><el-button type="primary">导入配置包…</el-button></el-upload></div>
        <div v-if="preview">
          <p>导入预览(确认前不会修改任何配置):</p>
          <div class="table-wrap"><el-table :data="preview.items" border max-height="320"><el-table-column prop="category" label="类别" width="140" /><el-table-column prop="key" label="配置项" min-width="160" /><el-table-column label="操作" width="90"><template #default="{ row }"><el-tag :type="row.action === 'add' ? 'success' : 'warning'">{{ row.action === 'add' ? '新增' : '覆盖' }}</el-tag></template></el-table-column></el-table></div>
          <el-alert v-for="s in preview.skipped" :key="s.category + s.key" :title="`将跳过 ${s.category} ${s.key}:${s.reason}`" type="warning" :closable="false" style="margin-top: 6px" />
          <el-button type="primary" style="margin-top: 12px" @click="applyPkg">确认导入</el-button>
        </div>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('print')" label="打印模板" name="print">
        <div class="toolbar"><el-select v-model="printDoc" style="width: 160px" @change="loadPrints"><el-option v-for="(l, k) in DOC_TYPE_LABEL" :key="k" :label="l" :value="k" /></el-select><el-button type="primary" @click="editPrint()">新增模板</el-button></div>
        <div class="table-wrap"><el-table :data="prints" border>
          <el-table-column prop="name" label="名称" min-width="140" /><el-table-column label="纸张" width="120"><template #default="{ row }">{{ PAPERS[row.paper as 'A4'].label }}</template></el-table-column>
          <el-table-column label="默认" width="80"><template #default="{ row }"><el-tag v-if="row.isDefault" type="success">默认</el-tag></template></el-table-column>
          <el-table-column label="操作" width="220"><template #default="{ row }"><el-button link type="primary" @click="editPrint(row)">编辑</el-button><el-button v-if="!row.isDefault" link @click="setDefault(row)">设为默认</el-button><el-button v-if="!row.isDefault" link type="danger" @click="delPrint(row)">删除</el-button></template></el-table-column>
        </el-table></div>
        <el-dialog :model-value="!!printEditing" title="编辑打印模板" width="720px" @close="printEditing = null">
          <el-form v-if="printEditing" label-position="top">
            <div class="form-grid"><el-form-item label="名称"><el-input v-model="printEditing.name" /></el-form-item><el-form-item label="纸张"><el-select v-model="printEditing.paper"><el-option v-for="(p, k) in PAPERS" :key="k" :label="p.label" :value="k" /></el-select></el-form-item></div>
            <el-form-item label="版式(JSON:字段位置、字号 6–72 磅、显示/隐藏、占位符如 {{header.docNo}}、{{cf.brand}})"><el-input v-model="layoutText" type="textarea" :rows="14" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="printEditing = null">取消</el-button><el-button type="primary" @click="savePrint">保存</el-button></template>
        </el-dialog>
      </el-tab-pane>

      <el-tab-pane v-if="tabs.includes('audit')" label="操作日志" name="audit">
        <div class="toolbar"><el-input v-model="lq.action" placeholder="操作类型,如 document.audit" clearable style="width: 220px" @change="loadLogs" /><el-input v-model="lq.objectType" placeholder="对象类型" clearable style="width: 160px" @change="loadLogs" /></div>
        <div class="table-wrap"><el-table :data="logs" border>
          <el-table-column prop="occurred_at" label="时间" width="190" /><el-table-column prop="actor_name" label="操作人" width="120" /><el-table-column prop="client" label="客户端" width="90" /><el-table-column prop="ip" label="IP" width="130" />
          <el-table-column prop="action" label="操作" width="160" /><el-table-column prop="object_type" label="对象" width="110" /><el-table-column prop="object_no" label="编号" width="170" />
          <el-table-column label="变更" min-width="220"><template #default="{ row }"><code style="font-size: 12px">{{ JSON.stringify(row.after ?? row.detail ?? '') }}</code></template></el-table-column>
        </el-table></div>
        <el-pagination v-model:current-page="lq.page" :page-size="lq.pageSize" :total="logTotal" layout="total, prev, pager, next" style="margin-top: 12px" @current-change="loadLogs" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
