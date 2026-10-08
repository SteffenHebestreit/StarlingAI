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
 * private one. Each guarded call site hands fetch the dispatcher whose lookup decides on the
 * address it connects to, and reports a connection that lookup refused as a refusal.
 *
 * These stub fetch: the names the test network lets through to a real connection are all under
 * .localhost, which the guard refuses by name before any request, so a real connection cannot
 * show the call site's wiring. The dispatcher itself is shown below, through the real fetch.
 */
describe("each guarded call site connects through the guard's dispatcher", () => {
  const ctx: ToolContext = { sessionId: "session-dns-rebinding", workspacePath: "/workspace" };
  // An IP literal: the check before the request needs no DNS for it.
  const FEED = "http://93.184.215.14/feed.xml";
  const REASON = "feeds.example resolved to a private/internal network address when connecting; the connection is refused";

  beforeAll(async () => {
    await import("../tools/web.js");
    await import("../tools/inline-utils.js");
    await import("../tools/http-request.js");
    await import("../tools/data-feeds/index.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mcpConnections.clear();
  });

  async function run(name: string, args: Record<string, unknown>) {
    const { getTool } = await import("../tools/registry.js");
    return getTool(name)!.execute(args, ctx);
  }

  /** fetch recording each request's dispatcher and failing it the way a refused connection fails. */
  function refusingConnections(): unknown[] {
    const dispatchers: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: { dispatcher?: unknown }) => {
      dispatchers.push(init?.dispatcher);
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(REASON), { code: "ESSRFBLOCKED" }) });
    }));
    return dispatchers;
  }

  it.each([
    ["web_fetch", { url: FEED }, `${FEED}: ${REASON}`],
    ["url_inspect", { url: FEED }, `Refusing to probe that URL: ${REASON}.`],
    ["read_rss_feed", { feedUrl: FEED }, `read_rss_feed failed: Refusing to fetch ${FEED}: ${REASON}`],
    ["http_request", { url: FEED, method: "GET" }, `Requesting private/internal network addresses is not allowed: ${REASON}`],
  ])("%s hands fetch the guard's dispatcher and reports a refused connection as a refusal", async (tool, args, error) => {
    const { guardedDispatcher } = await import("../tools/web.js");
    const dispatchers = refusingConnections();
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "### Result\n\"rendered\"" }] }));
    mcpConnections.set("playwright", { client: { callTool } });

    const r = await run(tool, args);
    expect(r.success).toBe(false);
    expect(r.error).toBe(error);
    expect(dispatchers.length).toBeGreaterThan(0);
    expect(dispatchers.every((dispatcher) => dispatcher === guardedDispatcher), "a request without the guard's dispatcher").toBe(true);
    expect(callTool, "a browser tool was called").not.toHaveBeenCalled();
  });
});

/**
 * The dispatcher itself, through Node's global fetch and a real connection: its lookup runs as
 * the connection is made, and its refusal reaches the caller as the cause of the fetch error.
 */
describe("the guard's dispatcher, through the global fetch", () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("internal");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses the connection the default dispatcher makes, so the server is not reached", async () => {
    const { connectRefusalReason, guardedDispatcher } = await import("../tools/web.js");
    const url = `http://localhost:${port}/`;

    const plain = await fetch(url);
    expect(plain.status, "the server is reachable without the guard").toBe(200);
    expect(hits).toBe(1);

    const refused = await fetch(url, { dispatcher: guardedDispatcher } as RequestInit).then(() => null, (err: unknown) => err);
    expect(connectRefusalReason(refused)).toBe("localhost resolved to a private/internal network address when connecting; the connection is refused");
    expect(hits, "the guarded fetch reached the server").toBe(1);
  });
});

function allowPrivateHosts(hosts: string[]) {
  const realConfig = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
  } as typeof realConfig);
}

/** What guardedConnectLookup hands a connection asking for `hostname` (of one address family, when given). */
async function lookUp(hostname: string, all: boolean, family?: number | "IPv4" | "IPv6"): Promise<{ error: (Error & { code?: string }) | null; address?: unknown; family?: unknown }> {
  const { guardedConnectLookup } = await import("../tools/web.js");
  return new Promise((resolve) => {
    guardedConnectLookup(hostname, family === undefined ? { all } : { all, family }, (error, address, answeredFamily) =>
      resolve({ error: error as (Error & { code?: string }) | null, address, family: answeredFamily }));
  });
}

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

  // net may ask for one address family. The first record was handed over whatever its family,
  // so a connection asking for IPv4 could be given an IPv6 address.
  it("answers in the address family the connection asks for", async () => {
    connectAnswers.set("dual.public.example", [{ address: "2001:db8::1", family: 6 }, { address: "93.184.215.14", family: 4 }]);

    expect(await lookUp("dual.public.example", false, 4)).toEqual({ error: null, address: "93.184.215.14", family: 4 });
    expect(await lookUp("dual.public.example", false, "IPv4")).toEqual({ error: null, address: "93.184.215.14", family: 4 });
    expect(await lookUp("dual.public.example", false, 6)).toEqual({ error: null, address: "2001:db8::1", family: 6 });
    expect(await lookUp("dual.public.example", true, 4)).toEqual({ error: null, address: [{ address: "93.184.215.14", family: 4 }], family: undefined });
    expect(await lookUp("dual.public.example", false, 0)).toEqual({ error: null, address: "2001:db8::1", family: 6 });
  });

  it("fails like a resolver when no address of the asked family exists", async () => {
    connectAnswers.set("v6only.public.example", [{ address: "2001:db8::2", family: 6 }]);

    const { error } = await lookUp("v6only.public.example", false, 4);
    expect(error?.code).toBe("ENOTFOUND");
  });
});

/**
 * A name whose answer was the metadata address written as IPv4-mapped IPv6 passed both the check
 * before the request and the lookup its connection made: neither knew that form as private.
 */
describe("a name answering with a private IPv4 address written as IPv6", () => {
  const metadata = [{ address: "::ffff:169.254.169.254", family: 6 }];

  afterEach(() => {
    vi.restoreAllMocks();
    checkAnswers.clear();
    connectAnswers.clear();
  });

  it("is refused by the check before the request", async () => {
    checkAnswers.set("mapped-metadata.example", metadata);
    const { checkUrlSsrf, hostIsBlocked } = await import("../tools/web.js");

    expect(await hostIsBlocked("mapped-metadata.example")).toBe(true);
    expect(await checkUrlSsrf("http://mapped-metadata.example/latest/meta-data/")).toMatch(/private|internal/);
  });

  it("is refused by the lookup its connection makes, listed or not", async () => {
    connectAnswers.set("mapped-metadata.example", metadata);
    expect((await lookUp("mapped-metadata.example", true)).error?.code).toBe("ESSRFBLOCKED");

    allowPrivateHosts(["mapped-metadata.example"]);
    expect((await lookUp("mapped-metadata.example", true)).error?.code).toBe("ESSRFBLOCKED");
  });

  it("passes when the IPv4 address inside is public", async () => {
    checkAnswers.set("mapped-public.example", [{ address: "::ffff:8.8.8.8", family: 6 }]);
    connectAnswers.set("mapped-public.example", [{ address: "::ffff:8.8.8.8", family: 6 }]);
    const { hostIsBlocked } = await import("../tools/web.js");

    expect(await hostIsBlocked("mapped-public.example")).toBe(false);
    expect(await lookUp("mapped-public.example", false)).toEqual({ error: null, address: "::ffff:8.8.8.8", family: 6 });
  });
});
