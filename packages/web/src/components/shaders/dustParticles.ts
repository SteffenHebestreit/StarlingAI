// The orb's breathing body: a cloud of dust round the core, inside the hologram sphere
// (shaders/hudRings.ts), which holds it like a cage. It used to be a flat disc of particles facing
// the camera out beyond the core, each one breathing in and out on its own phase — a backdrop with
// a life of its own behind a sphere that turns in 3D. Now it is the thing the sphere contains: a
// swirl in the plane of the globe's equator and a haze round it, hanging in the cage's own frames
// so it turns with them.
//
// It breathes as one body, with the orb's breath (OrbCanvas entityBreath): the whole cloud swells
// towards the cage and settles back, the outer points a moment after the inner ones and each a
// little in its own time, and it never reaches the cage. The crest of light that leaves the core
// on every breath (shaders/breath.ts) passes through it on its way out to the rings.
//
// All motion is driven by phases accumulated CPU-side (phase += delta * speed), not uTime * speed:
// with the latter, lerping a speed during a state transition multiplies the total elapsed time by
// the speed delta, which makes everything whip round in a long-lived session.
import { BREATH_WAVE } from "./breath";
import { LOOSE_FRAME, OUTER_GLOBE, seeded } from "./hudRings";
import { POINT_SCALE_VERTEX, POINT_SCALE_FRAGMENT } from "./pointScale";

/** The body at rest, in orb units: from just outside the core's shell of points to well inside the globe cage. */
export const DUST_INNER = 0.48;
export const DUST_OUTER = 0.9;
/** How far a breath moves a point, as a share of its distance from the centre. */
export const DUST_BREATH = 0.1;
/** How far a point strays from its place as the body stirs, orb units. */
export const DUST_STIR = 0.015;

/** One cloud of dust: the points that hang in one of the sphere's frames, in that frame's own cylinder coordinates. */
export interface DustCloud {
  frame: number;
  count: number;
  /** Distance from the frame's axis. */
  radius: Float32Array;
  /** Where on its circle a point starts, radians. */
  angle: Float32Array;
  /** Along the frame's axis. */
  height: Float32Array;
  /** Drift along the circle, radians per unit of orbit phase. */
  speed: Float32Array;
  phase: Float32Array;
  isNode: Float32Array;
}
/** A node: one of the few amber points a pulse can start from. */
export interface DustNode { frame: number; radius: number; angle: number; height: number; speed: number }
export interface Dust { clouds: DustCloud[]; nodes: DustNode[] }

const SWIRL_COUNT = 420;
const HAZE_COUNT = 340;
const NODE_COUNT = 10;
/** Half the swirl's thickness, as a share of the body's radius. */
const SWIRL_THICKNESS = 0.11;

/** The whole body, the same on every load. */
export function buildDust(seed = 20261113): Dust {
  const rand = seeded(seed);
  const points = new Map<number, number[][]>();
  const put = (frame: number, radius: number, angle: number, height: number, speed: number) => {
    if (!points.has(frame)) points.set(frame, []);
    points.get(frame)!.push([radius, angle, height, speed, rand() * Math.PI * 2]);
  };
  /** A distance from the centre inside the body, more points towards its outside than its middle. */
  const distance = () => DUST_INNER + (DUST_OUTER - DUST_INNER) * Math.sqrt(rand());

  // The swirl: a thick disc in the globe's equator, all turning one way, faster near the core.
  for (let i = 0; i < SWIRL_COUNT; i++) {
    const reach = distance();
    const lift = (rand() + rand() + rand() - 1.5) * SWIRL_THICKNESS * DUST_OUTER;
    const radius = Math.sqrt(Math.max(reach * reach - lift * lift, 0.01));
    put(OUTER_GLOBE, radius, rand() * Math.PI * 2, lift, 0.05 + 0.16 * Math.pow(DUST_INNER / reach, 1.5));
  }
  // The haze: points anywhere in the body, drifting either way, so the swirl has a body round it.
  for (let i = 0; i < HAZE_COUNT; i++) {
    const reach = distance();
    const z = 2 * rand() - 1;
    put(LOOSE_FRAME, reach * Math.sqrt(1 - z * z), rand() * Math.PI * 2, reach * z, (rand() - 0.5) * 0.12);
  }

  const clouds: DustCloud[] = [...points.entries()].map(([frame, list]) => ({
    frame, count: list.length,
    radius: Float32Array.from(list, (p) => p[0]!),
    angle: Float32Array.from(list, (p) => p[1]!),
    height: Float32Array.from(list, (p) => p[2]!),
    speed: Float32Array.from(list, (p) => p[3]!),
    phase: Float32Array.from(list, (p) => p[4]!),
    isNode: new Float32Array(list.length),
  }));
  const nodes: DustNode[] = [];
  while (nodes.length < NODE_COUNT) {
    const cloud = clouds[Math.floor(rand() * clouds.length)]!;
    const i = Math.floor(rand() * cloud.count);
    if (cloud.isNode[i]) continue;
    cloud.isNode[i] = 1;
    nodes.push({ frame: cloud.frame, radius: cloud.radius[i]!, angle: cloud.angle[i]!, height: cloud.height[i]!, speed: cloud.speed[i]! });
  }
  return { clouds, nodes };
}

