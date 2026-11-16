import { describe, expect, it } from "vitest";
import { canObserveComputerSession, computerSessionToObserve, normalizeComputerSession, type ComputerSession } from "./computerSessions";

const session = (id: string, state: string, restricted = false): ComputerSession =>
  ({ id, adapter: "remote_rdp", state, createdAt: 1, lastHeartbeat: 1, ...(restricted ? { restricted: true } : {}) });

describe("computer sessions in the dashboard", () => {
  it("keeps the gateway's mark on another user's session", () => {
    const foreign = normalizeComputerSession({ id: "cs-2", adapter: "remote_rdp", state: "active", createdAt: 5, restricted: true });
    expect(foreign).toMatchObject({ id: "cs-2", state: "active", restricted: true });
    expect(canObserveComputerSession(foreign)).toBe(false);

    const own = normalizeComputerSession({ id: "cs-1", adapter: "remote_rdp", state: "active", createdAt: 4, leaseOwner: "chat-1" });
    expect(own).not.toHaveProperty("restricted");
    expect(canObserveComputerSession(own)).toBe(true);
  });

  it("never follows another user's session in the live preview", () => {
    const foreignLive = session("theirs", "active", true);
    // Their live session is passed over for one's own, even a stopped one.
    expect(computerSessionToObserve([foreignLive, session("mine", "stopped")])).toBe("mine");
    // Not even when an event names it.
    expect(computerSessionToObserve([foreignLive, session("mine", "active")], "theirs")).toBe("mine");
    // With only others' sessions listed there is nothing to watch.
    expect(computerSessionToObserve([foreignLive])).toBeNull();
  });

  it("follows the preferred session, else the first live one, else the first", () => {
    const list = [session("old", "stopped"), session("live", "active"), session("paused", "paused")];
    expect(computerSessionToObserve(list, "paused")).toBe("paused");
    expect(computerSessionToObserve(list)).toBe("live");
    expect(computerSessionToObserve([session("a", "stopped"), session("b", "error")])).toBe("a");
    expect(computerSessionToObserve([])).toBeNull();
  });
});
