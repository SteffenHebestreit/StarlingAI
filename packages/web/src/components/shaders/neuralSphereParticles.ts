// Neural core sphere: the shell of points round the core glow. It is kept quiet (SHELL_GLOW,
// SHELL_OPACITY below), so the glow behind it and the hologram sphere round it carry the light;
// at its old strength the shell burned out to a white ball.
//
// Shimmer/pulse motion uses CPU-accumulated phase uniforms so abrupt speed changes (e.g. entering
// criticalError) slow the motion smoothly instead of snapping every particle to a new phase.
import { POINT_SCALE_VERTEX, POINT_SCALE_FRAGMENT } from "./pointScale";

export const vertexShader = `${POINT_SCALE_VERTEX}
  attribute float shimmerData;

  uniform float uShimmerPhase;
  uniform float uPulsePhase;
  uniform float uNeuralSpherePulseAmount;
  uniform vec3 uNeuralSphereColor;
  uniform float uNeuralSphereOpacity;

  const float NEURAL_SPHERE_SHIMMER_INTENSITY = 0.5;
  const float NEURAL_SPHERE_SHIMMER_COLOR_FACTOR = 0.4;
  const float NEURAL_SPHERE_POP_THRESHOLD = 0.8;
  const float NEURAL_SPHERE_POP_COLOR_LERP_FACTOR = 0.8;
  const float NEURAL_SPHERE_POP_OPACITY_BOOST = 0.4;

  varying vec4 vColor;

  void main() {
    float shimmerValue = (sin(uShimmerPhase + shimmerData) + 1.0) / 2.0;

    vec3 particleColor = uNeuralSphereColor;
    float particleOpacity = uNeuralSphereOpacity;

    float baseBrightnessFactor = 1.0 - NEURAL_SPHERE_SHIMMER_INTENSITY + shimmerValue * NEURAL_SPHERE_SHIMMER_INTENSITY * 1.3;
    particleColor *= baseBrightnessFactor;

    float colorShiftAmount = shimmerValue * NEURAL_SPHERE_SHIMMER_COLOR_FACTOR * 1.2;
    vec3 shimmerAdjustedColor = mix(particleColor, vec3(1.0, 1.0, 1.0), colorShiftAmount);

    float popIntensity = 0.0;
    if (shimmerValue > NEURAL_SPHERE_POP_THRESHOLD) {
      popIntensity = (shimmerValue - NEURAL_SPHERE_POP_THRESHOLD) / (1.0 - NEURAL_SPHERE_POP_THRESHOLD);
      popIntensity = pow(popIntensity, 0.8);
    }

    if (popIntensity > 0.0) {
      shimmerAdjustedColor = mix(shimmerAdjustedColor, vec3(1.3, 1.3, 1.3), popIntensity * NEURAL_SPHERE_POP_COLOR_LERP_FACTOR);
      particleOpacity = min(1.0, uNeuralSphereOpacity + popIntensity * NEURAL_SPHERE_POP_OPACITY_BOOST);
    }

    float pulseEffect = sin(uPulsePhase) * 0.5 + 0.5;
    shimmerAdjustedColor = mix(shimmerAdjustedColor, shimmerAdjustedColor * 1.5, pulseEffect * uNeuralSpherePulseAmount);

    vColor = vec4(shimmerAdjustedColor, particleOpacity);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float size = 0.08;
    gl_PointSize = scaledPointSize(size * (300.0 / -mvPosition.z));
  }
`;

export const fragmentShader = `${POINT_SCALE_FRAGMENT}
  varying vec4 vColor;

  void main() {
    vec2 center = vec2(0.5, 0.5);
    float dist = distance(gl_PointCoord, center);

    vec3 brightColor = vColor.rgb * 1.5;

    float glowFactor = 1.0 - dist * 1.2;
    glowFactor = pow(max(0.0, glowFactor), 1.2);
    // How hot a point burns and how much of its opacity it keeps: 2.2 and 1.0 made the shell the
    // brightest thing in the orb.
    const float SHELL_GLOW    = 1.4;
    const float SHELL_OPACITY = 0.8;
    float glowStrength = SHELL_GLOW;

    vec3 finalColor = brightColor * glowFactor * glowStrength;
    float alpha = vColor.a * SHELL_OPACITY * smoothstep(0.5, 0.1, dist) * vPointFade;

    gl_FragColor = vec4(finalColor, alpha);
  }
`;
