import { afterEach, describe, expect, it } from "vitest";
import {
  resolveThinkingControls,
  effortForEndpoint,
  isRejectedReasoningEffortError,
  noteRejectedReasoningEffort,
  _resetRejectedReasoningEffortsForTests,
} from "../providers/lmstudio.js";

afterEach(() => _resetRejectedReasoningEffortsForTests());

/**
 * THE CONTROL HAS TO REACH THE WIRE.
 *
 * The routing tier was defaulted to thinking-off in 2066738, but qwen3.6 lands in the
 * `enable_thinking` family, whose branch sent only `chat_template_kwargs.enable_thinking` and
 * dropped `reasoningEffort` entirely. Measured 2026-09-03 against qwen/qwen3.6-35b-a3b on the
 * deployment, judge-shaped prompt, 400-token cap:
 *
 *   no control              1,678 reasoning chars / 400 reasoning tokens / 6.8 s / EMPTY answer
 *   enable_thinking:false   1,678 / 400 / 6.5 s / EMPTY answer      ← identical to no control
 *   reasoning_effort:none       0 /   0 / 0.35 s / "YES"
 *
 * So the shipped switch was inert, and the verdict calls were not merely slow: reasoning consumed
 * the whole budget and they returned nothing at all.
 */
describe("thinking-off reaches the wire for the enable_thinking family", () => {
  it("sends the effort field alongside the flag when thinking is turned off", () => {
    expect(resolveThinkingControls("qwen/qwen3.6-35b-a3b", { enableThinking: false }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: false }, reasoningEffort: "none" });
  });

  it("honours an explicit effort this family used to ignore", () => {
    // What tierModelDefaults("routing") passes: both, and both must survive.
    expect(resolveThinkingControls("qwen/qwen3.6-35b-a3b", { enableThinking: false, reasoningEffort: "none" }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: false }, reasoningEffort: "none" });
    expect(resolveThinkingControls("glm-4.6", { reasoningEffort: "none" }))
      .toEqual({ reasoningEffort: "none" });
  });

  it("does not force a level upward — thinking on is the model's own default here", () => {
    expect(resolveThinkingControls("qwen/qwen3.6-35b-a3b", { enableThinking: true }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: true } });
    expect(resolveThinkingControls("qwen/qwen3.6-35b-a3b", { enableThinking: true, reasoningEffort: "medium" }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: true } });
  });

  it("a pinned graded effort beats the legacy toggle — the precedence the agent configs document", () => {
    // researcher and mission_coordinator pin { reasoningEffort: "medium", enableThinking: false }
    // with the comment "explicit effort overrides the enableThinking toggle, which predates graded
    // effort". Seen live after the rebuild: those agents' calls carry effort "medium" and think a
    // little (53–84 reasoning tokens), which is the configured intent, not an inert switch.
    expect(resolveThinkingControls("qwen/qwen3.6-35b-a3b", { enableThinking: false, reasoningEffort: "medium" }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: false }, reasoningEffort: "medium" });
  });

  it("still emits nothing without a signal", () => {
    expect(resolveThinkingControls("qwen/qwen3.6-35b-a3b", {})).toEqual({});
  });

  it("sends 'none' rather than folding it to a level that still thinks", () => {
    // "low" measured 1,752 reasoning chars in 6.5 s on this model — folding none→low was the bug.
    expect(resolveThinkingControls("qwen/qwen3.8-27b", { reasoningEffort: "none" }))
      .toEqual({ reasoningEffort: "none" });
    expect(resolveThinkingControls("qwen/qwen3.8-27b", { enableThinking: false }))
      .toEqual({ reasoningEffort: "none" });
  });
});

/**
 * An older LM Studio takes only xhigh|medium|low. Sending the correct value first and stepping
 * down once an endpoint actually refuses it keeps both backends working, and a 400 never ends a
 * turn. The current build names its own set: "Supported values: none, minimal, low, medium,
 * high, xhigh."
 */
describe("per-endpoint reasoning_effort ladder", () => {
  const ENDPOINT = "http://10.10.0.2:1234/v1";

  it("sends the requested value until the endpoint refuses it", () => {
    expect(effortForEndpoint(ENDPOINT, "none")).toBe("none");
    noteRejectedReasoningEffort(ENDPOINT, "none");
    expect(effortForEndpoint(ENDPOINT, "none")).toBe("low");
    noteRejectedReasoningEffort(ENDPOINT, "low");
    expect(effortForEndpoint(ENDPOINT, "none")).toBeUndefined();   // degrade, never fail
  });

  it("is per endpoint — one backend's refusal does not disarm another", () => {
    noteRejectedReasoningEffort(ENDPOINT, "none");
    expect(effortForEndpoint("http://other:1234/v1", "none")).toBe("none");
  });

  it("does not step down a level the endpoint never refused", () => {
    noteRejectedReasoningEffort(ENDPOINT, "none");
    expect(effortForEndpoint(ENDPOINT, "medium")).toBe("medium");
  });

  it("recognises the rejection and nothing else", () => {
    expect(isRejectedReasoningEffortError({ status: 400, message: "Invalid 'reasoning_effort' value: 'none'. Supported values: low, medium, xhigh." })).toBe(true);
    expect(isRejectedReasoningEffortError({ status: 400, message: "context length exceeded" })).toBe(false);
    expect(isRejectedReasoningEffortError({ status: 500, message: "reasoning_effort" })).toBe(false);
    expect(isRejectedReasoningEffortError(new Error("reasoning_effort"))).toBe(false);
  });
});
