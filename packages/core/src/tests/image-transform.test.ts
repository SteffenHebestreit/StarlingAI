/**
 * Local raster edits, proved to be edits — not regenerations.
 *
 * The whole point of this path is that it is NOT the diffusion model. A user asking to
 * sharpen a picture wants that picture sharper; sending it to the image model would spend
 * ~170s of a shared GPU and return a different scene, which is the failure that lost a user
 * their palm trees over three rounds of "continue from the last one".
 *
 * So the assertions are mostly about what does NOT change: dimensions that must survive a
 * colour operation, pixels that must survive a crop, and a refusal where a silent clamp
 * would have produced a different picture from the one asked for.
 */
import { describe, expect, it } from "vitest";
import Jimp from "jimp";

import { transformImage, type ImageTransformOp } from "../multimodal/image-transform.js";

/** A small image with structure, so a transform has something to preserve or change. */
async function sample(width = 16, height = 12): Promise<Buffer> {
  const image = new Jimp(width, height, 0x204060ff);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      if ((x + y) % 4 === 0) image.setPixelColor(0xf0d080ff, x, y);
    }
  }
  return Buffer.from(await image.getBufferAsync(Jimp.MIME_PNG));
}

const pixels = async (bytes: Buffer): Promise<Jimp> => Jimp.read(bytes);

describe("local image transforms", () => {
  it("sharpens without changing the size — it is the same picture", async () => {
    const src = await sample();
    const out = await transformImage(src, [{ op: "sharpen", amount: 0.5 }]);

    expect(out.before).toEqual({ width: 16, height: 12 });
    expect(out.after).toEqual({ width: 16, height: 12 });
    expect(out.applied).toEqual(["sharpen(0.5)"]);
    // Actually different bytes: a no-op that reported success would be the worse failure.
    expect(out.bytes.equals(src)).toBe(false);
  });

  it("resizes on one axis and keeps the aspect ratio", async () => {
    const out = await transformImage(await sample(16, 12), [{ op: "resize", width: 8 }]);

    expect(out.after).toEqual({ width: 8, height: 6 });
  });

  it("crops exactly the region asked for, and keeps those pixels", async () => {
    const src = await sample(16, 12);
    const before = await pixels(src);
    const expected = before.getPixelColor(4, 3);

    const out = await transformImage(src, [{ op: "crop", x: 4, y: 3, width: 6, height: 5 }]);

    expect(out.after).toEqual({ width: 6, height: 5 });
    // The cropped image's top-left must BE the source pixel at the crop origin. A crop that
    // resampled or shifted would pass a dimensions-only check while returning other pixels.
    expect((await pixels(out.bytes)).getPixelColor(0, 0)).toBe(expected);
  });

  it("REFUSES a crop that does not fit instead of quietly shrinking it", async () => {
    // A clamped crop returns a different picture from the one requested and nothing
    // downstream can tell. Refusing is the only honest answer.
    await expect(transformImage(await sample(16, 12), [{ op: "crop", x: 10, y: 10, width: 20, height: 20 }]))
      .rejects.toThrow(/does not fit inside 16x12/);
  });

  it("applies operations IN ORDER, which is why one call can do both", async () => {
    // crop-then-resize and resize-then-crop give different pictures from the same inputs;
    // if order were not honoured, one of these would come out the size of the other.
    const src = await sample(16, 12);
    const cropFirst = await transformImage(src, [
      { op: "crop", x: 0, y: 0, width: 8, height: 8 },
      { op: "resize", width: 4, height: 4 },
    ]);
    const resizeFirst = await transformImage(src, [
      { op: "resize", width: 8, height: 8 },
      { op: "crop", x: 0, y: 0, width: 4, height: 4 },
    ]);

    expect(cropFirst.after).toEqual({ width: 4, height: 4 });
    expect(resizeFirst.after).toEqual({ width: 4, height: 4 });
    expect(cropFirst.bytes.equals(resizeFirst.bytes)).toBe(false);
  });

  it("leaves dimensions alone for colour operations — the control", async () => {
    // Without this, an implementation that resized on every call would satisfy several
    // assertions above while silently changing images it was only asked to adjust.
    for (const operation of [
      { op: "brightness", amount: 0.2 },
      { op: "contrast", amount: 0.2 },
      { op: "grayscale" },
      { op: "soften", radius: 1 },
    ] as ImageTransformOp[]) {
      const out = await transformImage(await sample(16, 12), [operation]);
      expect(out.after, `${operation.op} changed the size`).toEqual({ width: 16, height: 12 });
    }
  });

  it("rotates by 90 degrees and swaps the axes", async () => {
    const out = await transformImage(await sample(16, 12), [{ op: "rotate", degrees: 90 }]);
    expect(out.after).toEqual({ width: 12, height: 16 });
  });

  it("rejects an empty operation list rather than copying the file", async () => {
    await expect(transformImage(await sample(), [])).rejects.toThrow(/at least one/);
  });

  it("reports what it did, so the caller can state it instead of guessing", async () => {
    const out = await transformImage(await sample(16, 12), [
      { op: "crop", x: 0, y: 0, width: 8, height: 8 },
      { op: "sharpen" },
    ]);
    expect(out.applied).toEqual(["crop(0,0 8x8)", "sharpen(1)"]);
  });
});
