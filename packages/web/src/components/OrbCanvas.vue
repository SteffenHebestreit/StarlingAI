<template>
  <!-- Static radial-gradient stand-in shown when WebGL is unavailable, so the
       decorative orb slot never renders as a blank hole. -->
  <div
    v-if="webglUnavailable"
    aria-hidden="true"
    style="width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 45%, rgba(148,163,255,0.35), rgba(88,101,242,0.12) 45%, transparent 70%);"
  />
  <canvas v-show="!webglUnavailable" ref="canvasEl" style="display:block;width:100%;height:100%;" />
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import * as THREE from "three";
import { vertexShader as torusVS, fragmentShader as torusFS } from "./shaders/torusParticles";
import { vertexShader as sphereVS, fragmentShader as sphereFS } from "./shaders/neuralSphereParticles";
import {
  orbitalVertexShader, orbitalFragmentShader,
  coreGlowVertexShader, coreGlowFragmentShader,
} from "./shaders/orbitalSystem";
import { ambientVertexShader, ambientFragmentShader } from "./shaders/ambientSystem";

const props = withDefaults(defineProps<{ aiState?: string }>(), { aiState: "default" });

// ─── Constants (matching original Orb.jsx) ────────────────────────────────────
// Main cloud: full particle density spread over double the old reach, with
// smaller points (see torusParticles gl_PointSize) — a fine, wide mist
// rather than a dense fuzz hugging the core.
const PARTICLE_COUNT          = 2400;
const OUTER_RADIUS            = 1.9;
const INNER_RADIUS            = 0.6;
const PORTAL_DEPTH            = 1.0;
const Z_DRIFT_SPEED           = 0.1;
const SNAKE_EYE_SCALE_X       = 0.8;
const SNAKE_EYE_SCALE_Y       = 1.35;
const RADIAL_WAVE_SPEED       = 0.75;
const Z_WAVE_SPEED            = 0.6;
// Default palette follows the Jarvis HUD reference: bright hologram cyan
// line-work fading into deep teal-blue, instead of the old cyan→violet.
const COLOR_NEAR              = new THREE.Color("#35d8ff").multiplyScalar(1.5);
const COLOR_FAR               = new THREE.Color("#0a5a78").multiplyScalar(1.3);
const BASE_BREATHE_SPEED      = 0.5;
const BASE_PARTICLE_OPACITY   = 0.9;

const NUM_NODES               = 10;
const PULSE_COLOR             = new THREE.Color(0xffffff);
const PULSE_SPEED             = 2.5;
// 2.25× the doubled OUTER_RADIUS keeps the same absolute pulse reach the
// old 4.5 × 0.95 gave — pulses must not overshoot the ambient star shell.
const PULSE_MAX_TRAVEL_RADIUS = OUTER_RADIUS * 2.25;
const MAX_ACTIVE_PULSES       = 9;
const PULSE_INTERVAL_MIN      = 0.5;
const PULSE_INTERVAL_MAX      = 2.0;

const NS_RADIUS               = 0.4;
const NS_COUNT                = 400;
const NS_BASE_COLOR           = new THREE.Color(0x7dd3fc).multiplyScalar(1.4);
const NS_ACTIVITY_COLOR       = new THREE.Color(0xffffff);
const NS_ERROR_COLOR          = new THREE.Color(0xff3333).multiplyScalar(1.3);
const NS_OUTPUT_COLOR         = new THREE.Color(0x33ff66).multiplyScalar(1.5);
const NS_WAITING_COLOR        = new THREE.Color(0xdd66ff).multiplyScalar(1.3);
const NS_BASE_OPACITY         = 0.9;
const NS_ACTIVITY_OPACITY     = 1.0;
const NS_ERROR_OPACITY        = 0.7;
const NS_OUTPUT_OPACITY       = 1.0;
const NS_BASE_PULSE           = 0.12;
const NS_ACTIVITY_PULSE       = 0.25;
const NS_ERROR_PULSE          = 0.06;
const NS_OUTPUT_PULSE         = 0.3;
const NS_PULSE_SPEED          = 1.2;
const NS_SHIMMER_SPEED        = 1.8;
const NS_ROTATION_SPEED       = 0.41;
const TRANSITION_DURATION     = 1.37;

// Orbital system (solar-system layer): per orbit — dust, planets + trails,
// a static tick track, and solar-wind streams connecting it to the core.
const RING_COUNT              = 3;
const DUST_PER_RING           = 220;
const PLANETS_PER_RING        = 2;
const TRAIL_PER_PLANET        = 26;
const TRACKS_PER_RING         = 88;
const WIND_PER_RING           = 90;
const ARCS_PER_RING           = 2;
const ARC_POINTS              = 60;
const ORBITAL_COUNT           = RING_COUNT * (
  DUST_PER_RING + PLANETS_PER_RING * (1 + TRAIL_PER_PLANET) + TRACKS_PER_RING + WIND_PER_RING
  + ARCS_PER_RING * ARC_POINTS
);
const GLOW_PULSE_SPEED        = 1.7;
// One coherent breath for the whole entity (~8s calm cycle); every layer
// swells and settles together so it reads as a single living organism.
const ENTITY_BREATH_SPEED     = 0.78;

// Ambient environment (starfield / shooting stars)
const STAR_COUNT              = 380;
const SHOOT_TRAIL_COUNT       = 22;
const AMBIENT_COUNT           = STAR_COUNT + SHOOT_TRAIL_COUNT;
const STAR_ROTATION_SPEED     = 0.008;
const SHOOT_DURATION          = 1.1;

