export const vertexShader = `
  attribute float shimmerData;

  uniform float uTime;
  uniform float uDeltaTime;
  uniform float uNeuralSpherePulseSpeed;
  uniform float uNeuralSpherePulseAmount;
  uniform float uNeuralSphereShimmerSpeed;
  uniform vec3 uNeuralSphereColor;
  uniform float uNeuralSphereOpacity;

  const float NEURAL_SPHERE_SHIMMER_INTENSITY = 0.5;
  const float NEURAL_SPHERE_SHIMMER_COLOR_FACTOR = 0.4;
  const float NEURAL_SPHERE_POP_THRESHOLD = 0.8;
  const float NEURAL_SPHERE_POP_COLOR_LERP_FACTOR = 0.8;
  const float NEURAL_SPHERE_POP_OPACITY_BOOST = 0.4;

  varying vec4 vColor;

  void main() {
    float shimmerPhase = shimmerData;
    float shimmerValue = (sin(uTime * uNeuralSphereShimmerSpeed + shimmerPhase) + 1.0) / 2.0;

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

    float pulseEffect = sin(uTime * uNeuralSpherePulseSpeed) * 0.5 + 0.5;
    shimmerAdjustedColor = mix(shimmerAdjustedColor, shimmerAdjustedColor * 1.5, pulseEffect * uNeuralSpherePulseAmount);

    vColor = vec4(shimmerAdjustedColor, particleOpacity);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float size = 0.08;
    gl_PointSize = size * (300.0 / -mvPosition.z);
  }
`;
export const fragmentShader = `
  varying vec4 vColor;

  void main() {
    vec2 center = vec2(0.5, 0.5);
    float dist = distance(gl_PointCoord, center);

    vec3 brightColor = vColor.rgb * 1.5;

    float glowFactor = 1.0 - dist * 1.2;
    glowFactor = pow(max(0.0, glowFactor), 1.2);
    float glowStrength = 2.2;

    vec3 finalColor = brightColor * glowFactor * glowStrength;
    float alpha = vColor.a * smoothstep(0.5, 0.1, dist);

    gl_FragColor = vec4(finalColor, alpha);
  }
`;
