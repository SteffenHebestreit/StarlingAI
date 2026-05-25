import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserSessionManager } from "../agent/browser-session.js";

describe("browserSessionManager", () => {
  beforeEach(() => browserSessionManager.resetForTests());
  afterEach(() => {
    browserSessionManager.resetForTests();
    delete process.env["BROWSER_VNC_WS_URL"];
  });

  it("registers a session as active and lists it", () => {
    const s = browserSessionManager.register({ agentName: "browser_agent", page: "freelancermap.de login" });
    expect(s.state).toBe("active");
    expect(s.page).toBe("freelancermap.de login");
    expect(browserSessionManager.listActiveSessions().map((x) => x.id)).toContain(s.id);
    expect(browserSessionManager.listAwaitingAssist()).toHaveLength(0);
  });

  it("requestAssist flips state and resolveAssist unblocks the waiter", async () => {
    const s = browserSessionManager.register({ agentName: "browser_agent" });
    const wait = browserSessionManager.requestAssist(s.id, "reCAPTCHA on login");

    expect(browserSessionManager.getSession(s.id)?.state).toBe("assist_requested");
    expect(browserSessionManager.getSession(s.id)?.assistReason).toBe("reCAPTCHA on login");
    expect(browserSessionManager.listAwaitingAssist().map((x) => x.id)).toContain(s.id);

    const resolved = browserSessionManager.resolveAssist(s.id, "steffen");
    expect(resolved).toBe(true);
    await expect(wait).resolves.toBe("resolved");

    const after = browserSessionManager.getSession(s.id);
    expect(after?.state).toBe("active_resolved");
    expect(after?.assistReason).toBeUndefined();
  });

  it("requestAssist times out and reverts to active", async () => {
    const s = browserSessionManager.register({ agentName: "browser_agent" });
    const outcome = await browserSessionManager.requestAssist(s.id, "captcha", { timeoutMs: 20 });
    expect(outcome).toBe("timeout");
    expect(browserSessionManager.getSession(s.id)?.state).toBe("active");
  });

  it("a second requestAssist while one is pending shares the same wait", async () => {
    const s = browserSessionManager.register({ agentName: "browser_agent" });
    const first = browserSessionManager.requestAssist(s.id, "captcha");
    const second = browserSessionManager.requestAssist(s.id, "captcha again");
    browserSessionManager.resolveAssist(s.id);
    await expect(first).resolves.toBe("resolved");
    await expect(second).resolves.toBe("resolved");
  });

  it("stop() unblocks a pending assist with 'stopped'", async () => {
    const s = browserSessionManager.register({ agentName: "browser_agent" });
    const wait = browserSessionManager.requestAssist(s.id, "captcha");
    browserSessionManager.stop(s.id, "run_ended");
    await expect(wait).resolves.toBe("stopped");
    expect(browserSessionManager.getSession(s.id)?.state).toBe("stopped");
    expect(browserSessionManager.listActiveSessions()).toHaveLength(0);
  });

  it("getVncTarget: default, custom, and disabled", () => {
    delete process.env["BROWSER_VNC_WS_URL"];
    expect(browserSessionManager.getVncTarget()).toEqual({ host: "browser-vnc", port: 6080, path: "/websockify" });
    expect(browserSessionManager.isEnabled()).toBe(true);

    process.env["BROWSER_VNC_WS_URL"] = "ws://10.0.0.5:7000/ws";
    expect(browserSessionManager.getVncTarget()).toEqual({ host: "10.0.0.5", port: 7000, path: "/ws" });

    process.env["BROWSER_VNC_WS_URL"] = "";
    expect(browserSessionManager.getVncTarget()).toBeNull();
    expect(browserSessionManager.isEnabled()).toBe(false);
  });

  it("resolveAssist on an unknown session returns false", () => {
    expect(browserSessionManager.resolveAssist("nope")).toBe(false);
  });
});
