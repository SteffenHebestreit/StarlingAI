import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("main assistant personality service", () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy flat personality files into the structured schema", async () => {
    const userStatePath = mkdtempSync(join(tmpdir(), "starlingai-personality-service-"));
    dirs.push(userStatePath);
    process.env["SAI_USER_MEMORY_PATH"] = userStatePath;

    const personalityPath = join(userStatePath, "main-assistant-personality.json");
    writeFileSync(personalityPath, JSON.stringify({
      identity: "An exacting but funny engineering partner.",
      tone: ["Measured."],
      style: ["Lead with the decisive constraint."],
      quirks: ["Drops a dry one-liner when it fits."],
      growthNotes: ["The user likes stronger opinions when architecture is involved."],
      revision: 4,
      updatedAt: "2026-04-01T12:00:00.000Z",
      updatedBy: "user",
      reason: "Preference tuning",
    }, null, 2), "utf8");

    const service = await import("../personality/service.js");
    const profile = service.loadMainAssistantPersonality();

    expect(profile.schemaVersion).toBe(2);
    expect(profile.identity.core).toBe("An exacting but funny engineering partner.");
    expect(profile.voice.tone).toEqual(["Measured."]);
    expect(profile.voice.style).toEqual(["Lead with the decisive constraint."]);
    expect(profile.voice.quirks).toEqual(["Drops a dry one-liner when it fits."]);
    expect(profile.growth.notes).toEqual(["The user likes stronger opinions when architecture is involved."]);
    expect(profile.collaboration.defaults).toEqual([]);
    expect(profile.collaboration.avoidances).toEqual([]);

    expect(existsSync(personalityPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(personalityPath, "utf8")) as { schemaVersion?: number; identity?: { core?: string } };
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.identity?.core).toBe("An exacting but funny engineering partner.");
  });

  it("supports structured saves for collaboration defaults and avoidances", async () => {
    const userStatePath = mkdtempSync(join(tmpdir(), "starlingai-personality-service-"));
    dirs.push(userStatePath);
    process.env["SAI_USER_MEMORY_PATH"] = userStatePath;

    const service = await import("../personality/service.js");
    const profile = service.saveMainAssistantPersonality({
      schemaVersion: 2,
      identity: {
        core: "A rigorous implementation partner.",
      },
      voice: {
        tone: ["Calm and exact."],
        style: ["State the tradeoff, then commit."],
        quirks: ["Dry humor in small doses."],
      },
      collaboration: {
        defaults: ["Prefer execution-ready recommendations."],
        avoidances: ["Do not pad the answer with generic reassurance."],
      },
      growth: {
        notes: ["The user wants sharper architecture calls."],
      },
    }, {
      updatedBy: "user",
      reason: "Refined the operating shape",
    });

    expect(profile.schemaVersion).toBe(2);
    expect(profile.collaboration.defaults).toEqual(["Prefer execution-ready recommendations."]);
    expect(profile.collaboration.avoidances).toEqual(["Do not pad the answer with generic reassurance."]);
    expect(profile.growth.notes).toEqual(["The user wants sharper architecture calls."]);
  });
});