// Honor the OS-level animation preference: slow the whole entity down and
// skip the shooting stars instead of disabling the canvas outright.
const REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const MOTION_SCALE = REDUCED_MOTION ? 0.35 : 1;

// Scale factor applied to the whole orb group
const ORB_SCALE               = 0.42;

// ─── Visual state ─────────────────────────────────────────────────────────────
interface VisualState {
  portalSpeedFactor: number; pulseSpeedFactor: number; pulseRateFactor: number;
  particleOpacity: number;
  pulseColor: THREE.Color; portalColorNear: THREE.Color; portalColorFar: THREE.Color;
  neuralSphereColor: THREE.Color; neuralSphereOpacity: number; neuralSpherePulseAmount: number;
  pulsesFromCenter: boolean; neuralSphereScale: number; frozenAnimation: boolean;
  orbitSpeedFactor: number; coreIntensity: number;
}

const STATE_DEFS: Record<string, {
  portalSpeedFactor: number; pulseSpeedFactor: number; pulseRateFactor: number;
  particleOpacity: number;
  pulseColorOverride: THREE.Color | null;
  portalColorNearOverride: THREE.Color | null;
  portalColorFarOverride: THREE.Color | null;
  neuralSphereColor: THREE.Color; neuralSphereOpacity: number; neuralSpherePulseAmount: number;
  pulsesFromCenter: boolean; neuralSphereScale: number; frozenAnimation: boolean;
  orbitSpeedFactor: number; coreIntensity: number;
}> = {
  default: {
    portalSpeedFactor: 0.3, pulseSpeedFactor: 0.6, pulseRateFactor: 0.15,
    particleOpacity: BASE_PARTICLE_OPACITY,
    pulseColorOverride: null, portalColorNearOverride: null, portalColorFarOverride: null,
    neuralSphereColor: NS_BASE_COLOR, neuralSphereOpacity: NS_BASE_OPACITY, neuralSpherePulseAmount: NS_BASE_PULSE,
    pulsesFromCenter: false, neuralSphereScale: 1.0, frozenAnimation: false,
    orbitSpeedFactor: 1.0, coreIntensity: 0.55,
  },
  activity: {
    portalSpeedFactor: 0.8, pulseSpeedFactor: 0.9, pulseRateFactor: 1.2,
    particleOpacity: BASE_PARTICLE_OPACITY + 0.05,
    pulseColorOverride: new THREE.Color(0xffffff).multiplyScalar(1.1),
    portalColorNearOverride: new THREE.Color(0xffff33).multiplyScalar(1.2),
    portalColorFarOverride: new THREE.Color(0xffaa00).multiplyScalar(1.1),
    neuralSphereColor: NS_ACTIVITY_COLOR.clone().multiplyScalar(1.1),
    neuralSphereOpacity: NS_ACTIVITY_OPACITY, neuralSpherePulseAmount: NS_ACTIVITY_PULSE * 0.8,
    pulsesFromCenter: false, neuralSphereScale: 1.0, frozenAnimation: false,
    orbitSpeedFactor: 2.4, coreIntensity: 0.95,
  },
  output: {
    portalSpeedFactor: 0.9, pulseSpeedFactor: 1.0, pulseRateFactor: 1.4,
    particleOpacity: BASE_PARTICLE_OPACITY + 0.08,
    pulseColorOverride: new THREE.Color(0xffffff).multiplyScalar(1.2),
    portalColorNearOverride: new THREE.Color(0x00ffaa).multiplyScalar(1.2),
    portalColorFarOverride: new THREE.Color(0x00aa44).multiplyScalar(1.1),
    neuralSphereColor: NS_OUTPUT_COLOR, neuralSphereOpacity: NS_OUTPUT_OPACITY,
    neuralSpherePulseAmount: NS_OUTPUT_PULSE * 0.8,
    pulsesFromCenter: true, neuralSphereScale: 1.02, frozenAnimation: false,
    orbitSpeedFactor: 1.7, coreIntensity: 1.05,
  },
  // Idle but needs the human: approval, input request, or intervention.
  // Magenta, slow orbits, strong core breathing — attention, not work.
  waiting: {
    portalSpeedFactor: 0.15, pulseSpeedFactor: 0.4, pulseRateFactor: 0.5,
    particleOpacity: BASE_PARTICLE_OPACITY - 0.05,
    pulseColorOverride: new THREE.Color(0xff66ff).multiplyScalar(1.2),
    portalColorNearOverride: new THREE.Color(0xcc44ff).multiplyScalar(1.2),
    portalColorFarOverride: new THREE.Color(0x550099).multiplyScalar(1.1),
    neuralSphereColor: NS_WAITING_COLOR, neuralSphereOpacity: 0.95, neuralSpherePulseAmount: 0.45,
    pulsesFromCenter: true, neuralSphereScale: 1.04, frozenAnimation: false,
    orbitSpeedFactor: 0.45, coreIntensity: 0.85,
  },
  error: {
    portalSpeedFactor: 0.25, pulseSpeedFactor: 0.18, pulseRateFactor: 0.08,
    particleOpacity: BASE_PARTICLE_OPACITY - 0.15,
    pulseColorOverride: new THREE.Color(0xff0000).multiplyScalar(1.2),
    portalColorNearOverride: new THREE.Color(0x8B0000).multiplyScalar(1.1),
    portalColorFarOverride: new THREE.Color(0x3d0000).multiplyScalar(1.05),
    neuralSphereColor: NS_ERROR_COLOR, neuralSphereOpacity: NS_ERROR_OPACITY,
    neuralSpherePulseAmount: NS_ERROR_PULSE * 0.8,
    pulsesFromCenter: false, neuralSphereScale: 1.0, frozenAnimation: false,
    orbitSpeedFactor: 0.3, coreIntensity: 0.4,
  },
  criticalError: {
    portalSpeedFactor: 0.08, pulseSpeedFactor: 0.04, pulseRateFactor: 0.04,
    particleOpacity: BASE_PARTICLE_OPACITY,
    pulseColorOverride: new THREE.Color(0xff0000).multiplyScalar(1.4),
    portalColorNearOverride: new THREE.Color(0xff2200).multiplyScalar(1.2),
    portalColorFarOverride: new THREE.Color(0x660000).multiplyScalar(1.1),
    neuralSphereColor: NS_ERROR_COLOR.clone().multiplyScalar(1.1),
    neuralSphereOpacity: 0.8, neuralSpherePulseAmount: 0.008,
    pulsesFromCenter: true, neuralSphereScale: 1.08, frozenAnimation: true,
    orbitSpeedFactor: 0.0, coreIntensity: 0.75,
  },
};

