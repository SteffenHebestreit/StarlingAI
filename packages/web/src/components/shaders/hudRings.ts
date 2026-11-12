// The HUD around the core, in the orb's own 3D space. Painted into the camera-facing core-glow
// plane, as it used to be, the bezel and the reticle arcs stayed perfect circles facing the viewer
// while every orbit around them turned as a tilted ellipse: a flat sticker on a 3D entity.
//
// Two parts:
// - the BEZEL, the arc-reactor ring fitted round the core sphere: coil, frame circles, dash track;
// - the DYSON SHELL round the whole orb: strips of panels on great circles of one sphere, never
//   complete, turning slowly on their own axes. While a turn runs, one more strip assembles panel
//   by panel and lights up: the step ring, which the steps on the page ride on
//   (composables/orbActivity.ts draws them with the same camera).
//
// Each ring is a flat annulus mesh with its own tilt and spin; the fragment shader draws its
// pattern from the ring's own polar coordinates, its near side brighter than its far side.

/** Which pattern a ring draws (the `uKind` uniform). */
export const HUD_KIND = { coil: 0, dashes: 1, circle: 2, panels: 6 } as const;

export interface HudRingSpec {
  kind: number;
  /** Radius in the mesh's own units: orb units for the bezel, 1 for the shell (scaled to its radius). */
  radius: number;
  /** Width of the drawn band (a Gaussian's sigma; for panels, half the strip), same units. */
  width: number;
  /** Peak brightness. */
  strength: number;
  /** The ring plane's tilt, radians, applied X then Y then Z. */
  tilt: [number, number, number];
  /** How far the tilt sways, radians; 0 holds the plane still. */
  wobble: number;
  /** Spin around the ring's own axis, radians per second at rest. */
  spin: number;
  /** Phase offset of the sway and the panel layout, so rings do not repeat each other. */
  seed: number;
  /** Panels: tiles round the circle, and the share of them that is there. */
  tiles?: number;
  coverage?: number;
  /** How far the colour runs towards white-hot: the step ring's strip stands out from the shell. */
  hot?: number;
}

const BEZEL_TILT: [number, number, number] = [0.42, -0.3, 0];

/**
 * The bezel hugs the core sphere (radius 0.4) as one machined part: coil, frame circles and dash
 * track share a mild tilt and sway together. Radii and widths are the old plane's (whose UV radius
 * of 1 was 2.2 orb units), so the parts keep their sizes.
 */
export const BEZEL_RINGS: readonly HudRingSpec[] = [
  { kind: HUD_KIND.coil, radius: 0.539, width: 0.040, strength: 1.5, tilt: BEZEL_TILT, wobble: 0.08, spin: 0.16, seed: 0 },
  { kind: HUD_KIND.circle, radius: 0.605, width: 0.013, strength: 0.7, tilt: BEZEL_TILT, wobble: 0.08, spin: 0, seed: 0 },
  { kind: HUD_KIND.dashes, radius: 0.693, width: 0.022, strength: 0.9, tilt: BEZEL_TILT, wobble: 0.08, spin: -0.12, seed: 0 },
  { kind: HUD_KIND.circle, radius: 0.792, width: 0.013, strength: 0.5, tilt: BEZEL_TILT, wobble: 0.08, spin: 0, seed: 0 },
];

/** The shell's strips, on a sphere of radius 1 that the canvas scales to the step ring's radius. */
const SHELL_WIDTH = 0.028;
export const SHELL_RINGS: readonly HudRingSpec[] = [
  { kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH, strength: 0.75, tilt: [0.35, 0.2, 0], wobble: 0.04, spin: 0.05, seed: 1.3, tiles: 44, coverage: 0.55 },
  { kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH, strength: 0.7, tilt: [1.25, 0.65, 0], wobble: 0.04, spin: -0.04, seed: 2.9, tiles: 44, coverage: 0.45 },
  { kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH, strength: 0.65, tilt: [2.05, -0.95, 0.4], wobble: 0.05, spin: 0.035, seed: 4.2, tiles: 40, coverage: 0.5 },
  { kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH, strength: 0.7, tilt: [0.9, 2.1, 1.0], wobble: 0.04, spin: -0.06, seed: 5.7, tiles: 48, coverage: 0.4 },
  { kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH, strength: 0.6, tilt: [2.6, 1.3, -0.5], wobble: 0.05, spin: 0.045, seed: 7.1, tiles: 40, coverage: 0.6 },
  { kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH, strength: 0.65, tilt: [1.6, -2.2, 0.8], wobble: 0.04, spin: -0.03, seed: 8.8, tiles: 44, coverage: 0.5 },
];

