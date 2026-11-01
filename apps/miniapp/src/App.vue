<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app'
import { applyBrand } from './core/runtime'

// 启动时加载品牌:主题色应用到导航栏与页面根节点 CSS 变量(需求 5.2)
onLaunch(() => void applyBrand())
</script>
<style>
page { --primary: #1677ff; background: #f5f5f5; font-size: 28rpx; }
.card { background: #fff; border-radius: 12rpx; padding: 24rpx; margin: 16rpx; }
.row { display: flex; justify-content: space-between; padding: 8rpx 0; }
.btn { background: var(--primary); color: #fff; border-radius: 8rpx; text-align: center; padding: 20rpx; margin: 16rpx; }
.err { color: #f56c6c; font-size: 24rpx; }
</style>
