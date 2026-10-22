import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake MCP client: each connect makes a new connection with its own number, listing the tools
// the test queued for that server (or the server's usual ones), and a connection the test marks
// dead throws on every call, as a client whose server went away does. A disconnect the test holds
// waits until the test lets it finish, as closing a docker server's container takes a while.
const fake = vi.hoisted(() => {
  const USUAL: Record<string, string[]> = {
    playwright: ["browser_navigate", "browser_snapshot", "browser_screenshot", "browser_evaluate"],
    reader: ["read_page", "list_pages"],
  };
  type Connection = {
    id: number;
    serverName: string;
    dead: boolean;
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    client: { callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> };
    disconnect: () => Promise<void>;
    disconnects: number;
    disconnectHolds: Array<() => Promise<void>>;
  };
  const made: Connection[] = [];
  const calls: string[] = [];
  const answers: Record<string, string> = {};
  const queued: Record<string, Array<() => Promise<string[]>>> = {};
  async function connect(serverName: string): Promise<Connection> {
    const next = queued[serverName]?.shift();
    const toolNames = next ? await next() : USUAL[serverName]!;
    const conn: Connection = {
      id: made.length + 1,
      serverName,
      dead: false,
      tools: toolNames.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
      client: {
        callTool: async (input) => {
          if (conn.dead) throw new Error("MCP error -32000: Connection closed");
          const url = input.name === "browser_navigate" ? ` ${String(input.arguments["url"])}` : "";
          calls.push(`#${conn.id} ${input.name}${url}`);
          return { content: [{ type: "text", text: answers[input.name] ?? "" }] };
        },
      },
      disconnect: async () => {
        conn.disconnects++;
        await conn.disconnectHolds.shift()?.();
      },
      disconnects: 0,
      disconnectHolds: [],
    };
    made.push(conn);
    return conn;
  }
  return { USUAL, made, calls, answers, queued, connect };
});

vi.mock("../mcp/client.js", () => ({
  connectMcpServer: vi.fn(async (serverName: string) => fake.connect(serverName)),
  cleanupConfiguredDockerMcpContainers: vi.fn(async () => {}),
}));

/**
 * A bridged MCP call that fails reconnects its server (mcp.autoReconnect). The reconnect tore the
 * server down, which unregisters its mcp__<server>__* tools, and set only the new connection: the
 * call it was made for went through, and from then on agents had none of that server's tools until
 * the next sync or a gateway restart.
 */
