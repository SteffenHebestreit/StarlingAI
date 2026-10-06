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

  it("keeps a read-only log of the turn's messages for its specialists, with what the orchestrator took", () => {
    const token = turnSteeringManager.markTurnActive("root-log");
    turnSteeringManager.enqueue("root-log", "first");
    turnSteeringManager.drain("root-log", token);
    turnSteeringManager.enqueue("root-log", "second");
    // A nested specialist reads the same turn through its own sub-session id, and reading takes nothing.
    const nested = "sub:sub:root-log:mission_coordinator:1:browser_agent:2";
    expect(turnSteeringManager.turnLogOf(nested).map(({ text, taken }) => ({ text, taken }))).toEqual([
      { text: "first", taken: true },
      { text: "second", taken: false },
    ]);
    expect(texts(turnSteeringManager.drain("root-log", token))).toEqual(["second"]);
    expect(turnSteeringManager.turnLogOf("root-log").every((m) => m.taken)).toBe(true);
    // A closed turn has no log, and the next turn starts empty.
    turnSteeringManager.closeTurn("root-log", token);
    expect(turnSteeringManager.turnLogOf("root-log")).toEqual([]);
    turnSteeringManager.markTurnActive("root-log");
    expect(turnSteeringManager.turnLogOf("root-log")).toEqual([]);
  });

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

  it("leaves a turn's queue alone on a reset, and keeps for the session only what was queued after it", () => {
    // Review of round 4, B #2: a stopped turn slow to unwind kept its leftovers again after a reset
    // had dropped them. Round 5, B #1: refusing the whole turn's leftovers also refused a message
    // typed into it after the reset. Turn-ids review, R1: clearing the queue instead lost a message
    // typed before a Reset, which does not stop the turn, so its own final status no longer listed
    // it and the page showed it "Queued" for good.
    turnSteeringManager.armTurn("s1", "tok-a", "req-a");
    turnSteeringManager.armTurn("s2", "tok-x", "req-x");
    turnSteeringManager.enqueue("s1", "make it blue", "steer-blue-01");
    turnSteeringManager.enqueue("s2", "a clear sky", "steer-sky-0001");
    turnSteeringManager.dropUnread("sub:s1:researcher:1780000000000");
    turnSteeringManager.enqueue("s1", "typed after the reset", "steer-after-01");
    // A retry of the message typed before is the same message, not one typed after.
    expect(turnSteeringManager.enqueue("s1", "make it blue", "steer-blue-01").queued).toBe(true);

    // The turn still lists both, for its own page.
    const leftovers = turnSteeringManager.closeTurn("s1", "tok-a");
    expect(leftovers.map(({ id }) => id)).toEqual(["steer-blue-01", "steer-after-01"]);
    // The session keeps only the one typed into the chat as it is now.
    expect(turnSteeringManager.keepUnread("s1", "req-a", leftovers)).toEqual([{ id: "steer-after-01", text: "typed after the reset" }]);
    expect(turnSteeringManager.unreadOf("s1")).toEqual([{ id: "steer-after-01", text: "typed after the reset", requestId: "req-a" }]);
    // Another session's drop is not this one's.
    const sky = turnSteeringManager.closeTurn("s2", "tok-x");
    expect(turnSteeringManager.keepUnread("s2", "req-x", sky)).toEqual([{ id: "steer-sky-0001", text: "a clear sky" }]);

    // A running turn still reads what was typed before the reset.
    turnSteeringManager.armTurn("s3", "tok-c", "req-c");
    turnSteeringManager.enqueue("s3", "and a hat", "steer-hat-0001");
    turnSteeringManager.dropUnread("s3");
    expect(turnSteeringManager.drain("s3", "tok-c").map(({ id }) => id)).toEqual(["steer-hat-0001"]);

    // The tag is taken when the message is queued: a drop between the turn's close and its final
    // status still counts.
    turnSteeringManager.armTurn("s4", "tok-d", "req-d");
    turnSteeringManager.enqueue("s4", "and a scarf", "steer-scarf-01");
    const closed = turnSteeringManager.closeTurn("s4", "tok-d");
    turnSteeringManager.dropUnread("s4");
    expect(turnSteeringManager.keepUnread("s4", "req-d", closed)).toEqual([]);
    expect(turnSteeringManager.unreadOf("s4")).toEqual([]);

    // Typed after one reset but before the next is older than the chat again.
    turnSteeringManager.armTurn("s5", "tok-e", "req-e");
    turnSteeringManager.dropUnread("s5");
    turnSteeringManager.enqueue("s5", "and gloves", "steer-glove-01");
    turnSteeringManager.dropUnread("s5");
    expect(turnSteeringManager.keepUnread("s5", "req-e", turnSteeringManager.closeTurn("s5", "tok-e"))).toEqual([]);
  });

  it("lists what a turn another turn took the session from had queued, and keeps only what came after a reset", () => {
    turnSteeringManager.armTurn("s1", "tok-a", "req-a");
    turnSteeringManager.enqueue("s1", "make it blue", "steer-blue-01");
    turnSteeringManager.armTurn("s1", "tok-b", "req-b");
    turnSteeringManager.dropUnread("s1");
    turnSteeringManager.enqueue("s1", "and a hat", "steer-hat-0001");

    const displaced = turnSteeringManager.closeTurn("s1", "tok-a");
    expect(displaced.map(({ id }) => id)).toEqual(["steer-blue-01"]);
    expect(turnSteeringManager.keepUnread("s1", "req-a", displaced)).toEqual([]);
    const current = turnSteeringManager.closeTurn("s1", "tok-b");
    expect(turnSteeringManager.keepUnread("s1", "req-b", current)).toEqual([{ id: "steer-hat-0001", text: "and a hat" }]);
    expect(turnSteeringManager.unreadOf("s1")).toEqual([{ id: "steer-hat-0001", text: "and a hat", requestId: "req-b" }]);
  });

  it("queues for the named chat turn only, and says when another turn holds the session", () => {
    // The web told turns apart by their text: a page still showing a turn that another tab had
    // replaced steered the replacement, and its message belonged to a turn the page never ran.
    expect(turnSteeringManager.enqueue("s1", "make it blue", "steer-blue-01", "req-a"))
      .toEqual({ queued: false, active: false, otherTurn: true });
    turnSteeringManager.armTurn("s1", "tok-a", "req-a");
    expect(turnSteeringManager.enqueue("sub:s1:researcher:1780000000000", "make it blue", "steer-blue-01", "req-a"))
      .toEqual({ queued: true, active: true, id: "steer-blue-01" });
    // The armed turn reaching the runtime keeps its id.
    turnSteeringManager.markTurnActive("s1", "tok-a");
    expect(turnSteeringManager.enqueue("s1", "and a hat", "steer-hat-0001", "req-a").queued).toBe(true);

    turnSteeringManager.armTurn("s1", "tok-b", "req-b");
    // It names the turn that took the session, so a page can tell "replaced" from "ended".
    expect(turnSteeringManager.enqueue("s1", "and a scarf", "steer-scarf-01", "req-a"))
      .toEqual({ queued: false, active: true, otherTurn: true, replaced: true, replacedBy: "req-b" });
    // Without an id it goes to whichever turn holds the session, as before.
    expect(turnSteeringManager.enqueue("s1", "and a scarf", "steer-scarf-01").queued).toBe(true);
    expect(turnSteeringManager.drain("s1", "tok-b").map(({ id }) => id)).toEqual(["steer-scarf-01"]);
    expect(turnSteeringManager.closeTurn("s1", "tok-a").map(({ id }) => id)).toEqual(["steer-blue-01", "steer-hat-0001"]);

    // A turn no chat.send started has no id to match, and none to name — but it still moved the
    // chat on from the named one (round 2, LOW 2).
    const unnamed = turnSteeringManager.markTurnActive("s1");
    expect(turnSteeringManager.enqueue("s1", "and a scarf", "steer-scarf-02", "req-b"))
      .toEqual({ queued: false, active: true, otherTurn: true, replaced: true });
    // Still named once nothing runs; a turn that simply ended names nobody.
    turnSteeringManager.armTurn("s2", "tok-x", "req-x");
    turnSteeringManager.closeTurn("s2", "tok-x");
    turnSteeringManager.closeTurn("s1", unnamed);
    expect(turnSteeringManager.enqueue("s1", "and a hat", "steer-hat-0002", "req-a"))
      .toEqual({ queued: false, active: false, otherTurn: true, replaced: true, replacedBy: "req-b" });
    expect(turnSteeringManager.enqueue("s2", "a clear sky", "steer-sky-0001", "req-x"))
      .toEqual({ queued: false, active: false, otherTurn: true });
  });

  it("keys what it remembers of a turn by its session: request ids are the client's", () => {
    // Round 2, LOW 1: one session's request id named another session's replacement, and a client
    // reusing ids across sessions had a steer refused as replaced instead of sent on as the next turn.
    turnSteeringManager.armTurn("A", "tok-a1", "req-1");
    turnSteeringManager.armTurn("A", "tok-a2", "req-2");
    turnSteeringManager.armTurn("M", "tok-m1", "req-1");
    turnSteeringManager.closeTurn("M", "tok-m1");
    expect(turnSteeringManager.enqueue("M", "and a hat", "steer-hat-0001", "req-1"))
      .toEqual({ queued: false, active: false, otherTurn: true });
    expect(turnSteeringManager.enqueue("A", "and a hat", "steer-hat-0002", "req-1"))
      .toEqual({ queued: false, active: true, otherTurn: true, replaced: true, replacedBy: "req-2" });
    // An id used again for a new turn names that turn now: once it simply ends, it was not replaced
    // (final review, LOW 2).
    turnSteeringManager.armTurn("A", "tok-a3", "req-1");
    turnSteeringManager.closeTurn("A", "tok-a3");
    expect(turnSteeringManager.enqueue("A", "and a hat", "steer-hat-0003", "req-1"))
      .toEqual({ queued: false, active: false, otherTurn: true });

    // Round 2, INFO 3: after a reset, a message resent under the same id into a LATER turn is another
    // message; its tag must not let the earlier turn's leftovers keep the first one.
    turnSteeringManager.armTurn("R", "tok-r1", "req-r1");
    turnSteeringManager.enqueue("R", "make it blue", "steer-blue-01");
    turnSteeringManager.dropUnread("R");
    turnSteeringManager.armTurn("R", "tok-r2", "req-r2");
    turnSteeringManager.enqueue("R", "make it blue", "steer-blue-01");
    const early = turnSteeringManager.closeTurn("R", "tok-r1");
    expect(early.map(({ id }) => id)).toEqual(["steer-blue-01"]);
    expect(turnSteeringManager.keepUnread("R", "req-r1", early)).toEqual([]);
    expect(turnSteeringManager.keepUnread("R", "req-r2", turnSteeringManager.closeTurn("R", "tok-r2")))
      .toEqual([{ id: "steer-blue-01", text: "make it blue" }]);
  });

  it("carries a failed turn's leftovers on the error it rethrows", () => {
    const err = new Error("provider timed out");
    recordUnconsumedSteering(err, [{ id: "late-id-0001", text: "late one" }]);
    expect(unconsumedSteeringOf(err)).toEqual([{ id: "late-id-0001", text: "late one" }]);
    expect(unconsumedSteeringOf(new Error("other"))).toEqual([]);
    expect(unconsumedSteeringOf("a string throw")).toEqual([]);
  });
});
