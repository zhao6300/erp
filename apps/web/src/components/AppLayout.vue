<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { api } from '../lib/api'
import { layoutFor } from '../lib/layout'
import { routeGuard, visibleMenu } from '../lib/menu'
import { useSession } from '../stores/session'

const session = useSession()
const router = useRouter()
const route = useRoute()
const width = ref(window.innerWidth)
const collapsed = ref(false)
const drawer = ref(false)
const onResize = () => (width.value = window.innerWidth)
onMounted(async () => {
  window.addEventListener('resize', onResize)
  try {
    await session.load()
  } catch {
    return
  }
  const b = session.boot!
  // 到期提醒:Tenant_Admin 登录后显示截止日期与剩余天数(需求 3.4)
  if (b.licenseReminder) ElMessageBox.alert(`授权将于 ${b.licenseReminder.expireDate} 到期,剩余 ${b.licenseReminder.daysLeft} 天,请及时续期。`, '授权到期提醒')
  if (b.user.mustChangePassword) ElMessageBox.alert('首次登录请先修改初始密码(系统设置 → 角色与用户 → 修改密码)。', '请修改密码')
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

const spec = computed(() => layoutFor(width.value))
watchEffect(() => {
  collapsed.value = spec.value.sidebar === 'collapsible' ? collapsed.value : false
})
const menu = computed(() => (session.boot ? visibleMenu(session.boot) : []))
const guard = computed(() => (session.boot ? routeGuard(session.boot, route.meta.module as string | undefined) : 'ok'))
const brand = computed(() => session.boot?.branding)

async function logout() {
  await api.logout()
  session.clear()
  await router.replace('/login')
}
function go(path: string) {
  if (path) router.push(path)
  drawer.value = false
}
</script>

<template>
  <el-container style="height: 100%">
    <template v-if="spec.mode !== 'mobile'">
      <el-aside :width="collapsed ? '64px' : '220px'" style="transition: width 0.2s; overflow-x: hidden">
        <div class="brand" style="padding: 12px; display: flex; align-items: center; gap: 8px; font-weight: 600">
          <img v-if="brand?.logoUrl" :src="brand.logoUrl" alt="" style="height: 28px" />
          <span v-if="!collapsed">{{ brand?.systemName }}</span>
        </div>
        <el-menu :default-active="route.path" :collapse="collapsed" router>
          <template v-for="g in menu" :key="g.key">
            <el-sub-menu v-if="g.children" :index="g.key">
              <template #title>{{ g.label }}</template>
              <el-menu-item v-for="c in g.children" :key="c.key" :index="c.path">{{ c.label }}</el-menu-item>
            </el-sub-menu>
            <el-menu-item v-else :index="g.path">{{ g.label }}</el-menu-item>
          </template>
        </el-menu>
      </el-aside>
    </template>
    <el-container style="min-width: 0">
      <el-header style="display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--el-border-color-light)">
        <el-button v-if="spec.mode === 'mobile'" @click="drawer = true">菜单</el-button>
        <el-button v-else-if="spec.sidebar === 'collapsible'" @click="collapsed = !collapsed">{{ collapsed ? '展开' : '折叠' }}</el-button>
        <span v-if="spec.mode === 'mobile'" style="font-weight: 600">{{ brand?.systemName }}</span>
        <div style="flex: 1" />
        <el-tag v-if="session.boot?.expired" type="danger">授权已过期,仅可查询与导出</el-tag>
        <span>{{ session.boot?.user.name }}</span>
        <el-button link @click="logout">退出</el-button>
      </el-header>
      <el-main style="padding: 0; overflow-x: hidden">
        <el-result v-if="guard === 'module_disabled'" icon="warning" title="模块未启用" sub-title="该功能所属模块当前未启用,请联系管理员。" />
        <router-view v-else-if="session.boot" />
        <div v-else class="page">加载中…</div>
        <div v-if="brand?.copyright" style="text-align: center; color: #999; font-size: 12px; padding: 12px">{{ brand.copyright }}</div>
      </el-main>
    </el-container>
    <el-drawer v-model="drawer" direction="ltr" size="75%" :with-header="false">
      <el-menu :default-active="route.path">
        <template v-for="g in menu" :key="g.key">
          <el-sub-menu v-if="g.children" :index="g.key">
            <template #title>{{ g.label }}</template>
            <el-menu-item v-for="c in g.children" :key="c.key" :index="c.path" @click="go(c.path)">{{ c.label }}</el-menu-item>
          </el-sub-menu>
          <el-menu-item v-else :index="g.path" @click="go(g.path)">{{ g.label }}</el-menu-item>
        </template>
      </el-menu>
    </el-drawer>
  </el-container>
</template>
