import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath, GENERATED_SUBDIR } from "../tools/workspace-path.js";

const WS = resolve("/tmp/ws");

describe("resolveWorkspaceWritePath", () => {
  it("roots a bare relative path under generated/", () => {
    const r = resolveWorkspaceWritePath("index.html", WS);
    expect(r.relativePath).toBe("generated/index.html");
    expect(r.resolved).toBe(resolve(WS, "generated", "index.html"));
  });

  it("roots nested project paths under generated/", () => {
    const r = resolveWorkspaceWritePath("site/css/app.css", WS);
    expect(r.relativePath).toBe("generated/site/css/app.css");
  });

  it("strips the /workspace virtual prefix then roots under generated/", () => {
    const r = resolveWorkspaceWritePath("/workspace/report.md", WS);
    expect(r.relativePath).toBe("generated/report.md");
  });

  it("is idempotent for paths already inside generated/", () => {
    const r = resolveWorkspaceWritePath(`${GENERATED_SUBDIR}/site/index.html`, WS);
    expect(r.relativePath).toBe("generated/site/index.html");
    expect(r.relativePath.startsWith("generated/generated")).toBe(false);
  });

  it("rejects paths escaping the workspace", () => {
    expect(() => resolveWorkspaceWritePath("../../etc/passwd", WS)).toThrow(/escapes workspace boundary/);
  });

  it("leaves reads workspace-wide (resolvePathWithinWorkspace is unchanged)", () => {
    // Reads must still reach the config zone, e.g. a scene definition.
    const r = resolvePathWithinWorkspace("scenes/10-scenes.jsonc", WS);
    expect(r.relativePath).toBe("scenes/10-scenes.jsonc");
    expect(r.relativePath.startsWith("generated/")).toBe(false);
  });
});
