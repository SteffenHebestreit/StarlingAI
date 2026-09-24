import { afterEach, describe, expect, it, vi } from "vitest";
import { recordUnconsumedSteering, turnSteeringManager, unconsumedSteeringOf } from "../agent/turn-steering.js";

/**
 * Mid-turn user steering inbox. The runtime drains this between tool-loop
 * iterations and folds queued messages into the running turn. Scoped to the
 * root (turn) session id so steering reaches the orchestrator turn regardless
 * of which sub-agent is mid-flight, and only queues while a turn is live so a
 * stray message never leaks into a later turn.
 */
describe("turnSteeringManager", () => {
  afterEach(() => turnSteeringManager.resetForTests());

  const texts = (entries: Array<{ text: string }>) => entries.map((entry) => entry.text);

  it("does NOT queue when no turn is active", () => {
    expect(turnSteeringManager.enqueueIfActive("s1", "hello")).toBe(false);
    expect(turnSteeringManager.enqueue("s1", "hello", "client-id-1")).toEqual({ queued: false, active: false });
    expect(turnSteeringManager.hasPending("s1")).toBe(false);
    expect(turnSteeringManager.drain("s1")).toEqual([]);
  });

  it("queues while active and drains in arrival order, once", () => {
    turnSteeringManager.markTurnActive("s1");
    expect(turnSteeringManager.enqueueIfActive("s1", "first")).toBe(true);
    expect(turnSteeringManager.enqueueIfActive("s1", "  second  ")).toBe(true);
    expect(turnSteeringManager.enqueueIfActive("s1", "   ")).toBe(false); // blank ignored
    expect(turnSteeringManager.hasPending("s1")).toBe(true);
    expect(texts(turnSteeringManager.drain("s1"))).toEqual(["first", "second"]);
    expect(turnSteeringManager.drain("s1")).toEqual([]); // drained once
    expect(turnSteeringManager.hasPending("s1")).toBe(false);
  });

  it("names each message: the client's id when it has the accepted shape, else a server id", () => {
    turnSteeringManager.markTurnActive("s1");
    expect(turnSteeringManager.enqueue("s1", "use qwen", "steer_ABC-123")).toEqual({ queued: true, active: true, id: "steer_ABC-123" });
    const tooShort = turnSteeringManager.enqueue("s1", "short id", "abc");
    const badChars = turnSteeringManager.enqueue("s1", "path id", "../../etc/passwd");
    expect(tooShort.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(badChars.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(turnSteeringManager.drain("s1").map((entry) => entry.id)).toEqual(["steer_ABC-123", tooShort.id, badChars.id]);
  });

  it("queues a retried id once, even after the first copy was drained", () => {
    // A POST retried after a dropped response must not fold the same words in twice.
    turnSteeringManager.markTurnActive("s1");
    turnSteeringManager.enqueue("s1", "nimm das qwen model", "retry-id-0001");
    expect(turnSteeringManager.enqueue("s1", "nimm das qwen model", "retry-id-0001")).toEqual({ queued: true, active: true, id: "retry-id-0001" });
    expect(texts(turnSteeringManager.drain("s1"))).toEqual(["nimm das qwen model"]);
    turnSteeringManager.enqueue("s1", "nimm das qwen model", "retry-id-0001");
    expect(turnSteeringManager.drain("s1")).toEqual([]);
  });

  it("a new turn starts with an empty queue", () => {
    turnSteeringManager.markTurnActive("s1");
    turnSteeringManager.enqueueIfActive("s1", "stale");
    const token = turnSteeringManager.markTurnActive("s1"); // new turn — old queue dropped
    expect(turnSteeringManager.drain("s1")).toEqual([]);

    turnSteeringManager.enqueueIfActive("s1", "live");
    turnSteeringManager.markTurnDone("s1", token);
    expect(turnSteeringManager.isTurnActive("s1")).toBe(false);
    expect(turnSteeringManager.drain("s1")).toEqual([]);
    expect(turnSteeringManager.enqueueIfActive("s1", "after-done")).toBe(false);
  });

  it("a superseded turn finishing late does not switch off the turn that replaced it", () => {
    // Turn 1 is cancelled by a new message and unwinds after turn 2 has started: its finally
    // used to clear the per-root flag, so every steer into turn 2 failed from then on.
    const first = turnSteeringManager.markTurnActive("s1");
    const second = turnSteeringManager.markTurnActive("s1");
    expect(second).not.toBe(first);
    turnSteeringManager.enqueueIfActive("s1", "for the second turn");

    turnSteeringManager.markTurnDone("s1", first);
    expect(turnSteeringManager.closeTurn("s1", first)).toEqual([]);
    expect(turnSteeringManager.drain("s1", first)).toEqual([]); // nor can it take the messages
    expect(turnSteeringManager.isTurnActive("s1")).toBe(true);
    expect(turnSteeringManager.enqueueIfActive("s1", "still steerable")).toBe(true);
    expect(texts(turnSteeringManager.drain("s1", second))).toEqual(["for the second turn", "still steerable"]);
  });

  it("an armed turn keeps what was sent while it started up; a superseded one takes nothing over", () => {
    turnSteeringManager.armTurn("s1", "turn-a");
    // Sent before the runtime reached markTurnActive.
    expect(turnSteeringManager.enqueueIfActive("s1", "early")).toBe(true);
    expect(turnSteeringManager.markTurnActive("s1", "turn-a")).toBe("turn-a");
    expect(texts(turnSteeringManager.drain("s1", "turn-a"))).toEqual(["early"]);

    // Turn B is armed before turn A's runtime gets going: A is already superseded.
    turnSteeringManager.armTurn("s1", "turn-b");
    turnSteeringManager.enqueueIfActive("s1", "for b");
    expect(turnSteeringManager.markTurnActive("s1", "turn-a")).toBe("turn-a");
    expect(turnSteeringManager.drain("s1", "turn-a")).toEqual([]);
    expect(texts(turnSteeringManager.drain("s1", "turn-b"))).toEqual(["for b"]);
  });

  it("closeTurn hands back the undrained messages and switches the turn off in the same step", () => {
    const token = turnSteeringManager.markTurnActive("s1");
    turnSteeringManager.enqueue("s1", "drained", "drained-id-01");
    turnSteeringManager.drain("s1", token);
    turnSteeringManager.enqueue("s1", "late one", "late-id-0001");
    turnSteeringManager.enqueue("s1", "late two", "late-id-0002");

    const leftovers = turnSteeringManager.closeTurn("s1", token);
    expect(leftovers.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "late-id-0001", text: "late one" },
      { id: "late-id-0002", text: "late two" },
    ]);
    // Nothing is accepted after the close only to vanish: the sender is told there is no turn.
    expect(turnSteeringManager.enqueue("s1", "too late", "late-id-0003")).toEqual({ queued: false, active: false });
    expect(turnSteeringManager.closeTurn("s1", token)).toEqual([]);
  });

  it("a turn another turn takes the root from gets what it had queued back as its own leftovers", () => {
    // Review #7: a second tab's turn armed over a running one, and "make it blue" — answered
    // steered:true — was folded into neither turn and reported by neither.
    turnSteeringManager.armTurn("s1", "turn-a");
    turnSteeringManager.enqueue("s1", "make it blue", "steer-blue-01");
    turnSteeringManager.armTurn("s1", "turn-b");
    turnSteeringManager.enqueue("s1", "and add a hat", "steer-hat-001");

    // The superseded turn cannot fold it in any more, but reports it when it closes, once.
    expect(turnSteeringManager.drain("s1", "turn-a")).toEqual([]);
    expect(turnSteeringManager.closeTurn("s1", "turn-a").map(({ id, text }) => ({ id, text })))
      .toEqual([{ id: "steer-blue-01", text: "make it blue" }]);
    expect(turnSteeringManager.closeTurn("s1", "turn-a")).toEqual([]);
    // The newer turn owns steering from the takeover on, and closing the old one left it alone.
    expect(turnSteeringManager.isTurnActive("s1")).toBe(true);
    expect(texts(turnSteeringManager.drain("s1", "turn-b"))).toEqual(["and add a hat"]);

    // A turn that finishes instead of closing lets its leftovers go with it.
    turnSteeringManager.enqueue("s1", "one more", "steer-more-01");
    turnSteeringManager.markTurnActive("s1");
    turnSteeringManager.markTurnDone("s1", "turn-b");
    expect(turnSteeringManager.closeTurn("s1", "turn-b")).toEqual([]);
  });

  it("is root-scoped: a sub-agent session steers the parent turn", () => {
    turnSteeringManager.markTurnActive("root1");
    // A message addressed to the running sub-agent still reaches the root turn queue.
    expect(turnSteeringManager.enqueueIfActive("sub:root1:researcher:1780000000000", "focus on the Zwinger")).toBe(true);
    expect(turnSteeringManager.isTurnActive("sub:root1:researcher:1780000000000")).toBe(true);
    // Drained via the root id.
    expect(texts(turnSteeringManager.drain("root1"))).toEqual(["focus on the Zwinger"]);
  });

  it("keeps unread leftovers for the session's next reader: bounded, for an hour, until a new turn starts", () => {
    // Review of round 1, B #5: leftovers whose final status reached no socket.
    vi.useFakeTimers();
    try {
      const many = Array.from({ length: 60 }, (_, index) => ({ id: `steer-${String(index).padStart(4, "0")}`, text: `note ${index}` }));
      turnSteeringManager.keepUnread("s1", "req-a", many);
      const kept = turnSteeringManager.unreadOf("sub:s1:researcher:1780000000000");
      expect(kept).toHaveLength(50);
      expect(kept[0]).toEqual({ id: "steer-0010", text: "note 10", requestId: "req-a" });
      // Kept twice, listed once.
      turnSteeringManager.keepUnread("s2", "req-x", [many[0]!]);
      turnSteeringManager.keepUnread("s2", "req-x", [many[0]!]);
      expect(turnSteeringManager.unreadOf("s2")).toEqual([{ id: "steer-0000", text: "note 0", requestId: "req-x" }]);

      vi.advanceTimersByTime(3_599_000);
      expect(turnSteeringManager.unreadOf("s1")).toHaveLength(50);
      vi.advanceTimersByTime(2_000);
      expect(turnSteeringManager.unreadOf("s1")).toEqual([]);

      // A turn the gateway arms drops them; so does a turn that starts without being armed.
      turnSteeringManager.keepUnread("s1", "req-a", [many[0]!]);
      turnSteeringManager.armTurn("s1", "turn-b");
      expect(turnSteeringManager.unreadOf("s1")).toEqual([]);
      turnSteeringManager.keepUnread("s1", "req-b", [many[1]!]);
      // The armed turn reaching the runtime is not a new turn.
      turnSteeringManager.markTurnActive("s1", "turn-b");
      expect(turnSteeringManager.unreadOf("s1")).toHaveLength(1);
      turnSteeringManager.markTurnActive("s1");
      expect(turnSteeringManager.unreadOf("s1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands what earlier turns left unread to the start that retires them, and forgets them on request", () => {
    // Review of round 2, B #5 and B #4.
    vi.useFakeTimers();
    try {
      turnSteeringManager.keepUnread("s1", "req-a", [{ id: "steer-blue-01", text: "make it blue" }]);
      expect(turnSteeringManager.armTurn("s1", "turn-b")).toEqual([{ id: "steer-blue-01", text: "make it blue", requestId: "req-a" }]);
      expect(turnSteeringManager.unreadOf("s1")).toEqual([]);
      expect(turnSteeringManager.armTurn("s1", "turn-c")).toEqual([]);
      // Not what has run out.
      turnSteeringManager.keepUnread("s1", "req-c", [{ id: "steer-hat-0001", text: "and a hat" }]);
      vi.advanceTimersByTime(3_601_000);
      expect(turnSteeringManager.armTurn("s1", "turn-d")).toEqual([]);

      // Dropped for the whole turn's session, and for that session only.
      turnSteeringManager.keepUnread("s1", "req-d", [{ id: "steer-hat-0001", text: "and a hat" }]);
      turnSteeringManager.keepUnread("s2", "req-x", [{ id: "steer-sky-0001", text: "a clear sky" }]);
      turnSteeringManager.dropUnread("sub:s1:researcher:1780000000000");
      expect(turnSteeringManager.unreadOf("s1")).toEqual([]);
      expect(turnSteeringManager.unreadOf("s2")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps nothing for a turn that started before its session's last drop", () => {
    // Review of round 4, B #2: a stopped turn slow to unwind kept its leftovers again after a reset
    // had dropped them.
    const blue = [{ id: "steer-blue-01", text: "make it blue" }];
    const before = turnSteeringManager.dropMark();
    turnSteeringManager.dropUnread("sub:s1:researcher:1780000000000");
    expect(turnSteeringManager.keepUnread("s1", "req-a", blue, before)).toBe(false);
    expect(turnSteeringManager.unreadOf("s1")).toEqual([]);
    // Another session's drop is not this one's.
    expect(turnSteeringManager.keepUnread("s2", "req-x", blue, before)).toBe(true);
    expect(turnSteeringManager.unreadOf("s2")).toHaveLength(1);
    // A turn that started after the drop keeps its own.
    const after = turnSteeringManager.dropMark();
    expect(turnSteeringManager.keepUnread("s1", "req-b", blue, after)).toBe(true);
    expect(turnSteeringManager.unreadOf("s1")).toEqual([{ id: "steer-blue-01", text: "make it blue", requestId: "req-b" }]);
    // Bounded like the unread lists: the oldest session's mark goes after a thousand others'.
    for (let index = 0; index < 1_000; index += 1) turnSteeringManager.dropUnread(`other-${index}`);
    expect(turnSteeringManager.keepUnread("other-999", "req-y", [{ id: "steer-hat-0001", text: "and a hat" }], before)).toBe(false);
    expect(turnSteeringManager.keepUnread("s1", "req-c", [{ id: "steer-hat-0001", text: "and a hat" }], before)).toBe(true);
  });

  it("carries a failed turn's leftovers on the error it rethrows", () => {
    const err = new Error("provider timed out");
    recordUnconsumedSteering(err, [{ id: "late-id-0001", text: "late one" }]);
    expect(unconsumedSteeringOf(err)).toEqual([{ id: "late-id-0001", text: "late one" }]);
    expect(unconsumedSteeringOf(new Error("other"))).toEqual([]);
    expect(unconsumedSteeringOf("a string throw")).toEqual([]);
  });
});
