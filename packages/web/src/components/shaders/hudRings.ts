// The Dyson sphere round the core, in the orb's own 3D space. The core used to wear an
// arc-reactor bezel and reticle arcs painted into the camera-facing core-glow plane: perfect
// circles facing the viewer while every orbit around them turned as a tilted ellipse, a flat
// sticker on a 3D entity. In their place the core now sits inside a Dyson sphere: strips of panels
// on great circles of two shells close round it, never complete, each strip turning on its own
// axis and the two shells turning against each other.
//
// While a turn runs, one more strip of panels assembles round the whole orb and lights up: the
// step ring, which the steps on the page ride on (composables/orbActivity.ts draws them with the
// same camera). It sits out past the particle torus, where its steps' labels have room.
//
// Each strip is a flat annulus mesh with its own tilt and spin; the fragment shader draws its
// panels from the strip's own polar coordinates, its near side brighter than its far side.

export interface HudRingSpec {
  /** Radius in the mesh's own units: orb units for the sphere, 1 for the step ring (scaled to its radius). */
  radius: number;
  /** Half the strip's width, same units. */
  width: number;
  /** Peak brightness. */
  strength: number;
  /** The strip plane's tilt, radians, applied X then Y then Z. */
  tilt: [number, number, number];
  /** How far the tilt sways, radians; 0 holds the plane still. */
  wobble: number;
  /** Spin around the strip's own axis, radians per second at rest. */
  spin: number;
  /** Phase offset of the sway and the panel layout, so strips do not repeat each other. */
  seed: number;
  /** Panels round the circle, and the share of them that is there. */
  tiles: number;
  coverage: number;
  /** How far the colour runs towards white-hot: the step ring stands out. */
  hot?: number;
}

/**
 * The Dyson sphere: an inner shell hugging the core sphere (radius 0.4) where the bezel's coil
 * was, and an outer one where its frame ended. Their strips lean every way, so together they
 * read as a sphere being built round the core, not as a ring.
 */
export const SPHERE_RINGS: readonly HudRingSpec[] = [
  { radius: 0.56, width: 0.050, strength: 1.9, tilt: [0.35, 0.2, 0], wobble: 0.05, spin: 0.22, seed: 1.3, tiles: 16, coverage: 0.7 },
  { radius: 0.56, width: 0.050, strength: 1.8, tilt: [1.45, 0.7, 0], wobble: 0.05, spin: -0.18, seed: 2.9, tiles: 16, coverage: 0.6 },
  { radius: 0.56, width: 0.050, strength: 1.71, tilt: [2.4, -1.0, 0.4], wobble: 0.06, spin: 0.15, seed: 4.2, tiles: 16, coverage: 0.65 },
  { radius: 0.56, width: 0.050, strength: 1.8, tilt: [0.95, 2.2, 1.1], wobble: 0.05, spin: -0.24, seed: 5.7, tiles: 16, coverage: 0.55 },
  { radius: 0.72, width: 0.042, strength: 1.27, tilt: [0.7, -0.5, 0.3], wobble: 0.04, spin: -0.12, seed: 7.1, tiles: 22, coverage: 0.5 },
  { radius: 0.72, width: 0.042, strength: 1.19, tilt: [1.9, 1.3, -0.5], wobble: 0.04, spin: 0.1, seed: 8.8, tiles: 22, coverage: 0.45 },
  { radius: 0.72, width: 0.042, strength: 1.19, tilt: [2.8, 0.3, 1.4], wobble: 0.05, spin: -0.14, seed: 10.2, tiles: 22, coverage: 0.5 },
];

/** The step ring's strip: every panel there, white-hot, built round the circle as a turn starts. */
export const STEP_RING: HudRingSpec = {
  radius: 1, width: 0.035, strength: 1.9, tilt: [0, 0, 0], wobble: 0, spin: 0.08, seed: 11.4, tiles: 56, coverage: 1, hot: 0.55,
};

export const hudRingVertexShader = `
  uniform float uRadius;
  varying vec2  vLocal;   // the point in the strip's own plane
  varying float vNear;    // 0 on the far side of the strip, 1 on the near side

  void main() {
    vLocal = position.xy;
    vec4 mv     = modelViewMatrix * vec4(position, 1.0);
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // The strip's radius as the camera sees it, whatever the mesh and the orb are scaled by.
    float seen  = length((modelViewMatrix * vec4(uRadius, 0.0, 0.0, 0.0)).xyz);
    // The camera looks down -z: a point nearer to it has the larger z.
    vNear = clamp((mv.z - centre.z) / seen * 0.5 + 0.5, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

export const hudRingFragmentShader = `
  uniform vec3  uCoreColor;
  uniform float uIntensity;
  uniform float uGlowPhase;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uStrength;
  uniform float uTiles;
  uniform float uCoverage;
  uniform float uSeed;
  uniform float uAssemble;   // how far round the circle the strip is built, 0..1
  uniform float uHot;        // extra white-hot share, for the step ring

  varying vec2  vLocal;
  varying float vNear;

  const float TAU = 6.28318;

  float band(float r, float centre, float width) {
    return exp(-pow((r - centre) / width, 2.0));
  }
  float gap(float pos, float a, float b, float c, float d) {
    return smoothstep(a, b, pos) * (1.0 - smoothstep(c, d, pos));
  }

  void main() {
    float r   = length(vLocal);
    float pos = fract(atan(vLocal.y, vLocal.x) / TAU + 1.0);

    // Panels along the strip, a share of them missing; the strip is built round the circle up to
    // uAssemble.
    float idx   = floor(pos * uTiles);
    float tile  = gap(fract(pos * uTiles), 0.04, 0.09, 0.91, 0.96);
    float h     = fract(sin(idx * 12.9898 + uSeed * 78.233) * 43758.5453);
    float there = step(h, uCoverage);
    float built = 1.0 - smoothstep(uAssemble - 0.03, uAssemble, pos);
    float off   = abs(r - uRadius);
    float fill  = 1.0 - smoothstep(uWidth * 0.7, uWidth, off);
    float edge  = band(off, uWidth * 0.85, uWidth * 0.16);
    float shimmer = 0.75 + 0.25 * sin(uGlowPhase * 0.6 + h * TAU);
    float lum = (fill * (0.28 + 0.3 * h) * shimmer + edge * 0.7) * tile * there * built;

    float pulse   = 0.88 + 0.12 * sin(uGlowPhase);
    float flicker = 1.0 + 0.05 * sin(uGlowPhase * 9.7) * sin(uGlowPhase * 23.3);
    // Near side bright, far side receding — the same depth cue the orbits use.
    float depth   = 0.35 + 0.85 * vNear;
    lum *= uStrength * uIntensity * pulse * flicker * depth;

    vec3 hot = mix(uCoreColor, vec3(1.0), 0.55);
    vec3 col = uCoreColor * lum + hot * lum * (0.15 + uHot);
    // Additive blending scales the colour by alpha. With the brightness as alpha and the colour
    // left as it is, as the core glow does, a strip counted its brightness twice and came out
    // faint; alpha 1 made the transparent canvas opaque along every strip, a black band over the
    // page. So alpha stays the brightness, and the colour is divided by it to be added once.
    float alpha = clamp(lum, 0.0, 1.0);
    gl_FragColor = vec4(col / max(alpha, 0.001), alpha);
  }
`;
