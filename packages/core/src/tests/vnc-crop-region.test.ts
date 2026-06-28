import { describe, it, expect } from "vitest";
import { cropRgbaRegion } from "../agent/computer-adapters/vnc-protocol.js";

// Build a w×h RGBA framebuffer whose RED channel encodes each pixel's position
// (R = px*10 + py), so a crop's pixels can be checked against their source coords.
function buildFb(w: number, h: number): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const o = (py * w + px) * 4;
      buf[o] = px * 10 + py; // R encodes position
      buf[o + 3] = 255;      // A
    }
  }
  return buf;
}

describe("cropRgbaRegion (B25 VNC region capture)", () => {
  const W = 4, H = 3;
  const fb = buildFb(W, H);

  it("crops the requested rect with the correct pixels and dimensions", () => {
    const r = cropRgbaRegion(fb, W, H, 1, 1, 2, 2);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(r.data.length).toBe(2 * 2 * 4);
    expect(r.data[0]).toBe(11);     // cropped(0,0) ← source(1,1)
    expect(r.data[4]).toBe(21);     // cropped(1,0) ← source(2,1)
    expect(r.data[8]).toBe(12);     // cropped(0,1) ← source(1,2)
    expect(r.data[12]).toBe(22);    // cropped(1,1) ← source(2,2)
  });

  it("clamps an over-large region to the screen bounds", () => {
    const r = cropRgbaRegion(fb, W, H, 3, 2, 10, 10);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
    expect(r.data[0]).toBe(32);     // source(3,2)
  });

  it("clamps a negative origin to (0,0)", () => {
    const r = cropRgbaRegion(fb, W, H, -5, -5, 2, 2);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(r.data[0]).toBe(0);      // source(0,0)
    expect(r.data[4]).toBe(10);     // source(1,0)
    expect(r.data[8]).toBe(1);      // source(0,1)
  });
});
