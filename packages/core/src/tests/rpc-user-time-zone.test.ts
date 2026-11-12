import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * chat.send carries the browser's time zone into the turn (RequestContext.userTimeZone): the
 * gateway runs in UTC, and a time of day the user names is on their own clock
 * (runtime/user-time.ts, tools/schedule.ts).
 */
describe("chat.send timeZone", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.unmock("../agent/runtime.js");
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    const session = await import("../agent/session.js");
    for (const active of session.getAllSessions()) session.endSession(active.id);
  });

  /** The zone the turn runs with, for a chat.send with these extra params. */
  async function zoneOfTurn(params: Record<string, unknown>): Promise<string | undefined> {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-rpc-zone-"));
    const workspacePath = join(tempDir, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "t".repeat(32) }, workspacePath }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const seen: Array<string | undefined> = [];
    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(async () => {
        const { currentRequestContext } = await import("../runtime/request-context.js");
        seen.push(currentRequestContext()?.userTimeZone);
        return new Promise(() => {});
      }),
    }));
    const { RpcConnection } = await import("../gateway/rpc.js");
    const session = await import("../agent/session.js");

    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection({ readyState: 1, send() { /* not read here */ } } as never);
    await connection.handleMessage(JSON.stringify({
      id: "req-zone",
      method: "chat.send",
      params: { sessionId: active.id, requestId: "turn-zone", message: "Remind me tomorrow at nine.", ...params },
    }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    return seen[0];
  }

  it("runs the turn in the zone the browser named", async () => {
    expect(await zoneOfTurn({ timeZone: "Europe/Berlin" })).toBe("Europe/Berlin");
  });

  it("runs it with no zone when the browser named none, or one the runtime does not know", async () => {
    expect(await zoneOfTurn({})).toBeUndefined();
    expect(await zoneOfTurn({ timeZone: "Mars/Olympus_Mons" })).toBeUndefined();
    expect(await zoneOfTurn({ timeZone: 60 })).toBeUndefined();
  });
});
