/**
 * A generated image must be findable by whoever needs it NEXT.
 *
 * Session 2c6bdb30: turn one made a sunset, turn two asked to make it realistic. The
 * orchestrator's task said "basierend auf dem Originalbild" and named no path, and turn one's
 * agent had not called share_finding, so the shared facts were empty. image_creator then
 * probed `/workspace/workspace/users/<seg>`, then `workspace/users/<seg>`, then the same path
 * again — all directories, all ENOENT — and fell back to a fresh generation. The user got a
 * second unrelated beach with no sign that "based on the original" had been dropped.
 *
 * The instruction to publish existed and was skipped, which is the point: it was one line
 * among many in a prompt. Recording the path is now something the TOOL does, so it happens
 * whether or not any agent remembers, and under the SHARED session id — a sub-agent writing
 * only into its own sub-session would be invisible to the sibling that needs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeSharedFact = vi.fn<(sessionId: string, key: string, value: string) => Promise<void>>(async () => {});

vi.mock("../swarm/memory.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../swarm/memory.js")),
  writeSharedFact,
}));

const { deriveSharedSessionId } = await import("../tools/memory.js");

describe("image artifact handoff", () => {
  beforeEach(() => { writeSharedFact.mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("collapses a sub-agent session to the shared one the siblings can read", () => {
    // The exact id shape from the failing session.
    const sub = "sub:2c6bdb30-fbbe-4c66-91b2-681a7f8c8dc8:image_creator:1790026362467";
    expect(deriveSharedSessionId(sub)).toBe("2c6bdb30-fbbe-4c66-91b2-681a7f8c8dc8");
  });

  it("collapses a NESTED sub-agent session too", () => {
    // Coordinators delegate onward, so two levels is a real shape — the coder in session
    // a1ea2ddf ran at sub:sub:<parent>:mission_coordinator:<ts>:coder:<ts>.
    const nested = "sub:sub:a1ea2ddf-3707-4aa3-8d7b-04eb11030807:mission_coordinator:1790024540141:coder:1790024793920";
    expect(deriveSharedSessionId(nested)).toBe("a1ea2ddf-3707-4aa3-8d7b-04eb11030807");
  });

  it("leaves a top-level session id alone — the control", () => {
    // Without this, a deriver that always stripped a prefix would corrupt the ordinary case.
    expect(deriveSharedSessionId("2c6bdb30-fbbe-4c66-91b2-681a7f8c8dc8"))
      .toBe("2c6bdb30-fbbe-4c66-91b2-681a7f8c8dc8");
  });

  it("publishes both a latest pointer and a per-file entry", async () => {
    // "the previous one" and "the one called sunset_beach" are both things users say, so the
    // path is recorded under both a moving pointer and a stable name.
    const { publishImageArtifactForTests } = await import("../tools/multimodal.js");
    await publishImageArtifactForTests(
      "sub:2c6bdb30-fbbe-4c66-91b2-681a7f8c8dc8:image_creator:1790026362467",
      "generated/.starlingai/generated/sunset_beach.png",
    );

    const keys = writeSharedFact.mock.calls.map((call) => call[1]);
    expect(keys).toContain("latest_image");
    expect(keys).toContain("image:sunset_beach.png");
    // All of it under the PARENT id, or the next agent cannot see it.
    for (const call of writeSharedFact.mock.calls) {
      expect(call[0]).toBe("2c6bdb30-fbbe-4c66-91b2-681a7f8c8dc8");
      expect(call[2]).toBe("generated/.starlingai/generated/sunset_beach.png");
    }
  });

  it("never fails a finished image because the fact store is down", async () => {
    // The image is already on disk. Losing it to a memory backend outage would turn a
    // successful generation into a reported failure.
    writeSharedFact.mockRejectedValueOnce(new Error("redis unreachable"));
    const { publishImageArtifactForTests } = await import("../tools/multimodal.js");

    await expect(publishImageArtifactForTests("session-1", "generated/x.png")).resolves.toBeUndefined();
  });

  it("does nothing without a session — no crash, no write", async () => {
    const { publishImageArtifactForTests } = await import("../tools/multimodal.js");
    await publishImageArtifactForTests(undefined, "generated/x.png");
    expect(writeSharedFact).not.toHaveBeenCalled();
  });
});
