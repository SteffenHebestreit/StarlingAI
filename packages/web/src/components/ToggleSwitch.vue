<template>
  <button
    type="button"
    role="switch"
    :aria-checked="value"
    :aria-label="label"
    :disabled="disabled"
    @click="!disabled && $emit('change', !value)"
    class="relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
    :class="[
      value ? 'bg-purple-500' : 'bg-gray-700',
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
    ]"
  >
    <span
      class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 motion-reduce:transition-none"
      :class="value ? 'translate-x-5' : 'translate-x-0'"
    />
  </button>
</template>

<script setup lang="ts">
defineProps<{
  value: boolean;
  disabled?: boolean;
  /** What the switch turns on, for a screen reader: the switch itself shows no text. */
  label?: string;
}>();
defineEmits<{ change: [value: boolean] }>();
</script>
