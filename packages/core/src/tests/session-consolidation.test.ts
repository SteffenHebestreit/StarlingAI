import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Control the session's shared-facts without needing Redis.
const { factsRef } = vi.hoisted(() => ({ factsRef: { value: {} as Record<string, string> } }));
vi.mock("../swarm/memory.js", () => ({
  readAllFacts: async () => factsRef.value,
}));

import { consolidateSessionMemory } from "../memory/session-consolidation.js";
import { listWorkspaceMemoryRecords, storeWorkspaceMemoryRecord } from "../memory/service.js";

describe("end-of-session memory consolidation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    factsRef.value = {};
  });
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-consolidate-"));
    dirs.push(dir);
    return dir;
  }

  it("promotes durable-worthy facts and skips trivial/transient/credential ones", async () => {
    const ws = workspace();
    factsRef.value = {
      verified_finding: "The latest stable release of the protocol is v2.4, confirmed on the official spec page.",
      status: "in_progress with several more steps before completion of the long task at hand", // transient key
      api_token: "the bearer token is abc123 and must be kept very secret for the integration", // credential-shaped
      tip: "short", // below minConsolidatedFactChars
    };

    const result = await consolidateSessionMemory({ sessionId: "sess-consolidate-1", workspacePath: ws, channel: "webchat", turnCount: 3 });

    expect(result.promoted).toBe(1);
    const records = listWorkspaceMemoryRecords(ws);
    expect(records).toHaveLength(1);
    expect(records[0]?.content).toContain("protocol is v2.4");
    expect(records[0]?.tags).toContain("consolidated");
    expect(records[0]?.tags).toContain("session-derived");
  });

  it("does not re-promote an already-stored fact (dedup)", async () => {
    const ws = workspace();
    factsRef.value = {
      finding: "The recommended microphone module for this board is the INMP441 I2S MEMS mic.",
    };

    const first = await consolidateSessionMemory({ sessionId: "sess-dedup", workspacePath: ws, turnCount: 2 });
    expect(first.promoted).toBe(1);

    const second = await consolidateSessionMemory({ sessionId: "sess-dedup", workspacePath: ws, turnCount: 2 });
    expect(second.promoted).toBe(0);
    expect(listWorkspaceMemoryRecords(ws)).toHaveLength(1);
  });

  it("keeps a short distinct fact even when an unrelated long record contains it as a substring (no false-drop)", async () => {
    const ws = workspace();
    // An unrelated, broader durable record that happens to contain the short fact verbatim.
    storeWorkspaceMemoryRecord(ws, {
      key: "ops_runbook",
      subject: "ops runbook",
      content:
        "Operational runbook: restart the gateway service before applying new config shards. Also rotate credentials weekly, verify nightly backups, and page the on-call engineer when the health check fails for several minutes during the maintenance window.",
      kind: "note",
    }, { sessionId: "seed" });

    factsRef.value = {
      deploy_step: "Restart the gateway service before applying new config shards.",
    };

    // Old bidirectional `includes()` dedup would have dropped this (it is a substring
    // of the long record); token-similarity dedup keeps it (low Jaccard + length mismatch).
    const result = await consolidateSessionMemory({ sessionId: "sess-substr", workspacePath: ws, turnCount: 2 });
    expect(result.promoted).toBe(1);
    expect(listWorkspaceMemoryRecords(ws).some((r) => r.content.startsWith("Restart the gateway service"))).toBe(true);
  });

  it("still dedups a genuine near-duplicate fact (token-similarity)", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, {
      key: "mic_choice",
      subject: "mic choice",
      content: "The recommended microphone module for this board is the INMP441 I2S MEMS microphone.",
      kind: "fact",
    }, { sessionId: "seed" });

    factsRef.value = {
      // Same fact, trivially reworded — should be caught as a near-duplicate.
      finding: "The recommended microphone module for this board is the INMP441 I2S MEMS microphone!",
    };

    const result = await consolidateSessionMemory({ sessionId: "sess-neardup", workspacePath: ws, turnCount: 2 });
    expect(result.promoted).toBe(0);
  });

  it("skips sessions with no completed turns", async () => {
    const ws = workspace();
    factsRef.value = { finding: "A perfectly durable-worthy finding that is long enough to qualify for promotion." };
    const result = await consolidateSessionMemory({ sessionId: "sess-empty", workspacePath: ws, turnCount: 0 });
    expect(result.promoted).toBe(0);
    expect(listWorkspaceMemoryRecords(ws)).toHaveLength(0);
  });
});
