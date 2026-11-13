// The hologram sphere round the core, in the orb's own 3D space: an instrument drawn in hairlines
// of light, and kept sparse — the core is the heart of the orb, and a crowd of rings round it
// stole the show. A globe cage of meridians and parallels turns about its pole; two discs and a
// rim stand in it at different leans and tumble slowly like gimbals; one quiet band runs close
// round the core. The rings are plain arcs with points of light running along them, graduated
// scales, rails with ties, tracks of broken parallel lines, bands of moving blocks and crenellated
// lines; most are partial arcs.
//
// The sphere is a cage: inside it lives the orb's breathing body, a cloud of dust round the core
// (shaders/dustParticles.ts) that swells towards the cage on every breath and settles back, and
// hangs in the cage's own frames. The sphere does not pulse by itself either: the crest of light
// that leaves the core on every breath (shaders/breath.ts) passes through the dust and the rings
// from the inside out.
//
// While a turn runs, a track of the same make assembles round the whole orb: the step ring, which
// the steps on the page ride on (composables/orbActivity.ts draws them with the same camera). It
// sits out past the orbits, where its steps' labels have room.
//
// Each ring is a flat annulus mesh; the fragment shader draws it from the ring's own polar
// coordinates. Line widths are measured in pixels (screen-space derivatives), so a line stays a
// hairline however small the orb is drawn and however far a ring is tipped from the viewer;
// detail the pixels cannot resolve fades out instead of merging into a smear, and on a small orb
// the minor rings step back altogether.
import { BREATH_WAVE } from "./breath";

/** What a ring draws. The shader's `uKind` is the index in this list. */
export const HUD_RING_KINDS = ["hair", "rail", "scale", "dash", "teeth", "tracks"] as const;
export type HudRingKind = (typeof HUD_RING_KINDS)[number];

export interface HudRingSpec {
  kind: HudRingKind;
  /** The circle's radius in the mesh's own units: orb units for the sphere, 1 for the step ring. */
  radius: number;
  /**
   * The kind's own measure, same units: a rail's or the tracks' half gauge, a scale's longest
   * mark, a band's or a tooth's height.
   */
  width: number;
  /** How far the circle's plane sits from the centre along its normal: 0 is a great circle, anything else a parallel. */
  offset: number;
  /** The plane's normal, in the frame the ring hangs in. */
  normal: [number, number, number];
  /** Which frame (SPHERE_FRAMES) carries the ring. */
  frame: number;
  /** How far the plane sways about its normal, radians. */
  wobble: number;
  /** Spin around the ring's own axis, radians per second at rest. */
  spin: number;
  /** How fast what travels along the ring moves, turns per second. */
  flow: number;
  /** Phase offset, so rings do not repeat each other. */
  seed: number;
  /** The share of the circle that is drawn. */
  arc: number;
  /** Ties, marks, blocks, teeth or track segments round the full circle; for a hair, the points of light on it. */
  tiles: number;
  /** Peak brightness. */
  strength: number;
  /** Line weight in hairlines: 1 unless the ring is one of the bold ones. */
  weight?: number;
  /** A minor ring is only drawn where the orb is large enough to hold the detail. */
  minor?: boolean;
  /** How far the colour runs towards white-hot. */
  hot?: number;
  /**
   * The ring's share of the dust's colours when the orb's state lets its lines take them (the
   * shader's uTint): absent or 0 keeps the core's colour, 1 is all the dust's.
   */
  tint?: number;
}

/** A frame the rings hang in: it turns about its pole, and the pole itself tumbles about an axis. */
export interface HudFrame {
  pole: [number, number, number];
  /** Radians per second at rest. */
  speed: number;
  tumbleAxis: [number, number, number];
  tumbleSpeed: number;
}

