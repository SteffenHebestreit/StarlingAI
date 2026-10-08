import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as loaderModule from "../config/loader.js";
import type { ToolContext } from "../tools/registry.js";

const mcpConnections = new Map<string, unknown>();
vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => mcpConnections,
}));

// Two resolutions of one name with different answers, which is what DNS rebinding is: the guard's
// check (node:dns/promises) is answered with a public address, the connection (node:dns, the
// callback lookup net uses) with loopback. Names not in the tables resolve for real.
const { checkAnswers, connectAnswers } = vi.hoisted(() => ({
  checkAnswers: new Map<string, Array<{ address: string; family: number }>>(),
  connectAnswers: new Map<string, Array<{ address: string; family: number }>>(),
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = (hostname: string, options?: unknown) => {
    const answer = checkAnswers.get(hostname);
    return answer ? Promise.resolve(answer) : actual.lookup(hostname, options as never);
  };
  return { ...actual, lookup };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    const answer = connectAnswers.get(hostname);
    if (!answer) return (actual.lookup as (...args: unknown[]) => void)(hostname, options, callback);
    process.nextTick(() => (options?.all ? callback(null, answer) : callback(null, answer[0]!.address, answer[0]!.family)));
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

/**
 * The guard resolved a name to decide and the request resolved it again to connect, so a name
 * whose answers changed in between passed the check on a public address and connected to a
 * private one. Each guarded call site now connects through a dispatcher whose lookup makes the
 * same decision on the addresses it connects to.
 */
describe("a name that resolves differently at connect time does not reach a private address", () => {
  const ctx: ToolContext = { sessionId: "session-dns-rebinding", workspacePath: "/workspace" };
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end("<?xml version=\"1.0\"?><rss><channel><title>Loopback</title><item><title>internal item</title><link>http://127.0.0.1/1</link></item></channel></rss>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    await import("../tools/web.js");
    await import("../tools/inline-utils.js");
    await import("../tools/http-request.js");
    await import("../tools/data-feeds/index.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mcpConnections.clear();
    checkAnswers.clear();
    connectAnswers.clear();
    hits = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A name the guard's check sees as public and the connection resolves to loopback. */
  function rebinding(name: string): string {
    checkAnswers.set(name, [{ address: "93.184.215.14", family: 4 }]);
    connectAnswers.set(name, [{ address: "127.0.0.1", family: 4 }]);
    return `http://${name}:${port}/feed.xml`;
  }

  async function run(name: string, args: Record<string, unknown>) {
    const { getTool } = await import("../tools/registry.js");
    return getTool(name)!.execute(args, ctx);
  }

  it("web_fetch: refused before connecting, with no browser fall-through", async () => {
    const url = rebinding("rebind-web.localhost");
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "### Result\n\"rendered\"" }] }));
    mcpConnections.set("playwright", { client: { callTool } });

    const r = await run("web_fetch", { url });
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${url}: rebind-web.localhost resolved to a private/internal network address when connecting; the connection is refused`);
    expect(callTool, "a browser tool was called").not.toHaveBeenCalled();
    expect(hits, "the loopback server was reached").toBe(0);
  });

  it("url_inspect: refused before connecting", async () => {
    const url = rebinding("rebind-inspect.localhost");

    const r = await run("url_inspect", { url });
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to probe that URL: rebind-inspect.localhost resolved to a private/internal network address when connecting; the connection is refused.");
    expect(hits).toBe(0);
  });

  it("read_rss_feed: refused before connecting", async () => {
    const url = rebinding("rebind-rss.localhost");

    const r = await run("read_rss_feed", { feedUrl: url });
    expect(r.success).toBe(false);
    expect(r.error).toBe(`read_rss_feed failed: Refusing to fetch ${url}: rebind-rss.localhost resolved to a private/internal network address when connecting; the connection is refused`);
    expect(hits).toBe(0);
  });

  it("http_request: refused before connecting", async () => {
    const url = rebinding("rebind-http.localhost");

    const r = await run("http_request", { url, method: "GET" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("Requesting private/internal network addresses is not allowed: rebind-http.localhost resolved to a private/internal network address when connecting; the connection is refused");
    expect(hits).toBe(0);
  });
});

/**
 * The connect-time decision itself, on the lookup undici calls: the same as the guard's, so an
 * operator's allowlisted LAN name still connects. Loopback cannot serve as the positive case
 * (the guard never allows it), so these call the lookup directly.
 */
describe("the connect-time lookup makes the guard's decision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    connectAnswers.clear();
  });

  function allowPrivateHosts(hosts: string[]) {
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
    } as typeof realConfig);
  }

  async function lookUp(hostname: string, all: boolean): Promise<{ error: (Error & { code?: string }) | null; address?: unknown; family?: unknown }> {
    const { guardedConnectLookup } = await import("../tools/web.js");
    return new Promise((resolve) => {
      guardedConnectLookup(hostname, { all }, (error, address, family) => resolve({ error: error as (Error & { code?: string }) | null, address, family }));
    });
  }

  it("hands an allowlisted LAN name's address to the connection, in both answer shapes", async () => {
    allowPrivateHosts(["wiki.lan.example"]);
    connectAnswers.set("wiki.lan.example", [{ address: "172.22.0.14", family: 4 }]);

    expect(await lookUp("wiki.lan.example", true)).toEqual({ error: null, address: [{ address: "172.22.0.14", family: 4 }], family: undefined });
    expect(await lookUp("wiki.lan.example", false)).toEqual({ error: null, address: "172.22.0.14", family: 4 });
  });

  it("refuses the same name when it is not listed", async () => {
    connectAnswers.set("wiki.lan.example", [{ address: "172.22.0.14", family: 4 }]);

    const { error } = await lookUp("wiki.lan.example", true);
    expect(error?.code).toBe("ESSRFBLOCKED");
    expect(error?.message).toBe("wiki.lan.example resolved to a private/internal network address when connecting; the connection is refused");
  });

  it("refuses a listed name that resolves to loopback or the metadata address", async () => {
    allowPrivateHosts(["wiki.lan.example"]);
    for (const address of ["127.0.0.1", "169.254.169.254"]) {
      connectAnswers.set("wiki.lan.example", [{ address, family: 4 }]);
      expect((await lookUp("wiki.lan.example", true)).error?.code, address).toBe("ESSRFBLOCKED");
    }
  });

  it("hands a public address to the connection", async () => {
    connectAnswers.set("www.public.example", [{ address: "93.184.215.14", family: 4 }]);

    expect(await lookUp("www.public.example", false)).toEqual({ error: null, address: "93.184.215.14", family: 4 });
  });
});
