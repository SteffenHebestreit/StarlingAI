// Ambient environment layer, one Points draw call with two particle kinds:
//   0 — starfield: static shell around the entity, slow rotation, twinkle.
//       Environment keeps living even when the entity itself is frozen.
//   1 — shooting star: a straight streak driven by CPU uniforms; inactive
//       when uShootProgress < 0.
export const ambientVertexShader = `
  attribute float aKind;
  attribute float aA;    // shoot: 0..1 trail position
  attribute float aSeed;
  attribute float aSize;

  uniform float uTime;          // star twinkle only (environment clock)
  uniform float uStarPhase;
  uniform vec3  uAccentColor;
  uniform vec3  uFarColor;
  uniform float uOpacity;
  uniform vec3  uShootStart;
  uniform vec3  uShootDir;      // direction * full travel distance
  uniform float uShootProgress; // 0..1 while flying, negative when idle

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec3 p;

    if (aKind < 0.5) {
      float c = cos(uStarPhase), s = sin(uStarPhase);
      p = vec3(position.x * c + position.z * s, position.y, -position.x * s + position.z * c);
      float tw = 0.55 + 0.45 * sin(uTime * (0.6 + fract(aSeed) * 0.7) + aSeed * 7.0);
      vColor = mix(vec3(0.75, 0.8, 1.0), uFarColor, 0.35) * tw;
      vAlpha = 0.5 * tw * uOpacity;
    } else {
      float along = clamp(uShootProgress, 0.0, 1.0) - aA * 0.12;
      p = uShootStart + uShootDir * along;
      float fade = smoothstep(0.0, 0.12, uShootProgress) * (1.0 - smoothstep(0.75, 1.0, uShootProgress));
      float live = step(0.0, uShootProgress) * (1.0 - step(1.0, uShootProgress)) * step(0.0, along);
      vColor = mix(vec3(1.2), uAccentColor * 1.3, aA);
      vAlpha = (1.0 - aA) * (1.0 - aA) * fade * live;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position  = projectionMatrix * mv;
    gl_PointSize = aSize * (5.0 / -mv.z);
  }
`;

export const ambientFragmentShader = `
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    float d    = distance(gl_PointCoord, vec2(0.5));
    float glow = pow(max(0.0, 1.0 - d * 2.0), 1.5);
    gl_FragColor = vec4(vColor * (0.7 + 1.6 * glow), vAlpha * smoothstep(0.5, 0.08, d));
  }
`;
