<template>
  <canvas ref="canvasEl" style="display:block;width:100%;height:100%;" />
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import * as THREE from "three";
import { vertexShader as torusVS, fragmentShader as torusFS } from "./shaders/torusParticles";
import { vertexShader as sphereVS, fragmentShader as sphereFS } from "./shaders/neuralSphereParticles";

const props = withDefaults(defineProps<{ aiState?: string }>(), { aiState: "default" });

// ─── Constants (matching original Orb.jsx) ────────────────────────────────────
const PARTICLE_COUNT          = 3000;
const OUTER_RADIUS            = 0.95;
const INNER_RADIUS            = 0.55;
const PORTAL_DEPTH            = 1.0;
const Z_DRIFT_SPEED           = 0.1;
const SNAKE_EYE_SCALE_X       = 0.8;
const SNAKE_EYE_SCALE_Y       = 1.35;
const RADIAL_WAVE_SPEED       = 0.75;
const Z_WAVE_SPEED            = 0.6;
const COLOR_NEAR              = new THREE.Color("#00ffff").multiplyScalar(1.5);
const COLOR_FAR               = new THREE.Color("#4a00e0").multiplyScalar(1.3);
const BASE_BREATHE_SPEED      = 0.5;
const BASE_PARTICLE_OPACITY   = 0.9;

const NUM_NODES               = 10;
const NODE_COLOR              = new THREE.Color(0xffaa00).multiplyScalar(1.4);
const PULSE_COLOR             = new THREE.Color(0xffffff);
const PULSE_SPEED             = 2.5;
const PULSE_MAX_TRAVEL_RADIUS = OUTER_RADIUS * 4.5;
const MAX_ACTIVE_PULSES       = 9;
const PULSE_INTERVAL_MIN      = 0.5;
const PULSE_INTERVAL_MAX      = 2.0;

const NS_RADIUS               = 0.4;
const NS_COUNT                = 400;
const NS_BASE_COLOR           = new THREE.Color(0x8888ff).multiplyScalar(1.4);
const NS_ACTIVITY_COLOR       = new THREE.Color(0xffffff);
const NS_ERROR_COLOR          = new THREE.Color(0xff3333).multiplyScalar(1.3);
const NS_OUTPUT_COLOR         = new THREE.Color(0x33ff66).multiplyScalar(1.5);
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

// Scale factor applied to the whole orb group
const ORB_SCALE               = 0.42;

// ─── Visual state ─────────────────────────────────────────────────────────────
interface VisualState {
  portalSpeedFactor: number; pulseSpeedFactor: number; pulseRateFactor: number;
  particleOpacity: number;
  pulseColor: THREE.Color; portalColorNear: THREE.Color; portalColorFar: THREE.Color;
  neuralSphereColor: THREE.Color; neuralSphereOpacity: number; neuralSpherePulseAmount: number;
  pulsesFromCenter: boolean; neuralSphereScale: number; frozenAnimation: boolean;
}

