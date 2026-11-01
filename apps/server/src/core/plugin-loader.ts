import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ErpPlugin } from '@erp/plugin-sdk'
import type { Container } from '../container'

/**
 * 加载 plugins/<客户>/index.(js|mjs) 导出的进程内插件(独立部署的客户定制)。
 * 每个客户一个子目录,不进入核心代码;核心升级不需要修改插件(接口见 @erp/plugin-sdk)。
 * 插件是否对某租户生效由 tenant_plugin.enabled 控制。
 */
export async function loadPlugins(c: Container, dir: string): Promise<string[]> {
  const loaded: string[] = []
  if (!existsSync(dir)) return loaded
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of ['index.mjs', 'index.js']) {
      const p = path.join(dir, entry.name, file)
      if (!existsSync(p)) continue
      try {
        const mod = (await import(pathToFileURL(p).href)) as { default?: ErpPlugin | ErpPlugin[] }
        const list = Array.isArray(mod.default) ? mod.default : mod.default ? [mod.default] : []
        for (const plugin of list) {
          c.plugins.register(plugin)
          loaded.push(plugin.name)
        }
      } catch (e) {
        console.error(`[插件] 加载 ${p} 失败:`, e)
      }
      break
    }
  }
  if (loaded.length) console.log(`[插件] 已加载: ${loaded.join(', ')}`)
  return loaded
}
