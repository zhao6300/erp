<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { MODULE_CODES, MODULE_LABEL } from '@erp/shared'
import { PlatformError, call, clearToken, hasToken, saveToken, validateTenantForm } from './lib/platform-api'

interface Tenant { id: string; name: string; contact: string; phone: string; status: string; createdAt: string }
const authed = ref(hasToken())
const login = reactive({ username: '', password: '' })
const tenants = ref<Tenant[]>([])
const tab = ref('tenants')
const fail = (e: unknown) => {
  if (e instanceof PlatformError && e.status === 401) authed.value = false
  ElMessage.error((e as Error).message)
}

async function doLogin() {
  try {
    saveToken((await call<{ token: string }>('POST', '/platform/auth/login', login)).token)
    authed.value = true
    await load()
  } catch (e) {
    fail(e)
  }
}
async function load() {
  try {
    tenants.value = await call('GET', '/platform/tenants')
    packages.value = await call('GET', '/platform/config-packages')
  } catch (e) {
    fail(e)
  }
}
onMounted(() => authed.value && load())

/* 开通 */
const dlg = ref(false)
const form = reactive({ name: '', contact: '', phone: '', expireDate: '', modules: [...MODULE_CODES] as string[], maxUsers: 10, maxWarehouses: 3, configPackageId: '' })
const errors = ref<Record<string, string>>({})
const packages = ref<{ id: string; name: string; industry: string; status: string }[]>([])
async function create() {
  errors.value = validateTenantForm(form) // 保留已填写内容,逐一标明未通过字段
  if (Object.keys(errors.value).length) return
  try {
    const r = await call<{ tenant: Tenant; adminPhone: string; initialPassword?: string; skippedConfig?: { key: string; reason: string }[] }>('POST', '/platform/tenants', {
      name: form.name.trim(), contact: form.contact.trim(), phone: form.phone,
      license: { expireDate: form.expireDate, modules: form.modules, maxUsers: form.maxUsers, maxWarehouses: form.maxWarehouses },
      configPackageId: form.configPackageId || undefined,
    })
    dlg.value = false
    await ElMessageBox.alert(`租户“${r.tenant.name}”已开通。管理员手机号:${r.adminPhone}${r.initialPassword ? `\n初始密码:${r.initialPassword}(仅显示一次)` : '\n(该手机号已有账号,沿用原密码)'}${r.skippedConfig?.length ? `\n配置包跳过项:${r.skippedConfig.map((s) => s.key).join('、')}` : ''}`, '开通成功')
    await load()
  } catch (e) {
    if (e instanceof PlatformError && e.body.details) {
      errors.value = Object.fromEntries(e.body.details.map((d) => [(d.field ?? '').replace('license.', ''), d.reason]))
    }
    fail(e)
  }
}
async function toggle(t: Tenant) {
  try {
    await call('POST', `/platform/tenants/${t.id}/${t.status === 'enabled' ? 'disable' : 'enable'}`)
    await load()
  } catch (e) {
    fail(e)
  }
}

/* License */
const lic = reactive({ show: false, id: '', expireDate: '', modules: [] as string[], maxUsers: 1, maxWarehouses: 1 })
function openLic(t: Tenant) {
  Object.assign(lic, { show: true, id: t.id, expireDate: '', modules: [...MODULE_CODES], maxUsers: 10, maxWarehouses: 3 })
}
async function saveLic() {
  try {
    const r = await call<{ disabledModules: string[] }>('PUT', `/platform/tenants/${lic.id}/license`, { expireDate: lic.expireDate, modules: lic.modules, maxUsers: lic.maxUsers, maxWarehouses: lic.maxWarehouses })
    lic.show = false
    ElMessage.success(r.disabledModules.length ? `已保存,以下模块及其依赖方已关闭:${r.disabledModules.join('、')}` : '已保存,1 分钟内生效')
  } catch (e) {
    fail(e)
  }
}

/* 配置包 */
const pkg = reactive({ show: false, id: '', text: '', preview: null as null | { items: { category: string; key: string; action: string }[]; skipped: { key: string; reason: string }[] } })
function openPkg(t: Tenant) {
  Object.assign(pkg, { show: true, id: t.id, text: '', preview: null })
}
async function pkgFile(f: { raw: File }) {
  pkg.text = await f.raw.text()
  try {
    pkg.preview = await call('POST', `/platform/tenants/${pkg.id}/config-package/preview`, { text: pkg.text })
  } catch (e) {
    pkg.preview = null
    fail(e)
  }
}
async function pkgApply() {
  try {
    const r = await call<{ added: number; overwritten: number; skipped: unknown[] }>('POST', `/platform/tenants/${pkg.id}/config-package/apply`, { text: pkg.text })
    ElMessage.success(`新增 ${r.added},覆盖 ${r.overwritten},跳过 ${r.skipped.length}`)
    pkg.show = false
  } catch (e) {
    fail(e)
  }
}
async function pkgExport(t: Tenant) {
  const r = await call<{ text: string }>('GET', `/platform/tenants/${t.id}/config-package`).catch(fail)
  if (!r) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }))
  a.download = `${t.name}-config.json`
  a.click()
}

