// Orbital system: three tilted elliptical orbits sharing one Points draw
// call. Each orbit carries dust, planets with comet trails, a static tick
// "track" that planets energize as they sweep past, and solar-wind streams
// that spiral outward from the core into the orbit plane — so the core,
// cloud, and orbits read as one connected organism, not stacked layers.
// Motion is driven by uOrbitTime, a CPU-accumulated phase, so speed changes
// (state transitions, freezes) never cause angle jumps.
export const orbitalVertexShader = `
  attribute float aRing;    // ring index 0..2
  attribute float aAngle;   // base angle on the ring
  attribute float aRadial;  // radial offset from the orbit radius
  attribute float aTilt;    // out-of-plane jitter
  attribute float aKind;    // 0 dust, 1 planet, 2 trail, 3 track tick, 4 solar wind, 5 holo arc
  attribute float aTrail;   // trail: 0..1 along the tail | wind: flow phase offset
  attribute float aSeed;    // random phase
  attribute float aSize;    // point size in px at camera distance 5

  uniform float uOrbitTime;
  uniform vec3  uRingColorA;   // near / highlight
  uniform vec3  uRingColorB;   // far / shadow
  uniform vec3  uPlanetColor;
  uniform float uOpacity;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vKind;

  const float TRAIL_ARC  = 0.75;
  const float WIND_TWIST = 2.6;
  const float WIND_FLOW  = 0.10;

  void main() {
    int ring = int(aRing + 0.5);
    // Kepler-ish: inner rings orbit faster.
    float radius  = ring == 0 ? 1.45 : (ring == 1 ? 1.85 : 2.25);
    float speed   = ring == 0 ? 0.50 : (ring == 1 ? 0.31 : 0.19);
    float ecc     = ring == 0 ? 0.88 : (ring == 1 ? 0.93 : 0.85);
    float tiltX   = ring == 0 ? 0.50 : (ring == 1 ? -0.65 : 0.22);
    float tiltZ   = ring == 0 ? 0.35 : (ring == 1 ? -0.10 : 0.60);
    float precess = ring == 0 ? 0.050 : (ring == 1 ? -0.040 : 0.032);

    float ang;
    float r;
    float y = aTilt;
    float windFade = 0.0;

    if (aKind > 4.5) {
      // holo arc fragment: counter-rotating segment hugging the orbit
      ang = aAngle - uOrbitTime * speed * 1.6 + aTrail * 1.4;
      r   = radius + 0.09;
      y  *= 0.3;
    } else if (aKind > 3.5) {
      // solar wind: streams rising from the core, spiraling out to the orbit
      float prog = fract(aSeed * 0.159155 + uOrbitTime * WIND_FLOW + aTrail);
      r   = mix(0.30, radius, pow(prog, 0.75));
      ang = aAngle + prog * WIND_TWIST;
      windFade = sin(prog * 3.14159);
    } else if (aKind > 2.5) {
      // track tick: static in the orbit plane (precesses with it)
      ang = aAngle;
      r   = radius;
      y  *= 0.3;
    } else {
      ang = aAngle + uOrbitTime * speed - aTrail * TRAIL_ARC;
      r   = radius + aRadial;
    }

    vec3 p = vec3(cos(ang) * r, y, sin(ang) * r * ecc);

    // Orient the orbit plane: tilt around X, then Z.
    float cx = cos(tiltX), sx = sin(tiltX);
    p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
    float cz = cos(tiltZ), sz = sin(tiltZ);
    p = vec3(p.x * cz - p.y * sz, p.x * sz + p.y * cz, p.z);

    // Slow precession of the whole orbit plane around Y.
    float pa = uOrbitTime * precess;
    float cp = cos(pa), sp = sin(pa);
    p = vec3(p.x * cp + p.z * sp, p.y, -p.x * sp + p.z * cp);

    // Depth cue: particles on the camera-near arc take the highlight color.
    float depthMix = clamp(p.z * 0.45 + 0.5, 0.0, 1.0);
    float twinkle  = 0.7 + 0.3 * sin(uOrbitTime * 2.1 + aSeed);

    // 3D legibility: the near arc is brighter, the far arc recedes.
    float depthFade = 0.55 + 0.45 * depthMix;

    if (aKind > 4.5) {
      // holo arc: bright, tapering toward both ends
      float taper = pow(sin(aTrail * 3.14159), 0.7);
      vColor = mix(uRingColorA, vec3(1.0), 0.35) * 1.5;
      vAlpha = taper * 0.9 * depthFade * uOpacity;
    } else if (aKind > 3.5) {
      // wind cools from core color to ring color as it travels outward
      float prog = fract(aSeed * 0.159155 + uOrbitTime * WIND_FLOW + aTrail);
      vColor = mix(uPlanetColor, mix(uRingColorB, uRingColorA, depthMix), prog) * 1.1;
      vAlpha = windFade * 0.42 * uOpacity;
    } else if (aKind > 2.5) {
      // tick wakes up as a planet passes (planets sit at rel 0 and PI);
      // ~a third of ticks stay dark so the track reads as interrupted
      // data-fragments (reference look), not a continuous circle
      float rel  = aAngle - uOrbitTime * speed - float(ring) * 0.7;
      float wake = pow(abs(cos(rel)), 16.0);
      float frag = step(0.35, fract(aSeed * 2.39996));
      vColor = mix(uRingColorA, uPlanetColor, wake * 0.7) * (0.35 + 1.7 * wake);
      vAlpha = (0.15 + 1.0 * wake) * frag * depthFade * uOpacity;
    } else if (aKind > 1.5) {
      // comet trail: fades and cools toward the tail
      vColor = mix(uPlanetColor, uRingColorA, aTrail) * 1.2;
      vAlpha = (1.0 - aTrail) * (1.0 - aTrail) * 0.85 * depthFade * uOpacity;
    } else if (aKind > 0.5) {
      // planet: bright, gently pulsing, each with its own hue lean
      float pulse = 1.1 + 0.25 * sin(uOrbitTime * 3.0 + aSeed);
      vec3 tint = vec3(
        0.85 + 0.3 * sin(aSeed),
        0.85 + 0.3 * sin(aSeed + 2.094),
        0.85 + 0.3 * sin(aSeed + 4.189));
      vColor = uPlanetColor * pulse * tint;
      vAlpha = uOpacity;
    } else {
      // disk dust: alpha eases off the farther it sits from its orbit
      float spread = 1.0 - clamp(abs(aRadial) * 1.8, 0.0, 0.72);
      vColor = mix(uRingColorB, uRingColorA, depthMix) * twinkle;
      vAlpha = 0.68 * twinkle * spread * depthFade * uOpacity;
    }

    vKind = aKind;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position  = projectionMatrix * mvPosition;
    gl_PointSize = aSize * (5.0 / -mvPosition.z);
  }
`;

