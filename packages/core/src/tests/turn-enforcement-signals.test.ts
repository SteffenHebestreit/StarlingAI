import { describe, it, expect } from "vitest";
import { computeTurnEnforcementSignals } from "../agent/turn-setup.js";

// The up-front source-sensitivity classifier (orchestration.upfrontSourceSensitiveClassifier) feeds
// its verdict here as `upfrontSourceSensitive`. It must re-arm requiresDelegatedResearch exactly like
// guidance.sourceSensitive would — that is the signal that makes the runtime research FIRST (suppress
// the draft + force orchestration) instead of "answer, then research" (audit a75e1c26 follow-up).
describe("computeTurnEnforcementSignals — up-front source-sensitivity re-arm", () => {
  const base = {
    initialDynamicGuidance: null,
    channel: "webchat",
    allowedToolNameSet: new Set<string>(),
    userMessage: "Wie funktioniert das Pfandsystem in Dänemark?", // no URL → requiresUrlFetch stays off
    recentWorkflowAuthoringMaintenanceContext: false,
  };

  it("fires requiresDelegatedResearch when the up-front classifier flagged the question (orchestration_only)", () => {
    const sig = computeTurnEnforcementSignals({ ...base, effectiveToolMode: "orchestration_only", upfrontSourceSensitive: true });
    expect(sig.requiresDelegatedResearch).toBe(true);
  });

  it("does NOT fire without the up-front verdict and with no source/freshness guidance", () => {
    const sig = computeTurnEnforcementSignals({ ...base, effectiveToolMode: "orchestration_only", upfrontSourceSensitive: false });
    expect(sig.requiresDelegatedResearch).toBe(false);
  });

  it("respects tool mode: an up-front verdict outside orchestration_only does not force research", () => {
    const sig = computeTurnEnforcementSignals({ ...base, effectiveToolMode: undefined, upfrontSourceSensitive: true });
    expect(sig.requiresDelegatedResearch).toBe(false);
  });

  it("omitting the param is backwards-compatible (undefined → off)", () => {
    const sig = computeTurnEnforcementSignals({ ...base, effectiveToolMode: "orchestration_only" });
    expect(sig.requiresDelegatedResearch).toBe(false);
  });
});
