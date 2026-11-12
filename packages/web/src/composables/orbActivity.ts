/**
 * The running turn as the orb shows it: its newest words in a status line under the orb, and its
 * steps as satellites on a ring around it. A turn used to post each of these into the chat — a
 * "Zwischenstand" bubble per progress message and a step list in the live bubble — so the
 * conversation filled up with the record of work while the work was still going on. The chat now
 * keeps questions and answers; the answer keeps its steps folded into one line.
 *
 * Pure: the store's messages in, what to draw out. The component (components/OrbActivity.vue)
 * only animates it.
 */
import {
  displayStatus,
  formatDuration,
  isQuietStep,
  stepDurationMs,
  stepSubject,
  stepTitle,
  stepsFor,
  type StepDisplayStatus,
  type StepSource,
  type TurnStep,
} from "./turnSteps";
import { turnText, type TurnLanguage } from "./turnText";

/** The live bubble of a running turn (stores/gateway.ts). */
const STREAMING_ID = "streaming";

/** Satellites on the ring at once: older steps leave it as new ones arrive. */
export const MAX_SATELLITES = 9;

export interface ActivityMessage extends StepSource {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  progress?: boolean;
  statusText?: string;
}

export interface Satellite {
  id: string;
  status: StepDisplayStatus;
  /** A call made inside a specialist the turn delegated to. */
  nested: boolean;
  label: string;
  /** What the satellite carries on the ring: the step's title and the short form of its subject. */
  short: string;
  duration: string;
}

export interface LiveActivity {
  /** The live bubble's id, for opening its steps. */
  messageId: string;
  /** What the turn last said while it works: a progress message, a narration line, its status. */
  headline: string;
  /** The step running now, the newest one when several run. */
  current?: { stepId: string; label: string; duration: string };
  /** Oldest first. */
  satellites: Satellite[];
  /** How long the turn has run, from the question it answers. */
  elapsed: string;
}

/** A subject short enough for the ring: a web address as its host, anything else cut. */
export function shortSubject(subject: string, max = 24): string {
  try {
    const url = new URL(subject);
    if (url.protocol === "http:" || url.protocol === "https:") return url.hostname.replace(/^www\./, "");
  } catch {
    // Not a web address.
  }
  const flat = subject.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function stepShort(step: TurnStep, lang: TurnLanguage): string {
  const subject = stepSubject(step);
  return subject ? `${stepTitle(step, lang)} · ${shortSubject(subject)}` : stepTitle(step, lang);
}

function stepLabel(step: TurnStep, lang: TurnLanguage): string {
  const subject = stepSubject(step);
  return subject ? `${stepTitle(step, lang)} · ${subject}` : stepTitle(step, lang);
}

/**
 * The running turn, or null when none runs. Its progress messages are the ones after the last
 * answer before the live bubble: an earlier turn's never speak for this one.
 */
export function liveActivity(messages: readonly ActivityMessage[], now: number, lang: TurnLanguage): LiveActivity | null {
  const liveIndex = messages.findIndex((message) => message.id === STREAMING_ID);
  const live = messages[liveIndex];
  if (!live) return null;
  let turnStart = 0;
  for (let index = liveIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && !message.progress) {
      turnStart = index + 1;
      break;
    }
  }
  const turn = messages.slice(turnStart, liveIndex);
  const question = turn.find((message) => message.role === "user");
  const progress = turn.filter((message) => message.progress && message.content.trim()).at(-1);

  const steps = stepsFor(live).filter((step) => !isQuietStep(step));
  const tools = steps.filter((step) => step.kind === "tool");
  const note = steps.filter((step) => step.kind === "note" && step.text?.trim()).at(-1);
  // The newer of the two speaks: a narration line after the last progress message is what the
  // turn is doing now. A note reconstructed without a time never outranks a message that has one.
  const noteIsNewer = note && (!progress || note.startedAt > progress.timestamp.getTime());
  const headline = (noteIsNewer ? note.text!.trim() : progress?.content.trim())
    || live.statusText?.trim()
    || turnText.working(lang);

  const running = tools.filter((step) => step.status === "running").at(-1);
  const startedAt = question?.timestamp.getTime() ?? live.timestamp.getTime();
  return {
    messageId: live.id,
    headline,
    ...(running
      ? { current: { stepId: running.id, label: stepLabel(running, lang), duration: formatDuration(stepDurationMs(running, now)) } }
      : {}),
    satellites: tools.slice(-MAX_SATELLITES).map((step) => ({
      id: step.id,
      status: displayStatus(step),
      nested: step.depth === 1,
      label: stepLabel(step, lang),
      short: stepShort(step, lang),
      duration: formatDuration(stepDurationMs(step, now)),
    })),
    elapsed: formatDuration(Math.max(0, now - startedAt)),
  };
}

