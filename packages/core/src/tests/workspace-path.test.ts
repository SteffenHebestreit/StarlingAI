import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath, GENERATED_SUBDIR } from "../tools/workspace-path.js";
import { runWithRequestContext } from "../runtime/request-context.js";

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

/**
 * Workspace zoning (audit 0ac7d3fc): scope-confined agents (the sub-agent default)
 * see only generated/ + uploads/; everything else re-roots into generated/ so a
 * working agent physically cannot wander into the platform's config zones or burn
 * minutes reading its docs. Core agents (workspaceAccess:"full") and runtime code
 * paths run without the scope and keep the whole workspace.
 */
describe("workspace zoning — scope-confined path resolution", () => {
  const scoped = <T>(fn: () => T): T => runWithRequestContext({ workspaceScope: "generated" }, fn);

  it("re-roots config-zone reads into generated/ under scope", () => {
    const r = scoped(() => resolvePathWithinWorkspace("README.md", WS));
    expect(r.relativePath).toBe("generated/README.md");
    const cfg = scoped(() => resolvePathWithinWorkspace("scenes/10-scenes.jsonc", WS));
    expect(cfg.relativePath).toBe("generated/scenes/10-scenes.jsonc");
  });

  it("re-roots the workspace root listing into generated/ under scope", () => {
    const r = scoped(() => resolvePathWithinWorkspace(".", WS));
    expect(r.relativePath).toBe(GENERATED_SUBDIR);
    expect(r.resolved).toBe(resolve(WS, GENERATED_SUBDIR));
  });

  it("keeps generated/ and uploads/ visible verbatim under scope", () => {
    expect(scoped(() => resolvePathWithinWorkspace("generated/site/index.html", WS)).relativePath)
      .toBe("generated/site/index.html");
    expect(scoped(() => resolvePathWithinWorkspace("uploads/brief.pdf", WS)).relativePath)
      .toBe("uploads/brief.pdf");
  });

  it("keeps read-after-write consistent: bare write target and bare read resolve to the same file", () => {
    const written = scoped(() => resolveWorkspaceWritePath("index.html", WS));
    const read = scoped(() => resolvePathWithinWorkspace("index.html", WS));
    expect(read.resolved).toBe(written.resolved);
  });

  it("does not double-root writes under scope", () => {
    const r = scoped(() => resolveWorkspaceWritePath("site/app.css", WS));
    expect(r.relativePath).toBe("generated/site/app.css");
    expect(r.relativePath.includes("generated/generated")).toBe(false);
  });

  it("still rejects workspace escapes under scope", () => {
    expect(() => scoped(() => resolvePathWithinWorkspace("../../etc/passwd", WS))).toThrow(/escapes workspace boundary/);
  });

  it("full scope and no scope leave resolution unchanged", () => {
    const full = runWithRequestContext({ workspaceScope: "full" }, () => resolvePathWithinWorkspace("README.md", WS));
    expect(full.relativePath).toBe("README.md");
    const unscoped = resolvePathWithinWorkspace("README.md", WS);
    expect(unscoped.relativePath).toBe("README.md");
  });
});
