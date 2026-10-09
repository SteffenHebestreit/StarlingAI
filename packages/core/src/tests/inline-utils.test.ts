import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as loaderModule from "../config/loader.js";
import { getTool, type ToolHandler } from "../tools/registry.js";
import "../tools/inline-utils.js"; // registers the Tier-0 inline tools

// A name on the operator's LAN for the allowlist cases: it resolves to a private address. Every
// other lookup is the real one.
const { LAN_HOST, LAN_ADDRESS } = vi.hoisted(() => ({ LAN_HOST: "wiki.lan.example", LAN_ADDRESS: "172.22.0.14" }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = (hostname: string, options?: unknown) => hostname === LAN_HOST
    ? Promise.resolve([{ address: LAN_ADDRESS, family: 4 }])
    : actual.lookup(hostname, options as never);
  return { ...actual, lookup };
});

function tool(name: string): ToolHandler {
  const t = getTool(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe("inline-utils Tier-0 tools", () => {
  beforeAll(() => { void import("../tools/inline-utils.js"); });

  describe("datetime_arithmetic", () => {
    const dt = () => tool("datetime_arithmetic");
    it("adds a duration", async () => {
      const r = await dt().execute({ operation: "add", base: "2026-01-01T00:00:00.000Z", duration: "5d" }, {} as never);
      expect(r.success).toBe(true);
      expect(r.output).toBe("2026-01-06T00:00:00.000Z");
    });
    it("subtracts a duration", async () => {
      const r = await dt().execute({ operation: "subtract", base: "2026-01-10T00:00:00.000Z", duration: "2 days" }, {} as never);
      expect(r.output).toBe("2026-01-08T00:00:00.000Z");
    });
    it("computes a diff in days", async () => {
      const r = await dt().execute({ operation: "diff", base: "2026-01-01T00:00:00.000Z", target: "2026-01-08T00:00:00.000Z", unit: "days" }, {} as never);
      expect(r.output).toBe("7 days");
      expect(r.metadata?.["value"]).toBe(7);
    });
    it("is calendar-aware for months", async () => {
      const r = await dt().execute({ operation: "add", base: "2026-01-15T00:00:00.000Z", duration: "1 mo" }, {} as never);
      expect(r.output.startsWith("2026-02-15")).toBe(true);
    });
    it("formats/parses a date", async () => {
      const r = await dt().execute({ operation: "format", base: "2026-03-04T05:06:07.000Z" }, {} as never);
      expect(r.success).toBe(true);
      expect(r.output).toBe("2026-03-04T05:06:07.000Z");
    });
    it("rejects unknown operation, bad base, bad duration", async () => {
      expect((await dt().execute({ operation: "nope" }, {} as never)).success).toBe(false);
      expect((await dt().execute({ operation: "add", base: "not-a-date", duration: "5d" }, {} as never)).success).toBe(false);
      expect((await dt().execute({ operation: "add", base: "2026-01-01T00:00:00Z", duration: "5 lightyears" }, {} as never)).success).toBe(false);
    });
  });

  describe("json_query", () => {
    const jq = () => tool("json_query");
    const doc = { users: [{ name: "Ann", "first.name": "A" }, { name: "Bo" }] };
    it("walks dot + index paths (string input)", async () => {
      const r = await jq().execute({ json: JSON.stringify(doc), path: "users[0].name" }, {} as never);
      expect(r.success).toBe(true);
      expect(r.output).toBe("Ann");
    });
    it("accepts an already-parsed object", async () => {
      const r = await jq().execute({ json: doc, path: "users[-1].name" }, {} as never);
      expect(r.output).toBe("Bo");
    });
    it("splat returns the array elements as-is (trailing path is ignored)", async () => {
      const r = await jq().execute({ json: doc, path: "users[*]" }, {} as never);
      expect(JSON.parse(r.output)).toEqual(doc.users);
    });
    it("supports quoted bracket keys with dots", async () => {
      const r = await jq().execute({ json: doc, path: 'users[0]["first.name"]' }, {} as never);
      expect(r.output).toBe("A");
    });
    it("returns the whole doc for '$'", async () => {
      const r = await jq().execute({ json: doc, path: "$" }, {} as never);
      expect(JSON.parse(r.output)).toEqual(doc);
    });
    it("fails on invalid JSON and on splat over a non-array", async () => {
      expect((await jq().execute({ json: "{bad", path: "$" }, {} as never)).success).toBe(false);
      expect((await jq().execute({ json: doc, path: "users[0][*]" }, {} as never)).success).toBe(false);
    });
  });

  describe("regex_test", () => {
    const rt = () => tool("regex_test");
    it("returns matches with capture groups + offsets", async () => {
      const r = await rt().execute({ pattern: "(\\d+)-(\\d+)", text: "a 12-34 b 56-78" }, {} as never);
      expect(r.success).toBe(true);
      const matches = r.metadata?.["matches"] as Array<{ match: string; groups: string[] }>;
      expect(matches).toHaveLength(2);
      expect(matches[0]!.groups).toEqual(["12", "34"]);
    });
    it("reports no matches cleanly", async () => {
      const r = await rt().execute({ pattern: "zzz", text: "abc" }, {} as never);
      expect(r.output).toBe("No matches.");
      expect(r.metadata?.["matchCount"]).toBe(0);
    });
    it("does not infinite-loop on a zero-width pattern", async () => {
      const r = await rt().execute({ pattern: "a*", text: "aaa", maxMatches: 10 }, {} as never);
      expect(r.success).toBe(true);
    });
    it("fails on missing pattern and on invalid regex", async () => {
      expect((await rt().execute({ pattern: "", text: "x" }, {} as never)).success).toBe(false);
      expect((await rt().execute({ pattern: "(", text: "x" }, {} as never)).success).toBe(false);
    });
  });

  describe("text_diff", () => {
    const td = () => tool("text_diff");
    it("reports identical text", async () => {
      const r = await td().execute({ before: "a\nb", after: "a\nb" }, {} as never);
      expect(r.output).toBe("(no differences)");
      expect(r.metadata?.["identical"]).toBe(true);
    });
    it("counts added and deleted lines", async () => {
      const r = await td().execute({ before: "a\nb\nc", after: "a\nB\nc" }, {} as never);
      expect(r.metadata?.["added"]).toBe(1);
      expect(r.metadata?.["deleted"]).toBe(1);
      expect(r.output).toContain("+ B");
      expect(r.output).toContain("- b");
    });
  });

  describe("hash_compute", () => {
    const hc = () => tool("hash_compute");
    it("computes a known sha256 digest", async () => {
      const r = await hc().execute({ text: "abc", algorithm: "sha256" }, {} as never);
      expect(r.output).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
    it("computes a known md5 digest", async () => {
      const r = await hc().execute({ text: "abc", algorithm: "md5" }, {} as never);
      expect(r.output).toBe("900150983cd24fb0d6963f7d28e17f72");
    });
    it("truncates the digest when asked", async () => {
      const r = await hc().execute({ text: "abc", truncate: 8 }, {} as never);
      expect(r.output).toBe("ba7816bf");
      expect(r.metadata?.["truncated"]).toBe(true);
    });
    it("fails on an unknown algorithm", async () => {
      expect((await hc().execute({ text: "abc", algorithm: "notahash" }, {} as never)).success).toBe(false);
    });
  });

  it("registers url_inspect", () => {
    expect(getTool("url_inspect")).toBeDefined();
  });
});

/**
 * url_inspect had no SSRF guard and let fetch follow redirects: it probed http://10.0.0.5/ as
 * asked, and a public URL that redirected into the private network answered with that
 * service's status and headers. It now checks every host it reaches with web_fetch's guard.
 */
describe("url_inspect goes through web_fetch's SSRF guard", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";
  const probe = (args: Record<string, unknown>) => tool("url_inspect").execute(args, {} as never);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * fetch on a small web of `pages` (URL -> status and headers). Like fetch, it follows redirects
   * itself unless the caller asks for redirect "manual"; `requested` lists every URL it was asked
   * for or followed to.
   */
  function web(pages: Record<string, { status: number; headers?: Record<string, string> }>) {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = String(input);
      for (let hop = 0; hop <= 20; hop++) {
        requested.push(url);
        const page = pages[url] ?? { status: 404 };
        const res = new Response(null, { status: page.status, headers: page.headers });
        const location = res.headers.get("location");
        if (init?.redirect === "manual" || !location || ![301, 302, 303, 307, 308].includes(res.status)) {
          Object.defineProperty(res, "url", { value: url });
          return res;
        }
        url = new URL(location, url).toString();
      }
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, requested };
  }

  function allowPrivateHosts(hosts: string[]) {
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
    } as typeof realConfig);
  }

  it("refuses a private address before any request is sent", async () => {
    const { fetchMock } = web({ "http://10.0.0.5/": { status: 200, headers: { server: "internal-admin" } } });

    const r = await probe({ url: "http://10.0.0.5/" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to probe that URL: requesting private/internal network addresses is not allowed.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to follow a public URL's redirect into loopback, and never requests the target", async () => {
    const internal = "http://127.0.0.1:9000/exec?query=select%201";
    const { requested } = web({
      [`${PUBLIC}/go`]: { status: 302, headers: { location: internal } },
      [internal]: { status: 200, headers: { server: "questdb", "content-type": "application/json" } },
    });

    const r = await probe({ url: `${PUBLIC}/go` });
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Refusing to follow the redirect from ${PUBLIC}/go: requesting private/internal network addresses is not allowed.`);
    expect(r.output).not.toContain("questdb");
    expect(requested).toEqual([`${PUBLIC}/go`]);
  });

  it("follows a public redirect chain hop by hop and reports where it ended", async () => {
    const { requested } = web({
      [`${PUBLIC}/alt`]: { status: 301, headers: { location: "/neu" } },
      [`${PUBLIC}/neu`]: { status: 200, headers: { "content-type": "text/html", server: "nginx" } },
    });

    const r = await probe({ url: `${PUBLIC}/alt` });
    expect(r.success).toBe(true);
    expect(r.output).toBe(["200", `final: ${PUBLIC}/neu (redirected)`, "content-type: text/html", "server: nginx"].join("\n"));
    expect(r.metadata?.["redirected"]).toBe(true);
    expect(requested).toEqual([`${PUBLIC}/alt`, `${PUBLIC}/neu`]);
  });

  it("gives up after as many redirects as web_fetch follows", async () => {
    const { requested } = web({
      [`${PUBLIC}/a`]: { status: 302, headers: { location: "/b" } },
      [`${PUBLIC}/b`]: { status: 302, headers: { location: "/a" } },
    });

    const r = await probe({ url: `${PUBLIC}/a` });
    expect(r.success).toBe(false);
    expect(r.error).toBe("URL probe failed: more than 5 redirects");
    expect(requested).toHaveLength(6);
  });

  it("refuses a LAN name that resolves to a private address when it is not listed", async () => {
    const { fetchMock } = web({ [`http://${LAN_HOST}/`]: { status: 200 } });

    const r = await probe({ url: `http://${LAN_HOST}/` });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/private\/internal network addresses is not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still probes that name, redirects included, when guardrails.allowedPrivateHosts lists it", async () => {
    allowPrivateHosts([LAN_HOST]);
    const { requested } = web({
      [`http://${LAN_HOST}/`]: { status: 302, headers: { location: "/start" } },
      [`http://${LAN_HOST}/start`]: { status: 200, headers: { "content-type": "text/html" } },
    });

    const r = await probe({ url: `http://${LAN_HOST}/` });
    expect(r.success).toBe(true);
    expect(r.output).toContain(`final: http://${LAN_HOST}/start (redirected)`);
    expect(requested).toEqual([`http://${LAN_HOST}/`, `http://${LAN_HOST}/start`]);
  });
});