/** The step ring's strip: every panel there, brighter, built round the circle as a turn starts. */
export const STEP_RING: HudRingSpec = {
  kind: HUD_KIND.panels, radius: 1, width: SHELL_WIDTH * 1.25, strength: 1.9, tilt: [0, 0, 0], wobble: 0, spin: 0.08, seed: 11.4, tiles: 56, coverage: 1, hot: 0.55,
};

export const hudRingVertexShader = `
  uniform float uRadius;
  varying vec2  vLocal;   // the point in the ring's own plane
  varying float vNear;    // 0 on the far side of the ring, 1 on the near side

  void main() {
    vLocal = position.xy;
    vec4 mv     = modelViewMatrix * vec4(position, 1.0);
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // The ring's radius as the camera sees it, whatever the mesh and the orb are scaled by.
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
  uniform float uKind;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uStrength;
  uniform float uTiles;
  uniform float uCoverage;
  uniform float uSeed;
  uniform float uAssemble;   // panels: how far round the circle the strip is built, 0..1
  uniform float uHot;        // panels: extra white-hot share, for the step ring's strip

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
    float r = length(vLocal);
    float u = atan(vLocal.y, vLocal.x) / TAU;
    float lum;
    float hotMix = 0.0;

    if (uKind < 0.5) {
      // coil: ten segments, the radius alternating per tooth so it reads as a notched gear
      float seg   = gap(fract(u * 10.0), 0.08, 0.18, 0.82, 0.92);
      float tooth = step(0.5, fract(u * 20.0));
      lum = band(r, uRadius * mix(0.96, 1.04, tooth), uWidth) * seg;
      hotMix = 0.3;
    } else if (uKind < 1.5) {
      // dash track
      lum = band(r, uRadius, uWidth) * gap(fract(u * 24.0), 0.18, 0.32, 0.68, 0.82);
    } else if (uKind < 2.5) {
      // fine circle framing the coil
      lum = band(r, uRadius, uWidth);
    } else {
      // Dyson panels: tiles along a strip, a share of them missing; the strip is built round the
      // circle up to uAssemble
      float pos   = fract(u + 1.0);
      float idx   = floor(pos * uTiles);
      float tile  = gap(fract(pos * uTiles), 0.04, 0.09, 0.91, 0.96);
      float h     = fract(sin(idx * 12.9898 + uSeed * 78.233) * 43758.5453);
      float there = step(h, uCoverage);
      float built = 1.0 - smoothstep(uAssemble - 0.03, uAssemble, pos);
      float off   = abs(r - uRadius);
      float fill  = 1.0 - smoothstep(uWidth * 0.7, uWidth, off);
      float edge  = band(off, uWidth * 0.85, uWidth * 0.16);
      float shimmer = 0.75 + 0.25 * sin(uGlowPhase * 0.6 + h * TAU);
      lum = (fill * (0.28 + 0.3 * h) * shimmer + edge * 0.7) * tile * there * built;
      hotMix = 0.15 + uHot;
    }

    float pulse   = 0.88 + 0.12 * sin(uGlowPhase);
    float flicker = 1.0 + 0.05 * sin(uGlowPhase * 9.7) * sin(uGlowPhase * 23.3);
    // Near side bright, far side receding — the same depth cue the orbits use.
    float depth   = 0.35 + 0.85 * vNear;
    lum *= uStrength * uIntensity * pulse * flicker * depth;

    vec3 hot = mix(uCoreColor, vec3(1.0), 0.55);
    vec3 col = uCoreColor * lum + hot * lum * hotMix;
    // Additive blending scales the colour by alpha. With the brightness as alpha and the colour
    // left as it is, as the core glow does, a ring counted its brightness twice and came out faint;
    // alpha 1 made the transparent canvas opaque along every strip, a black band over the page.
    // So alpha stays the brightness, and the colour is divided by it to be added exactly once.
    float alpha = clamp(lum, 0.0, 1.0);
    gl_FragColor = vec4(col / max(alpha, 0.001), alpha);
  }
`;
