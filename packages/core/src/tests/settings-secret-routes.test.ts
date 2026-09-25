import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../product/index.js";
import type { Config } from "../config/schema.js";

/**
 * The moved-key rule (config-secrets.ts) on the REAL routes that restore masked keys beside an
 * endpoint: the sub-agent model patch, the channel settings, and the settings PUTs and the upload
 * that live in createGateway. Unit tests of the rule passed whether or not a route called it — the
 * channel test re-implemented the route's call — and whatever the production context answered.
 */

const MASK = "••••••••";
const EVIL = "https://collector.example/v1";
const tempDirs: string[] = [];

async function boot(config: Record<string, unknown>) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-secret-routes-"));
  tempDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "s".repeat(40) }, workspacePath: tempDir, ...config }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  vi.resetModules();
  const [{ registerSubAgentRoutes }, { registerChannelRoutes }, auth, loader, channels] = await Promise.all([
    import("../gateway/sub-agent-routes.js"),
    import("../gateway/channels-routes.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../credentials/channels.js"),
  ]);
  const app = new Hono();
  registerSubAgentRoutes(app);
  registerChannelRoutes(app);
  const authorization = `Bearer ${await auth.createToken("admin", { role: "admin" })}`;
  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: { Authorization: authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { send, loader, channels };
}

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  const auth = await import("../gateway/auth.js");
  auth.resetAuthStateForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("the sub-agent model routes", () => {
  const config = {
    agents: { defaults: { model: { primary: "lmstudio/orch", baseUrl: "http://orch.local/v1", apiKey: "default-key" } } },
    subAgents: {
      coder: { description: "Writes code.", model: { primary: "lmstudio/coder" } },
      own: { description: "Has its own endpoint.", model: { primary: "lmstudio/own", baseUrl: "http://own.local/v1", apiKey: "own-key" } },
    },
  };

  it("lists a sub-agent's key masked: every signed-in account can read the list", async () => {
    const { send } = await boot(config);
    const listed = await (await send("GET", "/api/agents")).json() as Array<{ name: string; model: Record<string, unknown> }>;
    expect(listed.find((agent) => agent.name === "own")?.model).toMatchObject({ baseUrl: "http://own.local/v1", apiKey: MASK });
    expect(JSON.stringify(listed)).not.toContain("own-key");
  });

  it("keeps the saved key for an echoed mask, and refuses it at a moved endpoint", async () => {
    const { send, loader } = await boot(config);
    const kept = await send("PATCH", "/api/agents/own/model", { apiKey: MASK, temperature: 0.2 });
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as { model: Record<string, unknown> }).model.apiKey).toBe(MASK);
    expect(loader.getConfig().subAgents["own"]?.model?.apiKey).toBe("own-key");

    const moved = await send("PATCH", "/api/agents/own/model", { baseUrl: EVIL, apiKey: MASK });
    expect(moved.status).toBe(400);
    expect(((await moved.json()) as { details: { field: string } }).details.field).toBe("subAgents.own.model.apiKey");
    expect(loader.getConfig().subAgents["own"]?.model?.baseUrl).toBe("http://own.local/v1");
  });

  it("refuses to hand the default key, or a reference, to a new endpoint", async () => {
    const { send, loader } = await boot(config);
    // coder has no key of its own: at an endpoint of its own it is sent the DEFAULT key.
    const inherited = await send("PATCH", "/api/agents/coder/model", { baseUrl: EVIL });
    expect(inherited.status).toBe(400);
    expect(((await inherited.json()) as { details: { field: string } }).details.field).toBe("agents.defaults.model.apiKey");
    expect((await send("PATCH", "/api/agents/coder/model", { baseUrl: EVIL, apiKey: "$SAI_JWT_SECRET" })).status).toBe(400);
    expect(loader.getConfig().subAgents["coder"]?.model?.baseUrl).toBeUndefined();

    // A key typed in goes with it, and "" sends none.
    expect((await send("PATCH", "/api/agents/coder/model", { baseUrl: EVIL, apiKey: "typed-key" })).status).toBe(200);
    expect(loader.getConfig().subAgents["coder"]?.model).toMatchObject({ baseUrl: EVIL, apiKey: "typed-key" });
    expect((await send("PATCH", "/api/agents/own/model", { baseUrl: EVIL, apiKey: "" })).status).toBe(200);
    expect(loader.getConfig().subAgents["own"]?.model).toMatchObject({ baseUrl: EVIL, apiKey: "" });
  });

  // Patched into the loaded config only, the change went back at the next reload from disk — any
  // other save, a config file change, a restart — and the other saves' rule, judged on the loaded
  // config, read its going back as a key moving and refused them (r3 A-security #1).
  it("saves the change, so it outlives a reload from disk", async () => {
    const { send, loader } = await boot(config);
    expect((await send("PATCH", "/api/agents/own/model", { baseUrl: "http://own-b.local/v1", apiKey: "typed-key", temperature: 0.2, enableThinking: true })).status).toBe(200);
    // The page's "auto" sends null: saved, a pin it could not clear would outlive every restart.
    expect((await send("PATCH", "/api/agents/own/model", { temperature: null, enableThinking: null })).status).toBe(200);
    loader.resetConfigForTests();
    expect(loader.getConfig().subAgents["own"]?.model).toMatchObject({ primary: "lmstudio/own", baseUrl: "http://own-b.local/v1", apiKey: "typed-key" });
    expect(loader.getConfig().subAgents["own"]?.model?.temperature).toBeUndefined();
    expect(loader.getConfig().subAgents["own"]?.model?.enableThinking).toBeUndefined();
  });

  // Kept as "", an emptied model field overrode the default's model with no model at all, and saved,
  // for good (r4 A-security #1).
  it("clears an emptied model, so the agent runs on the default's again", async () => {
    const { send, loader } = await boot(config);
    expect((await send("PATCH", "/api/agents/coder/model", { primary: "" })).status).toBe(200);
    loader.resetConfigForTests();
    expect(loader.getConfig().subAgents["coder"]?.model?.primary).toBeUndefined();
  });

  // The A2A client lays each peer skill over the loaded config as a sub-agent. The patch is saved,
  // so it reloads the config, and the reload dropped them from delegation until the next card
  // refresh (r4 A-security #3).
  it("keeps an A2A peer's skill through an unrelated patch", async () => {
    const { send, loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 0, peers: [{ id: "peer", url: "https://peer.example" }] } });
    const card = { name: "peer", skills: [{ id: "skill", name: "Skill", description: "A peer's skill." }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } })));
    const a2a = await import("../a2a/client.js");
    try {
      await a2a.startA2AClient();
      expect(loader.getConfig().subAgents["a2a__peer__skill"]?.description).toBe("[A2A:peer] A peer's skill.");
      expect((await send("PATCH", "/api/agents/coder/model", { temperature: 0.2 })).status).toBe(200);
      expect(loader.getConfig().subAgents["coder"]?.model?.temperature).toBe(0.2);
      expect(loader.getConfig().subAgents["a2a__peer__skill"]?.description).toBe("[A2A:peer] A peer's skill.");
    } finally {
      a2a.stopA2AClient();
      vi.unstubAllGlobals();
    }
  });

  // Each reload lays the runtime agents back over, so a skill the client unregisters has to leave
  // the loader's too: left there, the orchestrator went on delegating to a skill the peer had
  // dropped until the next restart (r5 A-security).
  it("drops a skill the peer's card no longer lists, and a patch does not bring it back", async () => {
    const { send, loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 0, peers: [{ id: "peer", url: "https://peer.example" }] } });
    const card = { name: "peer", skills: [{ id: "skill", name: "Skill", description: "A peer's skill." }, { id: "kept", name: "Kept", description: "A skill it keeps." }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } })));
    const a2a = await import("../a2a/client.js");
    try {
      await a2a.startA2AClient();
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeDefined();
      card.skills = card.skills.filter((skill) => skill.id !== "skill");
      await a2a.startA2AClient(); // polls every peer again, as the refresh timer does
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined();
      expect((await send("PATCH", "/api/agents/coder/model", { temperature: 0.2 })).status).toBe(200);
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined();
      expect(loader.getConfig().subAgents["a2a__peer__kept"]?.description).toBe("[A2A:peer] A skill it keeps.");
    } finally {
      a2a.stopA2AClient();
      vi.unstubAllGlobals();
    }
  });

  // Turned off by a config change the client is not told of (a settings save, a file edit), the
  // refresh timer went on polling the peers back in (r5 A-security).
  it("drops the peers' skills at the next refresh once A2A is turned off", async () => {
    const { loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 20, peers: [{ id: "peer", url: "https://peer.example" }] } });
    const card = { name: "peer", skills: [{ id: "skill", name: "Skill", description: "A peer's skill." }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } })));
    const a2a = await import("../a2a/client.js");
    try {
      await a2a.startA2AClient();
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeDefined();
      loader.updateConfig((raw) => { (raw["a2a"] as Record<string, unknown>)["enabled"] = false; });
      await vi.waitFor(() => expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined());
    } finally {
      a2a.stopA2AClient();
      vi.unstubAllGlobals();
    }
  });

  // The peers routes save, then restart the client. With A2A turned off the restart returned before
  // it unregistered anything, so even deleting the peer left its skill in delegation for good
  // (r5 A-security).
  it("drops a deleted peer's skills while A2A is turned off", async () => {
    const { loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 0, peers: [{ id: "peer", url: "https://peer.example" }] } });
    const card = { name: "peer", skills: [{ id: "skill", name: "Skill", description: "A peer's skill." }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } })));
    const a2a = await import("../a2a/client.js");
    try {
      await a2a.startA2AClient();
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeDefined();
      loader.updateConfig((raw) => { (raw["a2a"] as Record<string, unknown>)["enabled"] = false; });
      // DELETE /api/a2a/peers/peer: the save, then the restart.
      loader.updateConfig((raw) => { (raw["a2a"] as Record<string, unknown>)["peers"] = []; });
      await a2a.startA2AClient();
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined();
    } finally {
      a2a.stopA2AClient();
      vi.unstubAllGlobals();
    }
  });

  // A save or a file edit that takes the peer out of config does not go through the peers route, so
  // only the config watcher can restart the client; with refreshIntervalMs 0 the skill stayed
  // delegatable until restart (review of round 6, A-security).
  it("drops a peer taken out of config by a reload that changed the a2a section, and only then", async () => {
    const { loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 0, peers: [{ id: "peer", url: "https://peer.example" }] } });
    const card = { name: "peer", skills: [{ id: "skill", name: "Skill", description: "A peer's skill." }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } })));
    const a2a = await import("../a2a/client.js");
    try {
      await a2a.startA2AClient();
      loader.updateConfig((raw) => { (raw["a2a"] as Record<string, unknown>)["peers"] = []; });
      // A reload of another section leaves the client alone.
      expect(await a2a.syncA2AClientWithConfig(["channels"])).toBe(false);
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeDefined();
      expect(await a2a.syncA2AClientWithConfig(["a2a"])).toBe(true);
      expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined();
    } finally {
      a2a.stopA2AClient();
      vi.unstubAllGlobals();
    }
  });

  // A card fetch can outlast a restart. Finishing afterwards, it registered again the skill of the
  // peer the restart had removed, and its start set a refresh timer over the newer start's, which
  // then went on polling after the client stopped (r6 A-security, remaining 2).
  describe("a card that arrives after a restart or a stop", () => {
    const card = { name: "peer", skills: [{ id: "skill", name: "Skill", description: "A peer's skill." }] };
    const peers = [{ id: "peer", url: "https://peer.example" }];
    function holdFirstCard() {
      let deliver = (): void => {};
      const held = new Promise<void>((resolve) => { deliver = resolve; });
      const fetchCard = vi.fn(async () => {
        if (fetchCard.mock.calls.length === 1) await held;
        return new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } });
      });
      vi.stubGlobal("fetch", fetchCard);
      return { fetchCard, deliver: () => deliver() };
    }

    it("registers nothing for a peer the restart removed", async () => {
      const { loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 0, peers } });
      const { fetchCard, deliver } = holdFirstCard();
      const a2a = await import("../a2a/client.js");
      try {
        const first = a2a.startA2AClient();
        await vi.waitFor(() => expect(fetchCard).toHaveBeenCalledTimes(1));
        loader.updateConfig((raw) => { (raw["a2a"] as Record<string, unknown>)["peers"] = []; });
        await a2a.startA2AClient();
        deliver();
        await first;
        expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined();
        expect(a2a.listA2APeers()).toEqual([]);
      } finally {
        a2a.stopA2AClient();
        vi.unstubAllGlobals();
      }
    });

    it("leaves no refresh timer from the start it overtook", async () => {
      await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 20, peers } });
      const { fetchCard, deliver } = holdFirstCard();
      const a2a = await import("../a2a/client.js");
      try {
        const first = a2a.startA2AClient();
        await vi.waitFor(() => expect(fetchCard).toHaveBeenCalledTimes(1));
        await a2a.startA2AClient();
        deliver();
        await first;
        a2a.stopA2AClient();
        await new Promise((resolve) => setImmediate(resolve)); // a tick's fetch already under way
        const polled = fetchCard.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(fetchCard).toHaveBeenCalledTimes(polled);
      } finally {
        a2a.stopA2AClient();
        vi.unstubAllGlobals();
      }
    });

    // A shutdown moves the run on as a restart does. Were only a start to move it, the card of a start
    // the shutdown cut short would register the peer after the client stopped, and that start would
    // set its refresh timer (review of r6 leftovers, 1).
    it("registers nothing, and polls no more, when the client stopped rather than restarted", async () => {
      const { loader } = await boot({ ...config, a2a: { enabled: true, refreshIntervalMs: 20, peers } });
      const { fetchCard, deliver } = holdFirstCard();
      const a2a = await import("../a2a/client.js");
      try {
        const first = a2a.startA2AClient();
        await vi.waitFor(() => expect(fetchCard).toHaveBeenCalledTimes(1));
        a2a.stopA2AClient();
        deliver();
        await first;
        expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeUndefined();
        expect(a2a.listA2APeers()).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(fetchCard).toHaveBeenCalledTimes(1);
      } finally {
        a2a.stopA2AClient();
        vi.unstubAllGlobals();
      }
    });
  });

  it("refuses a value the schema refuses, and saves nothing", async () => {
    const { send, loader } = await boot(config);
    // Under maxTokens' floor: patched in memory it was taken as it came.
    expect((await send("PATCH", "/api/agents/own/model", { maxTokens: 100 })).status).toBe(400);
    loader.resetConfigForTests();
    expect(loader.getConfig().subAgents["own"]?.model?.maxTokens).toBeUndefined();
  });

  it("refuses an agent that is loaded but not saved: an A2A peer's, which runs on the peer's model", async () => {
    const { send, loader } = await boot(config);
    (loader.getConfig().subAgents as Record<string, unknown>)["a2a__peer__skill"] = { description: "A peer's skill.", tools: [] };
    expect((await send("PATCH", "/api/agents/a2a__peer__skill/model", { temperature: 0.2 })).status).toBe(409);
    expect((await send("PATCH", "/api/agents/nobody/model", { temperature: 0.2 })).status).toBe(404);
  });
});

