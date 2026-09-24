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
import { afterEach, describe, expect, it, vi } from "vitest";
import Jimp from "jimp";

import { transformImage, type ImageTransformOp } from "../multimodal/image-transform.js";

/** A PNG header declaring `width`x`height` and nothing to decode: a few bytes that ask for gigabytes. */
function pngDeclaring(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, iend]);
}

/** A 2048x2048 JPEG frame naming 20 components: jpeg-js allocates for each, then throws. */
function jpegNaming20Components(): Buffer {
  const segment = (marker: number, body: number[]) => Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
  const frame = [8, 0x08, 0x00, 0x08, 0x00, 20];
  for (let id = 1; id <= 20; id++) frame.push(id, 0x11, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    segment(0xc0, frame),
    segment(0xc4, [0x00, 1, ...new Array<number>(15).fill(0), 0x00]),
    segment(0xc4, [0x10, 1, ...new Array<number>(15).fill(0), 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("reads a null side as omitted, and refuses a resize with neither side", async () => {
    // Models send null for an optional field they leave out; that is the aspect-ratio side, not a
    // size to refuse. Both null used to pass the "width, height, or both" check and end in Jimp's
    // own "w and h cannot both be set to auto".
    const out = await transformImage(await sample(16, 12), [{ op: "resize", width: null, height: 6 } as never]);
    expect(out.after).toEqual({ width: 8, height: 6 });
    await expect(transformImage(await sample(16, 12), [{ op: "resize", width: null, height: null } as never]))
      .rejects.toThrow("resize needs a width, a height, or both.");
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

  it("holds a turn by any other angle to the bound, measured on the canvas Jimp turns it on", async () => {
    // The control: an angle within the bound still turns, to Jimp's own bounding box.
    const turned = await transformImage(await sample(16, 12), [{ op: "rotate", degrees: 45 }]);
    expect(turned.after).toEqual({ width: 22, height: 22 });

    // A 6400x1 strip turned 1° comes out 6402x114, under 1 MP, so a bound on the result lets it
    // through; Jimp first fills a 6402x6402 canvas, 41 MP, and turns it into a second one.
    const strip = await sample(6400, 1);
    await expect(transformImage(strip, [{ op: "rotate", degrees: 1 }]))
      .rejects.toThrow("rotate(1°) turns this 6400x1 picture on a 6402x6402 canvas, larger than the 40 MP transform_image works within."
        + " Resize its longer side to 6323 or less first (one call can do both, in that order).");

    // The way forward it names must BE one, and the longest: resized to 6323 the strip passes the
    // bound, at 6324 it does not. Jimp's turn itself is stubbed, since a 40 MP canvas is seconds of
    // work that proves nothing about the bound (measured separately: the real turn succeeds, 6324x114).
    const turn = vi.spyOn(Jimp.prototype, "rotate").mockImplementation(function (this: Jimp) { return this; });
    await transformImage(strip, [{ op: "resize", width: 6323 }, { op: "rotate", degrees: 1 }]);
    expect(turn).toHaveBeenCalledTimes(1);
    await expect(transformImage(strip, [{ op: "resize", width: 6324 }, { op: "rotate", degrees: 1 }]))
      .rejects.toThrow("on a 6326x6326 canvas");
  });

  it("does not hold a right-angle turn to that canvas, and refuses an angle that is no number", async () => {
    // A right angle only swaps the sides, so the same strip that 1° refuses turns 90° untouched —
    // otherwise a 7000x5000 picture, 35 MP and allowed, would be refused a quarter turn.
    expect((await transformImage(await sample(6400, 1), [{ op: "rotate", degrees: 90 }])).after)
      .toEqual({ width: 1, height: 6400 });

    // Infinity (JSON's 1e999) made the canvas NaN, which passed the bound, and Jimp then failed
    // with a message about a buffer size.
    await expect(transformImage(await sample(), [{ op: "rotate", degrees: Infinity }]))
      .rejects.toThrow("rotate needs its degrees as a finite number, not Infinity.");

    // Sent as text, the angle is refused as text: "not 90" read as though 90 itself were wrong.
    await expect(transformImage(await sample(), [{ op: "rotate", degrees: "90" as unknown as number }]))
      .rejects.toThrow('rotate needs its degrees as a number, not the text "90".');
  });

  it("rejects an empty operation list rather than copying the file", async () => {
    await expect(transformImage(await sample(), [])).rejects.toThrow(/at least one/);
  });

  it("judges a picture from its header before decoding it, and refuses one that asks for too much", async () => {
    const read = vi.spyOn(Jimp, "read");
    await expect(transformImage(pngDeclaring(7000, 7000), [{ op: "sharpen" }]))
      .rejects.toThrow("The picture is 7000x7000; transform_image works on pictures up to 40 MP. Nothing was changed.");
    await expect(transformImage(jpegNaming20Components(), [{ op: "sharpen" }]))
      .rejects.toThrow(/none of them or is built to decode larger than it declares\. Nothing was changed\./);
    expect(read, "a crafted picture was decoded").not.toHaveBeenCalled();

    // What it produces is held to the same bound: 8000 wide keeps the aspect, 8000x6000 is 48 MP.
    await expect(transformImage(await sample(16, 12), [{ op: "resize", width: 8000 }]))
      .rejects.toThrow("resize to 8000xauto is larger than the 40 MP transform_image works within.");
  });

  it("holds a resize to the rows it widens, not only to what comes out", async () => {
    // 7x7000 made 7000x7 is 0.05 MP in and out, but Jimp widens all 7000 rows to 7000 first:
    // a 49 MP float buffer, 784 MB, before the height changes.
    const strip = await sample(7, 7000);
    await expect(transformImage(strip, [{ op: "resize", width: 7000, height: 7 }]))
      .rejects.toThrow("resize to 7000x7 first widens all 7000 rows of this 7x7000 picture to 7000, larger than the 40 MP"
        + " transform_image works within. Change the height first: resize{width: 7, height: 7}, then"
        + " resize{width: 7000, height: 7} (one call can do both, in that order).");

    // And the way it names works.
    const out = await transformImage(strip, [{ op: "resize", width: 7, height: 7 }, { op: "resize", width: 7000, height: 7 }]);
    expect(out.after).toEqual({ width: 7000, height: 7 });
  });

  it("holds a resize to the sides Jimp makes, and refuses a side that is no size", async () => {
    // Jimp reads -1 as the side that keeps the aspect ratio and rounds 0.4 up to 1: -1x8000 made
    // 10667x8000, 85 MP, and 0.4x100000000 multiplied to 40 MP on the way to 1x100000000. Jimp's
    // resize is stubbed to fail, so a bound that lets either through fails here in milliseconds.
    vi.spyOn(Jimp.prototype, "resize").mockImplementation(() => {
      throw new Error("resized past the bound");
    });
    await expect(transformImage(await sample(), [{ op: "resize", width: -1, height: 8000 }]))
      .rejects.toThrow("resize needs its width as a finite number above 0, not -1. Omit a side to keep the aspect ratio.");
    await expect(transformImage(await sample(), [{ op: "resize", width: 0.4, height: 100_000_000 }]))
      .rejects.toThrow("resize to 0.4x100000000 is larger than the 40 MP transform_image works within.");
  });

  it("refuses an amount that is no number, and reports each amount as applied", async () => {
    // Each of these was a success: soften "abc" left every pixel transparent black, reported as
    // soften(radius NaN), and the others turned the picture black.
    for (const [operation, refusal] of [
      [{ op: "soften", radius: "abc" }, 'soften needs its radius as a number, not the text "abc".'],
      [{ op: "sharpen", amount: "abc" }, 'sharpen needs its amount as a number, not the text "abc".'],
      [{ op: "brightness", amount: Number.NaN }, "brightness needs its amount as a finite number, not NaN."],
      [{ op: "contrast" }, "contrast needs its amount as a finite number, not undefined."],
    ] as Array<[ImageTransformOp, string]>) {
      await expect(transformImage(await sample(), [operation])).rejects.toThrow(refusal);
    }

    // Out of range, each is clamped, and the report says to what rather than repeating the request.
    const out = await transformImage(await sample(), [
      { op: "sharpen", amount: 5 },
      { op: "brightness", amount: 2 },
      { op: "contrast", amount: -4 },
    ]);
    expect(out.applied).toEqual(["sharpen(3)", "brightness(1)", "contrast(-1)"]);
    // And that is what was done: a sharpen of 5 is the same picture as one of 3, on a picture
    // faint enough that neither is cut off at black or white (the sample is, by 3).
    const faint = Buffer.from(await new Jimp(16, 12, 0x808080ff).setPixelColor(0x848484ff, 8, 6).getBufferAsync(Jimp.MIME_PNG));
    const five = await transformImage(faint, [{ op: "sharpen", amount: 5 }]);
    const three = await transformImage(faint, [{ op: "sharpen", amount: 3 }]);
    expect(five.bytes.equals(three.bytes)).toBe(true);
  });

  it("softens no wider than Jimp can count, and says which radius it used", async () => {
    // Past radius 144 Jimp's blur overflows its 32-bit sums: radius 300 left every pixel fully
    // transparent black, and radius 200 half-transparent, each reported as a soften that worked.
    for (const radius of [200, 300]) {
      const out = await transformImage(await sample(16, 12), [{ op: "soften", radius }]);
      expect(out.applied).toEqual(["soften(radius 144)"]);
      const softened = await pixels(out.bytes);
      softened.scan(0, 0, 16, 12, (x, y, index) => {
        const [red, green, blue, alpha] = softened.bitmap.data.subarray(index, index + 4);
        // Opaque, and between the sample's two colours (0x204060 and 0xf0d080): a blur of them.
        expect([alpha, red! >= 0x20 && red! <= 0xf0, green! >= 0x40 && green! <= 0xd0, blue! >= 0x60 && blue! <= 0x80],
          `radius ${radius} at (${x},${y})`).toEqual([255, true, true, true]);
      });
    }
  });

  it("reports what it did, so the caller can state it instead of guessing", async () => {
    const out = await transformImage(await sample(16, 12), [
      { op: "crop", x: 0, y: 0, width: 8, height: 8 },
      { op: "sharpen" },
    ]);
    expect(out.applied).toEqual(["crop(0,0 8x8)", "sharpen(1)"]);
  });
});