export interface OrbitGeometry {
  /** Half-axes of the ring as it is seen: wide, and flattened by its tilt. */
  rx: number;
  ry: number;
  /** The orb's bright core: a satellite behind it is mostly hidden. */
  coreRadius: number;
}

export interface OrbitPoint {
  x: number;
  y: number;
  /** 1 nearest the viewer, -1 farthest. */
  depth: number;
  scale: number;
  opacity: number;
}

/** Slots on the ring: at least this many, so a few steps do not spread round the whole orb. */
const MIN_SLOTS = 7;

/** OrbCanvas.vue's camera: 60° vertical field of view from distance 5, the orb group scaled 0.42. */
const CAMERA_Z = 5;
const ORB_SCALE = 0.42;
const BASE_HALF_TAN = Math.tan(Math.PI / 6);
/** The orb's particle torus reaches this radius, in the orb's own units. */
const TORUS_RADIUS = 1.9;
/** The step ring is tipped this far from edge-on: seen from the front it is about 0.28 as tall as wide. */
const RING_TILT = Math.asin(0.28);

/** How far the particle torus reaches on the page, as a share of the window's height (≈ 0.138). */
export const TORUS_SCREEN_SHARE = TORUS_RADIUS * ORB_SCALE / CAMERA_Z / BASE_HALF_TAN / 2;

/** The torus's reach in pixels for a window: below an aspect of 0.4 the canvas widens its view and the orb shrinks. */
export function torusPixels(width: number, height: number): number {
  return TORUS_SCREEN_SHARE * height * Math.min(1, width / height / 0.4);
}

/**
 * The step ring as the orb canvas draws it: one strip of the Dyson shell around the orb, in the
 * orb's own units. The page puts the steps on it with the same camera (projectOrbPoint), so they
 * sit on the strip and not beside it.
 */
export interface ActivityRing {
  /** Radius in orb units: the particle torus reaches 1.9. */
  radius: number;
  /** How far the ring is tipped towards the viewer from edge-on, in radians; its front is below the orb. */
  tilt: number;
}

/** The step ring for a viewport: as wide on screen as orbitGeometry's ring, in orb units. */
export function activityRing(width: number, height: number, freeHalf = Infinity): ActivityRing {
  return { radius: orbitGeometry(width, height, freeHalf).rx / torusPixels(width, height) * TORUS_RADIUS, tilt: RING_TILT };
}

/** Where the ring passes at `angle`, in orb units: π/2 is its front, nearest the viewer and below the orb. */
export function ringPosition(angle: number, ring: ActivityRing): [number, number, number] {
  return [
    ring.radius * Math.cos(angle),
    -ring.radius * Math.sin(angle) * Math.sin(ring.tilt),
    ring.radius * Math.sin(angle) * Math.cos(ring.tilt),
  ];
}

/**
 * A point of the orb's space on the page, as OrbCanvas's camera sees it: pixels from the viewport's
 * centre, y downwards, and how much nearer than the orb's centre it is (1 at the centre's depth).
 * Below an aspect of 0.4 the canvas widens its field of view, as here.
 */
export function projectOrbPoint(point: readonly [number, number, number], width: number, height: number): { x: number; y: number; scale: number } {
  const halfTan = BASE_HALF_TAN * Math.max(1, 0.4 / (width / height));
  const distance = CAMERA_Z - point[2] * ORB_SCALE;
  const focal = height / 2 / halfTan;
  return {
    x: point[0] * ORB_SCALE / distance * focal,
    y: -point[1] * ORB_SCALE / distance * focal,
    scale: CAMERA_Z / distance,
  };
}