const STATE_DEFS: Record<string, {
  portalSpeedFactor: number; pulseSpeedFactor: number; pulseRateFactor: number;
  particleOpacity: number;
  pulseColorOverride: THREE.Color | null;
  portalColorNearOverride: THREE.Color | null;
  portalColorFarOverride: THREE.Color | null;
  neuralSphereColor: THREE.Color; neuralSphereOpacity: number; neuralSpherePulseAmount: number;
  pulsesFromCenter: boolean; neuralSphereScale: number; frozenAnimation: boolean;
}> = {
  default: {
    portalSpeedFactor: 0.3, pulseSpeedFactor: 0.6, pulseRateFactor: 0.15,
    particleOpacity: BASE_PARTICLE_OPACITY,
    pulseColorOverride: null, portalColorNearOverride: null, portalColorFarOverride: null,
    neuralSphereColor: NS_BASE_COLOR, neuralSphereOpacity: NS_BASE_OPACITY, neuralSpherePulseAmount: NS_BASE_PULSE,
    pulsesFromCenter: false, neuralSphereScale: 1.0, frozenAnimation: false,
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
let torusUniforms: Record<string, THREE.IUniform>;
let sphereUniforms: Record<string, THREE.IUniform>;
let isAnimating = false;

interface Pulse { origin: THREE.Vector3; startTime: number }
let activePulses: Pulse[] = [];
let lastPulseTime    = 0;
let nextPulseInterval = PULSE_INTERVAL_MIN + Math.random() * (PULSE_INTERVAL_MAX - PULSE_INTERVAL_MIN);
let neuralSphereRotation = 0;
let nodeIndices: number[] = [];

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
  const colors                 = new Float32Array(PARTICLE_COUNT * 3);
  const particleAngles         = new Float32Array(PARTICLE_COUNT);
  const particleRadii          = new Float32Array(PARTICLE_COUNT);
  const particlePhases         = new Float32Array(PARTICLE_COUNT);
  const particleDriftZ         = new Float32Array(PARTICLE_COUNT);
  const particleZOffsets       = new Float32Array(PARTICLE_COUNT);
  const particleIsNode         = new Float32Array(PARTICLE_COUNT);
  const particleBasePositions  = new Float32Array(PARTICLE_COUNT * 3);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3     = i * 3;
    const isNode = nodeIndices.includes(i);

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
    particleBasePositions[i3]     = bx;
    particleBasePositions[i3 + 1] = by;
    particleBasePositions[i3 + 2] = bz;

    if (isNode) {
      colors[i3] = NODE_COLOR.r; colors[i3+1] = NODE_COLOR.g; colors[i3+2] = NODE_COLOR.b;
    } else {
      const tmp  = new THREE.Color();
      const norm = ((bz - (-PORTAL_DEPTH / 2)) / PORTAL_DEPTH) % 1;
      tmp.copy(COLOR_FAR).lerp(COLOR_NEAR, norm < 0 ? norm + 1 : norm);
      colors[i3] = tmp.r; colors[i3+1] = tmp.g; colors[i3+2] = tmp.b;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position",        new THREE.BufferAttribute(positions,             3));
  geo.setAttribute("color",           new THREE.BufferAttribute(colors,               3));
  geo.setAttribute("particleAngle",   new THREE.BufferAttribute(particleAngles,       1));
  geo.setAttribute("particleRadius",  new THREE.BufferAttribute(particleRadii,        1));
  geo.setAttribute("particlePhase",   new THREE.BufferAttribute(particlePhases,       1));
  geo.setAttribute("particleDriftZ",  new THREE.BufferAttribute(particleDriftZ,       1));
  geo.setAttribute("particleZOffset", new THREE.BufferAttribute(particleZOffsets,     1));
  geo.setAttribute("particleIsNode",  new THREE.BufferAttribute(particleIsNode,       1));
  geo.setAttribute("particlePosition",new THREE.BufferAttribute(particleBasePositions,3));
  return geo;
}

function buildSphereGeometry(): THREE.BufferGeometry {
  const positions   = new Float32Array(NS_COUNT * 3);
  const colors      = new Float32Array(NS_COUNT * 4);
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
  geo.setAttribute("color",       new THREE.BufferAttribute(colors,      4));
  geo.setAttribute("shimmerData", new THREE.BufferAttribute(shimmerData, 1));
  return geo;
}

// ─── Animation loop ───────────────────────────────────────────────────────────
function animate() {
  if (!isAnimating) return;
  animId = requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const time  = clock.elapsedTime;

  torusUniforms["uTime"]!.value       = time;
  torusUniforms["uDeltaTime"]!.value  = delta;
  sphereUniforms["uTime"]!.value      = time;
  sphereUniforms["uDeltaTime"]!.value = delta;

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
    cv.pulseColor.lerpColors(src.pulseColor,             dst.pulseColor,        t);
    cv.portalColorNear.lerpColors(src.portalColorNear,   dst.portalColorNear,   t);
    cv.portalColorFar.lerpColors(src.portalColorFar,     dst.portalColorFar,    t);
    cv.neuralSphereColor.lerpColors(src.neuralSphereColor, dst.neuralSphereColor, t);
    if (t > 0.5) { cv.pulsesFromCenter = dst.pulsesFromCenter; cv.frozenAnimation = dst.frozenAnimation; }

    const spf = cv.portalSpeedFactor;
    torusUniforms["uPortalSpeedFactor"]!.value = spf;
    torusUniforms["uBreatheSpeed"]!.value      = BASE_BREATHE_SPEED * spf;
    torusUniforms["uRadialWaveSpeed"]!.value   = RADIAL_WAVE_SPEED  * spf;
    torusUniforms["uZWaveSpeed"]!.value        = Z_WAVE_SPEED       * spf;
    torusUniforms["uParticleOpacity"]!.value   = cv.particleOpacity;
    (torusUniforms["uPulseColor"]!.value      as THREE.Color).copy(cv.pulseColor);
    (torusUniforms["uPortalColorNear"]!.value as THREE.Color).copy(cv.portalColorNear);
    (torusUniforms["uPortalColorFar"]!.value  as THREE.Color).copy(cv.portalColorFar);
    (sphereUniforms["uNeuralSphereColor"]!.value as THREE.Color).copy(cv.neuralSphereColor);
    sphereUniforms["uNeuralSphereOpacity"]!.value     = cv.neuralSphereOpacity;
    sphereUniforms["uNeuralSpherePulseAmount"]!.value = cv.neuralSpherePulseAmount;
  }

  const cv = currentVisuals;
  const effectivePulseSpeed = PULSE_SPEED * cv.pulseSpeedFactor;
  const geo = torusPoints.geometry;

  // ── Pulse generation ─────────────────────────────────────────────────────────
  if (time - lastPulseTime > nextPulseInterval / cv.pulseRateFactor && activePulses.length < MAX_ACTIVE_PULSES) {
    let origin: THREE.Vector3;
    if (cv.pulsesFromCenter) {
      origin = new THREE.Vector3(0, 0, 0);
    } else {
      const ni = nodeIndices[Math.floor(Math.random() * nodeIndices.length)]!;
      const bp = geo.attributes["particlePosition"]!.array as Float32Array;
      origin   = new THREE.Vector3(bp[ni*3]!, bp[ni*3+1]!, bp[ni*3+2]!);
    }
    activePulses.push({ origin, startTime: time });
    lastPulseTime     = time;
    nextPulseInterval = PULSE_INTERVAL_MIN + Math.random() * (PULSE_INTERVAL_MAX - PULSE_INTERVAL_MIN);
  }
  activePulses = activePulses.filter(p => (time - p.startTime) * effectivePulseSpeed <= PULSE_MAX_TRAVEL_RADIUS);

  // ── Upload pulse data as uniforms → GPU computes intensity per-vertex ─────────
  const pulseOrigins = torusUniforms["uPulseOrigins"]!.value as THREE.Vector3[];
  const pulseRadii   = torusUniforms["uPulseTravelRadii"]!.value as number[];
  for (let i = 0; i < activePulses.length; i++) {
    pulseOrigins[i]!.copy(activePulses[i]!.origin);
    pulseRadii[i] = (time - activePulses[i]!.startTime) * effectivePulseSpeed;
  }
  torusUniforms["uActivePulseCount"]!.value = activePulses.length;

  // ── Neural sphere ─────────────────────────────────────────────────────────────
  if (!cv.frozenAnimation) neuralSphereRotation = time * NS_ROTATION_SPEED;
  sphereGroup.rotation.y = cv.frozenAnimation ? 0 : neuralSphereRotation;
  sphereGroup.scale.setScalar(cv.neuralSphereScale);

  renderer.render(scene, camera);
}

function startAnimation() {
  if (isAnimating) return;
  isAnimating = true;
  clock.start();
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
onMounted(() => {
  const canvas = canvasEl.value!;
  const w = canvas.clientWidth  || 400;
  const h = canvas.clientHeight || 400;

  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(w, h, false);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100);
  camera.position.set(0, 0, 5.0);

  clock = new THREE.Clock();

  torusUniforms = {
    uTime:              { value: 0 },
    uDeltaTime:         { value: 0 },
    uPortalSpeedFactor: { value: currentVisuals.portalSpeedFactor },
    uBreatheSpeed:      { value: BASE_BREATHE_SPEED * currentVisuals.portalSpeedFactor },
    uRadialWaveSpeed:   { value: RADIAL_WAVE_SPEED  * currentVisuals.portalSpeedFactor },
    uZWaveSpeed:        { value: Z_WAVE_SPEED       * currentVisuals.portalSpeedFactor },
    uDriftSpeed:        { value: Z_DRIFT_SPEED },
    uParticleOpacity:   { value: currentVisuals.particleOpacity },
    uPulseColor:        { value: currentVisuals.pulseColor.clone() },
    uPortalColorNear:   { value: currentVisuals.portalColorNear.clone() },
    uPortalColorFar:    { value: currentVisuals.portalColorFar.clone() },
    uPulseOrigins:      { value: Array.from({ length: MAX_ACTIVE_PULSES }, () => new THREE.Vector3()) },
    uPulseTravelRadii:  { value: new Array<number>(MAX_ACTIVE_PULSES).fill(0) },
    uActivePulseCount:  { value: 0 },
  };

  sphereUniforms = {
    uTime:                    { value: 0 },
    uDeltaTime:               { value: 0 },
    uNeuralSpherePulseSpeed:  { value: NS_PULSE_SPEED },
    uNeuralSpherePulseAmount: { value: currentVisuals.neuralSpherePulseAmount },
    uNeuralSphereShimmerSpeed:{ value: NS_SHIMMER_SPEED },
    uNeuralSphereColor:       { value: currentVisuals.neuralSphereColor.clone() },
    uNeuralSphereOpacity:     { value: currentVisuals.neuralSphereOpacity },
  };

  // Orb group — scale controls visual size
  orbGroup = new THREE.Group();
  orbGroup.scale.setScalar(ORB_SCALE);
  scene.add(orbGroup);

  torusPoints = new THREE.Points(buildTorusGeometry(), new THREE.ShaderMaterial({
    vertexShader: torusVS, fragmentShader: torusFS, uniforms: torusUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true,
  }));
  orbGroup.add(torusPoints);

  sphereGroup = new THREE.Group();
  sphereGroup.add(new THREE.Points(buildSphereGeometry(), new THREE.ShaderMaterial({
    vertexShader: sphereVS, fragmentShader: sphereFS, uniforms: sphereUniforms,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true,
  })));
  orbGroup.add(sphereGroup);

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
  renderer?.dispose();
});

// ─── aiState watcher ──────────────────────────────────────────────────────────
watch(() => props.aiState, (next) => {
  transitionSrc      = cloneVisuals(currentVisuals);
  transitionDst      = resolveVisuals(next);
  transitionStart    = -1;
  transitionProgress = 0;

  if (next === "criticalError") {
    sphereUniforms["uNeuralSphereShimmerSpeed"]!.value = 0.05;
    sphereUniforms["uNeuralSpherePulseSpeed"]!.value   = 0.1;
  } else {
    sphereUniforms["uNeuralSphereShimmerSpeed"]!.value = NS_SHIMMER_SPEED;
    sphereUniforms["uNeuralSpherePulseSpeed"]!.value   = NS_PULSE_SPEED;
  }
});
</script>