function resolveVisuals(stateName: string): VisualState {
  const d = STATE_DEFS[stateName] ?? STATE_DEFS["default"]!;
  return {
    portalSpeedFactor:       d.portalSpeedFactor,
    pulseSpeedFactor:        d.pulseSpeedFactor,
    pulseRateFactor:         d.pulseRateFactor,
    particleOpacity:         d.particleOpacity,
    pulseColor:              d.pulseColorOverride      ? d.pulseColorOverride.clone()      : PULSE_COLOR.clone(),
    portalColorNear:         d.portalColorNearOverride ? d.portalColorNearOverride.clone() : COLOR_NEAR.clone(),
    portalColorFar:          d.portalColorFarOverride  ? d.portalColorFarOverride.clone()  : COLOR_FAR.clone(),
    neuralSphereColor:       d.neuralSphereColor.clone(),
    neuralSphereOpacity:     d.neuralSphereOpacity,
    neuralSpherePulseAmount: d.neuralSpherePulseAmount,
    pulsesFromCenter:        d.pulsesFromCenter,
    neuralSphereScale:       d.neuralSphereScale,
    frozenAnimation:         d.frozenAnimation,
    orbitSpeedFactor:        d.orbitSpeedFactor,
    coreIntensity:           d.coreIntensity,
  };
}

function cloneVisuals(v: VisualState): VisualState {
  return { ...v,
    pulseColor: v.pulseColor.clone(), portalColorNear: v.portalColorNear.clone(),
    portalColorFar: v.portalColorFar.clone(), neuralSphereColor: v.neuralSphereColor.clone(),
  };
}

// ─── Three.js state ───────────────────────────────────────────────────────────
const canvasEl = ref<HTMLCanvasElement | null>(null);

let renderer:    THREE.WebGLRenderer;
let scene:       THREE.Scene;
let camera:      THREE.PerspectiveCamera;
let clock:       THREE.Clock;
let animId:      number;
let resizeObserver: ResizeObserver | null = null;
let orbGroup:    THREE.Group;          // scaled root for the whole orb
let torusPoints: THREE.Points;
let sphereGroup: THREE.Group;
let orbitalPoints: THREE.Points;
let ambientPoints: THREE.Points;
let coreGlowMesh:  THREE.Mesh;
let torusUniforms: Record<string, THREE.IUniform>;
let sphereUniforms: Record<string, THREE.IUniform>;
let orbitalUniforms: Record<string, THREE.IUniform>;
let ambientUniforms: Record<string, THREE.IUniform>;
let coreUniforms: Record<string, THREE.IUniform>;
let isAnimating = false;

interface Pulse { origin: THREE.Vector3; startTime: number }
let activePulses: Pulse[] = [];
let lastPulseTime    = 0;
let nextPulseInterval = PULSE_INTERVAL_MIN + Math.random() * (PULSE_INTERVAL_MAX - PULSE_INTERVAL_MIN);
let nodeIndices: number[] = [];
let torusBasePositions: Float32Array;   // CPU-side copy for pulse origins

// Phase accumulators: advanced by delta * currentSpeed each frame, so speed
// changes (transitions, freezes, tab visibility) never cause phase jumps.
let breathePhase         = 0;
let radialWavePhase      = 0;
let zWavePhase           = 0;
let driftOffset          = 0;
let orbitTime            = 0;
let glowPhase            = 0;
let nsShimmerPhase       = 0;
let nsPulsePhase         = 0;
let neuralSphereRotation = 0;
let nsShimmerSpeed       = NS_SHIMMER_SPEED;
let nsPulseSpeed         = NS_PULSE_SPEED;
let starPhase            = 0;
let entityBreath         = 0;
let shootStartTime       = -1;   // clock time the current streak launched, -1 = idle
let shootNextAt          = 4 + Math.random() * 6;

let currentVisuals   = resolveVisuals("default");
let transitionSrc    = cloneVisuals(currentVisuals);
let transitionDst    = cloneVisuals(currentVisuals);
let transitionStart  = -1;
let transitionProgress = 1.0;

