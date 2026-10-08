/**
 * The receptionist's memory capsule reads the session's own workspace root (found 2026-10-07).
 *
 * Under multi-user auth a user's workspace memories are stored in their own root,
 * <workspace>/users/<segment>/. The fast lane built its capsule from the configured root, the shared
 * one, so it never saw them, and it offered the shared root's records to every account instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...args),
    stream: vi.fn(),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
  };
});
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

import { tryReceptionistFastLaneDetailed } from "../agent/receptionist.js";
import { AgentSession } from "../agent/session.js";
import { prepareReceptionistFastLane } from "../agent/turn-prepare.js";
import { getConfig } from "../config/loader.js";
import { _clearDurableMemoryCaches, storeWorkspaceMemoryRecord } from "../memory/service.js";

const dirs: string[] = [];
const authBefore = getConfig().auth;
afterEach(() => {
  getConfig().auth = authBefore;
  _clearDurableMemoryCaches();
  completeMock.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A shared root holding one record of its own, with the fast lane on and its prompts captured. */
function setUp(): { sharedRoot: string; sent: string[] } {
  const sharedRoot = mkdtempSync(join(tmpdir(), "recept-scope-"));
  dirs.push(sharedRoot);
  storeWorkspaceMemoryRecord(sharedRoot, { key: "shared_rule", subject: "Hausregel", content: "Eine Regel an der geteilten Wurzel", kind: "decision" });

  const config = getConfig();
  config.workspacePath = sharedRoot;
  config.receptionist = { ...config.receptionist, enabled: true };
  config.orchestration.routingTierPresetFallback = true;
  const sent: string[] = [];
  completeMock.mockImplementation(async (messages: Array<{ content: string }>) => {
    sent.push(messages.map((message) => message.content).join("\n"));
    return { content: "Hallo! Wie kann ich helfen?", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  });
  return { sharedRoot, sent };
}

describe("receptionist memory capsule scope", () => {
  it("is built from the session's workspace root, not the configured shared root", async () => {
    const { sharedRoot, sent } = setUp();
    const userRoot = join(sharedRoot, "users", "alice-0123456789abcdef");
    storeWorkspaceMemoryRecord(userRoot, { key: "alice_tea", subject: "Lieblingstee", content: "Alices Nordhafen-Mischung", kind: "preference" });

    const outcome = await tryReceptionistFastLaneDetailed("hi", undefined, { workspacePath: userRoot });

    expect(outcome.handled).toBe(true);
    const prompt = sent.join("\n");
    expect(prompt).toContain("Alices Nordhafen-Mischung");
    expect(prompt).not.toContain("geteilten Wurzel");
  });

  it("gets that root from the session on a real turn, under multi-user auth", async () => {
    // The turn is what hands the lane the session's root (turn-prepare.ts), and the field is
    // optional: without it the code still compiles and the lane falls back to the configured shared
    // root. Review found (2026-10-08) that no test noticed, because the case above passes the root
    // to the lane itself.
    const { sharedRoot, sent } = setUp();
    getConfig().auth = { ...authBefore, enabled: true };
    const session = new AgentSession({ channel: "webchat", userId: "alice", systemPrompt: "test" });
    expect(session.getWorkspacePath()).not.toBe(sharedRoot);
    storeWorkspaceMemoryRecord(session.getWorkspacePath(), { key: "alice_tea", subject: "Lieblingstee", content: "Alices Nordhafen-Mischung", kind: "preference" });

    const output = await prepareReceptionistFastLane({
      eligible: true,
      userMessage: "hi",
      signal: new AbortController().signal,
      opts: { session, userMessage: "hi" },
      session,
      guardrailEvents: [],
      turnStartedAt: Date.now(),
    });

    expect(output?.performance?.finishReason).toBe("receptionist_fast_lane");
    const prompt = sent.join("\n");
    expect(prompt).toContain("Alices Nordhafen-Mischung");
    expect(prompt).not.toContain("geteilten Wurzel");
  });

  it("still finds the user's records once the session has been restored", async () => {
    // A restored session's root came back one level deeper per restore (found in review,
    // 2026-10-08): the lane read <shared>/users/<seg>/users/<seg> and offered nothing of the user's.
    const { sent } = setUp();
    getConfig().auth = { ...authBefore, enabled: true };
    const live = new AgentSession({ channel: "webchat", userId: "alice", systemPrompt: "test" });
    storeWorkspaceMemoryRecord(live.getWorkspacePath(), { key: "alice_tea", subject: "Lieblingstee", content: "Alices Nordhafen-Mischung", kind: "preference" });
    const session = AgentSession.fromRecord(live.toRecord());

    const output = await prepareReceptionistFastLane({
      eligible: true,
      userMessage: "hi",
      signal: new AbortController().signal,
      opts: { session, userMessage: "hi" },
      session,
      guardrailEvents: [],
      turnStartedAt: Date.now(),
    });

    expect(output?.performance?.finishReason).toBe("receptionist_fast_lane");
    expect(sent.join("\n")).toContain("Alices Nordhafen-Mischung");
  });
});
