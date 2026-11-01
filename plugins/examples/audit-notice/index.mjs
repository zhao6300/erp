// 示例插件:禁止审核金额为 0 的销售出库单,并在审核后输出一条日志。
// 使用方法:把本目录复制到 plugins/<客户名>/ (与 examples 同级),重启服务,
// 然后在 tenant_plugin 中为目标租户启用。插件接口见 packages/plugin-sdk。
export default {
  name: 'audit-notice',
  version: '1.0.0',
  subscribes: ['document.beforeAudit', 'document.afterAudit'],
  handle(event, ctx) {
    if (event.eventType === 'document.beforeAudit' && event.docType === 'sales_out' && Number(event.document.totalAmount) === 0) {
      return { ok: false, message: '金额为 0 的销售出库单不允许审核' }
    }
    if (event.eventType === 'document.afterAudit') ctx.log(`单据 ${event.docNo} 已审核`)
  },
}
