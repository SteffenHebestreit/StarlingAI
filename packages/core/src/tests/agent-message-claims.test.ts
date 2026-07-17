import { afterEach, describe, expect, it } from "vitest";
import {
  appendAgentMessage,
  claimAgentMessages,
  consumeAgentMessages,
  getAgentMessageBacklogSnapshot,
  getDeadLetteredAgentMessages,
  resetSharedMemoryForTests,
} from "../swarm/memory.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const msg = (id: string, toAgent = "coder", content = `payload ${id}`) => ({
  sessionId: "claims-session",
  id,
  fromAgent: "planner",
  toAgent,
  content,
  ts: new Date().toISOString(),
});

describe("acknowledged agent messages (ADR-003, in-process transport)", () => {
  afterEach(async () => {
    await resetSharedMemoryForTests();
  });

  it("claims without destroying: an unacked claim redelivers after the visibility timeout", async () => {
    await appendAgentMessage(msg("m1"));
    const first = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(first.messages.map((m) => m.id)).toEqual(["m1"]);
    // Never acked (simulated crash). Before the timeout nothing is claimable...
    const during = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(during.messages).toEqual([]);
    // ...after it, the message comes back.
    await pause(1_100);
    const redelivered = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(redelivered.messages.map((m) => m.id)).toEqual(["m1"]);
    await redelivered.ack();
  });

  it("an acked claim is final: no redelivery, and duplicate sends of the same id are filtered", async () => {
    await appendAgentMessage(msg("m2"));
    const claim = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(claim.messages).toHaveLength(1);
    await claim.ack();
    await pause(1_100);
    const after = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(after.messages).toEqual([]);
    // A duplicate send with an already-processed id is idempotently dropped.
    await appendAgentMessage(msg("m2"));
    const dup = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(dup.messages).toEqual([]);
  });

  it("dead-letters a message after the retry ceiling instead of redelivering forever", async () => {
    await appendAgentMessage(msg("poison"));
    for (let round = 0; round < 3; round += 1) {
      const claim = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
      expect(claim.messages.map((m) => m.id)).toEqual(["poison"]);
      await pause(1_100); // never ack — claim expires each round
    }
    const final = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(final.messages).toEqual([]);
    expect((await getDeadLetteredAgentMessages("claims-session")).map((m) => m.id)).toEqual(["poison"]);
  });

  it("preserves oldest-first order on fresh claims AND on redelivery", async () => {
    await appendAgentMessage(msg("o1"));
    await appendAgentMessage(msg("o2"));
    await appendAgentMessage(msg("o3"));
    const first = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(first.messages.map((m) => m.id)).toEqual(["o1", "o2", "o3"]);
    await pause(1_100); // never acked — expire and redeliver
    const redelivered = await claimAgentMessages("claims-session", "coder", { visibilityMs: 1_000 });
    expect(redelivered.messages.map((m) => m.id)).toEqual(["o1", "o2", "o3"]);
    await redelivered.ack();
  });

  it("a duplicate send after ack leaves no ghost in the backlog snapshot", async () => {
    await appendAgentMessage(msg("g1"));
    const claim = await claimAgentMessages("claims-session", "coder");
    await claim.ack();
    await appendAgentMessage(msg("g1")); // duplicate id
    const dup = await claimAgentMessages("claims-session", "coder");
    expect(dup.messages).toEqual([]);
    expect(getAgentMessageBacklogSnapshot()).toEqual([]);
  });

  it("messages for other recipients are untouched by a claim", async () => {
    await appendAgentMessage(msg("m3", "coder"));
    await appendAgentMessage(msg("m4", "tester"));
    const coder = await claimAgentMessages("claims-session", "coder");
    expect(coder.messages.map((m) => m.id)).toEqual(["m3"]);
    await coder.ack();
    const tester = await claimAgentMessages("claims-session", "tester");
    expect(tester.messages.map((m) => m.id)).toEqual(["m4"]);
    await tester.ack();
  });

  it("keeps the legacy consume wrapper destructive (claim + immediate ack)", async () => {
    await appendAgentMessage(msg("m5"));
    expect((await consumeAgentMessages("claims-session", "coder")).map((m) => m.id)).toEqual(["m5"]);
    expect(await consumeAgentMessages("claims-session", "coder")).toEqual([]);
  });

  it("backlog snapshot counts queued AND claimed-but-unacked messages", async () => {
    await appendAgentMessage(msg("m6", "coder"));
    await appendAgentMessage(msg("m7", "tester"));
    await claimAgentMessages("claims-session", "coder", { visibilityMs: 60_000 }); // held, unacked
    const snapshot = getAgentMessageBacklogSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.pending).toBe(2);
    expect(snapshot[0]?.targets).toEqual({ coder: 1, tester: 1 });
  });
});
