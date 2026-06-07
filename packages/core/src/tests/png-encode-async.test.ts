import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { encodeRgbaToPng, encodeRgbaToPngAsync } from "../agent/computer-adapters/vnc-protocol.js";

/**
 * P4 perf: the async PNG encoder offloads the dominant cost (deflate of a full
 * framebuffer) to the libuv threadpool so it no longer blocks the gateway event
 * loop on every VNC screenshot. It must produce byte-identical output to the
 * synchronous encoder (same zlib algorithm + level).
 */
function patternRgba(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = (i * 7) & 0xff;       // R
    buf[i * 4 + 1] = (i * 13) & 0xff;  // G
    buf[i * 4 + 2] = (i * 29) & 0xff;  // B
    buf[i * 4 + 3] = 0xff;             // A
  }
  return buf;
}

describe("encodeRgbaToPngAsync", () => {
  it("produces byte-identical output to the synchronous encoder", async () => {
    const w = 17, h = 11;
    const rgba = patternRgba(w, h);
    const sync = encodeRgbaToPng(w, h, rgba);
    const async = await encodeRgbaToPngAsync(w, h, rgba);
    expect(async.equals(sync)).toBe(true);
  });

  it("emits a valid PNG signature + IHDR/IDAT/IEND structure", async () => {
    const png = await encodeRgbaToPngAsync(2, 2, patternRgba(2, 2));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const s = png.toString("latin1");
    expect(s).toContain("IHDR");
    expect(s).toContain("IDAT");
    expect(s).toContain("IEND");
  });
});
