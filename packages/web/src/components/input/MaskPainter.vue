<template>
  <div class="mp">
    <div class="mp__toolbar">
      <div class="mp__modes" role="group" aria-label="Brush">
        <button type="button" :class="['mp__tool', { 'mp__tool--on': mode === 'paint' }]" :aria-pressed="mode === 'paint'" @click="mode = 'paint'">Paint</button>
        <button type="button" :class="['mp__tool', { 'mp__tool--on': mode === 'erase' }]" :aria-pressed="mode === 'erase'" title="Erase (E)" @click="mode = 'erase'">Erase</button>
      </div>
      <label class="mp__brush">
        <span>Brush</span>
        <input v-model.number="brush" type="range" :min="MIN_BRUSH" :max="MAX_BRUSH" step="1" aria-label="Brush size in pixels" />
        <span class="mp__num">{{ brush }} px</span>
      </label>
      <button type="button" class="mp__tool" title="Swap what may change and what is kept (X)" @click="invert">Invert</button>
      <button type="button" class="mp__tool" :disabled="undoDepth === 0" title="Undo (Ctrl+Z)" @click="undo">Undo</button>
      <button type="button" class="mp__tool" title="Start over: nothing may change" @click="clear">Clear</button>
      <span class="mp__coverage" aria-live="polite">{{ coverageLabel(coverage) }} may change</span>
    </div>
    <p class="mp__hint">
      Paint over what may change — the tinted part. Everything else is kept.
      <span class="mp__keys">[ ] brush size · E eraser · X invert · Ctrl+Z undo</span>
    </p>

    <div class="mp__stage-wrap">
      <div class="mp__stage" :style="stageStyle">
        <img v-if="baseUrl" :src="baseUrl" class="mp__layer" alt="The picture to edit" draggable="false" />
        <div v-else class="mp__layer mp__loading">{{ baseError || 'Loading the picture…' }}</div>
        <canvas
          ref="overlayEl"
          :width="width"
          :height="height"
          class="mp__layer mp__overlay"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="cursor = null"
        />
        <div v-if="cursor" class="mp__cursor" :style="cursorStyle" aria-hidden="true" />
      </div>
    </div>

    <div class="mp__footer">
      <button type="button" class="btn-ghost mp__action" @click="emit('cancel')">Cancel</button>
      <button type="button" class="btn-grad mp__action" :disabled="!exportable" :title="exportTitle" @click="apply">Use this mask</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  MAX_BRUSH,
  MIN_BRUSH,
  canExportMask,
  clampBrush,
  clearMask,
  coverageLabel,
  createMask,
  defaultBrushSize,
  invertMask,
  mapPointerToImage,
  maskCoverage,
  normalizeMask,
  paintSegment,
  popUndo,
  pushUndo,
  renderOverlay,
  type DirtyRect,
  type MaskCoverage,
  type MaskImage,
  type Point,
} from "@/composables/maskPainter";

const props = defineProps<{
  /** The base picture's natural size — the mask is exactly this size. */
  width: number;
  height: number;
  /** The base picture at full size; null while it loads. */
  baseUrl: string | null;
  baseError?: string;
  /** A mask to start from (the agent's, or one painted earlier) instead of a blank one. */
  initialMaskUrl?: string;
}>();

const emit = defineEmits<{
  /** The mask as a PNG data URL: transparent pixels may change, opaque ones are kept. */
  apply: [dataUrl: string, coverage: MaskCoverage];
  cancel: [];
}>();

const overlayEl = ref<HTMLCanvasElement | null>(null);
const mode = ref<"paint" | "erase">("paint");
const brush = ref(defaultBrushSize(props.width, props.height));
const coverage = ref<MaskCoverage>({ editable: 0, total: props.width * props.height, ratio: 0 });
const undoDepth = ref(0);
const cursor = ref<{ x: number; y: number; size: number } | null>(null);

// Plain, not reactive: a 2048×2048 mask is 16 MB, and Vue has no business proxying it.
let mask: MaskImage = createMask(props.width, props.height);
let overlay: ImageData | null = null;
let undoStack: Uint8Array[] = [];
let activePointer: number | null = null;
let last: Point | null = null;

const exportable = computed(() => canExportMask(coverage.value));
const exportTitle = computed(() => {
  if (coverage.value.editable === 0) return "Paint the region that may change first";
  if (coverage.value.editable === coverage.value.total) return "Everything may change — that is an edit without a mask";
  return "Send this mask with the render";
});
// The stage keeps the picture's shape and fits the space both ways, so a tall picture is not
// cut off on a wide screen or the other way round.
const stageStyle = computed(() => ({
  aspectRatio: `${props.width} / ${props.height}`,
  "--mp-ratio": String(props.width / props.height),
}));
const cursorStyle = computed(() => cursor.value
  ? { left: `${cursor.value.x}px`, top: `${cursor.value.y}px`, width: `${cursor.value.size}px`, height: `${cursor.value.size}px` }
  : {});

function context(): CanvasRenderingContext2D | null {
  return overlayEl.value?.getContext("2d") ?? null;
}

function redraw(rect?: DirtyRect): void {
  const ctx = context();
  if (!ctx) return;
  overlay ??= ctx.createImageData(props.width, props.height);
  renderOverlay(mask, overlay.data, rect);
  if (rect) ctx.putImageData(overlay, 0, 0, rect.x, rect.y, rect.width, rect.height);
  else ctx.putImageData(overlay, 0, 0);
}

function recount(): void {
  coverage.value = maskCoverage(mask);
}

