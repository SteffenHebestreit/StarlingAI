import { describe, expect, it } from "vitest";
import {
  buildScreenshotPrompt,
  normalizeScreenshotAnalysisFocus,
} from "../agent/computer-vision.js";

describe("computer vision prompt selection", () => {
  it("uses the LM Studio prompt for loaded-model inspection hints", () => {
    expect(normalizeScreenshotAnalysisFocus("LM Studio loaded models")).toBe("lmstudio_loaded_models");
    expect(normalizeScreenshotAnalysisFocus("welche models sind in lm studio geladen?")).toBe("lmstudio_loaded_models");

    const prompt = buildScreenshotPrompt(undefined, "LM Studio loaded models");
    expect(prompt).toContain("Loaded Models list");
    expect(prompt).toContain("Do not omit rows");
    expect(prompt).toContain("Reachable at");
  });

  it("keeps the generic prompt when no specialized focus is provided", () => {
    expect(normalizeScreenshotAnalysisFocus("browser toolbar")).toBeNull();

    const prompt = buildScreenshotPrompt();
    expect(prompt).toContain("STEP 1 — IDENTIFY ALL APPLICATIONS");
    expect(prompt).toContain("STEP 2 — READ ALL TEXT");
  });
});