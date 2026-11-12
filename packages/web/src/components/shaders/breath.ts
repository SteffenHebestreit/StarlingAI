// The orb's breath as light. Every layer of the orb swells with one breath (OrbCanvas
// entityBreath); each time the core is at its brightest a crest of light leaves it and travels
// outward — through the hologram sphere's rings, the dust beyond them and the step ring. One
// formula, shared by every shader that shows it, so the crest is in the same place in all of them.
//
// `phase` is the entity's breath (the core peaks when sin(phase) is 1), `radius` the distance from
// the orb's centre in orb units.
export const BREATH_WAVE = `
  const float BREATH_WAVE_NUMBER = 3.2;
  // -1..1: where the breath is at this radius.
  float breathSwell(float phase, float radius) {
    return sin(phase - radius * BREATH_WAVE_NUMBER);
  }
  // 0 between crests, 1 on one.
  float breathCrest(float phase, float radius) {
    return pow(0.5 + 0.5 * breathSwell(phase, radius), 4.0);
  }
`;