const DISC_FRAMES: readonly number[] = [0, 1];
const RIM_FRAME = 2;
export const OUTER_GLOBE = 3;
export const LOOSE_FRAME = 4;
/** The two discs, the rim, the globe tipped like a planet, and the loose arcs. All of it slow. */
export const SPHERE_FRAMES: readonly HudFrame[] = [
  { pole: [0.22, 0.9, 0.38],   speed: 0,    tumbleAxis: [1, 0, 0.3],   tumbleSpeed: 0.03 },
  { pole: [0.8, 0.3, 0.52],    speed: 0,    tumbleAxis: [0, 1, 0],     tumbleSpeed: 0.04 },
  { pole: [-0.55, 0.45, 0.7],  speed: 0,    tumbleAxis: [0.3, 0.2, 1], tumbleSpeed: -0.035 },
  { pole: [0.36, 0.84, 0.41],  speed: 0.07, tumbleAxis: [0, 0, 1],     tumbleSpeed: 0.015 },
  { pole: [0, 1, 0],           speed: 0.04, tumbleAxis: [1, 0, 0],     tumbleSpeed: -0.02 },
];

/** The sphere keeps clear of the core's own sphere of points (0.4) and of the first orbit (1.45). */
export const SPHERE_INNER = 0.5;
export const SPHERE_OUTER = 1.28;
/** The globe cage's radius: what the orb's breathing body stays inside of. */
export const GLOBE_RADIUS = 1.06;

interface KindLook { width: number; arc: [number, number]; perRadius: number; strength: number }
const LOOK: Record<HudRingKind, KindLook> = {
  hair:   { width: 0,     arc: [0.4, 0.95],  perRadius: 0,  strength: 1.3 },
  rail:   { width: 0.03,  arc: [0.25, 0.6],  perRadius: 30, strength: 1.3 },
  scale:  { width: 0.075, arc: [0.55, 1],    perRadius: 60, strength: 1.4 },
  dash:   { width: 0.026, arc: [0.45, 0.9],  perRadius: 24, strength: 1.5 },
  teeth:  { width: 0.034, arc: [0.2, 0.5],   perRadius: 36, strength: 1.3 },
  tracks: { width: 0.06,  arc: [0.35, 0.75], perRadius: 9,  strength: 1.3 },
};

/** A small seeded generator: the sphere is the same sphere on every load. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tilesFor(kind: HudRingKind, radius: number, rand: () => number): number {
  if (kind === "hair") return Math.floor(rand() * 3);
  const count = Math.max(6, Math.round(LOOK[kind].perRadius * radius));
  return kind === "scale" ? Math.round(count / 5) * 5 : count;
}

interface DiscRing { kind: HudRingKind; radius: number; weight?: number; minor?: boolean }

/** One disc: concentric rings in one plane, each turning against its neighbour. */
function disc(frame: number, rings: readonly DiscRing[], rand: () => number): HudRingSpec[] {
  return rings.map(({ kind, radius, weight, minor }, i) => {
    const look = LOOK[kind];
    return {
      kind, radius, width: look.width, offset: 0, frame, normal: [0, 0, 1], wobble: 0,
      spin: (i % 2 ? -1 : 1) * (0.04 + 0.12 * rand()),
      flow: (rand() < 0.5 ? -1 : 1) * (0.02 + 0.04 * rand()),
      seed: 10 * rand(),
      arc: look.arc[0] + (look.arc[1] - look.arc[0]) * rand(),
      tiles: tilesFor(kind, radius, rand),
      strength: look.strength * (0.85 + 0.3 * rand()),
      ...(weight ? { weight } : {}),
      ...(minor ? { minor } : {}),
    };
  });
}

/** Loose hairline arcs between the discs, each leaning its own way; out in the sphere's outer half, away from the core. */
function loose(count: number, rand: () => number): HudRingSpec[] {
  return Array.from({ length: count }, (_, i): HudRingSpec => {
    const z = 2 * rand() - 1;
    const turn = 2 * Math.PI * rand();
    const flat = Math.sqrt(1 - z * z);
    return {
      kind: "hair", width: 0, offset: 0, frame: LOOSE_FRAME,
      radius: 0.9 + (SPHERE_OUTER - 0.94) * (i / Math.max(1, count - 1)),
      normal: [flat * Math.cos(turn), flat * Math.sin(turn), z],
      wobble: 0.03 + 0.04 * rand(),
      spin: (rand() < 0.5 ? -1 : 1) * (0.08 + 0.2 * rand()),
      flow: 0.03 + 0.05 * rand(),
      seed: 10 * rand(),
      arc: 0.25 + 0.4 * rand(),
      tiles: 1 + Math.floor(rand() * 2),
      strength: LOOK.hair.strength * 0.8,
      minor: true,
    };
  });
}

