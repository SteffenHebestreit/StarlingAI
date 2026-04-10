<script setup lang="ts">
import { computed } from "vue";
import { useShellStore } from "../stores/shell";

const shell = useShellStore();

const observedExecution = computed(() => shell.observedExecution);
const recentExecutions = computed(() => shell.recentExecutions);

function observe(id: string) {
  shell.observeExecution(id);
}

function clearPreview() {
  shell.reset();
}

function statusLabel(status: "running" | "completed" | "failed") {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "done";
}

function formatTimestamp(ts?: number) {
  return ts ? new Date(ts).toLocaleTimeString() : "";
}
</script>

<template>
  <div class="shell-session-panel">
    <div class="panel-header">
      <h3>Shell Preview</h3>
      <button class="btn-sm" @click="clearPreview">Clear</button>
    </div>

    <div v-if="recentExecutions.length === 0" class="empty-state">
      No shell or SSH activity yet.
    </div>

    <template v-else>
      <div class="session-list">
        <button
          v-for="execution in recentExecutions"
          :key="execution.id"
          class="session-card"
          :class="{ observed: observedExecution?.id === execution.id, failed: execution.status === 'failed' }"
          @click="observe(execution.id)"
        >
          <div class="session-info">
            <span class="session-id">{{ execution.title }}</span>
            <span v-if="execution.target" class="session-adapter">{{ execution.target }}</span>
            <span class="session-state" :class="execution.status">{{ statusLabel(execution.status) }}</span>
          </div>
          <div class="session-meta">{{ formatTimestamp(execution.updatedAt) }}</div>
        </button>
      </div>

      <div v-if="observedExecution" class="preview-viewer">
        <h4>
          {{ observedExecution.title }}
          <span v-if="observedExecution.target" class="preview-target">{{ observedExecution.target }}</span>
        </h4>
        <p class="preview-help">
          Tracks live shell tool activity from `ssh_exec`, `shell_exec`, and `run_script` during the current session.
        </p>

        <div class="preview-meta">
          <span>Tool: {{ observedExecution.toolName }}</span>
          <span>Status: {{ statusLabel(observedExecution.status) }}</span>
          <span>Started: {{ formatTimestamp(observedExecution.startedAt) }}</span>
          <span v-if="observedExecution.finishedAt">Finished: {{ formatTimestamp(observedExecution.finishedAt) }}</span>
        </div>

        <div class="command-block">
          <div class="command-label">Command</div>
          <code class="command-text">{{ observedExecution.command }}</code>
        </div>

        <div class="output-block">
          <div class="output-label">Latest Output</div>
          <pre v-if="observedExecution.outputPreview" class="output-preview">{{ observedExecution.outputPreview }}</pre>
          <div v-else class="empty-state compact">
            {{ observedExecution.status === 'running' ? 'Waiting for output...' : 'No preview output captured.' }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.shell-session-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.empty-state {
  color: var(--color-text-muted, #888);
  font-style: italic;
  padding: 0.5rem 0;
}

.empty-state.compact {
  padding: 0;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.session-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border, #333);
  border-radius: 8px;
  background: var(--color-bg-secondary, #1a1a1a);
  text-align: left;
}

.session-card.observed {
  border-color: var(--color-primary, #2196f3);
  background: var(--color-bg-highlight, #1e2a3a);
}

.session-card.failed {
  border-color: rgba(239, 68, 68, 0.6);
}

.session-info {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  min-width: 0;
}

.session-id {
  font-size: 0.9rem;
  font-weight: 600;
}

.session-adapter,
.session-meta {
  font-size: 0.78rem;
  color: var(--color-text-muted, #888);
}

.session-state {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.session-state.running {
  background: rgba(59, 130, 246, 0.18);
  color: #93c5fd;
}

.session-state.completed {
  background: rgba(34, 197, 94, 0.18);
  color: #86efac;
}

.session-state.failed {
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
}

.preview-viewer {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.85rem;
  border: 1px solid var(--color-border, #333);
  border-radius: 10px;
  background: rgba(8, 12, 24, 0.75);
}

.preview-viewer h4 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.preview-target {
  margin-left: 0.5rem;
  font-size: 0.8rem;
  color: var(--color-text-muted, #9ca3af);
}

.preview-help {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-text-muted, #9ca3af);
}

.preview-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.35rem 0.75rem;
  font-size: 0.76rem;
  color: var(--color-text-muted, #9ca3af);
}

.command-block,
.output-block {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.command-label,
.output-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #a78bfa;
}

.command-text,
.output-preview {
  margin: 0;
  padding: 0.75rem;
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.18);
  color: #e5e7eb;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.output-preview {
  max-height: 18rem;
  overflow: auto;
}
</style>