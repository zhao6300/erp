<script setup lang="ts">
import { computed } from 'vue'
import type { Bootstrap } from '@erp/api-client'
import type { FieldDef } from '@erp/shared'
import { fieldsForForm } from '@erp/shared'

type Def = Bootstrap['customFields'][string][number]
const props = defineProps<{ defs: Def[]; modelValue: Record<string, unknown>; errors?: Record<string, string>; readonly?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [Record<string, unknown>] }>()

/** 按显示顺序升序渲染(需求 6.3);停用字段已由后端剔除 */
const ordered = computed(() => fieldsForForm(props.defs as unknown as FieldDef[]) as unknown as Def[])
function set(code: string, v: unknown) {
  emit('update:modelValue', { ...props.modelValue, [code]: v })
}
</script>

<template>
  <div class="form-grid">
    <el-form-item v-for="d in ordered" :key="d.code" :label="d.label" :required="d.required">
      <el-input v-if="d.type === 'text'" :model-value="(modelValue[d.code] as string) ?? ''" :disabled="readonly" maxlength="200" @update:model-value="set(d.code, $event)" />
      <el-input v-else-if="d.type === 'textarea'" type="textarea" :model-value="(modelValue[d.code] as string) ?? ''" :disabled="readonly" maxlength="2000" @update:model-value="set(d.code, $event)" />
      <el-input-number v-else-if="d.type === 'integer'" :model-value="modelValue[d.code] as number" :disabled="readonly" :precision="0" :min="-999999999" :max="999999999" @update:model-value="set(d.code, $event)" />
      <el-input v-else-if="d.type === 'decimal'" :model-value="(modelValue[d.code] as string) ?? ''" :disabled="readonly" placeholder="最多 12 位整数、6 位小数" @update:model-value="set(d.code, $event)" />
      <el-date-picker v-else-if="d.type === 'date'" :model-value="(modelValue[d.code] as string) ?? ''" :disabled="readonly" type="date" value-format="YYYY-MM-DD" @update:model-value="set(d.code, $event)" />
      <el-select v-else-if="d.type === 'select'" :model-value="modelValue[d.code]" :disabled="readonly" clearable @update:model-value="set(d.code, $event)"><el-option v-for="o in d.options" :key="o" :label="o" :value="o" /></el-select>
      <el-select v-else-if="d.type === 'multiselect'" :model-value="(modelValue[d.code] as string[]) ?? []" :disabled="readonly" multiple @update:model-value="set(d.code, $event)"><el-option v-for="o in d.options" :key="o" :label="o" :value="o" /></el-select>
      <el-switch v-else-if="d.type === 'boolean'" :model-value="!!modelValue[d.code]" :disabled="readonly" @update:model-value="set(d.code, $event)" />
      <span v-else class="err">图片字段请在详情页上传</span>
      <div v-if="errors?.[`custom.${d.code}`]" class="err">{{ errors[`custom.${d.code}`] }}</div>
    </el-form-item>
  </div>
</template>
