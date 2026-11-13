<template>
  <!-- The running turn at the orb: its steps as satellites on the step ring, its newest words in a
       status line under it (composables/orbActivity.ts). The ring itself is the orb canvas's: a
       track of light round the orb, which this layer's points ride on through the same camera. Only
       the satellites and the status line take clicks; the layer itself lets everything through. -->
  <div class="orb-activity" :class="{ 'orb-activity--narrow': narrow }">
    <div v-if="!narrow" class="orb-activity__ring">
      <button
        v-for="body in drawn"
        :key="body.id"
        type="button"
        class="orb-sat"
        :class="[`orb-sat--${body.status}`, { 'orb-sat--nested': body.nested, 'orb-sat--front': body.front, 'orb-sat--labelled': body.labelled }]"
        :style="body.style"
        :tabindex="body.leaving ? -1 : 0"
        :title="body.duration ? `${body.label} · ${body.duration}` : body.label"
        :aria-label="`${body.label}: ${statusWord(body.status)}`"
        @click="emit('open', body.id)"
      >
        <span class="orb-sat__dot" aria-hidden="true" />
        <span class="orb-sat__label">{{ body.text }}</span>
      </button>
    </div>

    <Transition name="orb-status">
      <button
        v-if="activity"
        type="button"
        class="orb-status"
        :style="statusStyle"
        :title="clickHint"
        @click="emit('open', activity.current?.stepId)"
      >
        <span class="orb-status__headline">{{ activity.headline }}</span>
        <span class="orb-status__step">
          <template v-if="activity.current">
            <span class="orb-status__spinner" aria-hidden="true" />
            <span class="orb-status__label">{{ activity.current.label }}</span>
            <span class="orb-status__time">{{ activity.current.duration }}</span>
          </template>
          <span v-else class="orb-status__time">{{ activity.elapsed }}</span>
        </span>
      </button>
    </Transition>
    <!-- Read out as the turn says something new; the button above is only its visible form. -->
    <span class="sr-only" role="status" aria-live="polite">{{ activity?.headline ?? "" }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { activityRing, freeHalfWidth, labelPlacement, orbitGeometry, orbitPoint, placeLabels, orbPixels, type LabelPlacement, type LiveActivity } from "@/composables/orbActivity";
import type { StepDisplayStatus } from "@/composables/turnSteps";
import { turnText, type TurnLanguage } from "@/composables/turnText";

const props = defineProps<{
  activity: LiveActivity | null;
  language?: TurnLanguage;
  /** The room the messages keep free at their outer edge for the page's round controls, in pixels. */
  lane?: number;
}>();

const emit = defineEmits<{
  /** Open the live turn's steps in the side panel, at this step when one is given. */
  open: [stepId: string | undefined];
}>();

const lang = computed<TurnLanguage>(() => props.language ?? "en");
const clickHint = computed(() => turnText.clickForDetails(lang.value));

function statusWord(status: StepDisplayStatus): string {
  if (status === "running") return turnText.statusRunning(lang.value);
  if (status === "failed") return turnText.statusFailed(lang.value);
  if (status === "stopped") return turnText.statusNoResult(lang.value);
  if (status === "skipped") return turnText.statusSkipped(lang.value);
  return turnText.statusDone(lang.value);
}

// ── Viewport: the ring is sized to the orb, which follows the window (OrbCanvas.vue) ──────────
const width = ref(typeof window === "undefined" ? 1600 : window.innerWidth);
const height = ref(typeof window === "undefined" ? 900 : window.innerHeight);
function onResize(): void {
  width.value = window.innerWidth;
  height.value = window.innerHeight;
}
/** Below this the messages take the whole width and would sit under the ring. */
const narrow = computed(() => width.value < 1100);
/** The band the messages leave free around the orb (Chat.vue lays them out at the outer edges). */
const freeHalf = computed(() => freeHalfWidth(width.value, height.value, 16, props.lane ?? 0));
/** The step ring as the canvas draws it, and the page seen through the canvas's camera. */
const view = computed(() => ({
  ring: activityRing(width.value, height.value, freeHalf.value),
  width: width.value,
  height: height.value,
  coreRadius: orbPixels(width.value, height.value) * 0.55,
  /** The ring's half-width on the page. */
  rx: orbitGeometry(width.value, height.value, freeHalf.value).rx,
}));
/** Under the orb and the front of the ring with its labels. */
const statusStyle = computed(() => {
  if (narrow.value) return {};
  const front = orbitPoint(0, 1, view.value).y;
  return { top: `calc(50% + ${Math.round(Math.max(orbPixels(width.value, height.value) * 1.08, front + 52))}px)` };
});

const reducedMotion = typeof window !== "undefined"
  && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// ── Bodies: where each satellite is drawn now, eased towards where it belongs ────────────────
interface Body {
  id: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  depth: number;
  status: StepDisplayStatus;
  nested: boolean;
  label: string;
  short: string;
  subject?: string;
  duration: string;
  leaving: boolean;
}
const bodies = new Map<string, Body>();
const drawn = ref<Array<Body & { style: Record<string, string | number>; front: boolean; labelled: boolean; text: string }>>([]);

/**
 * What a step's label says. The front one has room for the step and its subject; one beside it
 * has little, and says the part that tells it apart — "wissen.example.org", not "Webseite lesen · …".
 */
function labelText(body: Body, front: boolean): string {
  return front ? body.short : body.subject || body.short;
}

let frame = 0;
let last = 0;
let clock = 0;

function step(time: number): void {
  const dt = last ? Math.min(0.1, (time - last) / 1000) : 0.016;
  last = time;
  clock += dt;
  const satellites = props.activity?.satellites ?? [];
  const sway = reducedMotion ? 0 : 0.06 * Math.sin(clock * 0.35);
  const ease = reducedMotion ? 1 : 1 - Math.exp(-dt * 5);
  const present = new Set<string>();
  const newest = satellites.at(-1)?.id;

  satellites.forEach((satellite, index) => {
    present.add(satellite.id);
    const target = orbitPoint(index, satellites.length, view.value, sway);
    // A new satellite is launched from the orb's core.
    const body = bodies.get(satellite.id) ?? {
      id: satellite.id, x: 0, y: 0, scale: 0.2, opacity: 0, depth: 1,
      status: satellite.status, nested: satellite.nested, label: satellite.label, short: satellite.short, subject: satellite.subject, duration: satellite.duration, leaving: false,
    };
    body.x += (target.x - body.x) * ease;
    body.y += (target.y - body.y) * ease;
    body.scale += (target.scale * (satellite.nested ? 0.75 : 1) - body.scale) * ease;
    body.opacity += (target.opacity - body.opacity) * ease;
    body.depth = target.depth;
    Object.assign(body, { status: satellite.status, label: satellite.label, short: satellite.short, subject: satellite.subject, duration: satellite.duration, leaving: false });
    bodies.set(satellite.id, body);
  });
  // A step that left the ring, or every step once the turn is over, falls back into the orb.
  for (const body of bodies.values()) {
    if (present.has(body.id)) continue;
    body.leaving = true;
    body.x += (0 - body.x) * ease;
    body.y += (0 - body.y) * ease;
    body.scale += (0.2 - body.scale) * ease;
    body.opacity += (0 - body.opacity) * ease * 1.4;
    if (body.opacity < 0.02 || reducedMotion) bodies.delete(body.id);
  }

  // Labels on the near arc, where they can be read, keep out of the messages and off each other:
  // the nearest one first (labelPlacement, placeLabels).
  const placements = new Map<string, LabelPlacement>();
  for (const body of bodies.values()) {
    if (body.leaving) continue;
    const placement = labelPlacement(body.x, body.depth, view.value.rx, freeHalf.value);
    if (placement) placements.set(body.id, placement);
  }
  const labelled = placeLabels([...bodies.values()]
    .filter((body) => placements.has(body.id))
    .sort((a, b) => b.depth - a.depth)
    .map((body) => ({ id: body.id, x: body.x, y: body.y, scale: body.scale, text: labelText(body, body.id === newest), ...placements.get(body.id)! })));
  drawn.value = [...bodies.values()].map((body) => {
    const placement = placements.get(body.id);
    const scale = Math.max(0.2, body.scale);
    return {
      ...body,
      front: body.id === newest,
      labelled: labelled.has(body.id),
      // A point without a label shows the whole of it on hover, where it has the room.
      text: labelled.has(body.id) ? labelText(body, body.id === newest) : body.short,
      style: {
        transform: `translate(-50%, -50%) translate3d(${body.x.toFixed(1)}px, ${body.y.toFixed(1)}px, 0) scale(${body.scale.toFixed(3)})`,
        opacity: Math.max(0, Math.min(1, body.opacity)).toFixed(3),
        // Far side out of focus: the ring reads as depth, not as a flat row.
        filter: body.depth < 0 ? `blur(${(-body.depth * 1.1).toFixed(2)}px)` : "none",
        zIndex: Math.round(10 + body.depth * 10),
        // What undoes the point's own scale: a label is read at full size, however far round the
        // ring its point is (at 0.9 of 11.5 px it was a strain already).
        "--inv": (1 / scale).toFixed(3),
        // Where the label hangs and how wide it may be; it grows from the edge it hangs by.
        ...(placement
          ? {
            "--label-x": `${(-50 + 50 * placement.lean).toFixed(1)}%`,
            "--label-origin": `${(50 - 50 * placement.lean).toFixed(1)}%`,
            "--label-max": `${placement.maxWidth}px`,
          }
          : {}),
      },
    };
  });

  if (bodies.size > 0 || props.activity) frame = requestAnimationFrame(step);
  else stop();
}

function start(): void {
  if (frame || narrow.value) return;
  last = 0;
  frame = requestAnimationFrame(step);
}
function stop(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

watch(() => props.activity?.satellites.map((satellite) => `${satellite.id}:${satellite.status}`).join("|"), () => {
  if (props.activity) start();
});
watch(() => Boolean(props.activity), (active) => { if (active || bodies.size) start(); }, { immediate: true });
watch(narrow, (isNarrow) => {
  if (isNarrow) {
    stop();
    bodies.clear();
    drawn.value = [];
  } else if (props.activity) {
    start();
  }
});

onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  stop();
});
</script>

