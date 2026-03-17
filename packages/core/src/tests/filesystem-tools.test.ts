import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("filesystem tools", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-filesystem-tools-"));

  beforeAll(async () => {
    mkdirSync(join(tempDir, "uploads"), { recursive: true });
    writeFileSync(join(tempDir, "uploads", "screenshot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await import("../tools/filesystem.js");
  });

  it("lists files for a /workspace-prefixed directory", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("list_files");

    const result = await tool!.execute({ path: "/workspace/uploads" }, {
      sessionId: "session-list-workspace-prefix",
      workspacePath: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("screenshot.png");
  });
});