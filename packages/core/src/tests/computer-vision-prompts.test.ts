import { describe, expect, it } from "vitest";
import {
  computeScreenshotHash,
  normalizeScreenshotAnalysisFocus,
  buildScreenshotPrompt,
  buildComputerVisionPrompt,
} from "../agent/computer-vision.js";

// Pure screenshot prompt/hash helpers (no vision-model calls).
describe("computer-vision pure prompt helpers", () => {
  it("computeScreenshotHash is deterministic and differs for different bytes", () => {
    const a = computeScreenshotHash(new Uint8Array([1, 2, 3, 4]));
    const b = computeScreenshotHash(new Uint8Array([1, 2, 3, 4]));
    const c = computeScreenshotHash(new Uint8Array([9, 9, 9]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("normalizeScreenshotAnalysisFocus maps LM-Studio phrasing (any language) to a focus, else null", () => {
    expect(normalizeScreenshotAnalysisFocus("welche models sind geladen")).toBe("lmstudio_loaded_models");
    expect(normalizeScreenshotAnalysisFocus("loaded models")).toBe("lmstudio_loaded_models");
    expect(normalizeScreenshotAnalysisFocus("something unrelated")).toBeNull();
    expect(normalizeScreenshotAnalysisFocus("")).toBeNull();
    expect(normalizeScreenshotAnalysisFocus(undefined)).toBeNull();
  });

  it("buildScreenshotPrompt honors an explicit prompt, else picks focus/default", () => {
    expect(buildScreenshotPrompt("just do X")).toBe("just do X");
    expect(buildScreenshotPrompt(undefined, "loaded models")).toContain("Loaded Models");
    expect(buildScreenshotPrompt(undefined, undefined)).toContain("IDENTIFY ALL APPLICATIONS");
  });

  it("buildComputerVisionPrompt embeds the screen state, task, and recent actions", () => {
    const out = buildComputerVisionPrompt(
      { description: "LM Studio is visible with an Eject button", hash: "h1", timestamp: 1782000000000 },
      "click the Eject button",
      ["took a snapshot", "moved the mouse"],
    );
    expect(out).toContain("LM Studio is visible");
    expect(out).toContain("click the Eject button");
    expect(out).toContain("Recent Actions");
    expect(out).toContain("moved the mouse");
  });
});