interface Parallel { kind: HudRingKind; degrees: number; arc: number; minor?: boolean }

/**
 * The globe cage: parallels (circles of latitude round the frame's pole) and meridians (half great
 * circles from pole to pole, every other one a minor ring), each sliding along its own circle.
 */
function globe(frame: number, radius: number, parallels: readonly Parallel[], meridianCount: number, rand: () => number): HudRingSpec[] {
  const circles = parallels.map(({ kind, degrees, arc, minor }): HudRingSpec => {
    const latitude = (degrees * Math.PI) / 180;
    const circle = radius * Math.cos(latitude);
    return {
      kind, radius: circle, width: LOOK[kind].width, offset: radius * Math.sin(latitude), frame,
      normal: [0, 0, 1], wobble: 0, spin: 0.04 + 0.1 * rand(), flow: 0.03 + 0.03 * rand(), seed: 10 * rand(),
      arc, tiles: tilesFor(kind, circle, rand), strength: LOOK[kind].strength * 0.9,
      ...(minor ? { minor } : {}),
    };
  });
  const meridians = Array.from({ length: meridianCount }, (_, i): HudRingSpec => {
    const turn = (i * Math.PI) / meridianCount;
    const kind: HudRingKind = i % 4 === 2 ? "rail" : "hair";
    return {
      kind, radius, width: LOOK[kind].width, offset: 0, frame,
      normal: [-Math.sin(turn), Math.cos(turn), 0], wobble: 0,
      spin: (i % 2 ? -1 : 1) * (0.05 + 0.07 * rand()), flow: 0.03 + 0.04 * rand(), seed: 10 * rand(),
      arc: kind === "rail" ? 0.3 : 0.38 + 0.14 * rand(), tiles: tilesFor(kind, radius, rand),
      strength: LOOK[kind].strength * 0.8,
      ...(i % 2 ? { minor: true } : {}),
    };
  });
  return [...circles, ...meridians];
}

/**
 * The whole sphere, the same on every load. Few rings, and fewest near the core: the cage and the
 * gimbals stand out at the sphere's own radius and leave the core its room.
 */
export function buildSphereRings(seed = 20261112): HudRingSpec[] {
  const rand = seeded(seed);
  return tinted([
    ...globe(OUTER_GLOBE, GLOBE_RADIUS, [
      { kind: "scale", degrees: 0, arc: 1 },
      { kind: "dash", degrees: 40, arc: 0.75 }, { kind: "hair", degrees: -40, arc: 0.7 },
      { kind: "hair", degrees: 64, arc: 0.9, minor: true }, { kind: "teeth", degrees: 78, arc: 1 },
    ], 6, rand),
    // Close round the core: one quiet band, in the globe's own equator.
    ...disc(OUTER_GLOBE, [{ kind: "dash", radius: 0.56 }], rand),
    ...disc(DISC_FRAMES[0]!, [
      { kind: "hair", radius: 0.76 }, { kind: "tracks", radius: 0.92, minor: true }, { kind: "hair", radius: 1.2, weight: 1.5 },
    ], rand),
    ...disc(DISC_FRAMES[1]!, [
      { kind: "scale", radius: 0.88 }, { kind: "hair", radius: 1.25, weight: 1.5 },
    ], rand),
    ...disc(RIM_FRAME, [
      { kind: "scale", radius: 1.15, minor: true }, { kind: "hair", radius: SPHERE_OUTER - 0.01 },
    ], rand),
    ...loose(2, rand),
  ], seed);
}

/**
 * Which rings take the dust's colours while the orb works: about half of them, some wholly and
 * some half-way, the rest staying in the core's colour. All of them in the core's white, the
 * working orb was one blaze round a body of yellow dust; with some of its lines in that yellow it
 * is one thing again. The shares come from a generator of their own, so the sphere is laid out as
 * it was.
 */
function tinted(rings: HudRingSpec[], seed: number): HudRingSpec[] {
  const rand = seeded((seed ^ 0x5bd1e995) >>> 0);
  return rings.map((ring) => {
    const draw = rand();
    if (draw < 0.45) return ring;
    return { ...ring, tint: draw < 0.7 ? 0.55 : 1 };
  });
}

