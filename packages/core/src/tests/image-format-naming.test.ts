/**
 * The bytes on disk must match the name on disk.
 *
 * Session a1ea2ddf is what happens otherwise. An agent asked `generate_image` for
 * `sunset_beach.jpg`; the backend produces PNG only; the client trusted the caller's
 * extension and wrote PNG bytes under a .jpg name. The artifact verifier caught it —
 * "named .jpg but its bytes are PNG, not JPEG — the wrong format was delivered" — and the
 * swarm then spent EIGHT MINUTES on it: an artifact-repair coordinator, an ephemeral agent
 * rejected for requesting generate_image, a 221-second `coder` run transcoding the file, and
 * two progress-verifier interventions. Thirteen minutes of wall clock for one sunset.
 *
 * All of it from a single line that believed the filename over the bytes. The rule here is
 * that a requested format we can encode is PRODUCED, and one we cannot is corrected in the
 * NAME and said out loud — because an agent that reports a path which does not exist has
 * simply moved the failure somewhere harder to see.
 */
import { describe, expect, it } from "vitest";
import Jimp from "jimp";

import { encodeImageAs } from "../multimodal/image-transform.js";

async function png(): Promise<Buffer> {
  const image = new Jimp(8, 8, 0x3366ccff);
  return Buffer.from(await image.getBufferAsync(Jimp.MIME_PNG));
}

const isPng = (b: Buffer) => b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

describe("image output format", () => {
  it("ENCODES to JPEG when .jpg is asked for, instead of mislabelling PNG", async () => {
    const out = await encodeImageAs(await png(), ".jpg");

    expect(out.extension).toBe(".jpg");
    expect(isJpeg(out.bytes), "the bytes must actually be JPEG").toBe(true);
    expect(out.mimeType).toBe(Jimp.MIME_JPEG);
    // Nothing was corrected: the caller got exactly what they asked for.
    expect(out.correctedFrom).toBeUndefined();
  });

  it("treats .jpeg the same as .jpg", async () => {
    const out = await encodeImageAs(await png(), ".jpeg");
    expect(isJpeg(out.bytes)).toBe(true);
    expect(out.extension).toBe(".jpeg");
  });

  it("leaves PNG alone when PNG is asked for — the control", async () => {
    // Without this, an encoder that always transcoded would satisfy the cases above while
    // re-compressing every ordinary generation for nothing.
    const source = await png();
    const out = await encodeImageAs(source, ".png");

    expect(out.bytes).toBe(source);
    expect(out.extension).toBe(".png");
  });

  it("leaves PNG alone when NO extension is asked for", async () => {
    const source = await png();
    const out = await encodeImageAs(source, "");
    expect(out.bytes).toBe(source);
    expect(out.extension).toBe(".png");
  });

  it("CORRECTS the name for a format it cannot produce, and says so", async () => {
    // .webp is not encodable here. The bytes stay PNG and the extension follows them, with
    // `correctedFrom` set so the caller can tell the user the path changed rather than
    // reporting one that does not exist.
    const out = await encodeImageAs(await png(), ".webp");

    expect(isPng(out.bytes)).toBe(true);
    expect(out.extension).toBe(".png");
    expect(out.correctedFrom).toBe(".webp");
  });

  it("never returns an extension that contradicts the bytes — the property that matters", async () => {
    for (const requested of [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".txt", ""]) {
      const out = await encodeImageAs(await png(), requested);
      const claimsJpeg = out.extension === ".jpg" || out.extension === ".jpeg";
      const claimsPng = out.extension === ".png";
      if (claimsJpeg) expect(isJpeg(out.bytes), `${requested} -> ${out.extension}`).toBe(true);
      if (claimsPng) expect(isPng(out.bytes), `${requested} -> ${out.extension}`).toBe(true);
    }
  });
});
