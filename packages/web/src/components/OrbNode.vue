<template>
  <!-- One of the chat page's round controls (the session, its actions, the message input, and
       the input's options): a glyph in a hairline bezel, with no body of its own. On a wide
       window it stands on an orbit round the orb, where the orb canvas draws a gimbal round it
       (composables/orbControls.ts); on a narrow one it is parked at the page's edge and this face
       is all of it. Listeners and ARIA attributes given to the component land on its root: a
       button, or a plain span where something else takes the click (a <summary>). -->
  <component
    :is="as"
    :type="as === 'button' ? 'button' : undefined"
    class="orb-node"
    :class="[
      `orb-node--${side}`,
      tone ? `orb-node--${tone}` : '',
      { 'orb-node--open': open, 'orb-node--idle': idle, 'orb-node--docked': docked, 'orb-node--lit': lit },
    ]"
  >
    <span class="orb-node__bezel" aria-hidden="true" />
    <span class="orb-node__spark" aria-hidden="true" />
    <span class="orb-node__glyph" aria-hidden="true">
      <span v-if="open" class="orb-node__close">✕</span>
      <slot v-else />
    </span>
    <span v-if="(label || state) && docked" class="orb-node__label" aria-hidden="true">
      <span v-if="label" class="orb-node__name">{{ label }}</span>
      <span v-if="state" class="orb-node__state">{{ state }}</span>
    </span>
  </component>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  /** Which way the label goes: away from the orb. */
  side?: "left" | "right" | "below";
  /** Standing on its orbit round the orb, where it carries its name beside it. */
  docked?: boolean;
  /** Its menu is open: the glyph turns into the way out. */
  open?: boolean;
  /** Nothing behind it yet (no session): its bezel is dashed and nothing runs round it. */
  idle?: boolean;
  /** The control's name in a word, shown beside it while docked. */
  label?: string;
  /** What it is set to, in a word, under or beside its name: an option's current setting. */
  state?: string;
  /** Switched on: the whole bezel is lit. */
  lit?: boolean;
  /** A setting to be careful with: it is drawn in amber. */
  tone?: "caution" | "";
  /** The root element: a span where the node stands inside something that takes the click itself. */
  as?: "button" | "span";
}>(), { side: "below", docked: false, open: false, idle: false, label: "", state: "", lit: false, tone: "", as: "button" });
</script>

<style scoped>
.orb-node {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: rgb(var(--logo-cyan));
  /* No body: only a dark ground under the glyph, so it reads over the orbit's line, the orb's
     dust and, on a narrow window, a message. */
  background: radial-gradient(circle, rgba(var(--app-bg), 0.9) 0%, rgba(var(--app-bg), 0.9) 46%, rgba(var(--app-bg), 0) 70%);
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform 260ms var(--ease-out), color 200ms var(--ease-out);
}
.orb-node:not(.orb-node--docked) { cursor: grab; }
.orb-node:not(.orb-node--docked):active { cursor: grabbing; }

/* The bezel: a faint full circle, and one arc of light going round it, brightest at its head. */
.orb-node__bezel,
.orb-node__spark {
  position: absolute;
  inset: 2px;
  border-radius: inherit;
  pointer-events: none;
}
.orb-node__bezel::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1px solid rgba(var(--logo-cyan), 0.26);
  transition: border-color 220ms var(--ease-out), box-shadow 220ms var(--ease-out);
}
.orb-node__bezel::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: conic-gradient(
    from 0deg,
    rgba(var(--logo-cyan), 0) 0deg,
    rgba(var(--logo-cyan), 0) 205deg,
    rgba(var(--logo-cyan), 0.95) 358deg,
    rgba(var(--logo-cyan), 0) 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.7px), #000 calc(100% - 1px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.7px), #000 calc(100% - 1px));
  animation: orb-node-turn 16s linear infinite;
}
/* The point of light at the arc's head. */
.orb-node__spark::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(circle at 50% 0.7px, rgba(255, 255, 255, 0.95) 0, rgba(var(--logo-cyan), 0.85) 1.1px, rgba(var(--logo-cyan), 0) 2.6px);
  animation: orb-node-turn 16s linear infinite;
}
@keyframes orb-node-turn {
  to { transform: rotate(360deg); }
}

.orb-node__glyph {
  position: relative;
  display: grid;
  place-items: center;
  width: 44%;
  height: 44%;
  filter: drop-shadow(0 0 4px rgba(var(--logo-cyan), 0.6));
  transition: transform 260ms var(--ease-out);
}
.orb-node__glyph :deep(svg) {
  width: 100%;
  height: 100%;
}
.orb-node__close {
  font-size: 0.82rem;
  line-height: 1;
}
.orb-node--open .orb-node__glyph { transform: rotate(90deg); }

