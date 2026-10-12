// Point sprites are sized in drawing-buffer pixels, while everything else in the orb scales
// with the canvas. With fixed sizes a small window shrank the geometry but not the points: the
// core's particles piled onto each other and additive blending turned them into a white disc.
// Every point shader multiplies its authored size by uPointScale (the orb's size on screen
// against the size the look was authored at, at most 1; set by OrbCanvas on each resize), so a
// smaller orb keeps the look of the full-size one.
//
// A point cannot draw smaller than one pixel. Below that it stays one pixel and gives up the
// difference in brightness instead (vPointFade, the area ratio), so a very small canvas does
// not saturate either.
export const POINT_SCALE_VERTEX = `
  uniform float uPointScale;
  varying float vPointFade;
  float scaledPointSize(float size) {
    float s = size * uPointScale;
    vPointFade = s < 1.0 ? s * s : 1.0;
    return max(s, 1.0);
  }
`;

export const POINT_SCALE_FRAGMENT = `
  varying float vPointFade;
`;
