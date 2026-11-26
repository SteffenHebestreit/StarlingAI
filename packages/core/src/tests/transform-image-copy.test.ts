/**
 * NAMING A PICTURE DOES NOT CHANGE IT.
 *
 * Session b0a37996: image_creator wanted its finished edit under a readable name and ran
 * transform_image `normalize` over the whole photo to get one — a contrast stretch nobody asked for,
 * on the picture the person had just approved. transform_image with an empty operation list now
 * saves an exact copy, and a JPEG kept as it is is labelled a JPEG.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Jimp from "jimp";
import { encodeImageAs } from "../multimodal/image-transform.js";

describe("transform_image with no operations", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-transform-copy-"));
  let getTool: typeof import("../tools/registry.js").getTool;
  let photo: Buffer;

  const run = (args: Record<string, unknown>) =>
    getTool("transform_image")!.execute(args, { sessionId: "transform-copy", workspacePath: tempDir } as never);

  beforeAll(async () => {
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({ workspacePath: tempDir }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await import("../tools/multimodal.js");
    ({ getTool } = await import("../tools/registry.js"));
    // A low-contrast picture: exactly what normalize would have stretched.
    const picture = new Jimp(64, 48, 0x6a7a6aff);
    picture.scan(0, 0, 32, 48, (_x, _y, at) => { picture.bitmap.data[at] = 0x80; });
    photo = await picture.getBufferAsync(Jimp.MIME_PNG);
    writeFileSync(join(tempDir, "flower.png"), photo);
  });

  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves an exact copy under the name asked for, with every byte as it was", async () => {
    const result = await run({ path: "flower.png", operations: [], outputPath: "retouched/flower_left_hand.png" });

    expect(result.success, String(result.error)).toBe(true);
    expect(result.output).toContain("exact copy");
    const written = String((result.metadata as Record<string, unknown>)["outputPath"]);
    expect(readFileSync(join(tempDir, written)).equals(photo)).toBe(true);
  });

  it("converts the format when the name asks for another one, and says so", async () => {
    const result = await run({ path: "flower.png", operations: [], outputPath: "flower.jpg" });

    expect(result.success, String(result.error)).toBe(true);
    expect(result.output).toContain("JPG copy");
    expect((result.metadata as Record<string, unknown>)["contentType"]).toBe("image/jpeg");
  });

  it("refuses an empty operation list with no name, and a copy onto the picture itself", async () => {
    expect((await run({ path: "flower.png", operations: [] })).error).toMatch(/nothing to do/i);
    expect((await run({ path: "flower.png", operations: [], outputPath: "flower.png" })).error).toMatch(/the picture itself/);
  });
});

describe("encodeImageAs", () => {
  it("labels bytes it keeps as the source's type, not always PNG", async () => {
    const jpeg = await new Jimp(8, 8, 0x336699ff).getBufferAsync(Jimp.MIME_JPEG);

    const kept = await encodeImageAs(jpeg, "", ".jpg");

    expect(kept.bytes).toBe(jpeg);
    expect(kept.mimeType).toBe("image/jpeg");
  });
});
