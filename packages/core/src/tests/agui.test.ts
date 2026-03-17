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
    .map(part => part.replace(/^data:\s*/m, ""))
    .map(part => JSON.parse(part) as Record<string, unknown>);
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
});