describe("the channel settings route", () => {
  const email = {
    enabled: false,
    imapHost: "imap.example.com",
    imapUser: "me",
    imapPassword: "imap-pass",
    smtpHost: "smtp.example.com",
    smtpPassword: "smtp-pass",
  };

  it("refuses to move a mail server with the saved password masked", async () => {
    const { send, channels } = await boot({ channels: { email } });
    const refused = await send("PUT", "/api/channels/email", { ...email, imapHost: "imap.collector.example", imapPassword: MASK, smtpPassword: MASK });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { details: { field: string } }).details.field).toBe("imapPassword");
    expect(channels.getStoredChannelConfig("email")).toBeNull();
  });

  it("saves the move with the password typed in", async () => {
    const { send, channels } = await boot({ channels: { email } });
    const saved = await send("PUT", "/api/channels/email", { ...email, imapHost: "imap.new.example", imapPassword: "typed", smtpPassword: MASK });
    expect(saved.status).toBe(200);
    expect(channels.getStoredChannelConfig("email")).toMatchObject({ imapHost: "imap.new.example", imapPassword: "typed", smtpPassword: "smtp-pass" });
  });
});

/**
 * Each answer the production context gives, and the routes that live in createGateway, with a
 * primary provider key configured. Round 2's fallback refusal passed its unit table while the real
 * context could have answered "no key" everywhere, and two paths sent the primary key through a
 * resolver the rule did not ask: the embeddings (resolveEmbeddingEndpoint) and the image-upload
 * vision fallback (which read providers.lmstudio itself).
 */
