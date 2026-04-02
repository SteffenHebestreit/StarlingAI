import { describe, expect, it } from "vitest";
import { parseContainerDiagnosticLine } from "../agent/container-runner.js";
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
});