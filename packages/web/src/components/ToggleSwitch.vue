<template>
  <button
    type="button"
    role="switch"
    :aria-checked="value"
    :disabled="disabled"
    @click="!disabled && $emit('change', !value)"
    class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    :class="[
      value ? 'bg-indigo-600' : 'bg-gray-700',
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
    ]"
  >
    <span
      class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200"
      :class="value ? 'translate-x-5' : 'translate-x-0'"
    />
  </button>
</template>

<script setup lang="ts">
defineProps<{ value: boolean; disabled?: boolean }>();
defineEmits<{ change: [value: boolean] }>();
</script>