// ─── Geometry ─────────────────────────────────────────────────────────────────
function buildTorusGeometry(): THREE.BufferGeometry {
  const indexSet = new Set<number>();
  while (indexSet.size < NUM_NODES) indexSet.add(Math.floor(Math.random() * PARTICLE_COUNT));
  nodeIndices = Array.from(indexSet);

  const positions              = new Float32Array(PARTICLE_COUNT * 3);
  const particleAngles         = new Float32Array(PARTICLE_COUNT);
  const particleRadii          = new Float32Array(PARTICLE_COUNT);
  const particlePhases         = new Float32Array(PARTICLE_COUNT);
  const particleDriftZ         = new Float32Array(PARTICLE_COUNT);
  const particleZOffsets       = new Float32Array(PARTICLE_COUNT);
  const particleIsNode         = new Float32Array(PARTICLE_COUNT);
  torusBasePositions           = new Float32Array(PARTICLE_COUNT * 3);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3     = i * 3;
    const isNode = indexSet.has(i);

    const r     = INNER_RADIUS + Math.random() * (OUTER_RADIUS - INNER_RADIUS);
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
    const dz    = (Math.random() - 0.5) * PORTAL_DEPTH;
    const zo    = (Math.random() - 0.5) * 0.05;
    const bx    = Math.cos(angle) * r;
    const by    = Math.sin(angle) * r;
    const bz    = dz + zo;

    positions[i3]     = bx * SNAKE_EYE_SCALE_X;
    positions[i3 + 1] = by * SNAKE_EYE_SCALE_Y;
    positions[i3 + 2] = bz;

    particleAngles[i]        = angle;
    particleRadii[i]         = r;
    particlePhases[i]        = Math.random() * Math.PI * 2;
    particleDriftZ[i]        = dz;
    particleZOffsets[i]      = zo;
    particleIsNode[i]        = isNode ? 1.0 : 0.0;
    torusBasePositions[i3]     = bx;
    torusBasePositions[i3 + 1] = by;
    torusBasePositions[i3 + 2] = bz;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position",        new THREE.BufferAttribute(positions,         3));
  geo.setAttribute("particleAngle",   new THREE.BufferAttribute(particleAngles,    1));
  geo.setAttribute("particleRadius",  new THREE.BufferAttribute(particleRadii,     1));
  geo.setAttribute("particlePhase",   new THREE.BufferAttribute(particlePhases,    1));
  geo.setAttribute("particleDriftZ",  new THREE.BufferAttribute(particleDriftZ,    1));
  geo.setAttribute("particleZOffset", new THREE.BufferAttribute(particleZOffsets,  1));
  geo.setAttribute("particleIsNode",  new THREE.BufferAttribute(particleIsNode,    1));
  return geo;
}