function remember(): void {
  undoStack = pushUndo(undoStack, mask);
  undoDepth.value = undoStack.length;
}

function toImage(event: { clientX: number; clientY: number }): Point {
  const rect = overlayEl.value!.getBoundingClientRect();
  return mapPointerToImage(event.clientX, event.clientY, rect, props.width, props.height);
}

function stroke(from: Point, to: Point): void {
  const rect = paintSegment(mask, from, to, brush.value / 2, mode.value);
  if (rect) redraw(rect);
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (activePointer !== null) return;
  // Capture, so a stroke that leaves the picture keeps drawing until the button is released.
  try { overlayEl.value?.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
  activePointer = event.pointerId;
  remember();
  const point = toImage(event);
  last = point;
  stroke(point, point);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  const rect = overlayEl.value?.getBoundingClientRect();
  if (rect && event.pointerType !== "touch") {
    cursor.value = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      size: (brush.value * rect.width) / props.width,
    };
  }
  if (event.pointerId !== activePointer || !last) return;
  // A fast pen reports several positions per frame; drawing through each keeps curves round.
  const points = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  for (const sample of points.length ? points : [event]) {
    const point = toImage(sample);
    stroke(last, point);
    last = point;
  }
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return;
  activePointer = null;
  last = null;
  recount();
}

function invert(): void {
  remember();
  invertMask(mask);
  redraw();
  recount();
}

function clear(): void {
  remember();
  clearMask(mask);
  redraw();
  recount();
}

function undo(): void {
  undoStack = popUndo(undoStack, mask);
  undoDepth.value = undoStack.length;
  redraw();
  recount();
}

function apply(): void {
  if (!exportable.value) return;
  const canvas = document.createElement("canvas");
  canvas.width = props.width;
  canvas.height = props.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(props.width, props.height);
  image.data.set(mask.data);
  ctx.putImageData(image, 0, 0);
  emit("apply", canvas.toDataURL("image/png"), coverage.value);
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range"))) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const step = Math.max(2, Math.round(brush.value * 0.15));
  if (event.key === "[") brush.value = clampBrush(brush.value - step);
  else if (event.key === "]") brush.value = clampBrush(brush.value + step);
  else if (event.key === "e" || event.key === "E") mode.value = mode.value === "erase" ? "paint" : "erase";
  else if (event.key === "x" || event.key === "X") invert();
  else return;
  event.preventDefault();
}

/** Start from a mask made elsewhere, when it is the same size as this picture. */
function loadInitialMask(url: string): void {
  const image = new Image();
  image.onload = () => {
    if (image.naturalWidth !== props.width || image.naturalHeight !== props.height) return;
    const canvas = document.createElement("canvas");
    canvas.width = props.width;
    canvas.height = props.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    mask = normalizeMask({ width: props.width, height: props.height, data: ctx.getImageData(0, 0, props.width, props.height).data });
    undoStack = [];
    undoDepth.value = 0;
    redraw();
    recount();
  };
  image.src = url;
}

onMounted(() => {
  redraw();
  recount();
  if (props.initialMaskUrl) loadInitialMask(props.initialMaskUrl);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.mp { display: flex; flex-direction: column; gap: 0.5rem; min-height: 0; }
.mp__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.6rem; font-size: 0.78rem; }
.mp__modes { display: inline-flex; border-radius: 0.55rem; overflow: hidden; border: 1px solid var(--hairline-strong, rgba(168, 85, 247, 0.3)); }
.mp__modes .mp__tool { border: none; border-radius: 0; }
.mp__tool {
  padding: 0.25rem 0.6rem;
  border-radius: 0.55rem;
  border: 1px solid var(--hairline-strong, rgba(168, 85, 247, 0.3));
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mp__tool:hover:not(:disabled) { background: rgba(var(--accent-purple), 0.12); }
.mp__tool:disabled { opacity: 0.4; cursor: default; }
.mp__tool--on { background: rgba(var(--accent-purple), 0.3); }
.mp__brush { display: inline-flex; align-items: center; gap: 0.35rem; }
.mp__brush input { width: 7rem; }
.mp__num { min-width: 3.4rem; font-variant-numeric: tabular-nums; color: rgb(156 163 175); }
.mp__coverage { margin-left: auto; font-variant-numeric: tabular-nums; color: rgb(203 213 225); }
.mp__hint { margin: 0; font-size: 0.74rem; color: rgb(156 163 175); }
.mp__keys { margin-left: 0.4rem; opacity: 0.75; }

.mp__stage-wrap { display: flex; justify-content: center; min-height: 0; }
.mp__stage {
  position: relative;
  width: min(100%, calc((100dvh - 18rem) * var(--mp-ratio)));
  border-radius: 0.5rem;
  overflow: hidden;
  background:
    repeating-conic-gradient(rgba(148, 163, 184, 0.16) 0% 25%, transparent 0% 50%) 0 0 / 20px 20px;
}
.mp__layer { position: absolute; inset: 0; width: 100%; height: 100%; }
.mp__base, img.mp__layer { object-fit: fill; user-select: none; pointer-events: none; }
.mp__loading { display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: rgb(156 163 175); }
/* Pen and touch draw instead of scrolling the page. */
.mp__overlay { touch-action: none; cursor: crosshair; }
.mp__cursor {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.mp__footer { display: flex; justify-content: flex-end; gap: 0.5rem; }
.mp__action { padding: 0.4rem 1rem; border-radius: 0.7rem; font-size: 0.82rem; }
</style>
