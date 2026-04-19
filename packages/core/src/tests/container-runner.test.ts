import { describe, expect, it } from "vitest";
import { parseContainerDiagnosticLine, probeDockerReachability } from "../agent/container-runner.js";
import { resolveDockerWorkspaceMountSource } from "../tools/workspace-mount.js";

describe("container runner diagnostics", () => {
  it("parses readiness markers with bootstrap timing", () => {
    expect(parseContainerDiagnosticLine("READY:187")).toEqual({
      type: "ready",
      bootstrapMs: 187,
    });
  });

  it("parses heartbeat markers", () => {
    expect(parseContainerDiagnosticLine("HEARTBEAT:1710600000000")).toEqual({
      type: "heartbeat",
    });
  });

  it("ignores non-diagnostic stderr lines", () => {
    expect(parseContainerDiagnosticLine("regular stderr output")).toBeNull();
  });

  it("prefers an explicit workspace mount source for docker child containers", () => {
    expect(
      resolveDockerWorkspaceMountSource("/workspace", {
        mountSource: "/run/desktop/mnt/host/f/StarlingAI",
        fallbackVolume: "gc-workspace",
      }),
    ).toBe("/run/desktop/mnt/host/f/StarlingAI");
  });

  it("falls back to the shared workspace volume when no host mount source is provided", () => {
    expect(
      resolveDockerWorkspaceMountSource("/workspace/subdir", {
        mountSource: "",
        fallbackVolume: "gc-workspace",
      }),
    ).toBe("gc-workspace");
  });

  it("passes through non-default workspace paths unchanged", () => {
    expect(
      resolveDockerWorkspaceMountSource("/tmp/custom-workspace", {
        mountSource: "/run/desktop/mnt/host/f/StarlingAI",
        fallbackVolume: "gc-workspace",
      }),
    ).toBe("/tmp/custom-workspace");
  });

  it("probeDockerReachability resolves with reachable=true or returns a structured failure", async () => {
    // Real probe — environment-dependent, so we only assert structural shape.
    const result = await probeDockerReachability(3000);
    expect(typeof result.reachable).toBe("boolean");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    if (result.reachable) {
      expect(result.serverVersion).toBeTruthy();
      expect(result.error).toBeUndefined();
    } else {
      expect(result.error).toBeTruthy();
    }
  }, 10_000);

  it("probeDockerReachability honors a tight timeout when docker is missing", async () => {
    // Override PATH so the docker binary cannot be found, forcing the spawn to fail
    // fast. This validates that probe failures surface as structured errors rather
    // than throwing.
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-path-for-test";
    try {
      const result = await probeDockerReachability(2000);
      expect(result.reachable).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.durationMs).toBeLessThan(3000);
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  }, 10_000);
});