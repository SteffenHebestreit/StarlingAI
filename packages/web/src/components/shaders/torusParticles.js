export const vertexShader = `
  attribute float particleAngle;
  attribute float particleRadius;
  attribute float particlePhase;
  attribute float particleDriftZ;
  attribute float particleZOffset;
  attribute float particleIsNode;

  uniform float uTime;
  uniform float uDeltaTime;
  uniform float uPortalSpeedFactor;
  uniform float uBreatheSpeed;
  uniform float uRadialWaveSpeed;
  uniform float uZWaveSpeed;
  uniform float uDriftSpeed;
  uniform float uParticleOpacity;
  uniform vec3  uPulseColor;
  uniform vec3  uPortalColorNear;
  uniform vec3  uPortalColorFar;

  #define MAX_PULSES 9
  uniform vec3  uPulseOrigins[MAX_PULSES];
  uniform float uPulseTravelRadii[MAX_PULSES];
  uniform int   uActivePulseCount;

  const float PORTAL_DEPTH               = 1.0;
  const float AXIAL_PULSE_AMPLITUDE      = 0.15;
  const float RADIAL_PULSE_AMPLITUDE     = 0.15;
  const float SNAKE_EYE_SCALE_X          = 0.8;
  const float SNAKE_EYE_SCALE_Y          = 1.35;
  const float RADIAL_WAVE_FREQUENCY      = 66.0;
  const float RADIAL_WAVE_AMPLITUDE      = 0.18;
  const float Z_WAVE_FREQUENCY           = 3.0;
  const float Z_WAVE_AMPLITUDE           = 0.2;
  const float COLOR_INTENSITY_BOOST      = 1.4;
  const float NODE_COLOR_INTENSITY_BOOST = 1.6;
  const float DEPTH_COLOR_CONTRAST       = 1.2;
  const float PULSE_HALF_WIDTH           = 0.415;   // PULSE_WIDTH(0.83) / 2
  const float PULSE_MAX_RADIUS           = 4.275;   // OUTER_RADIUS(0.95) * 4.5

  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    float breatheFactor = 0.0;
    if (uBreatheSpeed > 0.0)
      breatheFactor = sin(uTime * uBreatheSpeed + particlePhase);

    float radialWaveOffset   = uTime * uRadialWaveSpeed;
    float angleWaveComponent = sin(particleAngle * RADIAL_WAVE_FREQUENCY + radialWaveOffset);
    float dynamicRadius      = particleRadius + angleWaveComponent * RADIAL_WAVE_AMPLITUDE;
    float pulsedRadius       = dynamicRadius + breatheFactor * RADIAL_PULSE_AMPLITUDE;

    float x_base = cos(particleAngle) * pulsedRadius;
    float y_base = sin(particleAngle) * pulsedRadius;
    float finalX = x_base * SNAKE_EYE_SCALE_X;
    float finalY = y_base * SNAKE_EYE_SCALE_Y;

    float driftZ = particleDriftZ - uTime * uDriftSpeed * uPortalSpeedFactor;
    driftZ = mod(driftZ + PORTAL_DEPTH * 0.5, PORTAL_DEPTH);
    if (driftZ < 0.0) driftZ += PORTAL_DEPTH;
    driftZ -= PORTAL_DEPTH * 0.5;

    float zWaveOffset         = uTime * uZWaveSpeed;
    float zAngleWaveComponent = sin(particleAngle * Z_WAVE_FREQUENCY + zWaveOffset + particlePhase * 0.5);
    float waveZ               = zAngleWaveComponent * Z_WAVE_AMPLITUDE;
    float finalZ              = driftZ + particleZOffset + breatheFactor * AXIAL_PULSE_AMPLITUDE + waveZ;

    vec3 finalPosition = vec3(finalX, finalY, finalZ);

    vOpacity = uParticleOpacity;

    if (particleIsNode > 0.5) {
      vColor = vec3(1.0, 0.67, 0.0) * NODE_COLOR_INTENSITY_BOOST;
      float nodePulse = sin(uTime * 2.0 + particlePhase) * 0.2 + 0.8;
      vColor *= nodePulse;
    } else {
      float colorCycleOffset    = -PORTAL_DEPTH / 2.0;
      float normalizedZPeriodic = (finalZ - colorCycleOffset) / PORTAL_DEPTH;
      normalizedZPeriodic       = normalizedZPeriodic - floor(normalizedZPeriodic);
      float enhancedNormalizedZ = pow(normalizedZPeriodic, DEPTH_COLOR_CONTRAST);
      vColor = mix(uPortalColorFar, uPortalColorNear, enhancedNormalizedZ) * COLOR_INTENSITY_BOOST;

      float pulseIntensity = 0.0;
      for (int i = 0; i < MAX_PULSES; i++) {
        if (i >= uActivePulseCount) break;
        float dist = distance(finalPosition, uPulseOrigins[i]);
        float diff = abs(dist - uPulseTravelRadii[i]);
        if (diff < PULSE_HALF_WIDTH) {
          float fadeOut = max(0.0, 1.0 - uPulseTravelRadii[i] / PULSE_MAX_RADIUS);
          float hit     = (1.0 - diff / PULSE_HALF_WIDTH) * fadeOut;
          pulseIntensity = max(pulseIntensity, hit);
        }
      }
      vColor = mix(vColor, uPulseColor * 1.2, pulseIntensity);

      float breathLuminosity = breatheFactor * 0.15 + 1.0;
      vColor *= breathLuminosity;
    }

    vec4 mvPosition = modelViewMatrix * vec4(finalPosition, 1.0);
    gl_Position     = projectionMatrix * mvPosition;
    gl_PointSize    = 3.5;
  }
`;
export const fragmentShader = `
  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    float dist        = distance(gl_PointCoord, vec2(0.5));
    vec3  brightColor = vColor * 1.4;
    float glowFactor  = max(0.0, 1.5 - dist * 1.5);
    vec3  finalColor  = brightColor * glowFactor * 2.0;
    float alpha       = vOpacity * smoothstep(1.0, 0.0, dist * 1.8);
    gl_FragColor = vec4(finalColor, alpha);
  }
`;
