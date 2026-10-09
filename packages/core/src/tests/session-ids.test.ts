import { afterEach, describe, expect, it } from "vitest";
import { parentSessionOf, rootSessionOf } from "../agent/session-ids.js";

/**
 * Nested run ids resolve to the session they belong to (2026-10-07). An ephemeral agent's name
 * carries its own colon (`ephemeral:<name>`), and the old split-on-the-last-two-colons parse turned
 * `sub:<chat>:ephemeral:<name>:<stamp>` into `<chat>:ephemeral`.
 */
describe("session id resolution", () => {
  it("resolves configured and ephemeral sub-agent runs to their parent", () => {
    expect(parentSessionOf("sub:chat-1:researcher:1791300000000")).toBe("chat-1");
    expect(parentSessionOf("sub:chat-1:ephemeral:kb_worker:1791300000000")).toBe("chat-1");
    expect(parentSessionOf("sub:chat-1:researcher:missing")).toBe("chat-1");
    expect(parentSessionOf("chat-1")).toBeNull();
  });

  it("follows nesting through coordinators and ephemeral agents to the root", () => {
    expect(rootSessionOf("sub:sub:chat-1:mission_coordinator:111:ephemeral:kb_worker:222")).toBe("chat-1");
    expect(rootSessionOf("sub:sub:chat-1:ephemeral:planner:111:researcher:222")).toBe("chat-1");
    expect(rootSessionOf("chat-1")).toBe("chat-1");
    // Root ids may carry colons of their own.
    expect(rootSessionOf("sub:job:digest:7f3a:ephemeral:writer:333")).toBe("job:digest:7f3a");
  });

  it("crosses workflow hops only when asked to", () => {
    const id = "sub:workflow:sub:chat-1:ephemeral:planner:111:verified_research_brief:5b0c2f4e-1d2a-4c1b-9b7e-2f6d8a1c3e5f:researcher:444";
    expect(rootSessionOf(id)).toBe("workflow:sub:chat-1:ephemeral:planner:111:verified_research_brief:5b0c2f4e-1d2a-4c1b-9b7e-2f6d8a1c3e5f");
    expect(rootSessionOf(id, ["sub:", "workflow:"])).toBe("chat-1");
  });

  it("keeps degenerate ids stable", () => {
    expect(rootSessionOf("sub:lonely")).toBe("lonely");
    expect(rootSessionOf("sub:a:b")).toBe("a:b");
  });
});

describe("callers resolve an ephemeral run to its turn", () => {
  afterEach(async () => {
    (await import("../agent/turn-steering.js")).turnSteeringManager.resetForTests();
  });

  it("shares an ephemeral agent's findings under the turn's session", async () => {
    const { deriveSharedSessionId } = await import("../tools/memory.js");
    expect(deriveSharedSessionId("sub:chat-9:ephemeral:kb_worker:1791300000000")).toBe("chat-9");
  });

  it("shows an ephemeral run the turn's steering messages", async () => {
    const { turnSteeringManager } = await import("../agent/turn-steering.js");
    turnSteeringManager.markTurnActive("chat-9");
    turnSteeringManager.enqueue("chat-9", "Nur Messwerkzeug, bitte.");
    expect(turnSteeringManager.turnLogOf("sub:chat-9:ephemeral:kb_worker:1791300000000").map((m) => m.text))
      .toEqual(["Nur Messwerkzeug, bitte."]);
  });
});
