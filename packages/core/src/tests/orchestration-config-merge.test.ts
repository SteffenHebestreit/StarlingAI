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

  it("rejects a body that fails validation", () => {
    const result = mergeOrchestrationConfigUpdate(stored, { planFirst: "yes" });
    expect(result.ok).toBe(false);
  });

  it("is a full, well-formed section even over an empty store", () => {
    const result = mergeOrchestrationConfigUpdate(undefined, { planFirst: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planFirst).toBe(false);
    expect(typeof result.value.qaDeliveryLoop).toBe("boolean");
  });
});
