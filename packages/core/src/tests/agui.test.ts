import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks: string[] = [];
  ended = false;

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string) {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
}

function parseSseEvents(chunks: string[]): Array<Record<string, unknown>> {
  return chunks
    .flatMap(chunk => chunk.split("\n\n"))
    .map(part => part.trim())
    .filter(Boolean)
    // Comment lines are part of the SSE grammar and carry no event — the keepalive
    // heartbeat is written as one. A parser that JSON.parses them throws on a healthy
    // stream, which is exactly what a real client would have done too.
    .filter(part => !part.startsWith(":"))
    .map(part => part.replace(/^data:\s*/m, ""))
    .map(part => JSON.parse(part) as Record<string, unknown>);
}

/** SSE comment lines — the keepalive heartbeat. */
function heartbeats(chunks: string[]): string[] {
  return chunks.filter(chunk => chunk.startsWith(":"));
}

describe("AG-UI streaming", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.unmock("../agent/runtime.js");
    delete process.env["SAI_CONFIG_PATH"];

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    const session = await import("../agent/session.js");
    for (const active of session.getAllSessions()) {
      session.endSession(active.id);
    }
  });

  it("heartbeats through a silent turn, and stops when the turn ends", async () => {
    // THE DEFECT THIS FIXES, measured. A delegated sub-agent call produces no SSE traffic
    // for its whole duration (15.8 minutes in the run that prompted this). Node's own
    // fetch aborts a silent body at 300s, and the disconnect handler in agui.ts aborts the
    // TURN — so the client's timeout cancelled the run it was waiting on and the gateway
    // logged a sub-agent failure at iteration 0. Silence had to become non-silent.
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agui-hb-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "a".repeat(32), turnTimeoutMs: 1_800_000 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });

    vi.doMock("../agent/runtime.js", () => ({
      // A turn that produces NOTHING until released — the shape of a delegation.
      runTurn: vi.fn(async () => {
        await turnGate;
        return {
          response: "done",
          toolCallsExecuted: 0,
          guardrailEvents: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          blocked: false,
        };
      }),
    }));

    vi.useFakeTimers();
    try {
      const { handleAguiStream } = await import("../gateway/agui.js");
      const res = new FakeResponse();
      const streamed = handleAguiStream(res as never, { message: "build something large" });

      // Four heartbeat intervals of total silence — well past undici's 300s body timeout
      // in real terms, and the window in which the old code wrote nothing at all.
      await vi.advanceTimersByTimeAsync(62_000);
      expect(heartbeats(res.chunks).length).toBeGreaterThanOrEqual(4);

      releaseTurn();
      await streamed;

      // The interval is cleared on completion: a leaked one writes to a closed stream
      // every 15s forever, which is worse than the silence it replaced.
      const afterFinish = res.chunks.length;
      await vi.advanceTimersByTimeAsync(62_000);
      expect(res.chunks.length).toBe(afterFinish);

      // ...and the heartbeats did not corrupt the event stream.
      const events = parseSseEvents(res.chunks);
      expect(events.some(event => event["type"] === "RUN_STARTED")).toBe(true);
      expect(events.some(event => event["type"] === "RUN_FINISHED")).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("streams operator intervention notices over SSE", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agui-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "a".repeat(32),
        turnTimeoutMs: 30_000,
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(async (opts: Record<string, unknown>) => {
        const onIntervention = opts["onIntervention"] as ((notice: Record<string, unknown>) => void) | undefined;
        const onChunk = opts["onChunk"] as ((text: string) => void) | undefined;

        onIntervention?.({
          reasonCode: "network_failure",
          severity: "warn",
          summary: "web_fetch hit a network or service failure",
          detail: "You can stop this run, start a new one, or ask the agent to stop and restart the affected process with approval.",
          toolName: "web_fetch",
          actions: [{ kind: "stop_turn", label: "Stop this run" }],
        });
        onChunk?.("partial response");

        return {
          response: "partial response",
          toolCallsExecuted: 0,
          guardrailEvents: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          blocked: false,
        };
      }),
    }));

    try {
      const [{ handleAguiStream }] = await Promise.all([
        import("../gateway/agui.js"),
      ]);

      const res = new FakeResponse();
      await handleAguiStream(res as never, { message: "check this" });

      expect(res.statusCode).toBe(200);
      expect(res.headers?.["Content-Type"]).toBe("text/event-stream");

      const events = parseSseEvents(res.chunks);
      expect(events.some(event => event["type"] === "RUN_STARTED")).toBe(true);
      expect(events.some(event => event["type"] === "OPERATOR_INTERVENTION")).toBe(true);
      expect(events.some(event => event["type"] === "RUN_FINISHED")).toBe(true);

      const intervention = events.find(event => event["type"] === "OPERATOR_INTERVENTION");
      expect(intervention?.["notice"]).toMatchObject({
        reasonCode: "network_failure",
        toolName: "web_fetch",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the turn under the requested sessionId + authenticated userId (document-RAG scope)", async () => {
    // Regression: handleAguiStream previously called createSession without the
    // requested sessionId or a userId, so session/user-scoped documents dropped
    // out of retrieval (a doc uploaded under session:S / user:U was invisible to
    // that AG-UI turn — only workspace scope worked). The turn's session must
    // carry both so activeScopeSources includes session:S and user:U.
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agui-scope-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "a".repeat(32), turnTimeoutMs: 30_000 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    let seenSessionId: string | undefined;
    let seenUserId: string | undefined;
    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(async (opts: Record<string, unknown>) => {
        const session = opts["session"] as { id: string; userId?: string };
        seenSessionId = session.id;
        seenUserId = session.userId;
        (opts["onChunk"] as ((t: string) => void) | undefined)?.("ok");
        return { response: "ok", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, blocked: false };
      }),
    }));

    try {
      const { handleAguiStream } = await import("../gateway/agui.js");
      const res = new FakeResponse();
      await handleAguiStream(res as never, { sessionId: "sess-scope-1", message: "hi" }, { userId: "alice" });
      expect(seenSessionId).toBe("sess-scope-1");
      expect(seenUserId).toBe("alice");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to drive a turn on another user's existing session under active auth", async () => {
    // Regression: handleAguiStream resolved an existing session purely by id with no
    // ownership check, so any authenticated caller who knew a victim's sessionId could
    // run a turn AS the victim (their history + user-scoped memory/documents). Mirrors
    // the RPC canAccessSession invariant. Operators may still access any session.
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agui-owner-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "a".repeat(32), turnTimeoutMs: 30_000 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    const ran = vi.fn(async () => ({ response: "ok", toolCallsExecuted: 0, guardrailEvents: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, blocked: false }));
    vi.doMock("../agent/runtime.js", () => ({ runTurn: ran }));
    // Force auth ON deterministically (overlay onto the real loaded config so session.js
    // still sees every other field). Avoids depending on file-based auth resolution.
    vi.doMock("../config/loader.js", async () => {
      const actual = await vi.importActual<typeof import("../config/loader.js")>("../config/loader.js");
      return {
        ...actual,
        getConfig: () => {
          const cfg = actual.getConfig();
          return { ...cfg, auth: { ...cfg.auth, enabled: true, provider: "builtin", users: [] } };
        },
      };
    });

    try {
      const { handleAguiStream } = await import("../gateway/agui.js");

      // alice creates her session (owned by alice) via the handler.
      const resCreate = new FakeResponse();
      await handleAguiStream(resCreate as never, { sessionId: "victim-sess", message: "hi" }, { userId: "alice", role: "viewer" });
      expect(resCreate.statusCode).toBe(200);
      expect(ran).toHaveBeenCalledTimes(1);

      // A non-privileged "viewer" bob tries to drive it → opaque 404, turn never runs.
      // (Instance operators/admins are trusted to access any session, mirroring RPC.)
      const resBob = new FakeResponse();
      await handleAguiStream(resBob as never, { sessionId: "victim-sess", message: "leak it" }, { userId: "bob", role: "viewer" });
      expect(resBob.statusCode).toBe(404);
      expect(ran).toHaveBeenCalledTimes(1);

      // An admin (instance-wide) role may access any session.
      const resAdmin = new FakeResponse();
      await handleAguiStream(resAdmin as never, { sessionId: "victim-sess", message: "audit" }, { userId: "carol", role: "admin" });
      expect(resAdmin.statusCode).toBe(200);
      expect(ran).toHaveBeenCalledTimes(2);

      // The owner may access her own session.
      const resOwner = new FakeResponse();
      await handleAguiStream(resOwner as never, { sessionId: "victim-sess", message: "mine" }, { userId: "alice", role: "viewer" });
      expect(resOwner.statusCode).toBe(200);
      expect(ran).toHaveBeenCalledTimes(3);
    } finally {
      vi.unmock("../config/loader.js");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});