export const vertexShader = `${POINT_SCALE_VERTEX}${BREATH_WAVE}
  attribute float aRadius;
  attribute float aAngle;
  attribute float aHeight;
  attribute float aSpeed;
  attribute float aPhase;
  attribute float aIsNode;

  uniform mat4  uFrame;          // this cloud's frame, in orb space
  uniform float uOuter;          // the body's outer radius at rest
  uniform float uTime;
  uniform float uBreath;         // the entity's breath
  uniform float uOrbitPhase;     // how far the points have drifted along their circles
  uniform float uFlutterPhase;   // the body's stirring
  uniform float uParticleOpacity;
  uniform vec3  uPulseColor;
  uniform vec3  uPortalColorNear;
  uniform vec3  uPortalColorFar;

  #define MAX_PULSES 9
  uniform vec3  uPulseOrigins[MAX_PULSES];
  uniform float uPulseTravelRadii[MAX_PULSES];
  uniform int   uActivePulseCount;

  const float BREATH                     = ${DUST_BREATH.toFixed(3)};
  const float STIR                       = ${DUST_STIR.toFixed(3)};
  const float BODY_LAG                   = 1.2;    // how much later the outer points breathe, radians per orb unit
  const float COLOR_INTENSITY_BOOST      = 1.4;
  const float NODE_COLOR_INTENSITY_BOOST = 1.6;
  const float DEPTH_COLOR_CONTRAST       = 1.2;
  const float PULSE_HALF_WIDTH           = 0.415;
  const float PULSE_MAX_RADIUS           = 4.275;

  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    float angle = aAngle + uOrbitPhase * aSpeed;
    vec3  place = vec3(cos(angle) * aRadius, sin(angle) * aRadius, aHeight);
    float reach = length(place);
    // One body breathing: every point moves out and back along its line from the core, the outer
    // ones a moment after the inner ones, each a little in its own time.
    float body  = sin(uBreath - reach * BODY_LAG + 0.5 * sin(aPhase));
    vec3  finalPosition = place * (1.0 + BREATH * body);
    finalPosition += STIR * vec3(
      sin(uFlutterPhase + aPhase),
      cos(uFlutterPhase * 0.8 + aPhase * 1.7),
      sin(uFlutterPhase * 1.3 + aPhase * 0.6)
    );
    // The crest of light on its way out from the core to the rings.
    float crest = breathCrest(uBreath, reach);

    vec4 mvPosition = modelViewMatrix * vec4(finalPosition, 1.0);
    // Near side bright, far side receding — the same depth cue the sphere's rings use.
    vec4  centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float seen   = length((modelViewMatrix * vec4(uOuter, 0.0, 0.0, 0.0)).xyz);
    float near   = clamp((mvPosition.z - centre.z) / seen * 0.5 + 0.5, 0.0, 1.0);

    vOpacity = uParticleOpacity * (0.55 + 0.45 * near);

    if (aIsNode > 0.5) {
      vColor = vec3(1.0, 0.67, 0.0) * NODE_COLOR_INTENSITY_BOOST;
      float nodePulse = sin(uTime * 2.0 + aPhase) * 0.2 + 0.8;
      vColor *= nodePulse;
    } else {
      vColor = mix(uPortalColorFar, uPortalColorNear, pow(near, DEPTH_COLOR_CONTRAST)) * COLOR_INTENSITY_BOOST;

      // Pulses spread through the orb's own space, whatever frame a point hangs in.
      vec3  orbPosition    = (uFrame * vec4(finalPosition, 1.0)).xyz;
      float pulseIntensity = 0.0;
      for (int i = 0; i < MAX_PULSES; i++) {
        if (i >= uActivePulseCount) break;
        float dist = distance(orbPosition, uPulseOrigins[i]);
        float diff = abs(dist - uPulseTravelRadii[i]);
        if (diff < PULSE_HALF_WIDTH) {
          float fadeOut = max(0.0, 1.0 - uPulseTravelRadii[i] / PULSE_MAX_RADIUS);
          float hit     = (1.0 - diff / PULSE_HALF_WIDTH) * fadeOut;
          pulseIntensity = max(pulseIntensity, hit);
        }
      }
      vColor = mix(vColor, uPulseColor * 1.2, pulseIntensity);
      vColor *= 0.85 + 0.75 * crest;
    }

    gl_Position  = projectionMatrix * mvPosition;
    gl_PointSize = scaledPointSize(2.5 + 0.8 * crest);
  }
`;

export const fragmentShader = `${POINT_SCALE_FRAGMENT}
  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    float dist        = distance(gl_PointCoord, vec2(0.5));
    vec3  brightColor = vColor * 1.4;
    float glowFactor  = max(0.0, 1.5 - dist * 1.5);
    vec3  finalColor  = brightColor * glowFactor * 2.0;
    float alpha       = vOpacity * smoothstep(1.0, 0.0, dist * 1.8) * vPointFade;
    gl_FragColor = vec4(finalColor, alpha);
  }
`;
