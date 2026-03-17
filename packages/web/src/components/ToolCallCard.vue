<template>
  <div class="border border-gray-700 rounded-lg overflow-hidden text-xs">
    <div class="bg-gray-900 px-3 py-1.5 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-indigo-400">⚙️</span>
        <span class="font-mono font-medium text-indigo-300">{{ toolCall.name }}</span>
      </div>
      <span :class="[
        'px-1.5 py-0.5 rounded text-xs',
        toolCall.result !== undefined ? 'bg-green-900/50 text-green-400' : 'bg-yellow-900/50 text-yellow-400 animate-pulse'
      ]">
        {{ toolCall.result !== undefined ? 'done' : 'running...' }}
      </span>
    </div>
    <div class="px-3 py-2 bg-gray-950/50">
      <div v-if="Object.keys(toolCall.args).length" class="mb-1.5">
        <span class="text-gray-500">args: </span>
        <span class="font-mono text-gray-300">{{ JSON.stringify(toolCall.args).substring(0, 120) }}</span>
      </div>
      <div v-if="toolCall.result" class="border-t border-gray-800 pt-1.5 mt-1.5">
        <span class="text-gray-500">result: </span>
        <span class="text-gray-400 font-mono">{{ toolCall.result.substring(0, 200) }}{{ toolCall.result.length > 200 ? '...' : '' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  toolCall: { name: string; args: Record<string, unknown>; result?: string };
}>();
</script>
