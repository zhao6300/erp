<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { api } from '../../core/runtime'

const keyword = ref('')
const tab = ref<'stock' | 'product'>('stock')
const items = ref<any[]>([])
onLoad((q: Record<string, string> = {}) => {
  if (q.tab === 'product') tab.value = 'product'
  void load()
})
async function load() {
  items.value = tab.value === 'stock' ? (await api.get<{ items: any[] }>('/api/stock/balances', { keyword: keyword.value, pageSize: 50 })).items : (await api.get<{ items: any[] }>('/api/products', { keyword: keyword.value, pageSize: 50 })).items
}
</script>

<template>
  <view>
    <view class="card"><input v-model="keyword" placeholder="编码 / 名称 / 条码" @confirm="load" /></view>
    <view class="card row"><text @tap="() => { tab = 'stock'; load() }">库存</text><text @tap="() => { tab = 'product'; load() }">商品</text></view>
    <view v-for="i in items" :key="i.id ?? i.skuId + i.warehouseId" class="card">
      <view class="row"><text>{{ i.name }}</text><text>{{ i.skuCode ?? i.code }}</text></view>
      <view v-if="tab === 'stock'" class="row"><text>{{ i.warehouseName }}</text><text>{{ i.qty }}</text></view>
      <view v-else class="row"><text>售价</text><text>{{ i.refSalePrice }}</text></view>
    </view>
  </view>
</template>