<style scoped>
.orb-activity {
  position: fixed;
  inset: 0;
  z-index: 20;
  pointer-events: none;
}

/* The ring's centre is the orb's: the canvas is fixed and centred on the viewport. */
.orb-activity__ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
}

.orb-sat {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  pointer-events: auto;
  cursor: pointer;
  will-change: transform, opacity;
}

.orb-sat__dot {
  width: 11px;
  height: 11px;
  border-radius: 9999px;
  background: rgb(var(--accent-purple));
  box-shadow:
    0 0 6px 1px rgba(var(--accent-purple), 0.85),
    0 0 18px 4px rgba(var(--accent-purple), 0.35);
}
.orb-sat--nested .orb-sat__dot {
  width: 8px;
  height: 8px;
}
.orb-sat--done .orb-sat__dot {
  background: rgba(var(--accent-purple), 0.75);
  box-shadow: 0 0 8px 1px rgba(var(--accent-purple), 0.45);
}
.orb-sat--running .orb-sat__dot {
  background: #fff;
  box-shadow:
    0 0 8px 2px rgba(255, 255, 255, 0.9),
    0 0 22px 6px rgba(var(--accent-purple), 0.65);
  animation: orb-sat-pulse 1.6s ease-in-out infinite;
}
.orb-sat--failed .orb-sat__dot {
  background: #f87171;
  box-shadow: 0 0 10px 2px rgba(248, 113, 113, 0.7);
}
.orb-sat--stopped .orb-sat__dot,
.orb-sat--skipped .orb-sat__dot {
  background: rgba(148, 163, 184, 0.7);
  box-shadow: none;
}
@keyframes orb-sat-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.45); }
}