export const orbitalFragmentShader = `
  varying vec3  vColor;
  varying float vAlpha;
  varying float vKind;

  void main() {
    vec2  q = gl_PointCoord - 0.5;
    float d = length(q);
    if (vKind > 2.5 && vKind < 3.5) {
      // crisp square tick — the geometric "machined" accent on each orbit
      float box = max(abs(q.x), abs(q.y));
      gl_FragColor = vec4(vColor, vAlpha * (1.0 - smoothstep(0.3, 0.5, box)));
    } else if (vKind > 0.5 && vKind < 1.5) {
      // planet: wide soft halo around a hot core
      float halo = pow(max(0.0, 1.0 - d * 2.0), 0.9);
      vec3  col  = vColor * (0.5 + 1.6 * halo);
      float a    = vAlpha * (smoothstep(0.5, 0.02, d) * 0.9 + 0.25 * halo);
      gl_FragColor = vec4(col, a);
    } else {
      float glow = pow(max(0.0, 1.0 - d * 2.0), 1.4);
      vec3  col  = vColor * (0.6 + 1.8 * glow);
      float a    = vAlpha * smoothstep(0.5, 0.05, d);
      gl_FragColor = vec4(col, a);
    }
  }
`;

// Central energy core: white-hot nucleus, soft halo, and a 4-point
// diffraction star — the "artificial lens" signature of the entity.
// Rendered on a camera-facing plane at the origin with additive blending.
export const coreGlowVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const coreGlowFragmentShader = `
  uniform vec3  uCoreColor;
  uniform float uIntensity;
  uniform float uGlowPhase;

  varying vec2 vUv;

  void main() {
    vec2  c = (vUv - 0.5) * 2.0;
    float r = length(c);
    float angC = atan(c.y, c.x);
    const float TAU = 6.28318;

    float pulse = 0.88 + 0.12 * sin(uGlowPhase);
    float core  = exp(-r * 8.5) * 1.45;
    float halo  = exp(-r * 2.6) * 0.30;
    float spikeH = exp(-abs(c.y) * 26.0) * exp(-abs(c.x) * 3.2);
    float spikeV = exp(-abs(c.x) * 26.0) * exp(-abs(c.y) * 3.2);
    float star  = (spikeH + spikeV) * 0.35;

    // ── Arc-reactor bezel ────────────────────────────────────────────────
    // ten coil segments ringing the nucleus, rotating very slowly; the
    // radius alternates per tooth so the ring reads as a notched gear
    float segPos  = fract((angC / TAU) * 10.0 - uGlowPhase * 0.05);
    float segMask = smoothstep(0.08, 0.18, segPos) * (1.0 - smoothstep(0.82, 0.92, segPos));
    float toothSel = step(0.5, fract((angC / TAU) * 20.0 - uGlowPhase * 0.05));
    float gearR   = mix(0.235, 0.255, toothSel);
    float coil    = exp(-pow((r - gearR) / 0.018, 2.0)) * segMask * 1.5;
    // fine dash ring + two crisp circles framing the coil
    float dashPos  = fract((angC / TAU) * 24.0 + uGlowPhase * 0.04);
    float dashMask = smoothstep(0.18, 0.32, dashPos) * (1.0 - smoothstep(0.68, 0.82, dashPos));
    float dashes   = exp(-pow((r - 0.315) / 0.010, 2.0)) * dashMask * 0.9;
    float ringA    = exp(-pow((r - 0.275) / 0.006, 2.0)) * 0.7;
    float ringB    = exp(-pow((r - 0.360) / 0.006, 2.0)) * 0.5;

    // chunky arc blocks (HUD style: thick low-alpha segments between the
    // fine rings), drifting opposite the reticle
    float blkPos  = fract((angC - uGlowPhase * 0.08) / TAU * 4.0);
    float blkMask = smoothstep(0.10, 0.16, blkPos) * (1.0 - smoothstep(0.58, 0.64, blkPos));
    float blocks  = exp(-pow((r - 0.41) / 0.020, 2.0)) * blkMask * 0.55;

    // ── Reticle: rotating arc segments around the whole core body ───────
    float retPos   = fract((angC + uGlowPhase * 0.22) / TAU * 3.0);
    float retMask  = smoothstep(0.05, 0.12, retPos) * (1.0 - smoothstep(0.55, 0.62, retPos));
    float reticle  = exp(-pow((r - 0.47) / 0.008, 2.0)) * retMask * 0.85;
    float ret2Pos  = fract((angC - uGlowPhase * 0.13) / TAU * 2.0);
    float ret2Mask = smoothstep(0.04, 0.10, ret2Pos) * (1.0 - smoothstep(0.40, 0.46, ret2Pos));
    float reticle2 = exp(-pow((r - 0.53) / 0.007, 2.0)) * ret2Mask * 0.6;

    // hologram character: faint scanlines + slow instability shimmer
    float scan    = 1.0 + 0.05 * sin(c.y * 70.0 - uGlowPhase * 3.0);
    float flicker = 1.0 + 0.05 * sin(uGlowPhase * 9.7) * sin(uGlowPhase * 23.3);

    float lum = (core + halo + star + coil + dashes + ringA + ringB + blocks + reticle + reticle2)
      * uIntensity * pulse * scan * flicker;
    vec3  hot = mix(uCoreColor, vec3(1.0), 0.55);
    vec3  col = uCoreColor * lum
      + hot * (core * 0.35 + (coil + reticle) * 0.3) * uIntensity;
    gl_FragColor = vec4(col, clamp(lum, 0.0, 1.0));
  }
`;
