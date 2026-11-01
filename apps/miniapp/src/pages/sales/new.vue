<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import type { LocalDraft } from '@erp/api-client'
import { SalesSession, SkuInfo } from '../../core/salesSession'
import { api, bootstrap, drafts } from '../../core/runtime'

declare const uni: any

/**
 * 单页销售开单(需求 16.9):选择客户、扫码或搜索添加 SKU、改数量与单价、录入本单已收、一键保存并审核,
 * 全部在本页完成;仅扫码相机与 SKU 搜索弹层(同页 popup)属于例外。业务规则都在 SalesSession 中。
 */
const session = ref<SalesSession | null>(null)
const customers = ref<{ id: string; name: string; priceLevel: any }[]>([])
const funds = ref<{ id: string; name: string }[]>([])
const hits = ref<SkuInfo[]>([])
const keyword = ref('')
const searching = ref(false)
const msg = reactive({ text: '', kind: '' as '' | 'ok' | 'err' })
const errors = ref<Record<string, string>>({})
const busy = ref(false)
const form = computed(() => session.value?.form)
const sum = computed(() => session.value?.sum)

onLoad(async (q: Record<string, string> = {}) => {
  const b = await bootstrap()
  const [c, f, w] = await Promise.all([api.get<{ items: any[] }>('/api/partners', { kind: 'customer', enabled: true, pageSize: 100 }), api.get<any[]>('/api/fund-accounts', { enabled: true }), api.get<any[]>('/api/warehouses', { enabled: true })])
  customers.value = c.items
  funds.value = f
  let draft: LocalDraft | undefined
  if (q.draft) draft = (await drafts.list()).find((d) => d.clientRequestId === q.draft) // 从本地草稿恢复
  session.value = new SalesSession({ api, drafts, scales: b.settings }, new Date().toISOString().slice(0, 10), w[0]?.id ?? null, draft)
})

/** 小程序 input 事件的 detail.value 是字符串(DOM 类型里 detail 是 number,故用函数收口) */
type UniInput = { detail: { value: string } }
const onQty = (i: number, e: unknown) => session.value!.setQty(i, (e as UniInput).detail.value)
const onPrice = (i: number, e: unknown) => session.value!.setPrice(i, (e as UniInput).detail.value)
const onPaid = (e: unknown) => session.value!.setPaid((e as UniInput).detail.value, form.value!.fundAccountId)

function pickCustomer(e: { detail: { value: number } }) {
  const c = customers.value[e.detail.value]
  session.value!.setCustomer(c.id, c.priceLevel)
}
async function scan() {
  const code: string | null = await new Promise((resolve) => uni.scanCode({ onlyFromCamera: true, success: (r: { result: string }) => resolve(r.result), fail: () => resolve(null) }))
  const r = await session.value!.scan(code)
  if (r.kind === 'not_found') uni.showToast({ title: r.message, icon: 'none' }) // 明细保持不变
}
async function search() {
  hits.value = await session.value!.searchSkus(keyword.value)
}
function pick(s: SkuInfo) {
  session.value!.addSku(s)
  searching.value = false
  keyword.value = ''
}
async function submit(confirmCredit = false) {
  busy.value = true
  msg.text = ''
  try {
    const r = await session.value!.submit({ confirmCredit })
    errors.value = 'errors' in r ? r.errors : {}
    if (r.status === 'ok') {
      uni.showToast({ title: `已保存并审核 ${r.docNo}` })
      return uni.navigateBack()
    }
    if (r.status === 'audit_failed') {
      // 审核失败:单据已保存为草稿,内容全部保留,原因显示在本页
      msg.kind = 'err'
      msg.text = `已保存为草稿 ${r.docNo},审核未通过:${r.reason}`
      if (r.needsCreditConfirm) {
        const ok: boolean = await new Promise((resolve) => uni.showModal({ title: '超出信用额度', content: r.reason, success: (x: { confirm: boolean }) => resolve(x.confirm) }))
        if (ok) return submit(true)
      }
    } else if (r.status === 'offline') {
      msg.kind = 'err'
      msg.text = r.message // 提示提交失败、内容已在本机保留,可重新提交
    } else if (r.status === 'rejected') {
      msg.kind = 'err'
      msg.text = r.message
    } else {
      msg.kind = 'err'
      msg.text = '请先修正标红的问题'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <view v-if="form">
    <view class="card">
      <picker :range="customers" range-key="name" @change="pickCustomer"><view class="row"><text>客户</text><text>{{ customers.find((c) => c.id === form!.partnerId)?.name ?? '请选择' }}</text></view></picker>
      <text v-if="errors.partnerId" class="err">{{ errors.partnerId }}</text>
    </view>

    <view class="card">
      <view style="display: flex; gap: 16rpx">
        <view class="btn" style="flex: 1; margin: 0" @tap="scan">扫码添加</view>
        <view class="btn" style="flex: 1; margin: 0" @tap="searching = true">搜索商品</view>
      </view>
    </view>

    <view v-for="(l, i) in form.lines" :key="l.skuId + i" class="card">
      <view class="row"><text>{{ l.skuLabel }}</text><text @tap="session!.removeLine(i)">删除</text></view>
      <view class="row"><text>数量</text><input :value="l.qty" type="digit" @input="onQty(i, $event)" /></view>
      <text v-if="errors[`qty@${i + 1}`]" class="err">{{ errors[`qty@${i + 1}`] }}</text>
      <view class="row"><text>单价</text><input :value="l.price" type="digit" @input="onPrice(i, $event)" /></view>
      <text v-if="errors[`price@${i + 1}`]" class="err">{{ errors[`price@${i + 1}`] }}</text>
      <view class="row"><text>金额</text><text>{{ sum?.lines[i]?.amount }}</text></view>
    </view>

    <view class="card">
      <view class="row"><text>单据总金额</text><text>{{ sum?.total }}</text></view>
      <view class="row"><text>本单已收(≤ {{ session!.paidMax }})</text><input :value="form.paidAmount" type="digit" @input="onPaid($event)" /></view>
      <text v-if="errors.paidAmount" class="err">{{ errors.paidAmount }}</text>
      <picker v-if="Number(form.paidAmount) > 0" :range="funds" range-key="name" @change="session!.setPaid(form!.paidAmount, funds[$event.detail.value].id)"><view class="row"><text>收款账户</text><text>{{ funds.find((f) => f.id === form!.fundAccountId)?.name ?? '请选择' }}</text></view></picker>
      <text v-if="errors.fundAccountId" class="err">{{ errors.fundAccountId }}</text>
    </view>

    <text v-if="msg.text" :class="msg.kind === 'err' ? 'err' : ''" style="margin: 16rpx; display: block">{{ msg.text }}</text>
    <view class="btn" :style="{ opacity: busy ? 0.5 : 1 }" @tap="!busy && submit()">保存并审核</view>

    <!-- SKU 搜索弹层:同页 popup,不跳转 -->
    <view v-if="searching" style="position: fixed; left: 0; right: 0; bottom: 0; top: 20%; background: #fff; padding: 24rpx; overflow: auto">
      <input v-model="keyword" placeholder="编码 / 名称 / 条码" @input="search" />
      <view v-for="s in hits" :key="s.skuId" class="row" @tap="pick(s)"><text>{{ s.skuCode }} {{ s.name }}</text><text>{{ s.refSalePrice }}</text></view>
      <view class="btn" @tap="searching = false">关闭</view>
    </view>
  </view>
</template>
