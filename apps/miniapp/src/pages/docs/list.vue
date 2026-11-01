<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { ApiError, LocalDraft } from '@erp/api-client'
import { uniSharePlatform } from '../../core/platform'
import { api, drafts } from '../../core/runtime'
import { shareDocument } from '../../core/share'

declare const uni: any
declare const wx: any

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

/** 分享(需求 20.8):服务端按默认模板生成 PDF/图片,下载后调起微信发送界面 */
async function share(r: Row) {
  const pick = await new Promise<{ tapIndex: number }>((resolve) => uni.showActionSheet({ itemList: ['发送 PDF', '发送图片'], success: resolve, fail: () => resolve({ tapIndex: -1 }) }))
  if (pick.tapIndex < 0) return
  uni.showLoading({ title: '正在生成', mask: true })
  const result = await shareDocument(api, uniSharePlatform(uni, wx), { id: r.id, docNo: r.docNo }, pick.tapIndex === 0 ? 'pdf' : 'png')
  uni.hideLoading()
  if (!result.ok && !result.cancelled) uni.showToast({ title: result.message, icon: 'none' })
}
</script>

<template>
  <view>
    <view class="card row"><text @tap="tab = 'docs'">单据</text><text @tap="tab = 'drafts'">待提交({{ local.length }})</text></view>
    <text v-if="msg" class="err" style="margin: 16rpx; display: block">{{ msg }}</text>
    <view v-if="tab === 'docs'">
      <view v-for="r in rows" :key="r.id" class="card">
        <view class="row"><text>{{ r.docNo }}</text><text>{{ STATUS[r.status] }}</text></view>
        <view class="row"><text>{{ r.partnerName }}</text><text>{{ r.totalAmount }}</text></view>
        <view class="row"><text v-if="r.status === 'draft'" @tap="audit(r)">审核</text><text @tap="share(r)">分享</text></view>
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