export interface OrbitView {
  ring: ActivityRing;
  width: number;
  height: number;
  /** The orb's bright core on the page, in pixels: a satellite behind it is mostly hidden. */
  coreRadius: number;
}

/**
 * Where satellite `index` of `count` (0 the oldest) sits on the step ring: the newest nearest the
 * viewer, below the orb, and each older one a slot further round, away and up behind it. `turn`
 * adds a small sway (radians) so the ring is not frozen.
 */
export function orbitPoint(index: number, count: number, view: OrbitView, turn = 0): OrbitPoint {
  const age = count - 1 - index;
  const angle = Math.PI / 2 + age * (2 * Math.PI / Math.max(count, MIN_SLOTS)) + turn;
  const depth = Math.sin(angle);
  const { x, y } = projectOrbPoint(ringPosition(angle, view.ring), view.width, view.height);
  const near = (depth + 1) / 2;
  const behindCore = depth < 0 && Math.abs(x) < view.coreRadius;
  return {
    x,
    y,
    depth,
    scale: 0.55 + 0.45 * near,
    opacity: (0.3 + 0.7 * near) * (behindCore ? 0.35 : 1),
  };
}

/**
 * The ring's size for a viewport, matched to the orb (components/OrbCanvas.vue): its camera sees
 * the canvas height at a 60° field of view from distance 5, the orb group is scaled 0.42, and its
 * particle torus reaches radius 1.9 — TORUS_SCREEN_SHARE of the height. Below an aspect of 0.4 the field
 * of view widens, and the orb shrinks with it.
 */
export function orbitGeometry(width: number, height: number, freeHalf = Infinity): OrbitGeometry {
  const torus = torusPixels(width, height);
  // Outside the particle field, but inside the band the messages leave free (a label is about
  // LABEL_HALF wide either side of its point), and never inside the torus itself.
  const rx = Math.max(torus * 1.05, Math.min(torus * 1.5, freeHalf - LABEL_HALF));
  return { rx, ry: rx * 0.28, coreRadius: torus * 0.55 };
}

/** Half a satellite label's width, for fitting the ring between the messages. */
export const LABEL_HALF = 105;

/**
 * Whether a satellite at `x` from the centre can show its label without reaching into the
 * messages. Out at the ring's sides on a small window it cannot; it stays a point, its label
 * shown on hover.
 */
export function labelFits(x: number, freeHalf: number): boolean {
  return Math.abs(x) + LABEL_HALF <= freeHalf;
}

/** A label as drawn: centred under its point, its width from its text, all of it scaled with depth. */
export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  scale: number;
  text: string;
}

/**
 * Which of the candidates show their label, nearest first: one that would cover a label already
 * placed stays a point. On a small window the ring is tight, and the front step's label lay across
 * the one beside it ("Read a web page · arxiv.org" over "Looked for the right specialist").
 */
export function placeLabels(candidates: readonly LabelCandidate[]): Set<string> {
  const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const shown = new Set<string>();
  for (const label of candidates) {
    const width = Math.min(2 * LABEL_HALF, label.text.length * 6.5 + 18) * label.scale;
    const top = label.y + 11 * label.scale;
    const box = { left: label.x - width / 2, right: label.x + width / 2, top, bottom: top + 20 * label.scale };
    const covers = placed.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
    if (covers) continue;
    placed.push(box);
    shown.add(label.id);
  }
  return shown;
}

/**
 * Half the width the messages leave free around the centre, as the chat page lays them out
 * (pages/Chat.vue, from 1100 px): each bubble at its outer edge, ending at the orb's zone
 * (24vh + 1.5rem from the centre) but never narrower than 28rem nor wider than 52rem.
 */
export function freeHalfWidth(width: number, height: number, rem = 16): number {
  if (width < 1100) return 0;
  const inset = 1.25 * rem;
  const clear = 0.24 * height + 1.5 * rem;
  const row = width - 2 * inset;
  const bubble = Math.min(52 * rem, Math.max(28 * rem, row / 2 - clear));
  return width / 2 - inset - bubble;
}
