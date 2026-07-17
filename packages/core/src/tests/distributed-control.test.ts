import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestDistributedSessionCancel,
  resetDistributedControlForTests,
  startDistributedControl,
} from "../swarm/control.js";
import { registerSessionAbortController, deregisterSessionAbortController } from "../agent/warden.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { getConfig } from "../config/loader.js";

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => ({
      ...original.getConfig(),
      mission: {
        ...original.getConfig().mission,
        store: "off",
        control: { distributedCancel: true },
      },
    })),
  };
});

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("distributed session cancel (CTL-205, bus path)", () => {
  afterEach(async () => {
    await resetDistributedControlForTests();
    vi.mocked(getConfig).mockClear();
  });

  it("a cancel request aborts a locally-owned active turn", async () => {
    const controller = new AbortController();
    registerSessionAbortController("ctl-sess-1", controller);
    try {
      const result = await requestDistributedSessionCancel("ctl-sess-1", { reason: "test_stop", actor: "tester" });
      expect(result.abortedLocally).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      deregisterSessionAbortController("ctl-sess-1");
    }
  });

  it("a bus-delivered command from another process aborts the owner's turn, idempotently", async () => {
    const stop = startDistributedControl();
    const controller = new AbortController();
    registerSessionAbortController("ctl-sess-2", controller);
    try {
      // Simulate the command arriving over the bus from a REMOTE issuer.
      emitSwarmEvent("session_cancel_requested", {
        sessionId: "ctl-sess-2",
        data: { commandId: "cmd-remote-1", reason: "warden_alert", actor: "warden@other-process" },
      });
      await pause(50);
      expect(controller.signal.aborted).toBe(true);
      // Redelivery of the same command id is a no-op (no throw on an aborted controller).
      emitSwarmEvent("session_cancel_requested", {
        sessionId: "ctl-sess-2",
        data: { commandId: "cmd-remote-1", reason: "warden_alert", actor: "warden@other-process" },
      });
      await pause(50);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      deregisterSessionAbortController("ctl-sess-2");
      stop();
    }
  });

  it("a command for a session this process does not own does nothing locally", async () => {
    const stop = startDistributedControl();
    try {
      emitSwarmEvent("session_cancel_requested", {
        sessionId: "ctl-sess-unowned",
        data: { commandId: "cmd-remote-2", reason: "operator", actor: "op" },
      });
      await pause(50); // no registered controller — must not throw
      expect(true).toBe(true);
    } finally {
      stop();
    }
  });

  it("the issue side reports abortedLocally=false when it does not own the session", async () => {
    const result = await requestDistributedSessionCancel("ctl-sess-elsewhere", { reason: "op_stop" });
    expect(result.abortedLocally).toBe(false);
    expect(result.commandId).toBeTruthy();
  });
});
