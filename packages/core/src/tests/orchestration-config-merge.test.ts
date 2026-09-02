import { describe, expect, it } from "vitest";
import { OrchestrationSchema } from "../config/schemas/orchestration.js";
import { mergeOrchestrationConfigUpdate } from "../gateway/orchestration-config-merge.js";

/**
 * PUT /api/orchestration/config used to parse the body against the full schema — which fills
 * every absent key with its default — and store the result. One dashboard toggle reset every
 * other flag of the deployment.
 */
describe("PUT /api/orchestration/config merges over the stored section", () => {
  const stored = OrchestrationSchema.parse({ qaDeliveryLoop: true, planFirst: false });

  it("keeps every flag the body did not mention", () => {
    const result = mergeOrchestrationConfigUpdate(stored, { stablePromptPrefix: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stablePromptPrefix).toBe(false);  // what the caller changed
    expect(result.value.qaDeliveryLoop).toBe(true);       // what it did not
    expect(result.value.planFirst).toBe(false);
  });

  it("merges a nested cap map key by key instead of replacing it", () => {
    // A dashboard form that knows one cap must not tombstone the caps the shards define.
    const withCaps = OrchestrationSchema.parse({ perTurnCaps: { delegate_to_agent: 5, web_search: 20 } });
    const result = mergeOrchestrationConfigUpdate(withCaps, { perTurnCaps: { web_search: 30 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.perTurnCaps).toEqual({ delegate_to_agent: 5, web_search: 30 });
  });

  it("persists only the keys that were stored or sent — never the materialized defaults", () => {
    const result = mergeOrchestrationConfigUpdate({ planFirst: false }, { qaDeliveryLoop: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored).toEqual({ planFirst: false, qaDeliveryLoop: true });
    expect(typeof result.value.stablePromptPrefix).toBe("boolean");   // the resolved view is complete
  });

  it("rejects a body that fails validation", () => {
    expect(mergeOrchestrationConfigUpdate(stored, { planFirst: "yes" }).ok).toBe(false);
  });

  it("is a full, well-formed section even over an empty store", () => {
    const result = mergeOrchestrationConfigUpdate(undefined, { planFirst: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planFirst).toBe(false);
    expect(result.stored).toEqual({ planFirst: false });
  });
});