describe("the moved-key rule with a primary provider key", () => {
  // Anything that would put a key or a model in place from outside the test's own config.
  const OUTSIDE = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "SAI_PRIMARY_MODEL_KEY", "SAI_LMSTUDIO_API_KEY",
    "SAI_PRIMARY_MODEL", "SAI_DEFAULT_MODEL", "SAI_FALLBACK_MODEL", "SAI_EMBEDDING_MODEL", "SAI_ROUTING_MODEL",
    "SAI_PRIMARY_MODEL_URL", "SAI_LMSTUDIO_URL", "SAI_JWT_SECRET", "SAI_MULTIMODAL_FILES_URL",
  ];
  const saved = new Map<string, string | undefined>();
  const PROVIDERS = { lmstudio: { baseUrl: "http://primary.invalid/v1", apiKey: "lm-key" } };
  // The model-endpoints PUT replaces all four sections, so the test config sets all four.
  const ENDPOINT_SECTIONS = {
    retrieval: { reranker: { enabled: false, model: "rerank", baseUrl: "http://rerank.invalid/v1", apiKey: "rerank-key" } },
    guardrails: { modelModeration: { enabled: false, model: "guard", baseUrl: "http://guard.invalid/v1", apiKey: "guard-key" } },
  };

  beforeEach(() => {
    for (const key of OUTSIDE) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    (await import("../providers/index.js")).resetProvidersForTests();
  });

  function isolateStores(tempDir: string) {
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  }

  /** The whole gateway on a config DIRECTORY, so a save goes to the overlay as in a deployment. */
  async function bootGateway(config: Record<string, unknown>) {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-secret-gateway-"));
    tempDirs.push(tempDir);
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    const port = 31_000 + Math.floor(Math.random() * 2_000);
    writeFileSync(join(configDir, "10-test.json"), JSON.stringify({
      gateway: { port, jwtSecret: "s".repeat(40) },
      workspacePath: tempDir,
      ...config,
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configDir;
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    isolateStores(tempDir);
    vi.resetModules();
    const [{ createGateway }, auth, loader] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
      import("../config/loader.js"),
    ]);
    const gateway = createGateway();
    await gateway.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const healthy = await fetch(`${baseUrl}/healthz`).then((response) => response.ok, () => false);
      if (healthy) break;
      if (Date.now() > deadline) throw new Error("gateway did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const authorization = `Bearer ${await auth.createToken("admin", { role: "admin" })}`;
    const send = (method: string, path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { send, loader, authorization, baseUrl, stop: () => gateway.stop() };
  }

  const refusedField = async (response: Response) => ((await response.json()) as { details?: { field?: string } }).details?.field;

  it("names the stand-in key each runtime resolver sends", async () => {
    isolateStores(mkdtempSync(join(tmpdir(), "starlingai-secret-context-")));
    vi.resetModules();
    const [{ secretEndpointContext }, { ConfigSchema }] = await Promise.all([
      import("../gateway/secret-endpoint-context.js"),
      import("../config/schema.js"),
    ]);
    const ctx = secretEndpointContext(ConfigSchema.parse({ gateway: { jwtSecret: "s".repeat(40) }, providers: PROVIDERS }));
    expect(ctx.providerCredential("lmstudio/x")).toBe("lm-key");
    expect(ctx.providerEndpoint("lmstudio/x")).toBe("http://primary.invalid/v1");
    // No Anthropic credentials: a chat call sends none, while the embeddings send the primary key.
    expect(ctx.providerCredential("anthropic/x")).toBe("");
    expect(ctx.embeddingCredential("anthropic/x")).toBe("lm-key");
    expect(ctx.embeddingEndpoint("anthropic/x")).toBe("http://primary.invalid/v1");
  });

  it("refuses a move when a stand-in key cannot be resolved", async () => {
    const [{ secretEndpointContext }, secrets] = await Promise.all([
      import("../gateway/secret-endpoint-context.js"),
      import("../gateway/config-secrets.js"),
    ]);
    // A config the resolvers cannot read (no providers section): unknown must not read as "none".
    const ctx = secretEndpointContext({ agents: { defaults: { model: { primary: "lmstudio/x" } } } } as unknown as Config);
    const before = { files: { visionModel: "lmstudio/vl", visionBaseUrl: "http://vision.invalid/v1" } };
    const moved = { files: { visionModel: "lmstudio/vl", visionBaseUrl: EVIL } };
    expect(secrets.refuseMovedSecrets(secrets.multimodalSecretDestinations(ctx), {}, before, moved))
      .toMatchObject({ ok: false, field: "files.visionApiKey" });
    const embeddingsBefore = { orchestrator: { primary: "lmstudio/x" }, embeddings: { embeddingBaseUrl: "http://embed.invalid/v1" } };
    const embeddingsMoved = { orchestrator: { primary: "lmstudio/x" }, embeddings: { embeddingBaseUrl: EVIL } };
    expect(secrets.refuseMovedSecrets(secrets.modelEndpointSecretDestinations(ctx), {}, embeddingsBefore, embeddingsMoved))
      .toMatchObject({ ok: false, field: "embeddings.embeddingApiKey" });
  });

  it("refuses a moved vision endpoint that would carry the primary key", async () => {
    const gw = await bootGateway({
      providers: PROVIDERS,
      multimodal: { files: { baseUrl: "http://files.invalid", visionModel: "lmstudio/qwen-vl", visionBaseUrl: "http://vision.invalid/v1" } },
    });
    try {
      const refused = await gw.send("PUT", "/api/multimodal/config", { files: { visionBaseUrl: EVIL } });
      expect(refused.status).toBe(400);
      expect(await refusedField(refused)).toBe("files.visionApiKey");
      expect(gw.loader.getConfig().multimodal.files.visionBaseUrl).toBe("http://vision.invalid/v1");
      // "" says no key, so nothing goes in the provider key's place.
      expect((await gw.send("PUT", "/api/multimodal/config", { files: { visionBaseUrl: EVIL, visionApiKey: "" } })).status).toBe(200);
    } finally {
      await gw.stop();
    }
  }, 45_000);

  it("refuses a moved orchestrator endpoint, or embeddings on another provider, that would carry the primary key", async () => {
    const gw = await bootGateway({
      providers: PROVIDERS,
      agents: { defaults: { model: { primary: "lmstudio/orch", baseUrl: "http://orch.invalid/v1", embeddingModel: "lmstudio/embed" } } },
      ...ENDPOINT_SECTIONS,
    });
    try {
      const shown = await (await gw.send("GET", "/api/model-endpoints/config")).json() as Record<string, Record<string, unknown>>;
      const orchestratorMoved = await gw.send("PUT", "/api/model-endpoints/config", { ...shown, orchestrator: { ...shown["orchestrator"], baseUrl: EVIL } });
      expect(orchestratorMoved.status).toBe(400);
      expect(await refusedField(orchestratorMoved)).toBe("orchestrator.apiKey");
      // The embeddings resolver never reads Anthropic's credentials: for an anthropic/* model it
      // sends the primary key. Refused on the embeddings key, whose "" stops it.
      const embeddingsMoved = await gw.send("PUT", "/api/model-endpoints/config", {
        ...shown,
        embeddings: { embeddingModel: "anthropic/x", embeddingBaseUrl: EVIL },
      });
      expect(embeddingsMoved.status).toBe(400);
      expect(await refusedField(embeddingsMoved)).toBe("embeddings.embeddingApiKey");
      expect(gw.loader.getConfig().agents.defaults.model).toMatchObject({ baseUrl: "http://orch.invalid/v1", embeddingModel: "lmstudio/embed" });
      expect(gw.loader.getConfig().agents.defaults.model.embeddingBaseUrl).toBeUndefined();
    } finally {
      await gw.stop();
    }
  }, 45_000);

  it("judges the model-endpoints save on the config it leaves in effect, not on its body", async () => {
    const gw = await bootGateway({
      providers: PROVIDERS,
      // A key set in a config shard: a body that leaves it out is written as unset, which the
      // overlay cannot store, so this key stays — at the body's endpoint.
      agents: { defaults: { model: {
        primary: "lmstudio/orch", baseUrl: "http://orch.invalid/v1", apiKey: "shard-key",
        embeddingModel: "lmstudio/embed", embeddingBaseUrl: "http://embed.invalid/v1", embeddingApiKey: "embed-key",
      } } },
      ...ENDPOINT_SECTIONS,
    });
    try {
      const shown = await (await gw.send("GET", "/api/model-endpoints/config")).json() as Record<string, Record<string, unknown>>;
      // No Anthropic credentials, so judged on the body this had no key to protect.
      const leftOut = await gw.send("PUT", "/api/model-endpoints/config", { ...shown, orchestrator: { primary: "anthropic/x", baseUrl: EVIL } });
      expect(leftOut.status).toBe(400);
      expect(await refusedField(leftOut)).toBe("orchestrator.apiKey");
      expect(gw.loader.getConfig().agents.defaults.model).toMatchObject({ primary: "lmstudio/orch", baseUrl: "http://orch.invalid/v1", apiKey: "shard-key" });
    } finally {
      await gw.stop();
    }
  }, 45_000);

  it("judges the model an env variable pins, not the one the body names", async () => {
    // SAI_PRIMARY_MODEL outranks the saved primary, and with it whose key stands in for an unset one.
    process.env["SAI_PRIMARY_MODEL"] = "lmstudio/orch";
    const gw = await bootGateway({
      providers: PROVIDERS,
      agents: { defaults: { model: {
        primary: "lmstudio/orch", baseUrl: "http://orch.invalid/v1",
        embeddingModel: "lmstudio/embed", embeddingBaseUrl: "http://embed.invalid/v1", embeddingApiKey: "embed-key",
      } } },
      ...ENDPOINT_SECTIONS,
    });
    try {
      const shown = await (await gw.send("GET", "/api/model-endpoints/config")).json() as Record<string, Record<string, unknown>>;
      const renamed = await gw.send("PUT", "/api/model-endpoints/config", { ...shown, orchestrator: { primary: "anthropic/x", baseUrl: EVIL } });
      expect(renamed.status).toBe(400);
      expect(await refusedField(renamed)).toBe("orchestrator.apiKey");
    } finally {
      await gw.stop();
    }
  }, 45_000);

  it("judges a config-assistant proposal on the config it leaves in effect", async () => {
    // The same pin, reached through a proposal: neither path is protected, and judged on the
    // proposal's own model name the default endpoint moved with no key to protect.
    process.env["SAI_PRIMARY_MODEL"] = "lmstudio/orch";
    const gw = await bootGateway({
      providers: PROVIDERS,
      // Embeddings with an endpoint and key of their own, so only the default model's key is at stake.
      agents: { defaults: { model: {
        primary: "lmstudio/orch", baseUrl: "http://orch.invalid/v1",
        embeddingModel: "lmstudio/embed", embeddingBaseUrl: "http://embed.invalid/v1", embeddingApiKey: "embed-key",
      } } },
    });
    try {
      const { createConversationConfigProposal } = await import("../agent/config-assistant-proposals.js");
      const workspacePath = gw.loader.getConfig().workspacePath;
      const { id } = createConversationConfigProposal(workspacePath, {
        status: "pending",
        mode: "enhancement",
        request: "use Claude",
        summary: "Switch the default model.",
        assistantAgent: "config_assistant",
        configChanges: [
          { path: "agents.defaults.model.primary", value: "anthropic/x", reason: "test" },
          { path: "agents.defaults.model.baseUrl", value: EVIL, reason: "test" },
        ],
        promptChanges: [],
        validations: [],
        tags: [],
      });
      const refused = await gw.send("POST", `/api/config-assistant/proposals/${id}/apply`);
      expect(refused.status).toBe(400);
      expect(await refusedField(refused)).toBe("agents.defaults.model.apiKey");
      expect(gw.loader.getConfig().agents.defaults.model.baseUrl).toBe("http://orch.invalid/v1");
    } finally {
      await gw.stop();
    }
  }, 45_000);

  // A peer's agent is loaded but not saved. A prompt change aimed at one passed the target check,
  // and Apply then wrote the saved config an agent of a prompt alone and refused the proposal as one
  // that "does not leave a valid config" (r5 A-security).
  it("refuses a proposal aimed at an A2A peer's agent up front, when drafting and when applying", async () => {
    const gw = await bootGateway({ subAgents: { coder: { description: "Writes code." } } });
    try {
      // As the A2A client registers a peer's skill.
      gw.loader.setRuntimeSubAgent("a2a__peer__skill", { description: "[A2A:peer] A peer's skill.", tools: ["a2a__peer__skill"] } as never);
      const said = { error: "Agent 'a2a__peer__skill' is bridged in from an A2A peer and runs there, so its prompt and settings are the peer's to change, not ours." };
      const drafted = await gw.send("POST", "/api/config-assistant/proposals", { request: "Be terser.", mode: "prompt", targetAgent: "a2a__peer__skill" });
      expect(drafted.status).toBe(409);
      expect(await drafted.json()).toEqual(said);

      const { createConversationConfigProposal } = await import("../agent/config-assistant-proposals.js");
      const workspacePath = gw.loader.getConfig().workspacePath;
      const propose = (changes: { configChanges?: Array<{ path: string; value: unknown; reason: string }>; promptChanges?: Array<{ agentName: string; strategy: "replace" | "append"; prompt: string; rationale: string }> }) =>
        createConversationConfigProposal(workspacePath, {
          status: "pending", mode: "prompt", request: "Be terser.", summary: "Terser answers.", assistantAgent: "prompt_optimizer",
          configChanges: changes.configChanges ?? [], promptChanges: changes.promptChanges ?? [], validations: [], tags: [],
        }).id;
      const toPeer = [
        propose({ promptChanges: [{ agentName: "a2a__peer__skill", strategy: "append", prompt: "Be terser.", rationale: "test" }] }),
        propose({ configChanges: [{ path: "subAgents.a2a__peer__skill.model.temperature", value: 0.2, reason: "test" }] }),
        // The whole map with the peer's agent written in (review of r6 leftovers, 3).
        propose({ configChanges: [{ path: "subAgents", value: { coder: { description: "Writes code." }, a2a__peer__skill: { description: "Mine now.", tools: [] } }, reason: "test" }] }),
      ];
      for (const id of toPeer) {
        const applied = await gw.send("POST", `/api/config-assistant/proposals/${id}/apply`);
        expect(applied.status).toBe(409);
        expect(await applied.json()).toEqual(said);
      }
      // The whole map without it applies, and cannot drop the peer's agent: the next load lays it
      // back over (round 2 of the leftovers review, LOW 1).
      const mapWithout = propose({ configChanges: [{ path: "subAgents", value: { coder: { description: "Writes code." } }, reason: "test" }] });
      expect((await gw.send("POST", `/api/config-assistant/proposals/${mapWithout}/apply`)).status).toBe(200);
      expect(gw.loader.getConfig().subAgents["a2a__peer__skill"]).toBeDefined();
      // A saved agent's prompt still applies.
      const toCoder = propose({ promptChanges: [{ agentName: "coder", strategy: "replace", prompt: "Be terser.", rationale: "test" }] });
      expect((await gw.send("POST", `/api/config-assistant/proposals/${toCoder}/apply`)).status).toBe(200);
      expect(gw.loader.getConfig().subAgents["coder"]?.systemPrompt).toBe("Be terser.");
    } finally {
      await gw.stop();
    }
  }, 45_000);

  describe("after a sub-agent's model changes", () => {
    // The coder's endpoint and key are set in a config shard; the Settings page then moves both.
    const withCoder = {
      providers: PROVIDERS,
      agents: { defaults: { model: {
        primary: "lmstudio/orch", baseUrl: "http://orch.invalid/v1", apiKey: "orch-key",
        embeddingModel: "lmstudio/embed", embeddingBaseUrl: "http://embed.invalid/v1", embeddingApiKey: "embed-key",
      } } },
      subAgents: { coder: { description: "Writes code.", model: { primary: "lmstudio/coder", baseUrl: "http://coder-a.invalid/v1", apiKey: "coder-shard-key" } } },
      ...ENDPOINT_SECTIONS,
    };
    const proposeTemperature = async (workspacePath: string) => {
      const { createConversationConfigProposal } = await import("../agent/config-assistant-proposals.js");
      return createConversationConfigProposal(workspacePath, {
        status: "pending",
        mode: "enhancement",
        request: "warmer",
        summary: "Raise the temperature.",
        assistantAgent: "config_assistant",
        configChanges: [{ path: "agents.defaults.model.temperature", value: 0.4, reason: "test" }],
        promptChanges: [],
        validations: [],
        tags: [],
      }).id;
    };

    // Round 3 judged these saves' "before" on the loaded config, where the patch was: its going
    // back to the shard's endpoint read as the shard key moving, and both were refused until a reload.
    it("passes an unchanged model-endpoints save and an unrelated proposal, and keeps the change", async () => {
      const gw = await bootGateway(withCoder);
      try {
        expect((await gw.send("PATCH", "/api/agents/coder/model", { baseUrl: "http://coder-b.invalid/v1", apiKey: "coder-typed-key" })).status).toBe(200);
        const shown = await (await gw.send("GET", "/api/model-endpoints/config")).json();
        expect((await gw.send("PUT", "/api/model-endpoints/config", shown)).status).toBe(200);
        const id = await proposeTemperature(gw.loader.getConfig().workspacePath);
        expect((await gw.send("POST", `/api/config-assistant/proposals/${id}/apply`)).status).toBe(200);
        expect(gw.loader.getConfig().agents.defaults.model.temperature).toBe(0.4);
        // Both saves reloaded the config from disk, and the change is still there.
        expect(gw.loader.getConfig().subAgents["coder"]?.model).toMatchObject({ baseUrl: "http://coder-b.invalid/v1", apiKey: "coder-typed-key" });
      } finally {
        await gw.stop();
      }
    }, 45_000);

    // The loaded config can still differ from disk (the A2A client adds its peers' agents at
    // runtime). A save reloads from disk, so what it changes is judged disk against disk.
    it("judges the saves against the config on disk, not a loaded one that differs", async () => {
      const gw = await bootGateway(withCoder);
      const driftLoaded = () => {
        const coder = gw.loader.getConfig().subAgents["coder"]!;
        coder.model = { ...coder.model, baseUrl: "http://coder-b.invalid/v1" };
      };
      try {
        driftLoaded();
        const shown = await (await gw.send("GET", "/api/model-endpoints/config")).json();
        expect((await gw.send("PUT", "/api/model-endpoints/config", shown)).status).toBe(200);
        driftLoaded();
        const id = await proposeTemperature(gw.loader.getConfig().workspacePath);
        expect((await gw.send("POST", `/api/config-assistant/proposals/${id}/apply`)).status).toBe(200);
        // And a real move is still refused: judged disk against disk, the shard key at a new endpoint.
        const moved = await gw.send("PATCH", "/api/agents/coder/model", { baseUrl: EVIL, apiKey: MASK });
        expect(moved.status).toBe(400);
        expect(await refusedField(moved)).toBe("subAgents.coder.model.apiKey");
      } finally {
        await gw.stop();
      }
    }, 45_000);
  });

  /** An upstream that finds no text in an image, which sends it to the vision fallback, and records its bearer. */
  async function visionUpstream() {
    const authorizations: string[] = [];
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        authorizations.push(String(req.headers.authorization ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "a described image" } }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ markdown: "" }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    return { url, authorizations, close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) };
  }

  async function uploadImage(gw: { baseUrl: string; authorization: string }) {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "shot.png", { type: "image/png" }));
    const response = await fetch(`${gw.baseUrl}/api/multimodal/file-to-markdown`, { method: "POST", headers: { Authorization: gw.authorization }, body: form });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { markdown: string }).markdown).toBe("a described image");
  }

  it("sends the image-upload vision fallback the vision model's provider key, not the primary one", async () => {
    const upstream = await visionUpstream();
    // An anthropic/* vision model with no Anthropic credentials: the rule saw no key to protect at
    // its endpoint, and the fallback sent providers.lmstudio's key there anyway.
    const gw = await bootGateway({
      providers: PROVIDERS,
      multimodal: { files: { baseUrl: upstream.url, toolName: "file_to_markdown", visionModel: "anthropic/claude-x", visionBaseUrl: `${upstream.url}/v1` } },
    });
    try {
      await uploadImage(gw);
      expect(upstream.authorizations).toHaveLength(1);
      expect(upstream.authorizations[0]).not.toContain("lm-key");
    } finally {
      await gw.stop();
      await upstream.close();
    }
  }, 45_000);

  it("sends the image-upload vision fallback the vision key, where one is set", async () => {
    // The key the rule judged at the vision endpoint. Without it passed to the resolver, the
    // fallback sent the provider's key there instead (r3 A-security #4).
    const upstream = await visionUpstream();
    const gw = await bootGateway({
      providers: PROVIDERS,
      multimodal: { files: {
        baseUrl: upstream.url, toolName: "file_to_markdown",
        visionModel: "lmstudio/qwen-vl", visionBaseUrl: `${upstream.url}/v1`, visionApiKey: "vision-key",
      } },
    });
    try {
      await uploadImage(gw);
      expect(upstream.authorizations).toEqual(["Bearer vision-key"]);
    } finally {
      await gw.stop();
      await upstream.close();
    }
  }, 45_000);
});
