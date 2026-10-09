import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "../product/index.js";
import { ModelConfigSchema, type ModelConfig } from "../config/schema.js";
import type { LLMMessage, LLMToolDef, StreamCallOptions } from "../providers/lmstudio.js";

/**
 * THE SHIPPED ORCHESTRATOR MODEL STARTS ITS FORCED --agent AND BUILD CALLS INSIDE THE CALL, AND
 * ONLY ON THE MODEL IDS IT WAS MEASURED ON.
 *
 * ModelConfig.toolCallPrefill is off in the schema. The shipped workspace config names "qwen-xml"
 * on agents.defaults.model, the model the orchestrator reads, because on the deployed llama.cpp
 * tool_choice "required" lets the model write prose before the call: replayed on the Halo on
 * 2026-10-09 with the turn's own forced requests, 12 per arm, the Mermaid build called
 * diagram_designer 0 times in 12 without the prefill (8 ran prose to the 4,000-token ceiling) and
 * 12 times in 12 with it. Which forced calls ask for it is the runtime's decision
 * (forced-tool-call-controls.test.ts); this file pins that the shipped model answers the ask, on
 * the wire, and that the ask alone decides it.
 *
 * It names the syntax per model id. As one string it outlived the ids: SAI_PRIMARY_MODEL, which the
 * setup wizard writes for every backend, and the dashboard's model save replace the primary and
 * keep the rest of the model, so a wizard install on Ollama (`lmstudio/qwen2.5:7b`) would have sent
 * the Qwen3-Coder opener on every forced call (review of e7da7236). By that review Ollama continues
 * the trailing assistant message instead of refusing it with a 4xx, so the provider's refusal retry
 * never switches it off. Those paths are tested here on the config they leave in effect, through
 * the production provider; only the OpenAI SDK client is replaced.
 */

type Body = Record<string, unknown> & { model?: string; messages: Array<Record<string, unknown>> };

const wire = vi.hoisted(() => ({ bodies: [] as Body[] }));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async (body: Body) => {
          wire.bodies.push(body);
          return (async function* () {
            yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "delegate_to_agent", arguments: "{\"task\":\"draw\"}" } }] }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } };
          })();
        },
      },
    };
    models = { list: async () => ({ data: [] }) };
    embeddings = { create: async () => ({ data: [] }) };
    constructor(_opts: unknown) {}
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const PLATFORM_SHARD = join(REPO, "workspace", "agents", "00-platform.jsonc");
const OPENER = "<tool_call>\n<function=";

/** agents.defaults.model exactly as the shipped shard writes it, before any parsing. */
function shippedModelBlock(): Record<string, unknown> {
  const raw = JSON5.parse(readFileSync(PLATFORM_SHARD, "utf8")) as { agents?: { defaults?: { model?: Record<string, unknown> } } };
  return raw.agents?.defaults?.model ?? {};
}

/** agents.defaults.model as the shipped shard declares it, parsed as the loader parses it. */
function shippedDefaultModel(): ModelConfig {
  return ModelConfigSchema.parse(shippedModelBlock());
}

const messages: LLMMessage[] = [
  { role: "system", content: "You are the orchestrator." },
  { role: "user", content: "Zeichne den Bestellablauf als Mermaid-Flussdiagramm." },
];
const tools: LLMToolDef[] = [
  {
    name: "delegate_to_agent",
    description: "Delegate a task to a specialist.",
    parameters: { type: "object", properties: { agentName: { type: "string" }, task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "record_plan",
    description: "Record the plan.",
    parameters: { type: "object", properties: { objective: { type: "string" } }, required: ["objective"] },
  },
];
const FORCED_BUILD: StreamCallOptions = { toolChoice: "required", maxTokens: 4000, prefillToolCall: {} };

async function send(provider: { stream: (m: LLMMessage[], t: LLMToolDef[], s?: AbortSignal, o?: StreamCallOptions) => AsyncIterable<unknown> }, options?: StreamCallOptions): Promise<Body[]> {
  const from = wire.bodies.length;
  for await (const chunk of provider.stream(messages, tools, undefined, options)) void chunk;
  return wire.bodies.slice(from);
}

const lastWireMessage = (body: Body) => body.messages[body.messages.length - 1];

// Anything that would put a model, an endpoint or a key in place from outside a test's own setup.
const OUTSIDE = [
  "SAI_CONFIG_PATH", "SAI_WORKSPACE_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_AUDIT_LOG", "SAI_MASTER_KEY", "SAI_CRED_STORE",
  "SAI_PRIMARY_MODEL", "SAI_DEFAULT_MODEL", "SAI_FALLBACK_MODEL", "SAI_EMBEDDING_MODEL", "SAI_ROUTING_MODEL",
  "SAI_PRIMARY_MODEL_URL", "SAI_LMSTUDIO_URL", "SAI_PRIMARY_MODEL_KEY", "SAI_LMSTUDIO_API_KEY", "SAI_JWT_SECRET",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
];
const saved = new Map<string, string | undefined>();
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of OUTSIDE) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  wire.bodies.length = 0;
});