/* A step's label hangs under its point, clear of the ring: on the ring's near arc always — centred
   at the front, leaning outwards beside it (--label-x, --label-max from labelPlacement) — and on
   hover or keyboard focus everywhere else. Its ground is nearly opaque: the ring's lines and glow
   came through it and through the words. */
.orb-sat__label {
  position: absolute;
  left: 50%;
  /* 15 px on the page, whatever the point's own scale (--inv undoes it, as for the label's size). */
  top: calc(50% + 15px * var(--inv, 1));
  transform: translateX(var(--label-x, -50%)) scale(var(--inv, 1));
  transform-origin: var(--label-origin, 50%) 0;
  max-width: var(--label-max, 210px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0.12rem 0.55rem;
  border-radius: 9999px;
  border: 1px solid rgba(var(--accent-purple), 0.22);
  background: rgba(3, 7, 18, 0.9);
  color: rgb(209, 213, 219);
  font-size: 0.72rem;
  line-height: 1.35;
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms ease;
}
.orb-sat--labelled .orb-sat__label,
.orb-sat:hover .orb-sat__label,
.orb-sat:focus-visible .orb-sat__label {
  opacity: 1;
}
.orb-sat--front .orb-sat__label {
  border-color: rgba(var(--accent-purple), 0.5);
  color: rgb(243, 244, 246);
  font-size: 0.78rem;
}
.orb-sat--failed .orb-sat__label {
  border-color: rgba(248, 113, 113, 0.5);
}
/* Hovered or focused, a step comes forward wherever it is on the ring: sharp and opaque, its
   label centred under it at reading size — on the far side both were small and out of focus. */
.orb-sat:hover,
.orb-sat:focus-visible {
  z-index: 40 !important;
  opacity: 1 !important;
  filter: none !important;
}
.orb-sat:not(.orb-sat--labelled):hover .orb-sat__label,
.orb-sat:not(.orb-sat--labelled):focus-visible .orb-sat__label {
  transform: translateX(-50%) scale(var(--inv, 1));
  transform-origin: 50% 0;
  max-width: 260px;
}

.orb-sat:focus-visible {
  outline: none;
}
.orb-sat:focus-visible .orb-sat__dot {
  outline: 2px solid rgba(var(--accent-purple), 0.9);
  outline-offset: 3px;
}

/* ── Status line under the orb ─────────────────────────────────────────────────────────────── */
.orb-status {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  max-width: min(34rem, calc(100vw - 2rem));
  padding: 0.55rem 1.1rem 0.6rem;
  border-radius: 1rem;
  border: 1px solid rgba(var(--accent-purple), 0.22);
  background: rgba(3, 7, 18, 0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 10px 40px -18px rgba(var(--accent-purple), 0.55);
  color: rgb(243, 244, 246);
  text-align: center;
  pointer-events: auto;
  cursor: pointer;
}
/* On a narrow window the status sits under the header, clear of the round controls on the right. */
.orb-activity--narrow .orb-status {
  top: 4.75rem;
  left: 1rem;
  right: 4.5rem;
  transform: none;
  max-width: none;
}
.orb-activity--narrow .orb-status-enter-from,
.orb-activity--narrow .orb-status-leave-to {
  transform: translateY(-8px);
}
.orb-status__headline {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.95rem;
  line-height: 1.35;
}
.orb-status__step {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  max-width: 100%;
  font-size: 0.75rem;
  color: rgb(156, 163, 175);
}
.orb-status__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orb-status__time {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: rgba(var(--accent-purple), 0.95);
}
.orb-status__spinner {
  flex: none;
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 9999px;
  border: 2px solid rgba(var(--accent-purple), 0.25);
  border-top-color: rgb(var(--accent-purple));
  animation: orb-status-spin 0.9s linear infinite;
}
@keyframes orb-status-spin {
  to { transform: rotate(360deg); }
}

.orb-status-enter-active,
.orb-status-leave-active {
  transition: opacity 320ms var(--ease-out), transform 420ms var(--ease-out);
}
.orb-status-enter-from,
.orb-status-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px) scale(0.97);
}

@media (prefers-reduced-motion: reduce) {
  .orb-sat--running .orb-sat__dot,
  .orb-status__spinner {
    animation: none;
  }
  /* The status line fades in where it stands: its enter and leave states keep the resting
     transform (centred, or none on a narrow window) instead of sliding and growing into it. */
  .orb-status-enter-active,
  .orb-status-leave-active {
    transition: opacity 120ms linear;
  }
  .orb-status-enter-from,
  .orb-status-leave-to {
    transform: translateX(-50%);
  }
  .orb-activity--narrow .orb-status-enter-from,
  .orb-activity--narrow .orb-status-leave-to {
    transform: none;
  }
}
</style>
