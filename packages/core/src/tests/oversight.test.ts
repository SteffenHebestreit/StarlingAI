import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable routing-tier provider for the oversight check.
let completeImpl: (...args: unknown[]) => Promise<{ content: string }>;
let providerForTier: unknown;

vi.mock("../providers/index.js", () => ({
  applyActiveModelPreset: () => {},
  createChatProvider: () => null,
  resolveProviderEndpoint: () => ({}),
  getChatProviderForTier: () => providerForTier,
}));

import { assessOversightGoalMet } from "../agent/sub-agent.js";

beforeEach(() => {
  completeImpl = async () => ({ content: "DONE" });
  providerForTier = { complete: (...a: unknown[]) => completeImpl(...a) };
});

describe("assessOversightGoalMet — runtime oversight goal check", () => {
  it("returns true when the routing tier judges the goal DONE", async () => {
    completeImpl = async () => ({ content: "DONE" });
    expect(await assessOversightGoalMet(["cover today's top news"], "fetched headlines …")).toBe(true);
  });

  it("returns false when the routing tier says CONTINUE", async () => {
    completeImpl = async () => ({ content: "CONTINUE — sport section still missing" });
    expect(await assessOversightGoalMet(["10 stories incl. sport"], "politics only")).toBe(false);
  });

  it("returns false WITHOUT calling the model when there are no acceptance criteria", async () => {
    const spy = vi.fn(async () => ({ content: "DONE" }));
    providerForTier = { complete: spy };
    expect(await assessOversightGoalMet([], "evidence")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns false when no routing tier is configured (never blocks the worker)", async () => {
    providerForTier = null;
    expect(await assessOversightGoalMet(["x"], "evidence")).toBe(false);
  });

  it("returns false when the routing tier errors — oversight only ever ends work early", async () => {
    completeImpl = async () => { throw new Error("routing tier down"); };
    expect(await assessOversightGoalMet(["x"], "evidence")).toBe(false);
  });
});