export const SPHERE_RINGS: readonly HudRingSpec[] = buildSphereRings();

/**
 * The step ring: a rail the steps ride on (radius 1 is where the page puts them), a graduated
 * scale outside it and a band of moving blocks inside, all built round the circle as a turn starts.
 */
export const STEP_RINGS: readonly HudRingSpec[] = [
  { kind: "rail",  radius: 1,     width: 0.016, offset: 0, normal: [0, 0, 1], frame: 0, wobble: 0, spin: 0.05,  flow: 0,     seed: 11.4, arc: 1, tiles: 120, strength: 1.7, hot: 0.5 },
  // The rail the steps ride on stays in the core's colour; its scale and its blocks take the dust's.
  { kind: "scale", radius: 1.05,  width: 0.026, offset: 0, normal: [0, 0, 1], frame: 0, wobble: 0, spin: -0.03, flow: 0.04,  seed: 12.7, arc: 1, tiles: 180, strength: 1.1, hot: 0.3, tint: 1 },
  { kind: "dash",  radius: 0.955, width: 0.012, offset: 0, normal: [0, 0, 1], frame: 0, wobble: 0, spin: 0.02,  flow: 0.025, seed: 13.9, arc: 1, tiles: 48,  strength: 1.5, hot: 0.4, tint: 0.55 },
];

