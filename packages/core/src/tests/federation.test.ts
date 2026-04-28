import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { Readable } from "node:stream";

const SHARED_SECRET = "x".repeat(32);
const PEER_SHARED_SECRET = "p".repeat(32);

function writeFederationConfig(extra: Record<string, unknown> = {}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-federation-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    federation: {
      enabled: true,
      instanceId: "primary",
      sharedSecret: SHARED_SECRET,
      peers: [
        { id: "ops", url: "https://peer.example.com:8765" },
      ],
      ...extra,
    },
    subAgents: {
      researcher: {
        description: "test agent",
        capabilities: ["research"],
        tags: ["test"],
        tools: ["read_file"],
      },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  return tempDir;
}

async function buildAppWithFederationRoutes(): Promise<Hono> {
  const { mountFederationRoutes } = await import("../gateway/federation-router.js");
  const app = new Hono();
  mountFederationRoutes(app);
  return app;
}

async function mintTokenForLocal(audience: string, purpose: string, secret: string): Promise<string> {
  return new SignJWT({ purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("ops")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

describe("federation token round-trip", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("mints + verifies tokens scoped to the local instanceId", async () => {
    tempDir = writeFederationConfig();
    vi.resetModules();
    const fed = await import("../federation/index.js");
    fed._resetFederationCacheForTests();

    const token = await fed.mintFederationToken("ops", "delegate");
    // The minted token's audience is the peer ("ops"), but `verifyFederationToken`
    // checks audience against THIS instance ("primary").  A token addressed to
    // ops should fail when verified locally — that's the correct, scoped behavior.
    const verified = await fed.verifyFederationToken(token);
    expect(verified).toBeNull();

    const inboundToken = await mintTokenForLocal("primary", "delegate", SHARED_SECRET);
    const verifiedInbound = await fed.verifyFederationToken(inboundToken);
    expect(verifiedInbound?.issuer).toBe("ops");
    expect(verifiedInbound?.audience).toBe("primary");
    expect(verifiedInbound?.purpose).toBe("delegate");
  });

  it("rejects tokens signed with a different secret", async () => {
    tempDir = writeFederationConfig();
    vi.resetModules();
    const fed = await import("../federation/index.js");
    fed._resetFederationCacheForTests();

    const wrongToken = await mintTokenForLocal("primary", "delegate", PEER_SHARED_SECRET);
    expect(await fed.verifyFederationToken(wrongToken)).toBeNull();
  });

  it("returns null when federation is disabled", async () => {
    const tempDirLocal = mkdtempSync(join(tmpdir(), "starlingai-federation-disabled-"));
    const configPath = join(tempDirLocal, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ federation: { enabled: false } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const fed = await import("../federation/index.js");
    fed._resetFederationCacheForTests();

    const token = await mintTokenForLocal("primary", "delegate", SHARED_SECRET);
    expect(await fed.verifyFederationToken(token)).toBeNull();

    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDirLocal, { recursive: true, force: true });
  });
});

describe("federation HTTP routes", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = writeFederationConfig();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("returns 401 when health is called without a bearer token", async () => {
    const app = await buildAppWithFederationRoutes();
    const res = await app.request("/api/federation/health");
    expect(res.status).toBe(401);
  });

  it("returns 401 when capabilities is called with the wrong secret", async () => {
    const app = await buildAppWithFederationRoutes();
    const wrongToken = await mintTokenForLocal("primary", "capabilities", PEER_SHARED_SECRET);
    const res = await app.request("/api/federation/capabilities", {
      headers: { authorization: `Bearer ${wrongToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns instance metadata + uptime on health when authenticated", async () => {
    const app = await buildAppWithFederationRoutes();
    const token = await mintTokenForLocal("primary", "health", SHARED_SECRET);
    const res = await app.request("/api/federation/health", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; instanceId: string; uptimeMs: number };
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe("primary");
    expect(typeof body.uptimeMs).toBe("number");
  });

  it("advertises agents + tier 1/2 tools (but not tier 3+) on capabilities", async () => {
    // Touching the registry at module load time registers the federation tools,
    // and tier maps in tool-tiers.ts make sure tier 3+ tools are filtered.  We
    // assert agents are advertised and that no obvious tier-3 names leak.
    await import("../tools/sub-agent.js");
    const app = await buildAppWithFederationRoutes();
    const token = await mintTokenForLocal("primary", "capabilities", SHARED_SECRET);
    const res = await app.request("/api/federation/capabilities", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      instanceId: string;
      agents: { name: string }[];
      toolNames: string[];
      protocolVersion: string;
    };
    expect(body.instanceId).toBe("primary");
    expect(body.agents.find((a) => a.name === "researcher")).toBeDefined();
    expect(typeof body.protocolVersion).toBe("string");
    // Sanity-check: even though the registry contains many tools, none of the
    // privileged Tier-3 names should be advertised across the federation
    // boundary.  We don't enumerate them here — just check a couple sentinels.
    expect(body.toolNames).not.toContain("host_shell");
    expect(body.toolNames).not.toContain("docker_socket");
  });

  it("rejects delegate calls when the agentName is missing", async () => {
    const app = await buildAppWithFederationRoutes();
    const token = await mintTokenForLocal("primary", "delegate", SHARED_SECRET);
    const res = await app.request("/api/federation/delegate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "do something" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/agentName/i);
  });

  it("rejects delegate calls for agents not in exposeAgents allowlist", async () => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    tempDir = writeFederationConfig({ exposeAgents: ["other-only"] });
    vi.resetModules();
    const app = await buildAppWithFederationRoutes();
    const token = await mintTokenForLocal("primary", "delegate", SHARED_SECRET);
    const res = await app.request("/api/federation/delegate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentName: "researcher", task: "do something" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("federation streaming client", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = writeFederationConfig();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.restoreAllMocks();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("forwards progress events and resolves with the completed envelope", async () => {
    const sseFrames = [
      `data: ${JSON.stringify({ type: "progress", agentName: "researcher", kind: "tool_start", iteration: 1, toolName: "web_search" })}\n\n`,
      `data: ${JSON.stringify({ type: "progress", agentName: "researcher", kind: "tool_done", iteration: 1, toolName: "web_search" })}\n\n`,
      `data: ${JSON.stringify({ type: "completed", output: "final answer", remoteSessionId: "fed:ops:abc:123", stats: { iterations: 1 } })}\n\n`,
    ];
    const stream = Readable.toWeb(Readable.from(sseFrames.map((f) => Buffer.from(f, "utf8"))));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream as ReadableStream, { status: 200, headers: { "content-type": "text/event-stream" } })));

    const fed = await import("../federation/index.js");
    const progressEvents: { kind: string; toolName?: string }[] = [];
    const result = await fed.delegateToRemotePeerStreaming(
      "ops",
      { agentName: "researcher", task: "find references" },
      (event) => progressEvents.push({ kind: event.kind, toolName: event.toolName }),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("final answer");
    expect(result.remoteSessionId).toBe("fed:ops:abc:123");
    expect(progressEvents).toEqual([
      { kind: "tool_start", toolName: "web_search" },
      { kind: "tool_done", toolName: "web_search" },
    ]);
  });

  it("resolves with ok=false when the stream ends without a completion frame", async () => {
    const sseFrames = [
      `data: ${JSON.stringify({ type: "progress", agentName: "researcher", kind: "started", iteration: 0 })}\n\n`,
    ];
    const stream = Readable.toWeb(Readable.from(sseFrames.map((f) => Buffer.from(f, "utf8"))));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream as ReadableStream, { status: 200, headers: { "content-type": "text/event-stream" } })));

    const fed = await import("../federation/index.js");
    const result = await fed.delegateToRemotePeerStreaming(
      "ops",
      { agentName: "researcher", task: "find references" },
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without completion/i);
  });

  it("propagates HTTP errors as ok=false without consuming the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));

    const fed = await import("../federation/index.js");
    const result = await fed.delegateToRemotePeerStreaming(
      "ops",
      { agentName: "researcher", task: "find references" },
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 503/);
  });
});

describe("federated workspace search broadcast", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = writeFederationConfig({
      peers: [
        { id: "alpha", url: "https://alpha.example.com:8765" },
        { id: "beta", url: "https://beta.example.com:8765" },
      ],
    });
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.restoreAllMocks();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("merges matches from every reachable peer and tags them by source", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("alpha.example.com")) {
        return new Response(JSON.stringify({
          ok: true,
          instanceId: "alpha-prod",
          matches: [{ file: "alpha/readme.md", snippets: ["alpha snippet"] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("beta.example.com")) {
        return new Response(JSON.stringify({
          ok: true,
          instanceId: "beta-prod",
          matches: [{ file: "beta/readme.md", snippets: ["beta snippet"] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${u}`);
    }));

    const fed = await import("../federation/index.js");
    const result = await fed.broadcastWorkspaceSearch("readme", { maxResults: 5 });

    expect(result.peers).toHaveLength(2);
    expect(result.peers.every((p) => p.ok)).toBe(true);
    expect(result.matches).toHaveLength(2);
    const sources = result.matches.map((m) => m.source).sort();
    expect(sources).toEqual(["alpha", "beta"]);
    const alphaMatch = result.matches.find((m) => m.source === "alpha");
    expect(alphaMatch?.instanceId).toBe("alpha-prod");
    expect(alphaMatch?.file).toBe("alpha/readme.md");
  });

  it("surfaces unreachable peers as ok=false without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("alpha.example.com")) {
        return new Response(JSON.stringify({ ok: true, instanceId: "alpha-prod", matches: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("ECONNREFUSED");
    }));

    const fed = await import("../federation/index.js");
    const result = await fed.broadcastWorkspaceSearch("readme");

    const alpha = result.peers.find((p) => p.peerId === "alpha");
    const beta = result.peers.find((p) => p.peerId === "beta");
    expect(alpha?.ok).toBe(true);
    expect(beta?.ok).toBe(false);
    expect(beta?.error).toMatch(/ECONNREFUSED/);
  });

  it("honors the peerIds filter to broadcast to a subset", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, instanceId: "x", matches: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const fed = await import("../federation/index.js");
    const result = await fed.broadcastWorkspaceSearch("readme", { peerIds: ["alpha"] });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]?.peerId).toBe("alpha");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("federation transitive peer discovery", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-federation-discovery-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      federation: {
        enabled: true,
        instanceId: "primary",
        sharedSecret: SHARED_SECRET,
        peers: [
          { id: "alpha", url: "https://alpha.example.com:8765" },
        ],
        discovery: { enabled: true, intervalMs: 60_000 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.restoreAllMocks();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const fed = await import("../federation/index.js");
    fed._resetDiscoveredPeersForTests();
    fed.stopPeerDiscovery();
  });

  it("adds new peers reachable through configured peers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("alpha.example.com") && u.includes("/peers-known")) {
        return new Response(JSON.stringify({
          instanceId: "alpha-prod",
          peers: [
            { id: "beta", url: "https://beta.example.com:8765", tags: [], source: "configured" },
            { id: "gamma", url: "https://gamma.example.com:8765", tags: [], source: "discovered" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/api/federation/health")) {
        if (u.includes("beta.example.com")) {
          return new Response(JSON.stringify({ ok: true, instanceId: "beta-prod", uptimeMs: 1234 }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (u.includes("gamma.example.com")) {
          return new Response(JSON.stringify({ ok: true, instanceId: "gamma-prod", uptimeMs: 1234 }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      throw new Error(`unexpected fetch ${u}`);
    }));

    const fed = await import("../federation/index.js");
    const result = await fed.discoverPeersTransitively();

    expect(result.probed).toBe(2);
    expect(result.added).toBe(2);

    const known = fed.listAllKnownPeers();
    const beta = known.find((p) => p.id === "beta");
    const gamma = known.find((p) => p.id === "gamma");
    expect(beta).toBeDefined();
    expect(beta?.source).toBe("discovered");
    expect(gamma?.source).toBe("discovered");

    // Configured alpha is also returned
    expect(known.find((p) => p.id === "alpha")?.source).toBe("configured");
  });

  it("does not re-add peers that are already configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/peers-known")) {
        return new Response(JSON.stringify({
          instanceId: "alpha-prod",
          peers: [
            { id: "alpha", url: "https://alpha.example.com:8765", tags: [], source: "configured" }, // self-reference
            { id: "primary", url: "https://primary.example.com:8765", tags: [], source: "configured" }, // ourselves
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${u}`);
    }));

    const fed = await import("../federation/index.js");
    const result = await fed.discoverPeersTransitively();

    expect(result.added).toBe(0);
  });

  it("drops a discovered peer that becomes unreachable on the next refresh", async () => {
    let healthAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/peers-known")) {
        return new Response(JSON.stringify({
          peers: [
            { id: "beta", url: "https://beta.example.com:8765", tags: [], source: "configured" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("beta.example.com") && u.includes("/api/federation/health")) {
        healthAttempts += 1;
        // First probe succeeds, subsequent probes fail.
        if (healthAttempts === 1) {
          return new Response(JSON.stringify({ ok: true, instanceId: "beta-prod", uptimeMs: 1 }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("down", { status: 503 });
      }
      throw new Error(`unexpected fetch ${u}`);
    }));

    const fed = await import("../federation/index.js");
    const first = await fed.discoverPeersTransitively();
    expect(first.added).toBe(1);
    expect(fed.listAllKnownPeers().find((p) => p.id === "beta")).toBeDefined();

    const second = await fed.discoverPeersTransitively();
    // beta was already discovered, so on the second pass it doesn't add but the
    // health re-probe fails and it gets evicted.
    expect(second.added).toBe(0);
    expect(fed.listAllKnownPeers().find((p) => p.id === "beta")).toBeUndefined();
  });

  it("returns 0/0 when discovery is disabled", async () => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-federation-discovery-off-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      federation: {
        enabled: true,
        instanceId: "primary",
        sharedSecret: SHARED_SECRET,
        peers: [{ id: "alpha", url: "https://alpha.example.com:8765" }],
        discovery: { enabled: false },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const fed = await import("../federation/index.js");
    const result = await fed.discoverPeersTransitively();

    expect(result).toEqual({ probed: 0, added: 0, refreshed: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("federation tool guards", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("delegate_to_remote_agent refuses to execute when federation is disabled", async () => {
    const tempDirLocal = mkdtempSync(join(tmpdir(), "starlingai-federation-tool-disabled-"));
    const configPath = join(tempDirLocal, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ federation: { enabled: false } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    await import("../tools/federation.js");
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("delegate_to_remote_agent");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { peerId: "ops", agentName: "researcher", task: "x" },
      { sessionId: "s", workspacePath: "/tmp" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled/i);

    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDirLocal, { recursive: true, force: true });
  });

  it("list_federation_peers reports an empty registry when no peers are configured", async () => {
    const tempDirLocal = mkdtempSync(join(tmpdir(), "starlingai-federation-no-peers-"));
    const configPath = join(tempDirLocal, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      federation: { enabled: true, instanceId: "primary", sharedSecret: SHARED_SECRET, peers: [] },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    await import("../tools/federation.js");
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("list_federation_peers");
    expect(tool).toBeDefined();

    const result = await tool!.execute({}, { sessionId: "s", workspacePath: "/tmp" });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/no federation peers/i);

    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDirLocal, { recursive: true, force: true });
  });
});
