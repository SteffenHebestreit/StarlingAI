import { describe, expect, it } from "vitest";
import {
  ephemeralAgentSpecLacksWebTools,
  enforceSourceSensitiveOriginalRequestOnToolCall,
} from "../agent/runtime.js";

/**
 * Source-sensitive enforcement must not poison a write-only ephemeral-agent spec
 * (audit 74e49d90). A "create a verified reveal.js presentation" turn is
 * source-sensitive, so the research delegations correctly get the
 * "WEB RESEARCH TASK — gather datasheets/sourcing/pricing" preamble. But when the
 * orchestrator then spawns a presentation_builder (tools: [write_file]) to RENDER
 * the gathered evidence, injecting that research preamble into its task tripped the
 * agent-factory research-capability gate → the writer was rejected for lacking web
 * tools → the artifact was never built and the turn shipped a raw evidence dump.
 */
type ToolCall = Parameters<typeof enforceSourceSensitiveOriginalRequestOnToolCall>[0];
type Guidance = Parameters<typeof enforceSourceSensitiveOriginalRequestOnToolCall>[2];

const SOURCE_SENSITIVE = { sourceSensitive: true } as unknown as Guidance;
const WRITER_TASK = "Create the reveal.js presentation from the verified shared findings and write it to deck.html.";

const ephemeral = (tools: string[] | undefined): ToolCall => ({
  id: "1",
  type: "function",
  name: "create_ephemeral_agent",
  arguments: {
    agentName: "presentation_builder",
    task: WRITER_TASK,
    ...(tools ? { tools } : {}),
  },
} as ToolCall);

describe("ephemeralAgentSpecLacksWebTools", () => {
  it("flags write/artifact-only specs (the agent-factory rejection case)", () => {
    expect(ephemeralAgentSpecLacksWebTools({ tools: ["write_file"] })).toBe(true);
    expect(ephemeralAgentSpecLacksWebTools({ tools: ["generate_website", "write_file"] })).toBe(true);
    // url_inspect probes a known URL but cannot search/fetch — the gate does not count it.
    expect(ephemeralAgentSpecLacksWebTools({ tools: ["url_inspect", "write_file"] })).toBe(true);
  });

  it("does NOT flag research-capable specs", () => {
    expect(ephemeralAgentSpecLacksWebTools({ tools: ["web_search", "write_file"] })).toBe(false);
    expect(ephemeralAgentSpecLacksWebTools({ tools: ["web_fetch"] })).toBe(false);
    expect(ephemeralAgentSpecLacksWebTools({ tools: ["browser_navigate", "browser_snapshot"] })).toBe(false);
  });

  it("does NOT flag specs that inherit all tools (omitted/empty tools)", () => {
    expect(ephemeralAgentSpecLacksWebTools({})).toBe(false);
    expect(ephemeralAgentSpecLacksWebTools({ tools: [] })).toBe(false);
  });
});

describe("enforceSourceSensitiveOriginalRequestOnToolCall — ephemeral writer", () => {
  it("leaves a write-only ephemeral agent's task untouched (no research preamble)", () => {
    const call = ephemeral(["write_file"]);
    const events: Array<{ type: string; details: string }> = [];
    enforceSourceSensitiveOriginalRequestOnToolCall(call, "Erstelle eine verifizierte Präsentation.", SOURCE_SENSITIVE, "sess", events);
    expect((call.arguments as Record<string, unknown>)["task"]).toBe(WRITER_TASK);
    expect(events).toHaveLength(0);
  });

  it("still wraps a research-capable ephemeral agent (no regression)", () => {
    const call = ephemeral(["web_search", "write_file"]);
    const events: Array<{ type: string; details: string }> = [];
    enforceSourceSensitiveOriginalRequestOnToolCall(call, "Erstelle eine verifizierte Präsentation.", SOURCE_SENSITIVE, "sess", events);
    expect(String((call.arguments as Record<string, unknown>)["task"])).toContain("SOURCE-SENSITIVE DELEGATION");
    expect(events.length).toBeGreaterThan(0);
  });

  it("is a no-op when the turn is not source-sensitive", () => {
    const call = ephemeral(["write_file"]);
    const events: Array<{ type: string; details: string }> = [];
    enforceSourceSensitiveOriginalRequestOnToolCall(call, "x", { sourceSensitive: false } as unknown as Guidance, "sess", events);
    expect((call.arguments as Record<string, unknown>)["task"]).toBe(WRITER_TASK);
    expect(events).toHaveLength(0);
  });
});
