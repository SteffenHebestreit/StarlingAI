import { describe, expect, it } from "vitest";
import { parseContainerDiagnosticLine } from "../agent/container-runner.js";

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
});