afterEach(async () => {
  // The provider's audit rows are written after the call; flushed here, before their temp dir goes.
  await (await import("../audit/logger.js")).flushAuditLog();
  (await import("../providers/lmstudio.js"))._resetToolCallPrefillRefusalsForTests();
  (await import("../providers/index.js")).resetProvidersForTests();
  (await import("../config/loader.js")).resetConfigForTests();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("the shipped default model sends the prefilled tool call the orchestrator asks for", () => {
  it("names the qwen-xml syntax for its primary and its fallback, and for no other id", async () => {
    const { toolCallPrefillSyntaxFor } = await import("../providers/lmstudio.js");
    const model = shippedDefaultModel();
    // Each id must be a Qwen3.5/3.6 served by llama.cpp's Qwen3-Coder handler: an opener another
    // model's grammar does not take fails the request.
    expect(model.primary).toMatch(/^lmstudio\/qwen(?:-27b)?$/);
    expect(model.fallback).toMatch(/^lmstudio\/qwen(?:-27b)?$/);
    expect(model.cloudFallback).toBeUndefined();
    expect(model.toolCallPrefill).toEqual({ [model.primary]: "qwen-xml", [model.fallback!]: "qwen-xml" });
    // Each endpoint of the chain is a config with its own id as primary (createChatProvider).
    expect(toolCallPrefillSyntaxFor({ ...model, primary: model.fallback! })).toBe("qwen-xml");
    expect(toolCallPrefillSyntaxFor({ ...model, primary: "lmstudio/qwen2.5:7b" })).toBeUndefined();
  });

  it("a forced call that asks for it goes out with the opener, bare or named", async () => {
    const { LMStudioProvider } = await import("../providers/lmstudio.js");
    const provider = new LMStudioProvider("http://localhost:1234/v1", "test", shippedDefaultModel(), { maxRetries: 0 });
    const bodies = [
      ...await send(provider, FORCED_BUILD),
      ...await send(provider, { toolChoice: "required", maxTokens: 4000, prefillToolCall: { tool: "delegate_to_agent" } }),
    ];

    expect(bodies).toHaveLength(2);
    expect(lastWireMessage(bodies[0]!)).toEqual({ role: "assistant", content: OPENER });
    expect(lastWireMessage(bodies[1]!)).toEqual({ role: "assistant", content: `${OPENER}delegate_to_agent>\n` });
    for (const body of bodies) expect(body["tool_choice"]).toBe("required");
  });

  it("a call that does not ask goes out as before: forced or not, the last message is the user's", async () => {
    const { LMStudioProvider } = await import("../providers/lmstudio.js");
    const provider = new LMStudioProvider("http://localhost:1234/v1", "test", shippedDefaultModel(), { maxRetries: 0 });
    // A research-forced orchestrator call and a sub-agent's forced call ask for nothing.
    const bodies = [...await send(provider, { toolChoice: "required", maxTokens: 4000 }), ...await send(provider)];

    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(lastWireMessage(body)?.["role"]).toBe("user");
  });
});

describe("a model id that replaces the shipped one gets no opener", () => {
  /** The shipped config/ + workspace/ as the gateway loads them, with `env` laid over. */
  async function loadShipped(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "sai-shipped-prefill-"));
    tempDirs.push(dir);
    process.env["SAI_CONFIG_PATH"] = join(REPO, "config");
    process.env["SAI_WORKSPACE_CONFIG_PATH"] = join(REPO, "workspace");
    // Nothing is written into the repo: the overlay goes to a temp file and the compiled artifact
    // is not written.
    process.env["SAI_MUTABLE_CONFIG_PATH"] = join(dir, "runtime.overrides.json");
    process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    vi.resetModules();
    const loader = await import("../config/loader.js");
    const providers = await import("../providers/index.js");
    const config = loader.loadConfig({ skipCompiledWrite: true });
    return { model: config.agents.defaults.model, createChatProvider: providers.createChatProvider };
  }

  it("the setup wizard's Ollama pin: a forced build call goes out with the user's message last", async () => {
    // scripts/setup-wizard.mjs, backend "local Ollama", default tag.
    const { model, createChatProvider } = await loadShipped({
      SAI_PRIMARY_MODEL: "lmstudio/qwen2.5:7b",
      SAI_PRIMARY_MODEL_URL: "http://ollama:11434/v1",
    });
    expect(model.primary).toBe("lmstudio/qwen2.5:7b");
    expect(model.fallback).toBe("lmstudio/qwen2.5:7b");

    const bodies = await send(createChatProvider(model), FORCED_BUILD);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe("qwen2.5:7b");
    expect(lastWireMessage(bodies[0]!)?.["role"]).toBe("user");
    expect(bodies[0]!.messages.some((m) => m["role"] === "assistant")).toBe(false);
  });

  it("an env pin that names a shipped id keeps the opener", async () => {
    for (const id of ["lmstudio/qwen", "lmstudio/qwen-27b"]) {
      const { model, createChatProvider } = await loadShipped({ SAI_PRIMARY_MODEL: id });
      const bodies = await send(createChatProvider(model), FORCED_BUILD);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.model).toBe(id.slice("lmstudio/".length));
      expect(lastWireMessage(bodies[0]!)).toEqual({ role: "assistant", content: OPENER });
    }
  });

  /** The whole gateway on a config directory, so a save goes to the overlay as in a deployment. */
  async function bootGateway(config: Record<string, unknown>) {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-prefill-gateway-"));
    tempDirs.push(tempDir);
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    const port = 33_000 + Math.floor(Math.random() * 2_000);
    writeFileSync(join(configDir, "10-test.json"), JSON.stringify({ gateway: { port, jwtSecret: "s".repeat(40) }, workspacePath: tempDir, ...config }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configDir;
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
    vi.resetModules();
    const [{ createGateway }, auth, loader, providers] = await Promise.all([
      import("../gateway/index.js"),
      import("../gateway/auth.js"),
      import("../config/loader.js"),
      import("../providers/index.js"),
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
    const sendRoute = (method: string, path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { sendRoute, loader, providers, stop: async () => { await gateway.stop(); auth.resetAuthStateForTests(); } };
  }

  it("the dashboard's model save that changes the primary: no opener for the new primary, the shipped fallback keeps it", async () => {
    const shipped = shippedModelBlock();
    const gw = await bootGateway({
      providers: { lmstudio: { baseUrl: "http://primary.invalid/v1", apiKey: "lm-key" } },
      // The shipped model's ids and flag, as the shard writes them.
      agents: { defaults: { model: { primary: shipped["primary"], fallback: shipped["fallback"], toolCallPrefill: shipped["toolCallPrefill"] } } },
      // The model-endpoints PUT replaces all four sections, so the config sets all four.
      retrieval: { reranker: { enabled: false, model: "rerank", baseUrl: "http://rerank.invalid/v1", apiKey: "rerank-key" } },
      guardrails: { modelModeration: { enabled: false, model: "guard", baseUrl: "http://guard.invalid/v1", apiKey: "guard-key" } },
    });
    try {
      const shown = await (await gw.sendRoute("GET", "/api/model-endpoints/config")).json() as Record<string, Record<string, unknown>>;
      const saved = await gw.sendRoute("PUT", "/api/model-endpoints/config", { ...shown, orchestrator: { ...shown["orchestrator"], primary: "lmstudio/llama3.3" } });
      expect(saved.status).toBe(200);

      const model = gw.loader.getConfig().agents.defaults.model;
      expect(model.primary).toBe("lmstudio/llama3.3");
      const primaryBodies = await send(gw.providers.createChatProvider(model), FORCED_BUILD);
      expect(primaryBodies).toHaveLength(1);
      expect(primaryBodies[0]!.model).toBe("llama3.3");
      expect(lastWireMessage(primaryBodies[0]!)?.["role"]).toBe("user");

      // The fallback the save left in place is still the Qwen it was measured on: its endpoint, a
      // config of its own with its id as primary (createChatProvider), keeps the opener.
      expect(model.fallback).toBe(shipped["fallback"]);
      const fallbackBodies = await send(gw.providers.createChatProvider({ ...model, primary: model.fallback!, fallback: undefined }), FORCED_BUILD);
      expect(lastWireMessage(fallbackBodies[0]!)).toEqual({ role: "assistant", content: OPENER });
    } finally {
      await gw.stop();
    }
  }, 45_000);
});