.orb-node:hover,
.orb-node:focus-visible {
  transform: scale(1.07);
}
.orb-node:active { transform: scale(0.96); }
.orb-node:hover .orb-node__bezel::before,
.orb-node:focus-visible .orb-node__bezel::before,
.orb-node--open .orb-node__bezel::before,
.orb-node--lit .orb-node__bezel::before {
  border-color: rgba(var(--logo-cyan), 0.7);
  box-shadow: 0 0 14px rgba(var(--logo-cyan), 0.22), inset 0 0 10px rgba(var(--logo-cyan), 0.12);
}
/* A setting to be careful with: amber, bezel and glyph and what it says. */
.orb-node--caution { color: rgb(252, 211, 77); }
.orb-node--caution .orb-node__bezel::before {
  border-color: rgba(251, 191, 36, 0.7);
  box-shadow: 0 0 14px rgba(251, 191, 36, 0.22), inset 0 0 10px rgba(251, 191, 36, 0.1);
}
.orb-node--caution .orb-node__glyph { filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.6)); }
.orb-node--caution .orb-node__state { color: rgb(252, 211, 77); }
.orb-node:focus-visible {
  outline: 2px solid rgba(var(--logo-cyan), 0.85);
  outline-offset: 4px;
}

/* Nothing behind it: dimmed, its bezel dashed, nothing running round it. */
.orb-node--idle { color: rgba(var(--logo-cyan), 0.55); }
.orb-node--idle .orb-node__bezel::before { border-style: dashed; }
.orb-node--idle .orb-node__bezel::after,
.orb-node--idle .orb-node__spark::after { display: none; }

/* Its name, on the side away from the orb, at the end of a short leader line. */
.orb-node__label {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  pointer-events: none;
  font-family: var(--font-label);
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: rgba(var(--logo-cyan), 0.5);
  transition: color 220ms var(--ease-out), opacity 180ms var(--ease-out);
}
.orb-node__label::before {
  content: "";
  flex: none;
  width: 0.85rem;
  height: 1px;
  background: linear-gradient(90deg, rgba(var(--logo-cyan), 0.6), rgba(var(--logo-cyan), 0));
}
.orb-node--right .orb-node__label {
  left: calc(100% + 0.2rem);
  top: 50%;
  transform: translateY(-50%);
}
.orb-node--left .orb-node__label {
  right: calc(100% + 0.2rem);
  top: 50%;
  transform: translateY(-50%);
  flex-direction: row-reverse;
  /* the tracking's trailing space would push the word off its line */
  margin-right: -0.2em;
}
.orb-node--left .orb-node__label::before {
  background: linear-gradient(270deg, rgba(var(--logo-cyan), 0.6), rgba(var(--logo-cyan), 0));
}
.orb-node--below .orb-node__label {
  top: calc(100% + 0.1rem);
  left: 50%;
  transform: translateX(-50%);
  flex-direction: column;
  gap: 0.25rem;
  padding-left: 0.2em;
}
/* An option's two lines: its name, and under it what it is set to, which is the one to read. */
.orb-node__name,
.orb-node__state { display: block; line-height: 1.05; }
/* The setting is the line that gets read: a little larger than the name over it. */
.orb-node__state {
  font-size: 1.1em;
  color: rgba(var(--logo-cyan), 0.95);
}
.orb-node--below .orb-node__name + .orb-node__state { margin-top: -0.02rem; }
.orb-node--idle .orb-node__state { color: rgba(var(--logo-cyan), 0.6); }
.orb-node--below .orb-node__label::before {
  width: 1px;
  height: 0.45rem;
  background: linear-gradient(180deg, rgba(var(--logo-cyan), 0.6), rgba(var(--logo-cyan), 0));
}
.orb-node:hover .orb-node__label,
.orb-node:focus-visible .orb-node__label {
  color: rgb(var(--logo-cyan));
}
/* A menu that opens to the side opens where the name stands. */
.orb-node--left.orb-node--open .orb-node__label,
.orb-node--right.orb-node--open .orb-node__label { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .orb-node,
  .orb-node__glyph { transition: none; }
  .orb-node:hover,
  .orb-node:focus-visible,
  .orb-node:active { transform: none; }
  .orb-node__bezel::after,
  .orb-node__spark::after { animation: none; }
}
</style>
