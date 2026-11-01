<script setup lang="ts">
import { ref } from 'vue'
import { onLoad, onShareAppMessage } from '@dcloudio/uni-app'
import { ApiError, LocalDraft } from '@erp/api-client'
import { api, drafts } from '../../core/runtime'

declare const uni: any

interface Row { id: string; docNo: string; docType: string; docDate: string; status: string; partnerName: string | null; totalAmount: string; version: number }
const rows = ref<Row[]>([])
const local = ref<LocalDraft[]>([])
const tab = ref('docs')
const msg = ref('')
const STATUS: Record<string, string> = { draft: '草稿', audited: '已审核', voided: '已作废' }

async function load() {
  rows.value = (await api.get<{ items: Row[] }>('/api/documents', { pageSize: 50 })).items
  local.value = await drafts.list()
}
onLoad((q: Record<string, string> = {}) => {
  if (q.tab === 'drafts') tab.value = 'drafts'
  void load()
})
async function audit(r: Row, confirmCredit = false) {
  try {
    await api.post(`/api/documents/${r.id}/audit`, { version: r.version, confirmCredit })
    msg.value = ''
    await load()
  } catch (e) {
    const err = e as ApiError
    if (err.needsCreditConfirm) {
      const ok: boolean = await new Promise((resolve) => uni.showModal({ title: '超出信用额度', content: err.message, success: (x: { confirm: boolean }) => resolve(x.confirm) }))
      if (ok) return audit(r, true)
    }
    msg.value = err.message
  }
}
async function resubmit(d: LocalDraft) {
  const r = await drafts.submit(api, d) // 复用同一 clientRequestId(需求 19.8)
  msg.value = r.ok ? '' : r.error.message
  await load()
}
const dropDraft = async (d: LocalDraft) => (await drafts.remove(d.clientRequestId), load())

/**
 * 分享:转发单据卡片(单号 + 金额)给微信好友。
 * 需求 20.8 要求的"服务端渲染 PDF/图片再调起微信发送"尚未实现(服务端目前只输出 HTML 打印页)。
 */
onShareAppMessage((e: { target?: { dataset?: { id?: string } } }) => {
  const r = rows.value.find((x) => x.id === e.target?.dataset?.id)
  return { title: r ? `${r.docNo} ¥${r.totalAmount}` : '单据分享', path: `/pages/docs/list?doc=${r?.id ?? ''}` }
})
</script>

<template>
  <view>
    <view class="card row"><text @tap="tab = 'docs'">单据</text><text @tap="tab = 'drafts'">待提交({{ local.length }})</text></view>
    <text v-if="msg" class="err" style="margin: 16rpx; display: block">{{ msg }}</text>
    <view v-if="tab === 'docs'">
      <view v-for="r in rows" :key="r.id" class="card">
        <view class="row"><text>{{ r.docNo }}</text><text>{{ STATUS[r.status] }}</text></view>
        <view class="row"><text>{{ r.partnerName }}</text><text>{{ r.totalAmount }}</text></view>
        <view class="row"><text v-if="r.status === 'draft'" @tap="audit(r)">审核</text><button class="share" open-type="share" :data-id="r.id" size="mini">转发</button></view>
      </view>
    </view>
    <view v-else>
      <view v-for="d in local" :key="d.clientRequestId" class="card">
        <view class="row"><text>{{ new Date(d.savedAt).toLocaleString() }}</text></view>
        <text v-if="d.error" class="err">{{ d.error }}</text>
        <view class="row"><text @tap="resubmit(d)">重新提交</text><text @tap="dropDraft(d)">删除</text></view>
      </view>
    </view>
  </view>
</template>
