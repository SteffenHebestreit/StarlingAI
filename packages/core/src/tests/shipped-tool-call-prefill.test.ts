import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfigSchema, type ModelConfig } from "../config/schema.js";
import {
  LMStudioProvider,
  _resetToolCallPrefillRefusalsForTests,
  type LLMMessage,
  type LLMToolDef,
  type StreamCallOptions,
} from "../providers/lmstudio.js";

/**
 * THE SHIPPED ORCHESTRATOR MODEL STARTS ITS FORCED --agent AND BUILD CALLS INSIDE THE CALL.
 *
 * ModelConfig.toolCallPrefill is off in the schema. The shipped workspace config sets it to
 * "qwen-xml" on agents.defaults.model, the model the orchestrator reads, because on the deployed
 * llama.cpp tool_choice "required" lets the model write prose before the call: replayed on the
 * Halo on 2026-10-09 with the turn's own forced requests, 12 per arm, the Mermaid build called
 * diagram_designer 0 times in 12 without the prefill (8 ran prose to the 4,000-token ceiling) and
 * 12 times in 12 with it. Which forced calls ask for it is the runtime's decision
 * (forced-tool-call-controls.test.ts); this file pins that the shipped model answers the ask, on
 * the wire, and that the ask alone decides it.
 */

const PLATFORM_SHARD = fileURLToPath(new URL("../../../../workspace/agents/00-platform.jsonc", import.meta.url));

/** agents.defaults.model as the shipped shard declares it, parsed as the loader parses it. */
function shippedDefaultModel(): ModelConfig {
  const raw = JSON5.parse(readFileSync(PLATFORM_SHARD, "utf8")) as { agents?: { defaults?: { model?: unknown } } };
  return ModelConfigSchema.parse(raw.agents?.defaults?.model);
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

/** The shipped model behind a stub client that keeps every request body it is sent. */
function shippedProvider() {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", shippedDefaultModel(), { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return (async function* () {
            yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "delegate_to_agent", arguments: "{\"task\":\"draw\"}" } }] }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } };
          })();
        },
      },
    },
  };
  return { provider, bodies };
}

async function send(provider: LMStudioProvider, options?: StreamCallOptions): Promise<void> {
  for await (const chunk of provider.stream(messages, tools, undefined, options)) void chunk;
}

const lastWireMessage = (body: Record<string, unknown>) => {
  const wire = body["messages"] as Array<Record<string, unknown>>;
  return wire[wire.length - 1];
};

afterEach(() => {
  _resetToolCallPrefillRefusalsForTests();
});

describe("the shipped default model sends the prefilled tool call the orchestrator asks for", () => {
  it("names the qwen-xml syntax, on a model whose primary and fallback both serve it", () => {
    const model = shippedDefaultModel();
    expect(model.toolCallPrefill).toBe("qwen-xml");
    // The flag is shared by every endpoint of this config, so each must be a Qwen3.5/3.6 id served by
    // llama.cpp's Qwen3-Coder handler: an opener another model's grammar does not take fails the
    // request. Moving either id to another family means removing the flag from the shard.
    expect(model.primary).toMatch(/^lmstudio\/qwen(?:-27b)?$/);
    expect(model.fallback).toMatch(/^lmstudio\/qwen(?:-27b)?$/);
    expect(model.cloudFallback).toBeUndefined();
  });

  it("a forced call that asks for it goes out with the opener, bare or named", async () => {
    const { provider, bodies } = shippedProvider();
    await send(provider, { toolChoice: "required", maxTokens: 4000, prefillToolCall: {} });
    await send(provider, { toolChoice: "required", maxTokens: 4000, prefillToolCall: { tool: "delegate_to_agent" } });

    expect(bodies).toHaveLength(2);
    expect(lastWireMessage(bodies[0]!)).toEqual({ role: "assistant", content: "<tool_call>\n<function=" });
    expect(lastWireMessage(bodies[1]!)).toEqual({ role: "assistant", content: "<tool_call>\n<function=delegate_to_agent>\n" });
    for (const body of bodies) expect(body["tool_choice"]).toBe("required");
  });

  it("a call that does not ask goes out as before: forced or not, the last message is the user's", async () => {
    const { provider, bodies } = shippedProvider();
    // A research-forced orchestrator call and a sub-agent's forced call ask for nothing.
    await send(provider, { toolChoice: "required", maxTokens: 4000 });
    await send(provider);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(lastWireMessage(body)?.["role"]).toBe("user");
  });
});
