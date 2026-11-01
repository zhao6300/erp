import { defineStore } from 'pinia'
import type { Bootstrap, PublicBranding } from '@erp/api-client'
import { themeShades } from '@erp/api-client'
import { api } from '../lib/api'

/** 把品牌应用到页面:主题色写入 Element Plus 的 CSS 变量,并更新标题与 favicon(需求 5.2、5.3) */
export function applyBranding(b: Pick<PublicBranding, 'systemName' | 'themeColor' | 'logoUrl'>) {
  const root = document.documentElement
  const shades = themeShades(b.themeColor)
  for (const [name, v] of Object.entries(shades)) root.style.setProperty(name ? `--el-color-primary-${name}` : '--el-color-primary', v)
  document.title = b.systemName
  const link = document.getElementById('favicon') as HTMLLinkElement | null
  if (link && b.logoUrl) link.href = b.logoUrl
}

export const useSession = defineStore('session', {
  state: () => ({ boot: null as Bootstrap | null, loading: false }),
  getters: {
    isAdmin: (s) => !!s.boot?.user.isTenantAdmin,
    scales: (s) => s.boot?.settings ?? { qtyScale: 2, priceScale: 4, amountScale: 2 },
  },
  actions: {
    async load() {
      this.loading = true
      try {
        this.boot = await api.bootstrap()
        applyBranding(this.boot.branding)
      } finally {
        this.loading = false
      }
    },
    can(code: string) {
      const b = this.boot
      return !!b && (b.permissions.isAdmin || b.permissions.permissions.includes(code))
    },
    clear() {
      this.boot = null
    },
  },
})