/* 插件 */
const plug = reactive({ show: false, id: '', name: '', url: '', secret: '' })
async function setPlugin(enabled: boolean) {
  try {
    await call('PUT', `/platform/tenants/${plug.id}/plugins/${encodeURIComponent(plug.name)}`, { enabled, config: plug.url ? { url: plug.url, secret: plug.secret } : {} })
    ElMessage.success(enabled ? '已启用,1 分钟内生效' : '已停用')
    plug.show = false
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div v-if="!authed" style="max-width: 360px; margin: 12vh auto">
    <el-card>
      <h3>运营后台登录</h3>
      <el-form @submit.prevent="doLogin">
        <el-form-item><el-input v-model="login.username" placeholder="用户名" /></el-form-item>
        <el-form-item><el-input v-model="login.password" type="password" show-password placeholder="密码" @keyup.enter="doLogin" /></el-form-item>
        <el-button type="primary" style="width: 100%" @click="doLogin">登录</el-button>
      </el-form>
    </el-card>
  </div>
  <div v-else style="padding: 16px">
    <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 12px">
      <h2 style="margin: 0">Lite ERP 运营后台</h2><div style="flex: 1" />
      <el-button type="primary" @click="dlg = true">开通租户</el-button>
      <el-button @click="() => { clearToken(); authed = false }">退出</el-button>
    </div>
    <el-tabs v-model="tab">
      <el-tab-pane label="租户" name="tenants">
        <el-table :data="tenants" border>
          <el-table-column prop="name" label="企业名称" min-width="160" /><el-table-column prop="contact" label="联系人" width="100" /><el-table-column prop="phone" label="手机号" width="130" />
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'enabled' ? 'success' : 'danger'">{{ row.status === 'enabled' ? '启用' : '已停用' }}</el-tag></template></el-table-column>
          <el-table-column label="操作" min-width="420">
            <template #default="{ row }">
              <el-button link type="primary" @click="openLic(row)">授权</el-button>
              <el-button link @click="openPkg(row)">导入配置包</el-button>
              <el-button link @click="pkgExport(row)">导出配置</el-button>
              <el-button link @click="() => Object.assign(plug, { show: true, id: row.id, name: '', url: '', secret: '' })">插件</el-button>
              <el-button link :type="row.status === 'enabled' ? 'danger' : 'success'" @click="toggle(row)">{{ row.status === 'enabled' ? '停用' : '重新启用' }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="行业配置包" name="packages">
        <el-table :data="packages" border><el-table-column prop="name" label="名称" /><el-table-column prop="industry" label="行业" width="140" /><el-table-column prop="status" label="状态" width="120" /></el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="dlg" title="开通租户" width="560px">
      <el-form label-position="top">
        <el-form-item label="企业名称" :error="errors.name"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="联系人" :error="errors.contact"><el-input v-model="form.contact" /></el-form-item>
        <el-form-item label="管理员手机号" :error="errors.phone"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="授权截止日期" :error="errors.expireDate"><el-date-picker v-model="form.expireDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="授权模块" :error="errors.modules"><el-checkbox-group v-model="form.modules"><el-checkbox v-for="m in MODULE_CODES" :key="m" :value="m">{{ MODULE_LABEL[m] }}</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="最大用户数(1–9999)" :error="errors.maxUsers"><el-input-number v-model="form.maxUsers" :min="1" :max="9999" /></el-form-item>
        <el-form-item label="最大仓库数(1–999)" :error="errors.maxWarehouses"><el-input-number v-model="form.maxWarehouses" :min="1" :max="999" /></el-form-item>
        <el-form-item label="行业配置包(可选)" :error="errors.configPackageId"><el-select v-model="form.configPackageId" clearable><el-option v-for="p in packages.filter((x) => x.status === 'available')" :key="p.id" :label="`${p.name}(${p.industry})`" :value="p.id" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="dlg = false">取消</el-button><el-button type="primary" @click="create">开通</el-button></template>
    </el-dialog>

    <el-dialog v-model="lic.show" title="编辑授权" width="520px">
      <el-form label-position="top">
        <el-form-item label="截止日期"><el-date-picker v-model="lic.expireDate" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="授权模块"><el-checkbox-group v-model="lic.modules"><el-checkbox v-for="m in MODULE_CODES" :key="m" :value="m">{{ MODULE_LABEL[m] }}</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="最大用户数"><el-input-number v-model="lic.maxUsers" :min="1" :max="9999" /></el-form-item>
        <el-form-item label="最大仓库数"><el-input-number v-model="lic.maxWarehouses" :min="1" :max="999" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="lic.show = false">取消</el-button><el-button type="primary" @click="saveLic">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="pkg.show" title="导入配置包" width="640px">
      <el-upload :auto-upload="false" :show-file-list="false" accept=".json" :on-change="pkgFile"><el-button>选择配置包文件</el-button></el-upload>
      <div v-if="pkg.preview" style="margin-top: 12px">
        <el-table :data="pkg.preview.items" border max-height="280"><el-table-column prop="category" label="类别" width="140" /><el-table-column prop="key" label="配置项" /><el-table-column label="操作" width="90"><template #default="{ row }"><el-tag :type="row.action === 'add' ? 'success' : 'warning'">{{ row.action === 'add' ? '新增' : '覆盖' }}</el-tag></template></el-table-column></el-table>
        <el-alert v-for="s in pkg.preview.skipped" :key="s.key" :title="`跳过 ${s.key}:${s.reason}`" type="warning" :closable="false" style="margin-top: 6px" />
      </div>
      <template #footer><el-button @click="pkg.show = false">取消</el-button><el-button type="primary" :disabled="!pkg.preview" @click="pkgApply">确认导入</el-button></template>
    </el-dialog>

    <el-dialog v-model="plug.show" title="扩展插件" width="460px">
      <el-form label-position="top">
        <el-form-item label="插件名称"><el-input v-model="plug.name" /></el-form-item>
        <el-form-item label="Webhook 地址(进程内插件留空)"><el-input v-model="plug.url" /></el-form-item>
        <el-form-item label="签名密钥"><el-input v-model="plug.secret" show-password /></el-form-item>
      </el-form>
      <template #footer><el-button @click="setPlugin(false)">停用</el-button><el-button type="primary" @click="setPlugin(true)">启用</el-button></template>
    </el-dialog>
  </div>
</template>
