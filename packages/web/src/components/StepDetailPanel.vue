<template>
  <div v-if="steps.length" class="sdp">
    <ol class="sdp-list">
      <li
        v-for="(step, index) in steps"
        :key="step.id"
        :ref="(el) => registerRow(step.id, el)"
        :class="['sdp-item', `sdp-item--${step.status}`, {
          'sdp-item--nested': step.depth === 1,
          'sdp-item--focus': step.id === focusStepId,
          'sdp-item--note': step.kind === 'note',
        }]"
      >
        <p v-if="step.kind === 'note'" class="sdp-note">{{ stepTitle(step) }}</p>

        <template v-else>
          <button
            type="button"
            class="sdp-head"
            :aria-expanded="isOpen(step.id)"
            @click="toggle(step.id)"
          >
            <span class="sdp-index">{{ toolNumber(index) }}</span>
            <span class="sdp-title">{{ stepTitle(step) }}</span>
            <span class="sdp-status">{{ statusLabel(step) }}</span>
          </button>

          <div v-if="isOpen(step.id)" class="sdp-body">
            <dl class="sdp-facts">
              <template v-if="step.agent"><dt>Ran inside</dt><dd>{{ step.agent }}</dd></template>
              <dt>Tool</dt><dd class="sdp-mono">{{ step.name }}</dd>
              <!-- Not while running: the panel has no ticking clock, so a running step's figure
                   would be frozen at the moment it was opened and read as the final time. -->
              <template v-if="step.status !== 'running' && durationOf(step)"><dt>Took</dt><dd>{{ durationOf(step) }}</dd></template>
              <template v-if="stepOutcome(step)"><dt>Outcome</dt><dd>{{ stepOutcome(step) }}</dd></template>
              <template v-if="step.status === 'running' && step.progress"><dt>Now</dt><dd>{{ step.progress }}</dd></template>
            </dl>

            <section v-if="hasEntries(step.args)" class="sdp-section">
              <h4>Arguments</h4>
              <pre>{{ printable(step.args) }}</pre>
            </section>

            <section v-if="step.result" class="sdp-section">
              <h4>Result</h4>
              <pre>{{ step.result }}</pre>
              <!-- The live stream carries the first 500 characters of a result; the full text is
                   kept on the server. Say so, rather than presenting a cut result as complete. -->
              <p v-if="step.result.length === LIVE_RESULT_LIMIT" class="sdp-hint">
                First {{ LIVE_RESULT_LIMIT }} characters — the rest is in the session transcript.
              </p>
            </section>

            <section v-if="hasEntries(step.metadata)" class="sdp-section">
              <h4>Details</h4>
              <pre>{{ printable(step.metadata) }}</pre>
            </section>
          </div>
        </template>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import {
  formatDuration,
  stepDurationMs,
  stepOutcome,
  stepTitle,
  type TurnStep,
} from "@/composables/turnSteps";

const props = defineProps<{
  steps: TurnStep[];
  /** The step whose row was clicked — opened and scrolled into view. */
  focusStepId?: string | null;
  /** Changes on every click, so re-clicking the same row re-opens and re-scrolls it. */
  focusRequest?: number;
}>();

/** What gateway/rpc.ts cuts a live tool result to before sending it. */
const LIVE_RESULT_LIMIT = 500;

const open = ref(new Set<string>());
const rowEls = new Map<string, Element>();

function registerRow(id: string, el: unknown): void {
  if (el instanceof Element) rowEls.set(id, el);
  else rowEls.delete(id);
}

/** Number the tool calls only — a narration line between them is not a step. */
function toolNumber(index: number): number {
  return props.steps.slice(0, index + 1).filter(step => step.kind === "tool").length;
}

function isOpen(id: string): boolean { return open.value.has(id); }
function toggle(id: string): void {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  open.value = next;
}

watch(() => [props.focusStepId, props.focusRequest] as const, async ([id]) => {
  if (!id) return;
  open.value = new Set([...open.value, id]);
  await nextTick();
  rowEls.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}, { immediate: true });

function durationOf(step: TurnStep): string {
  return formatDuration(stepDurationMs(step, Date.now()));
}

function statusLabel(step: TurnStep): string {
  if (step.status === "running") return "running…";
  if (step.status === "failed") return "failed";
  if (step.status === "stopped") return "no result";
  return durationOf(step) || "done";
}

function hasEntries(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.keys(value).length);
}

/**
 * JSON for reading, with payloads replaced by what they are.
 *
 * A generated image's tool metadata carries the whole picture as a base64 data URL — ~2 MB of
 * text for a 1024² PNG. Printed as-is it would put megabytes into the DOM to show one step, and
 * tell the reader nothing the file path next to it does not. Same rule the audit log applies:
 * keep WHICH file, drop the bytes.
 */
function printable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry !== "string") return entry;
    if (entry.startsWith("data:") && entry.length > 256) {
      const kb = Math.round((entry.length * 3) / 4 / 1024);
      // The type ends at ';' (base64) or ',' (plain). Searching for ';' alone returned -1 for a
      // data: URL without one, and slice(5, -1) then printed the whole payload as the "label".
      const end = entry.search(/[;,]/);
      const type = end > 5 ? entry.slice(5, Math.min(end, 65)) : "data";
      return `[inline ${type}, ~${kb} KB — omitted]`;
    }
    if (entry.length > 4000) return `${entry.slice(0, 4000)}… [${entry.length - 4000} more characters]`;
    return entry;
  }, 2);
}
</script>

<style scoped>
.sdp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }

.sdp-item { border-radius: 0.45rem; }
.sdp-item--nested { margin-left: 1rem; border-left: 1px solid rgba(148, 163, 184, 0.25); padding-left: 0.4rem; }
.sdp-item--focus { background: rgba(var(--accent-purple), 0.1); box-shadow: inset 2px 0 0 rgb(var(--accent-purple)); }

.sdp-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  padding: 0.35rem 0.45rem;
  border: none;
  border-radius: 0.45rem;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
}
.sdp-head:hover { background: rgba(148, 163, 184, 0.1); }
.sdp-index { min-width: 1.2rem; color: rgb(var(--accent-purple)); font-weight: 700; font-variant-numeric: tabular-nums; }
.sdp-title { flex: 1; min-width: 0; }
.sdp-status { font-size: 0.72rem; opacity: 0.7; font-variant-numeric: tabular-nums; }
.sdp-item--done .sdp-status { color: #4ade80; opacity: 1; }
.sdp-item--failed .sdp-status { color: #f87171; opacity: 1; }
.sdp-item--stopped .sdp-status { color: #fbbf24; opacity: 1; }

.sdp-body { padding: 0.1rem 0.45rem 0.6rem 2.1rem; font-size: 0.76rem; }
.sdp-facts { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0 0 0.5rem; }
.sdp-facts dt { opacity: 0.6; }
.sdp-facts dd { margin: 0; word-break: break-word; }
.sdp-mono { font-family: var(--font-mono); }

.sdp-section { margin-top: 0.5rem; }
.sdp-section h4 {
  margin: 0 0 0.25rem;
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.6;
}
.sdp-section pre {
  margin: 0;
  padding: 0.45rem 0.55rem;
  border-radius: 0.4rem;
  background: rgba(0, 0, 0, 0.28);
  font-size: 0.7rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 22rem;
  overflow-y: auto;
}
.sdp-hint { margin: 0.25rem 0 0; font-size: 0.68rem; opacity: 0.6; font-style: italic; }
.sdp-note { margin: 0.2rem 0.45rem 0.2rem 2.2rem; font-size: 0.76rem; font-style: italic; opacity: 0.7; }
</style>