function buildSphereGeometry(): THREE.BufferGeometry {
  const positions   = new Float32Array(NS_COUNT * 3);
  const shimmerData = new Float32Array(NS_COUNT);
  const phi         = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < NS_COUNT; i++) {
    const y = 1 - (i / (NS_COUNT - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    positions[i*3]   = Math.cos(theta) * r * NS_RADIUS;
    positions[i*3+1] = y * NS_RADIUS;
    positions[i*3+2] = Math.sin(theta) * r * NS_RADIUS;
    shimmerData[i]   = Math.random() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position",    new THREE.BufferAttribute(positions,   3));
  geo.setAttribute("shimmerData", new THREE.BufferAttribute(shimmerData, 1));
  return geo;
}

function buildOrbitalGeometry(): THREE.BufferGeometry {
  // Positions are computed entirely in the vertex shader; the (zeroed)
  // position attribute only tells three.js the draw count.
  const positions = new Float32Array(ORBITAL_COUNT * 3);
  const aRing     = new Float32Array(ORBITAL_COUNT);
  const aAngle    = new Float32Array(ORBITAL_COUNT);
  const aRadial   = new Float32Array(ORBITAL_COUNT);
  const aTilt     = new Float32Array(ORBITAL_COUNT);
  const aKind     = new Float32Array(ORBITAL_COUNT);
  const aTrail    = new Float32Array(ORBITAL_COUNT);
  const aSeed     = new Float32Array(ORBITAL_COUNT);
  const aSize     = new Float32Array(ORBITAL_COUNT);

  let i = 0;
  const push = (ring: number, angle: number, radial: number, tilt: number, kind: number, trail: number, size: number) => {
    aRing[i] = ring; aAngle[i] = angle; aRadial[i] = radial; aTilt[i] = tilt;
    aKind[i] = kind; aTrail[i] = trail; aSeed[i] = Math.random() * Math.PI * 2; aSize[i] = size;
    i++;
  };

  const ringRadii = [1.30, 1.72, 2.18];
  for (let ring = 0; ring < RING_COUNT; ring++) {
    for (let d = 0; d < DUST_PER_RING; d++) {
      // 3 of 4 dust grains hug their orbit (soft gaussian band); the rest
      // scatter across the whole disk so the orbits sit inside one
      // continuous medium instead of three separate circles.
      let radial: number;
      let tilt: number;
      if (d % 4 !== 0) {
        radial = ((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * 0.28;
        tilt   = (Math.random() - 0.5) * 0.07;
      } else {
        radial = 1.05 + Math.random() * 1.30 - ringRadii[ring]!;
        tilt   = (Math.random() - 0.5) * 0.14;
      }
      push(ring, Math.random() * Math.PI * 2, radial, tilt, 0, 0, 1.6 + Math.random() * 1.6);
    }
    for (let t = 0; t < TRACKS_PER_RING; t++) {
      push(ring, (t / TRACKS_PER_RING) * Math.PI * 2, 0, (Math.random() - 0.5) * 0.04, 3, 0, 1.4 + Math.random() * 1.2);
    }
    for (let w = 0; w < WIND_PER_RING; w++) {
      push(ring, Math.random() * Math.PI * 2, 0, (Math.random() - 0.5) * 0.06, 4, Math.random(), 1.5 + Math.random() * 1.1);
    }
    for (let a = 0; a < ARCS_PER_RING; a++) {
      const arcBase = a * Math.PI + ring * 1.1;
      for (let k = 0; k < ARC_POINTS; k++) {
        push(ring, arcBase, 0, (Math.random() - 0.5) * 0.03, 5, k / (ARC_POINTS - 1), 2.0);
      }
    }
    for (let p = 0; p < PLANETS_PER_RING; p++) {
      const planetAngle = (p / PLANETS_PER_RING) * Math.PI * 2 + ring * 0.7;
      push(ring, planetAngle, 0, 0, 1, 0, 9.0);
      for (let t = 1; t <= TRAIL_PER_PLANET; t++) {
        const f = t / TRAIL_PER_PLANET;
        push(
          ring, planetAngle,
          (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02,
          2, f, 5.0 * (1 - f) + 1.2,
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aRing",    new THREE.BufferAttribute(aRing,     1));
  geo.setAttribute("aAngle",   new THREE.BufferAttribute(aAngle,    1));
  geo.setAttribute("aRadial",  new THREE.BufferAttribute(aRadial,   1));
  geo.setAttribute("aTilt",    new THREE.BufferAttribute(aTilt,     1));
  geo.setAttribute("aKind",    new THREE.BufferAttribute(aKind,     1));
  geo.setAttribute("aTrail",   new THREE.BufferAttribute(aTrail,    1));
  geo.setAttribute("aSeed",    new THREE.BufferAttribute(aSeed,     1));
  geo.setAttribute("aSize",    new THREE.BufferAttribute(aSize,     1));
  return geo;
}

function buildAmbientGeometry(): THREE.BufferGeometry {
  // Stars use the real position attribute (rotated in-shader); shooting-star
  // and HUD particles compute their positions from uniforms/attributes.
  const positions = new Float32Array(AMBIENT_COUNT * 3);
  const aKind     = new Float32Array(AMBIENT_COUNT);
  const aA        = new Float32Array(AMBIENT_COUNT);
  const aSeed     = new Float32Array(AMBIENT_COUNT);
  const aSize     = new Float32Array(AMBIENT_COUNT);

  let i = 0;
  for (let s = 0; s < STAR_COUNT; s++, i++) {
    // random direction, radius spread well past the outer ring
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = 2.4 + Math.random() * 3.1;
    const xy = Math.sqrt(1 - u * u);
    positions[i*3]   = Math.cos(theta) * xy * r;
    positions[i*3+1] = u * r * 0.85;
    positions[i*3+2] = Math.sin(theta) * xy * r * 0.6;
    aKind[i] = 0; aSeed[i] = Math.random() * Math.PI * 2;
    aSize[i] = 1.2 + Math.random() * 1.3;
  }
  for (let t = 0; t < SHOOT_TRAIL_COUNT; t++, i++) {
    aKind[i] = 1; aA[i] = t / (SHOOT_TRAIL_COUNT - 1);
    aSeed[i] = Math.random() * Math.PI * 2;
    aSize[i] = 4.5 * (1 - aA[i]!) + 1.2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aKind",    new THREE.BufferAttribute(aKind,     1));
  geo.setAttribute("aA",       new THREE.BufferAttribute(aA,        1));
  geo.setAttribute("aSeed",    new THREE.BufferAttribute(aSeed,     1));
  geo.setAttribute("aSize",    new THREE.BufferAttribute(aSize,     1));
  return geo;
}

// ─── Animation loop ───────────────────────────────────────────────────────────
function animate() {
  if (!isAnimating) return;
  animId = requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.1);
  const time  = clock.elapsedTime;

  // ── Transition ──────────────────────────────────────────────────────────────
  if (transitionProgress < 1) {
    if (transitionStart < 0) transitionStart = time;
    const t   = Math.min(1, (time - transitionStart) / TRANSITION_DURATION);
    transitionProgress = t;
    const src = transitionSrc, dst = transitionDst, cv = currentVisuals;

    cv.particleOpacity         = THREE.MathUtils.lerp(src.particleOpacity,         dst.particleOpacity,         t);
    cv.portalSpeedFactor       = THREE.MathUtils.lerp(src.portalSpeedFactor,       dst.portalSpeedFactor,       t);
    cv.pulseSpeedFactor        = THREE.MathUtils.lerp(src.pulseSpeedFactor,        dst.pulseSpeedFactor,        t);
    cv.pulseRateFactor         = THREE.MathUtils.lerp(src.pulseRateFactor,         dst.pulseRateFactor,         t);
    cv.neuralSphereOpacity     = THREE.MathUtils.lerp(src.neuralSphereOpacity,     dst.neuralSphereOpacity,     t);
    cv.neuralSpherePulseAmount = THREE.MathUtils.lerp(src.neuralSpherePulseAmount, dst.neuralSpherePulseAmount, t);
    cv.neuralSphereScale       = THREE.MathUtils.lerp(src.neuralSphereScale,       dst.neuralSphereScale,       t);
    cv.orbitSpeedFactor        = THREE.MathUtils.lerp(src.orbitSpeedFactor,        dst.orbitSpeedFactor,        t);
    cv.coreIntensity           = THREE.MathUtils.lerp(src.coreIntensity,           dst.coreIntensity,           t);
    cv.pulseColor.lerpColors(src.pulseColor,             dst.pulseColor,        t);
    cv.portalColorNear.lerpColors(src.portalColorNear,   dst.portalColorNear,   t);
    cv.portalColorFar.lerpColors(src.portalColorFar,     dst.portalColorFar,    t);
    cv.neuralSphereColor.lerpColors(src.neuralSphereColor, dst.neuralSphereColor, t);
    if (t > 0.5) { cv.pulsesFromCenter = dst.pulsesFromCenter; cv.frozenAnimation = dst.frozenAnimation; }

    (torusUniforms["uPulseColor"]!.value      as THREE.Color).copy(cv.pulseColor);
    (torusUniforms["uPortalColorNear"]!.value as THREE.Color).copy(cv.portalColorNear);
    (torusUniforms["uPortalColorFar"]!.value  as THREE.Color).copy(cv.portalColorFar);
    (sphereUniforms["uNeuralSphereColor"]!.value as THREE.Color).copy(cv.neuralSphereColor);
    sphereUniforms["uNeuralSphereOpacity"]!.value     = cv.neuralSphereOpacity;
    sphereUniforms["uNeuralSpherePulseAmount"]!.value = cv.neuralSpherePulseAmount;
    (orbitalUniforms["uRingColorA"]!.value  as THREE.Color).copy(cv.portalColorNear);
    (orbitalUniforms["uRingColorB"]!.value  as THREE.Color).copy(cv.portalColorFar);
    (orbitalUniforms["uPlanetColor"]!.value as THREE.Color).copy(cv.pulseColor);
    (ambientUniforms["uAccentColor"]!.value as THREE.Color).copy(cv.portalColorNear);
    (ambientUniforms["uFarColor"]!.value    as THREE.Color).copy(cv.portalColorFar);
    ambientUniforms["uOpacity"]!.value = cv.particleOpacity;
    (coreUniforms["uCoreColor"]!.value as THREE.Color).copy(cv.neuralSphereColor);
  }

  const cv = currentVisuals;
  const motion = cv.frozenAnimation ? 0 : 1;

  // ── Phase accumulation (CPU-side, jump-free) ─────────────────────────────────
  const dt = delta * MOTION_SCALE;
  breathePhase    += dt * BASE_BREATHE_SPEED * cv.portalSpeedFactor;
  radialWavePhase += dt * RADIAL_WAVE_SPEED  * cv.portalSpeedFactor;
  zWavePhase      += dt * Z_WAVE_SPEED       * cv.portalSpeedFactor;
  driftOffset      = (driftOffset + dt * Z_DRIFT_SPEED * cv.portalSpeedFactor) % PORTAL_DEPTH;
  orbitTime       += dt * cv.orbitSpeedFactor * motion;
  glowPhase       += dt * GLOW_PULSE_SPEED * (cv.frozenAnimation ? 0.15 : 1);
  nsShimmerPhase  += dt * nsShimmerSpeed;
  nsPulsePhase    += dt * nsPulseSpeed;
  neuralSphereRotation += dt * NS_ROTATION_SPEED * motion;
  // Stars are environment, not entity — they keep drifting even when frozen.
  starPhase       += dt * STAR_ROTATION_SPEED;
  // The breath quickens with the entity's state; even frozen it faintly
  // persists — barely alive reads as more alive than a statue.
  entityBreath    += dt * ENTITY_BREATH_SPEED * (0.6 + cv.portalSpeedFactor) * (cv.frozenAnimation ? 0.25 : 1);

  // One shared breath: scale and glow of every layer swell together.
  const breath = Math.sin(entityBreath);
  orbGroup.scale.setScalar(ORB_SCALE * (1 + 0.02 * breath));
  torusUniforms["uParticleOpacity"]!.value = cv.particleOpacity * (1 + 0.06 * breath);
  orbitalUniforms["uOpacity"]!.value       = cv.particleOpacity * (1 + 0.09 * breath);
  coreUniforms["uIntensity"]!.value        = cv.coreIntensity   * (1 + 0.13 * breath);

  torusUniforms["uTime"]!.value            = time;
  torusUniforms["uBreathePhase"]!.value    = breathePhase;
  torusUniforms["uRadialWavePhase"]!.value = radialWavePhase;
  torusUniforms["uZWavePhase"]!.value      = zWavePhase;
  torusUniforms["uDriftOffset"]!.value     = driftOffset;
  sphereUniforms["uShimmerPhase"]!.value   = nsShimmerPhase;
  sphereUniforms["uPulsePhase"]!.value     = nsPulsePhase;
  orbitalUniforms["uOrbitTime"]!.value     = orbitTime;
  coreUniforms["uGlowPhase"]!.value        = glowPhase;
  ambientUniforms["uTime"]!.value          = time;
  ambientUniforms["uStarPhase"]!.value     = starPhase;

  // ── Shooting star scheduler ──────────────────────────────────────────────────
  if (!REDUCED_MOTION && motion) {
    if (shootStartTime < 0 && time >= shootNextAt) {
      const ang  = Math.random() * Math.PI * 2;
      const from = new THREE.Vector3(Math.cos(ang) * 4.6, (Math.random() - 0.5) * 3.2, (Math.random() - 0.5) * 1.5);
      const to   = from.clone().multiplyScalar(-(0.6 + Math.random() * 0.4));
      to.y += (Math.random() - 0.5) * 2.0;
      (ambientUniforms["uShootStart"]!.value as THREE.Vector3).copy(from);
      (ambientUniforms["uShootDir"]!.value   as THREE.Vector3).copy(to.sub(from));
      shootStartTime = time;
    }
    if (shootStartTime >= 0) {
      const progress = (time - shootStartTime) / SHOOT_DURATION;
      if (progress >= 1) {
        shootStartTime = -1;
        shootNextAt = time + 6 + Math.random() * 9;
        ambientUniforms["uShootProgress"]!.value = -1;
      } else {
        ambientUniforms["uShootProgress"]!.value = progress;
      }
    }
  } else if (shootStartTime >= 0) {
    shootStartTime = -1;
    ambientUniforms["uShootProgress"]!.value = -1;
  }

  const effectivePulseSpeed = PULSE_SPEED * cv.pulseSpeedFactor;

  // ── Pulse generation ─────────────────────────────────────────────────────────
  if (time - lastPulseTime > nextPulseInterval / cv.pulseRateFactor && activePulses.length < MAX_ACTIVE_PULSES) {
    let origin: THREE.Vector3;
    if (cv.pulsesFromCenter) {
      origin = new THREE.Vector3(0, 0, 0);
    } else {
      const ni = nodeIndices[Math.floor(Math.random() * nodeIndices.length)]!;
      origin   = new THREE.Vector3(
        torusBasePositions[ni*3]!, torusBasePositions[ni*3+1]!, torusBasePositions[ni*3+2]!,
      );
    }
    activePulses.push({ origin, startTime: time });
    lastPulseTime     = time;
    nextPulseInterval = PULSE_INTERVAL_MIN + Math.random() * (PULSE_INTERVAL_MAX - PULSE_INTERVAL_MIN);
  }
  let alive = 0;
  for (let i = 0; i < activePulses.length; i++) {
    const p = activePulses[i]!;
    if ((time - p.startTime) * effectivePulseSpeed <= PULSE_MAX_TRAVEL_RADIUS) activePulses[alive++] = p;
  }
  activePulses.length = alive;

  // ── Upload pulse data as uniforms → GPU computes intensity per-vertex ─────────
  const pulseOrigins = torusUniforms["uPulseOrigins"]!.value as THREE.Vector3[];
  const pulseRadii   = torusUniforms["uPulseTravelRadii"]!.value as number[];
  for (let i = 0; i < activePulses.length; i++) {
    pulseOrigins[i]!.copy(activePulses[i]!.origin);
    pulseRadii[i] = (time - activePulses[i]!.startTime) * effectivePulseSpeed;
  }
  torusUniforms["uActivePulseCount"]!.value = activePulses.length;

  // ── Neural sphere ─────────────────────────────────────────────────────────────
  sphereGroup.rotation.y = neuralSphereRotation;
  sphereGroup.scale.setScalar(cv.neuralSphereScale);

  renderer.render(scene, camera);
}

function startAnimation() {
  if (isAnimating) return;
  isAnimating = true;
  clock.start();
  // clock.start() resets elapsedTime to 0, so anything keyed to absolute
  // clock time must be re-anchored or stale pulses linger forever.
  activePulses.length = 0;
  lastPulseTime = 0;
  if (transitionProgress < 1) transitionStart = -1;
  shootStartTime = -1;
  shootNextAt = 3 + Math.random() * 5;
  if (ambientUniforms) ambientUniforms["uShootProgress"]!.value = -1;
  animate();
}

function stopAnimation() {
  isAnimating = false;
  cancelAnimationFrame(animId);
  clock?.stop();
}

function handleVisibilityChange() {
  if (document.hidden) stopAnimation();
  else startAnimation();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
// True when WebGL context creation fails (old browser, disabled/blocklisted GPU,
// headless). The orb is purely decorative, so we degrade to a transparent canvas
// instead of throwing out of onMounted (which, with no app error boundary, would
// blank the whole dashboard). The template can key a CSS fallback off this.
const webglUnavailable = ref(false);

onMounted(() => {
  const canvas = canvasEl.value!;
  const w = canvas.clientWidth  || 400;
  const h = canvas.clientHeight || 400;

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
    });
  } catch (err) {
    webglUnavailable.value = true;
    console.warn("OrbCanvas: WebGL unavailable — skipping the animated orb.", err);
    return; // skip all 3D setup + the animation loop; onUnmounted's renderer?.dispose() stays safe
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(w, h, false);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100);
  camera.position.set(0, 0, 5.0);

  clock = new THREE.Clock();

  torusUniforms = {
    uTime:             { value: 0 },
    uBreathePhase:     { value: 0 },
    uRadialWavePhase:  { value: 0 },
    uZWavePhase:       { value: 0 },
    uDriftOffset:      { value: 0 },
    uParticleOpacity:  { value: currentVisuals.particleOpacity },
    uPulseColor:       { value: currentVisuals.pulseColor.clone() },
    uPortalColorNear:  { value: currentVisuals.portalColorNear.clone() },
    uPortalColorFar:   { value: currentVisuals.portalColorFar.clone() },
    uPulseOrigins:     { value: Array.from({ length: MAX_ACTIVE_PULSES }, () => new THREE.Vector3()) },
    uPulseTravelRadii: { value: new Array<number>(MAX_ACTIVE_PULSES).fill(0) },
    uActivePulseCount: { value: 0 },
  };

  sphereUniforms = {
    uShimmerPhase:            { value: 0 },
    uPulsePhase:              { value: 0 },
    uNeuralSpherePulseAmount: { value: currentVisuals.neuralSpherePulseAmount },
    uNeuralSphereColor:       { value: currentVisuals.neuralSphereColor.clone() },
    uNeuralSphereOpacity:     { value: currentVisuals.neuralSphereOpacity },
  };

  orbitalUniforms = {
    uOrbitTime:   { value: 0 },
    uRingColorA:  { value: currentVisuals.portalColorNear.clone() },
    uRingColorB:  { value: currentVisuals.portalColorFar.clone() },
    uPlanetColor: { value: currentVisuals.pulseColor.clone() },
    uOpacity:     { value: currentVisuals.particleOpacity },
  };

  ambientUniforms = {
    uTime:          { value: 0 },
    uStarPhase:     { value: 0 },
    uAccentColor:   { value: currentVisuals.portalColorNear.clone() },
    uFarColor:      { value: currentVisuals.portalColorFar.clone() },
    uOpacity:       { value: currentVisuals.particleOpacity },
    uShootStart:    { value: new THREE.Vector3() },
    uShootDir:      { value: new THREE.Vector3() },
    uShootProgress: { value: -1 },
  };

  coreUniforms = {
    uCoreColor: { value: currentVisuals.neuralSphereColor.clone() },
    uIntensity: { value: currentVisuals.coreIntensity },
    uGlowPhase: { value: 0 },
  };

  // Orb group — scale controls visual size
  orbGroup = new THREE.Group();
  orbGroup.scale.setScalar(ORB_SCALE);
  scene.add(orbGroup);

  // Core glow plane sits behind everything (additive, order-independent)
  coreGlowMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), new THREE.ShaderMaterial({
    vertexShader: coreGlowVertexShader, fragmentShader: coreGlowFragmentShader, uniforms: coreUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  coreGlowMesh.position.z = -0.05;
  orbGroup.add(coreGlowMesh);

  torusPoints = new THREE.Points(buildTorusGeometry(), new THREE.ShaderMaterial({
    vertexShader: torusVS, fragmentShader: torusFS, uniforms: torusUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  orbGroup.add(torusPoints);

  sphereGroup = new THREE.Group();
  sphereGroup.add(new THREE.Points(buildSphereGeometry(), new THREE.ShaderMaterial({
    vertexShader: sphereVS, fragmentShader: sphereFS, uniforms: sphereUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  orbGroup.add(sphereGroup);

  orbitalPoints = new THREE.Points(buildOrbitalGeometry(), new THREE.ShaderMaterial({
    vertexShader: orbitalVertexShader, fragmentShader: orbitalFragmentShader, uniforms: orbitalUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  orbGroup.add(orbitalPoints);

  ambientPoints = new THREE.Points(buildAmbientGeometry(), new THREE.ShaderMaterial({
    vertexShader: ambientVertexShader, fragmentShader: ambientFragmentShader, uniforms: ambientUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  ambientPoints.frustumCulled = false;   // shooting star can start outside the static bounds
  orbGroup.add(ambientPoints);

  resizeObserver = new ResizeObserver(() => {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (cw && ch) {
      renderer.setSize(cw, ch, false);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
    }
  });
  resizeObserver.observe(canvas);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  startAnimation();
});

onUnmounted(() => {
  stopAnimation();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  resizeObserver?.disconnect();
  torusPoints?.geometry.dispose();
  (torusPoints?.material as THREE.Material | undefined)?.dispose();
  const spherePoints = sphereGroup?.children[0] as THREE.Points | undefined;
  spherePoints?.geometry.dispose();
  (spherePoints?.material as THREE.Material | undefined)?.dispose();
  orbitalPoints?.geometry.dispose();
  (orbitalPoints?.material as THREE.Material | undefined)?.dispose();
  ambientPoints?.geometry.dispose();
  (ambientPoints?.material as THREE.Material | undefined)?.dispose();
  coreGlowMesh?.geometry.dispose();
  (coreGlowMesh?.material as THREE.Material | undefined)?.dispose();
  renderer?.dispose();
});

// ─── aiState watcher ──────────────────────────────────────────────────────────
watch(() => props.aiState, (next) => {
  transitionSrc      = cloneVisuals(currentVisuals);
  transitionDst      = resolveVisuals(next);
  transitionStart    = -1;
  transitionProgress = 0;

  // Speeds feed phase accumulators, so even this hard switch stays jump-free.
  if (next === "criticalError") {
    nsShimmerSpeed = 0.05;
    nsPulseSpeed   = 0.1;
  } else {
    nsShimmerSpeed = NS_SHIMMER_SPEED;
    nsPulseSpeed   = NS_PULSE_SPEED;
  }
});
</script>