describe("an MCP server reconnected after a failed call is bridged again", () => {
  const PUBLIC = "http://93.184.215.14";
  const ctx = { sessionId: "session-mcp-reconnect", workspacePath: "/workspace" };
  const tempDir = mkdtempSync(join(tmpdir(), "sai-mcp-reconnect-"));
  const configPath = join(tempDir, "starlingai.json");
  let registry: typeof import("../mcp/registry.js");
  let tools: typeof import("../tools/registry.js");
  let resetConfig: () => void;
  let clock = Date.UTC(2026, 9, 9, 12);

  const writeConfig = (servers: Record<string, { autoStart: boolean }>, autoReconnect = true) => {
    writeFileSync(configPath, JSON.stringify({
      mcp: {
        autoReconnect,
        servers: Object.fromEntries(Object.entries(servers).map(([name, { autoStart }]) =>
          [name, { transport: "stdio", command: "echo", args: [], autoStart }])),
      },
    }), "utf8");
    resetConfig();
  };
  const usualConfig = () => writeConfig({ playwright: { autoStart: true }, reader: { autoStart: true } });

  /** The bridged tool names registered for `server`, sorted. */
  const bridged = (server: string) =>
    tools.getAllTools().map((tool) => tool.name).filter((name) => name.startsWith(`mcp__${server}__`)).sort();
  const names = (server: string, mcpTools: string[]) => mcpTools.map((tool) => `mcp__${server}__${tool}`).sort();
  const live = (server: string) => registry.getMcpConnections().get(server) as unknown as (typeof fake.made)[number] | undefined;
  const call = (tool: string, args: Record<string, unknown> = {}) => {
    const handler = tools.getTool(tool);
    if (!handler) throw new Error(`${tool} is not registered`);
    return handler.execute(args, ctx);
  };
  /** Marks the server's connection dead, as a crashed or restarted server leaves it. */
  const blip = (server: string) => {
    const conn = live(server)!;
    conn.dead = true;
    return conn;
  };
  /** The next connect of `server` waits for `release` and lists the tools given to it. */
  const holdNextConnect = (server: string) => {
    let entered!: () => void;
    let release!: (toolNames: string[]) => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<string[]>((resolve) => { release = resolve; });
    (fake.queued[server] ??= []).push(async () => { entered(); return gate; });
    return { reached, release };
  };
  /** The next disconnect of `conn` waits for `release`. */
  const holdNextDisconnect = (conn: (typeof fake.made)[number]) => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    conn.disconnectHolds.push(async () => { entered(); await gate; });
    return { reached, release };
  };
  /** A Playwright MCP answer for a page at `url`. */
  const page = (url: string) => `### Page\n- Page URL: ${url}\n- Page Title: Seite\n### Snapshot\n\`\`\`yaml\n- text: Seite\n\`\`\``;

  beforeAll(async () => {
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    registry = await import("../mcp/registry.js");
    tools = await import("../tools/registry.js");
    ({ resetConfigForTests: resetConfig } = await import("../config/loader.js"));
    // The playwright guard imports the web tools on its first call; load them here, once.
    await import("../tools/web.js");
  });

  beforeEach(async () => {
    // Reconnects are throttled per server; each test starts a minute later.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock += 60_000);
    usualConfig();
    await registry.syncMcpServers();
    fake.calls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(fake.queued)) delete fake.queued[key];
    for (const key of Object.keys(fake.answers)) delete fake.answers[key];
  });

  afterAll(async () => {
    await registry.shutdownMcpServers();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers the same tools again on the new connection, with the browser guard on them", async () => {
    const before = bridged("playwright");
    const old = blip("playwright");
    fake.answers["browser_snapshot"] = page(`${PUBLIC}/katalog`);

    const r = await call("mcp__playwright__browser_snapshot");
    expect(r).toMatchObject({ success: true, output: page(`${PUBLIC}/katalog`) });
    const now = live("playwright")!;
    expect(now.id).not.toBe(old.id);
    expect(old.disconnects).toBe(1);
    expect(bridged("playwright")).toEqual(before);

    // The tools registered again call the new connection, and still take the guard: a private
    // address is refused before it is sent, and a private page an answer reports is refused.
    fake.calls.length = 0;
    const refused = await call("mcp__playwright__browser_navigate", { url: "http://10.0.0.5/admin" });
    expect(refused).toMatchObject({ success: false, error: "Refusing to navigate the browser: requesting private/internal network addresses is not allowed." });
    expect(fake.calls).toEqual([]);
    fake.answers["browser_snapshot"] = page("http://10.0.0.5/admin");
    const hidden = await call("mcp__playwright__browser_snapshot");
    expect(hidden.success).toBe(false);
    expect(fake.calls).toEqual([`#${now.id} browser_snapshot`, `#${now.id} browser_navigate about:blank`]);
  });

  it("registers exactly the tools the server lists after a reconnect that changed them", async () => {
    fake.queued["playwright"] = [async () => ["browser_navigate", "browser_snapshot", "browser_evaluate", "browser_tabs"]];
    blip("playwright");

    expect(await call("mcp__playwright__browser_snapshot")).toMatchObject({ success: true });
    expect(bridged("playwright")).toEqual(names("playwright", ["browser_navigate", "browser_snapshot", "browser_evaluate", "browser_tabs"]));

    // The tool the server added is guarded like the others.
    fake.answers["browser_tabs"] = page("http://10.0.0.5/admin");
    expect(await call("mcp__playwright__browser_tabs")).toMatchObject({ success: false });

    // The server's tool list is the new one: a teardown leaves none of them behind.
    vi.setSystemTime(clock += 60_000);
    fake.queued["playwright"] = [async () => { throw new Error("spawn ENOENT"); }];
    blip("playwright");
    expect(await call("mcp__playwright__browser_tabs")).toMatchObject({ success: false });
    expect(bridged("playwright")).toEqual([]);
  });

  it("does not retry a call whose tool the reconnected server no longer lists", async () => {
    fake.queued["reader"] = [async () => ["list_pages"]];
    blip("reader");

    const r = await call("mcp__reader__read_page");
    expect(r).toMatchObject({
      success: false,
      error: "MCP call failed: Error: MCP error -32000: Connection closed. After reconnecting, reader no longer offers read_page.",
    });
    expect(fake.calls).toEqual([]);
    expect(bridged("reader")).toEqual(["mcp__reader__list_pages"]);
  });

  it("leaves none of the server's tools and no connection when the reconnect fails", async () => {
    fake.queued["reader"] = [async () => { throw new Error("spawn ENOENT"); }];
    const old = blip("reader");
    const playwrightBefore = bridged("playwright");

    const r = await call("mcp__reader__read_page");
    expect(r).toMatchObject({ success: false, error: "MCP call failed: Error: MCP error -32000: Connection closed" });
    expect(bridged("reader")).toEqual([]);
    expect(live("reader")).toBeUndefined();
    expect(old.disconnects).toBe(1);
    expect(bridged("playwright")).toEqual(playwrightBefore);
  });

  it.each([
    ["no longer starts", { playwright: { autoStart: true }, reader: { autoStart: false } }],
    ["no longer lists", { playwright: { autoStart: true } }],
  ])("does not reconnect a server the config %s, and leaves none of its tools", async (_, servers) => {
    const old = blip("reader");
    const connections = fake.made.length;
    writeConfig(servers);

    expect(await call("mcp__reader__read_page")).toMatchObject({ success: false });
    expect(fake.made.length).toBe(connections);
    expect(bridged("reader")).toEqual([]);
    expect(live("reader")).toBeUndefined();
    expect(old.disconnects).toBe(1);
  });

  it("closes the new connection when the config stopped starting the server while it connected", async () => {
    const held = holdNextConnect("reader");
    blip("reader");
    const pending = call("mcp__reader__read_page");
    await held.reached;
    writeConfig({ playwright: { autoStart: true }, reader: { autoStart: false } });
    held.release(fake.USUAL["reader"]!);

    expect(await pending).toMatchObject({ success: false });
    expect(bridged("reader")).toEqual([]);
    expect(live("reader")).toBeUndefined();
    expect(fake.made.at(-1)!.disconnects).toBe(1);
  });

  it("closes the new connection when a sync connected the server again while it connected", async () => {
    const held = holdNextConnect("reader");
    blip("reader");
    const pending = call("mcp__reader__read_page");
    await held.reached;
    await registry.syncMcpServers();
    const synced = live("reader")!;
    held.release(["read_page"]);

    expect(await pending).toMatchObject({ success: false });
    const late = fake.made.at(-1)!;
    expect(late).toMatchObject({ serverName: "reader", disconnects: 1 });
    expect(late.tools.map((tool) => tool.name)).toEqual(["read_page"]);
    expect(live("reader")).toBe(synced);
    expect(synced.disconnects).toBe(0);
    expect(bridged("reader")).toEqual(names("reader", fake.USUAL["reader"]!));
  });

  it("closes the new connection when a sync that started first connected the server while it connected", async () => {
    // A call already under way when a sync tore the server down fails on the closed connection
    // and reconnects while the sync is still connecting.
    const handler = tools.getTool("mcp__reader__read_page")!;
    const syncConnect = holdNextConnect("reader");
    const reconnectConnect = holdNextConnect("reader");
    const old = live("reader")!;
    const sync = registry.syncMcpServers();
    await syncConnect.reached;
    old.dead = true;
    const pending = handler.execute({}, ctx);
    await reconnectConnect.reached;
    syncConnect.release(fake.USUAL["reader"]!);
    await sync;
    const synced = live("reader")!;
    reconnectConnect.release(["read_page"]);

    expect(await pending).toMatchObject({ success: false });
    expect(fake.made.at(-1)).toMatchObject({ serverName: "reader", disconnects: 1 });
    expect(live("reader")).toBe(synced);
    expect(synced.disconnects).toBe(0);
    expect(bridged("reader")).toEqual(names("reader", fake.USUAL["reader"]!));
  });

  it("closes the reconnected connection when a sync that started first connects the server after it", async () => {
    // The order the test above mirrors: the reconnect's connect comes back first and bridges the
    // server, and the sync's comes back after it.
    const handler = tools.getTool("mcp__reader__read_page")!;
    const syncConnect = holdNextConnect("reader");
    const reconnectConnect = holdNextConnect("reader");
    const old = live("reader")!;
    const sync = registry.syncMcpServers();
    await syncConnect.reached;
    old.dead = true;
    const pending = handler.execute({}, ctx);
    await reconnectConnect.reached;
    reconnectConnect.release(["read_page", "write_page"]);
    expect(await pending).toMatchObject({ success: true });
    const reconnected = live("reader")!;
    expect(reconnected.tools.map((tool) => tool.name)).toEqual(["read_page", "write_page"]);
    expect(fake.calls).toEqual([`#${reconnected.id} read_page`]);

    syncConnect.release(fake.USUAL["reader"]!);
    await sync;

    const synced = live("reader")!;
    expect(synced).toBe(fake.made.at(-1));
    expect(synced.id).not.toBe(reconnected.id);
    expect(synced.disconnects).toBe(0);
    expect(reconnected.disconnects).toBe(1);
    expect(bridged("reader")).toEqual(names("reader", fake.USUAL["reader"]!));
  });

  it("closes the connection of a later sync when an earlier sync connects the server after it", async () => {
    const earlier = holdNextConnect("reader");
    const later = holdNextConnect("reader");
    const first = registry.syncMcpServers();
    await earlier.reached;
    const second = registry.syncMcpServers();
    await later.reached;
    later.release(["read_page", "write_page"]);
    await second;
    const fromSecond = live("reader")!;
    expect(fromSecond.tools.map((tool) => tool.name)).toEqual(["read_page", "write_page"]);

    earlier.release(fake.USUAL["reader"]!);
    await first;

    expect(live("reader")).toBe(fake.made.at(-1));
    expect(live("reader")!.disconnects).toBe(0);
    expect(fromSecond.disconnects).toBe(1);
    expect(bridged("reader")).toEqual(names("reader", fake.USUAL["reader"]!));
  });

  it("does not take out a connection bridged while a teardown was still closing the one before it", async () => {
    // Two syncs close the same connection; the second one's close comes back first, and that
    // sync connects and bridges the server while the first one's close is still under way.
    const old = live("reader")!;
    const slowClose = holdNextDisconnect(old);
    const first = registry.syncMcpServers();
    await slowClose.reached;
    await registry.syncMcpServers();
    const fromSecond = live("reader")!;
    expect(fromSecond.id).not.toBe(old.id);

    slowClose.release();
    await first;

    const fromFirst = live("reader")!;
    expect(fromFirst).toBe(fake.made.at(-1));
    expect(fromFirst.disconnects).toBe(0);
    expect(fromSecond.disconnects).toBe(1);
    expect(bridged("reader")).toEqual(names("reader", fake.USUAL["reader"]!));
  });

  it("closes the new connection when the servers shut down while it connected", async () => {
    const held = holdNextConnect("reader");
    blip("reader");
    const pending = call("mcp__reader__read_page");
    await held.reached;
    await registry.shutdownMcpServers();
    held.release(fake.USUAL["reader"]!);

    expect(await pending).toMatchObject({ success: false });
    expect(bridged("reader")).toEqual([]);
    expect(live("reader")).toBeUndefined();
    expect(fake.made.at(-1)!.disconnects).toBe(1);
  });

  // E2E 2026-10-22: the playwright container went away mid-run. The gateway's own browser tools
  // call the connection directly (callPlaywrightTool), past the bridged tools' reconnect, and every
  // browser call after it failed with "Not connected" until the gateway restarted.
  describe("the gateway's own browser tools", () => {
    let callPlaywrightTool: typeof import("../tools/multimodal.js").callPlaywrightTool;
    beforeAll(async () => { ({ callPlaywrightTool } = await import("../tools/multimodal.js")); });

    it("reconnect the server when its connection is gone, and send the call once more", async () => {
      const old = blip("playwright");
      fake.answers["browser_snapshot"] = page(`${PUBLIC}/katalog`);

      expect(await callPlaywrightTool("browser_snapshot", {})).toBe(page(`${PUBLIC}/katalog`));
      const now = live("playwright")!;
      expect(now.id).not.toBe(old.id);
      expect(old.disconnects).toBe(1);
      expect(fake.calls).toEqual([`#${now.id} browser_snapshot`]);
    });

    it("leave a call the server may still be running alone: a timeout is not a lost connection", async () => {
      const conn = live("playwright")!;
      conn.client.callTool = async () => { throw new Error("MCP error -32001: Request timed out"); };

      await expect(callPlaywrightTool("browser_snapshot", {})).rejects.toThrow(/timed out/);
      expect(live("playwright")).toBe(conn);
    });

    it("stay down when mcp.autoReconnect is off", async () => {
      writeConfig({ playwright: { autoStart: true }, reader: { autoStart: true } }, false);
      const old = blip("playwright");

      await expect(callPlaywrightTool("browser_snapshot", {})).rejects.toThrow(/Connection closed/);
      expect(live("playwright")).toBe(old);
    });
  });
});