export const hudRingVertexShader = `
  uniform float uSphere;   // the radius of the sphere the ring lies on
  uniform float uOffset;   // how far the ring's plane sits from that sphere's centre
  varying vec2  vLocal;    // the point in the ring's own plane
  varying float vNear;     // 0 on the far side of the sphere, 1 on the near side
  varying float vFacing;   // 0 for a ring seen edge-on, 1 for one seen flat

  void main() {
    vLocal = position.xy;
    vec4 mv     = modelViewMatrix * vec4(position, 1.0);
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, -uOffset, 1.0);
    // The sphere's radius as the camera sees it, whatever the mesh and the orb are scaled by.
    float seen  = length((modelViewMatrix * vec4(uSphere, 0.0, 0.0, 0.0)).xyz);
    // The camera looks down -z: a point nearer to it has the larger z.
    vNear = clamp((mv.z - centre.z) / seen * 0.5 + 0.5, 0.0, 1.0);
    vec3 axis = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
    vFacing = abs(dot(axis, normalize(mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;

export const hudRingFragmentShader = `${BREATH_WAVE}
  uniform vec3  uCoreColor;
  uniform float uIntensity;
  uniform float uGlowPhase;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uStrength;
  uniform float uKind;       // index in HUD_RING_KINDS
  uniform float uTiles;
  uniform float uArc;        // the share of the circle that is drawn
  uniform float uSeed;
  uniform float uAssemble;   // how far the ring is built, 0..1 of its arc
  uniform float uHot;        // extra white-hot share
  uniform float uLinePx;     // a hairline's width in pixels
  uniform float uWeight;     // this ring's line weight, in hairlines
  uniform float uThin;       // what a hairline keeps of its brightness where it should be under a pixel wide
  uniform float uDetail;     // how much of the minor rings the orb's size can hold, 0..1
  uniform float uMinor;      // 1 for a minor ring
  uniform float uFlow;       // where what travels along the ring is, in turns
  uniform float uBreath;     // the entity's breath
  uniform float uWaveRadius; // how far from the orb's centre the ring is, in orb units
  uniform vec3  uTintNear;   // the dust's colour on the side nearest the viewer (shaders/dustParticles.ts)
  uniform vec3  uTintFar;    // and on the far side
  uniform float uTint;       // how far the orb's state lets its lines take the dust's colours
  uniform float uTintShare;  // this ring's own share of that

  varying vec2  vLocal;
  varying float vNear;
  varying float vFacing;

  const float TAU = 6.28318530718;

  float hash(float n) {
    return fract(sin(n * 12.9898 + uSeed * 78.233) * 43758.5453);
  }
  // A stroke: d is the distance to its centre line, px the size of one pixel, both in the ring's
  // own units; the anti-aliasing straddles the edge, so the line is as wide as it says.
  float stroke(float d, float px) {
    float reach = 0.5 * uLinePx * uWeight * px;
    return 1.0 - smoothstep(reach - 0.5 * px, reach + 0.5 * px, abs(d));
  }
  // A point of light, size hairlines across.
  float spark(vec2 p, float px, float size) {
    float d = length(vLocal - p) / (px * uLinePx * size);
    return exp(-d * d);
  }
  vec2 onCircle(float turn) {
    return uRadius * vec2(cos(turn * TAU), sin(turn * TAU));
  }

  void main() {
    float r     = max(length(vLocal), 0.00001);
    vec2  out_  = vLocal / r;
    vec2  along = vec2(-out_.y, out_.x);
    vec2  dx    = dFdx(vLocal);
    vec2  dy    = dFdy(vLocal);
    float pxR   = max(length(vec2(dot(dx, out_), dot(dy, out_))), 0.00001);    // one pixel across the ring
    float pxT   = max(length(vec2(dot(dx, along), dot(dy, along))), 0.00001);  // one pixel along it
    float pxMax = max(pxR, pxT);
    float pos   = fract(atan(vLocal.y, vLocal.x) / TAU + 1.0);
    float off   = r - uRadius;

    // The arc: a partial one breathes slowly, is brightest at its leading end and thins out
    // towards its tail; a ring being built grows round the circle up to uAssemble.
    float live  = uArc < 0.97 ? 1.0 - 0.12 * (0.5 + 0.5 * sin(uGlowPhase * 0.21 + uSeed * 3.0)) : 1.0;
    float arc   = clamp(uArc * live * uAssemble, 0.0, 1.0);
    float whole = smoothstep(0.97, 0.999, arc);
    float edge  = 1.5 * pxT / (TAU * r);
    float part  = smoothstep(0.0, edge, pos) * (1.0 - smoothstep(arc - edge, arc, pos));
    float inArc = mix(part, 1.0, whole);
    float taper = mix(mix(0.5, 1.0, clamp(pos / max(arc, 0.0001), 0.0, 1.0)), 1.0, smoothstep(0.85, 0.999, arc));

    float cell    = pos * uTiles;
    float idx     = floor(cell);
    float f       = fract(cell);
    float tileLen = TAU * r / max(uTiles, 1.0);   // one tile along the circle, in ring units
    // Marks, ties and teeth closer together than a few pixels would merge into a solid band:
    // they fade out where the ring is too small or too foreshortened to show them.
    float fine    = smoothstep(2.5, 5.0, tileLen / pxT);

    float lum      = 0.0;
    float glowAt   = abs(off);
    float glowGate = 1.0;
    if (uKind < 0.5) {
      // hair: one line, points of light running along it
      lum = stroke(off, pxR);
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        if (fk < uTiles) {
          float t = fract(uFlow + fk / max(uTiles, 1.0) + hash(fk + 3.0));
          lum += 1.5 * spark(onCircle(t * arc), pxMax, 1.6);
        }
      }
    } else if (uKind < 1.5) {
      // rail: two lines and the ties between them
      float between = 1.0 - smoothstep(uWidth, uWidth + pxR, abs(off));
      float tie     = stroke((f - 0.5) * tileLen, pxT) * between;
      lum    = stroke(abs(off) - uWidth, pxR) + 0.5 * tie * fine + 0.05 * between;
      glowAt = abs(abs(off) - uWidth);
    } else if (uKind < 2.5) {
      // scale: a line with graduation marks inside it, every fifth one longer, and a reading
      // head going round that lights the marks it passes
      float major  = step(mod(idx, 5.0), 0.5);
      float len    = uWidth * (0.45 + 0.55 * major);
      float inMark = step(-len, off) * step(off, 0.0);
      float head   = smoothstep(0.86, 1.0, fract(pos - uFlow));
      float mark   = stroke((f - 0.5) * tileLen, pxT) * inMark;
      lum = stroke(off, pxR) + mark * mix(major, 1.0, fine) * (0.45 + 0.35 * major + 1.4 * head);
    } else if (uKind < 3.5) {
      // dash: blocks of uneven length moving along a thin band
      float moved = cell + uFlow * uTiles;
      float id    = floor(moved);
      float g     = fract(moved);
      float len   = 0.25 + 0.6 * hash(id);
      float e     = pxT / max(tileLen, 0.00001);
      float lit   = step(hash(id + 17.0), 0.72) * smoothstep(0.0, e, g) * (1.0 - smoothstep(len - e, len, g));
      float reach = max(0.5 * uWidth, 0.5 * uLinePx * pxR);
      lum      = (1.0 - smoothstep(reach - 0.5 * pxR, reach + 0.5 * pxR, abs(off))) * lit * (0.5 + 0.5 * hash(id + 5.0));
      glowGate = lit;
    } else if (uKind < 4.5) {
      // teeth: a crenellated line
      float top     = uWidth * step(f, 0.5) * fine;
      float inTooth = step(0.0, off) * step(off, uWidth);
      float sides   = stroke(f * tileLen, pxT) + stroke((f - 0.5) * tileLen, pxT) + stroke((f - 1.0) * tileLen, pxT);
      lum    = stroke(off - top, pxR) + sides * inTooth * fine;
      glowAt = abs(off - top);
    } else {
      // tracks: four parallel lines, each broken into its own segments, sliding against each
      // other; where the pixels cannot hold four lines apart, the outer two stand for all
      float gap    = uWidth * 2.0 / 3.0;
      float lane   = clamp(floor((off + uWidth) / gap + 0.5), 0.0, 3.0);
      float toLane = off + uWidth - lane * gap;
      float way    = mod(lane, 2.0) < 0.5 ? 1.0 : -1.0;
      float seg    = floor(cell + lane * 7.3 + way * uFlow * uTiles);
      float lit    = step(hash(seg + lane * 31.0), 0.68);
      float apart  = smoothstep(1.8, 3.5, gap / pxR);
      float outer  = step(abs(lane - 1.5), 1.0) < 0.5 ? 1.0 : 0.0;
      lum      = stroke(toLane, pxR) * lit * mix(outer, 1.0, apart);
      glowAt   = abs(toLane);
      glowGate = lit * mix(outer, 1.0, apart);
    }

    // A soft halo round every line, and a point of light at each end of a partial arc.
    float glow = exp(-glowAt / (pxR * uLinePx * uWeight * 2.0)) * 0.1 * glowGate;
    float ends = (1.0 - whole) * step(0.002, arc)
               * (1.5 * spark(onCircle(arc), pxMax, 1.7) + 0.8 * spark(onCircle(0.0), pxMax, 1.3));
    lum = (lum + glow) * inArc * taper + ends;

    // The breath's crest lights the ring as it passes on its way out from the core.
    float pulse   = 0.9 + 0.5 * breathCrest(uBreath, uWaveRadius);
    float flicker = 1.0 + 0.04 * sin(uGlowPhase * 9.7 + uSeed) * sin(uGlowPhase * 23.3);
    // Near side bright, far side receding — the same depth cue the orbits use.
    float depth   = 0.25 + 0.95 * vNear;
    // A ring seen edge-on collapses into one line with both its halves and its halo on top of
    // each other: it dims as it turns edge-on, so it stays a hairline and not a bar of light.
    float flatness = mix(0.3, 1.0, smoothstep(0.03, 0.3, vFacing));
    lum *= uStrength * uIntensity * pulse * flicker * depth * flatness * uThin * mix(1.0, uDetail, uMinor);

    // A ring with a share of the dust's colours is graded like the dust, from its near colour to
    // its far one round the sphere, and runs less towards white-hot: the colour is the point.
    float tint = clamp(uTint * uTintShare, 0.0, 1.0);
    vec3 dust  = mix(uTintFar, uTintNear, pow(vNear, 1.2));
    vec3 base  = mix(uCoreColor, dust, tint);
    vec3 hot   = mix(base, vec3(1.0), 0.6);
    vec3 col   = (base + hot * (0.15 + uHot) * (1.0 - 0.75 * tint)) * lum;
    // Additive blending scales the colour by alpha. With the brightness as alpha and the colour
    // left as it is, a line counted its brightness twice and came out faint; alpha 1 made the
    // transparent canvas opaque along every ring, a black band over the page. So alpha stays the
    // brightness, and the colour is divided by it to be added once.
    float alpha = clamp(lum, 0.0, 1.0);
    gl_FragColor = vec4(col / max(alpha, 0.001), alpha);
  }
`;
