# plugins/

独立部署的客户定制放在这里,每个客户一个子目录:`plugins/<客户名>/index.mjs`,默认导出一个插件(或插件数组)。
服务启动时自动加载;插件是否对某个租户生效由 `tenant_plugin.enabled` 控制。核心代码升级不需要修改插件。

- 接口与事件载荷:`packages/plugin-sdk`(`definePlugin`、`EventPayload`)。事件载荷带版本号,契约测试保证已发布字段不被删改。
- 同步事件(`document.beforeSave`、`document.beforeAudit`)可返回 `{ ok: false, message }` 拒绝操作,5 秒超时;
  异步事件(`document.afterAudit`、`document.afterUnaudit`)通过 outbox 投递,失败最多重试 3 次,之后标记为 failed。
- `examples/` 目录下是示例,不会被自动加载;复制到 `plugins/<客户名>/` 后才生效。
