import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeEntry } from "../agent/outcomes.js";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", () => ({
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

describe("sub-agent turn timeouts", () => {
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("lets the current sub-agent LLM call finish after per-agent turnTimeoutMs elapses", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        slow_agent: {
          description: "Timeout test agent",
          systemPrompt: "Wait for the task to finish.",
          tools: [],
          maxIterations: 2,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    completeMock.mockImplementation((_messages: unknown, _tools: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      setTimeout(() => resolve({
        content: "Finished the current LLM run after the deadline.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      }), 1100);
    }));

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "slow_agent",
        task: "Do a very slow thing.",
        parentSessionId: "parent-1",
        workspacePath: "/workspace",
      });

      expect(result.output).toContain("Finished the current LLM run after the deadline.");
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("includes partial swarm progress in timeout output when work was already underway", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-timeout-progress-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coordinator_agent: {
          description: "Coordinator timeout test agent",
          systemPrompt: "Coordinate the task and use tools.",
          tools: ["get_swarm_state"],
          maxIterations: 3,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "get_swarm_state",
      description: "Populate swarm progress for timeout testing",
      parameters: { type: "object", properties: {} },
      async execute(_args, context) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const startedAt = new Date().toISOString();
        context.swarmState = {
          objective: "Build ETF chart",
          startedAt,
          updatedAt: startedAt,
          tasks: {
            fetch: {
              id: "fetch",
              title: "Fetch monthly ETF figures",
              status: "completed",
              dependsOn: [],
              selectedAgent: "researcher",
              attempts: [{
                agentName: "researcher",
                status: "completed",
                startedAt,
                finishedAt: startedAt,
                summary: "Collected monthly MSCI World ETF figures.",
              }],
              output: "Collected monthly MSCI World ETF figures.",
            },
          },
        };
        return { success: true, output: "Progress seeded" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "seed-1",
            name: "get_swarm_state",
            arguments: {},
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Final answer from partial progress: Fetch monthly ETF figures were collected.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coordinator_agent",
        task: "Coordinate an ETF chart build.",
        parentSessionId: "parent-progress-timeout",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Final answer from partial progress");
      expect(result.output).toContain("Fetch monthly ETF figures");
      expect(result.stats.terminalState).toBe("completed");
      expect(completeMock).toHaveBeenCalledTimes(2);
    } finally {
      unregisterTool("get_swarm_state");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("surfaces saved write_file artifacts when timing out after the current operation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-write-artifact-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        writer_agent: {
          description: "Writer timeout artifact test agent",
          systemPrompt: "Write the requested artifact.",
          tools: ["write_file"],
          maxIterations: 3,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "write_file",
      description: "Mock delayed file writer",
      parameters: { type: "object", properties: {} },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return {
          success: true,
          output: "File written: workspace/esp32-mic-array-project/README.md (486 chars)",
          metadata: {
            artifactKind: "workspace_file",
            outputPath: "workspace/esp32-mic-array-project/README.md",
            filename: "README.md",
            contentType: "text/markdown; charset=utf-8",
            previewMode: "text",
            isDirectory: false,
            size: 486,
            textPreview: "# ESP32 recorder Partial design.",
          },
        };
      },
    });

    completeMock.mockResolvedValueOnce({
      content: "",
      tool_calls: [{
        id: "write-artifact-1",
        name: "write_file",
        arguments: {
          path: "workspace/esp32-mic-array-project/README.md",
          content: "# ESP32 recorder\n\nPartial design.",
        },
      }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "tool_calls",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "writer_agent",
        task: "Write the portable ESP32 recorder README.",
        parentSessionId: "parent-write-artifact-timeout",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Artifacts collected: 1 (workspace/esp32-mic-array-project/README.md)");
      expect(result.output).toContain("Saved artifact workspace/esp32-mic-array-project/README.md");
      expect(result.output).toContain("# ESP32 recorder Partial design.");
      expect(result.stats.terminalState).toBe("timeout");
      expect(result.stats.outcome).toBe("partial");
      expect(result.artifacts?.[0]).toMatchObject({
        outputPath: "workspace/esp32-mic-array-project/README.md",
        sourceTool: "write_file",
      });
    } finally {
      unregisterTool("write_file");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("does not re-request approval-gated tools after approval expires", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-approval-loop-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        browser_agent: {
          description: "Browser approval loop test agent",
          systemPrompt: "Use the browser tools and report blockers plainly.",
          tools: ["http_request"],
          maxIterations: 4,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "approval-1", name: "http_request", arguments: { url: "https://example.test/login" } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "approval-2", name: "http_request", arguments: { url: "https://example.test/login" } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Login blocked because the required approval expired.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    const approvalCallback = vi.fn(() => Promise.reject(new Error("Tool 'http_request' approval timed out (no response within 5 min)")));

    try {
      await import("../tools/http-request.js");
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "browser_agent",
        task: "Open the saved login page.",
        parentSessionId: "parent-approval-loop",
        workspacePath: tempDir,
        approvalCallback,
      });

      expect(result.output).toContain("required approval expired");
      expect(approvalCallback).toHaveBeenCalledTimes(1);
      const secondCompletionTools = completeMock.mock.calls[1]?.[1] as Array<{ name: string }> | undefined;
      expect(secondCompletionTools?.some((tool) => tool.name === "http_request")).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("injects shared findings before the sub-agent starts iterating", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-shared-facts-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        reader_agent: {
          description: "Shared facts reader",
          systemPrompt: "Use existing shared facts before doing new work.",
          tools: [],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { writeSharedFact } = await import("../swarm/memory.js");
    await writeSharedFact("parent-shared-facts", "verified_endpoint", "Gateway endpoint is http://internal-gateway:8787.");

    completeMock.mockImplementationOnce((messages: Array<{ role: string; content?: string }>) => {
      const prompt = messages.map((message) => message.content ?? "").join("\n");
      expect(prompt).toContain("Shared findings snapshot");
      expect(prompt).toContain("verified_endpoint");
      expect(prompt).toContain("http://internal-gateway:8787");
      return Promise.resolve({
        content: "Used the shared endpoint finding.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "reader_agent",
        task: "Summarize the verified endpoint.",
        parentSessionId: "parent-shared-facts",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Used the shared endpoint finding.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("recovers usable snippets from mixed interrupted parallel output before returning a partial coordinator summary", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-mixed-interrupted-evidence-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coordinator_agent: {
          description: "Coordinator that delegates in parallel",
          systemPrompt: "Coordinate the task and use tools.",
          tools: ["parallel_delegate"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "parallel_delegate",
      description: "Run multiple delegated slices.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: [
            "**[researcher_a]** (failed): All candidate agents failed for task 'slice A'. Sub-agent error: Error: OpenAI-compatible request failed (model: qwen3.6-35b-a3b): Request timed out.",
            "",
            "---",
            "",
            "**[researcher_b]**:",
            "Sub-agent 'researcher_b' timed out after 300000ms",
            "Partial progress before interruption:",
            "- parallel_1 [completed] Verified sync slice via researcher_b | Verified endpoint: http://internal-gateway:8787. Sync worker drains a local retry queue before OTA upload and preserves failed batches for later retry.",
            "Recovered evidence snippets from completed tools:",
            "- web_search: Verified endpoint: http://internal-gateway:8787. Sync worker drains a local retry queue before OTA upload and preserves failed batches for later retry.",
          ].join("\n"),
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "parallel-mixed-1",
          name: "parallel_delegate",
          arguments: { tasks: [{ task: "Inspect the sync design." }, { task: "Inspect the retry behavior." }] },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "I'll continue by delegating another slice now.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coordinator_agent",
        task: "Coordinate the integration review.",
        parentSessionId: "parent-mixed-interrupted-evidence",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Recovered evidence snippets from completed tools");
      expect(result.output).toContain("http://internal-gateway:8787");
      expect(result.output).toContain("local retry queue");
      expect(result.output).not.toContain("All candidate agents failed");
      expect(result.stats.outcome).toBe("partial");
    } finally {
      unregisterTool("parallel_delegate");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("replaces truncation-claim synthesis with recovered parallel delegation evidence", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-truncation-recovery-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coordinator_agent: {
          description: "Coordinator that delegates in parallel",
          systemPrompt: "Coordinate the task and use tools.",
          tools: ["parallel_delegate"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "parallel_delegate",
      description: "Run multiple delegated slices.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: [
            "**[researcher]**: [researcher]: Before drafting the final answer, let me correct a critical misidentification from the search results.",
            "",
            "---",
            "",
            "**CRITICAL CORRECTION:** The ZX-9000 module is manufactured by VendorOne, not VendorTwo.",
            "Official source: VendorOne ZX-9000 datasheet. It is a verified component candidate for the requested design.",
            "Recommended follow-up: verify interface, power budget, geometry, and controller pin allocation before final selection.",
          ].join("\n"),
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "parallel-truncation-1",
          name: "parallel_delegate",
          arguments: { tasks: [{ task: "Research microphone candidates." }] },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "The workflow output appears truncated — it cuts off at \"CRITICAL CORRECTION: The ZX-9000 module is ...\" without completing the correction or providing the substantive findings.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coordinator_agent",
        task: "Coordinate the hardware recorder research.",
        parentSessionId: "parent-truncation-recovery",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Recovered evidence snippets from completed tools");
      expect(result.output).toContain("ZX-9000");
      expect(result.output).toContain("VendorOne");
      expect(result.output).not.toContain("workflow output appears truncated");
      expect(result.stats.outcome).toBe("partial");
    } finally {
      unregisterTool("parallel_delegate");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("propagates collected tool evidence in the max-iterations fallback instead of returning the 112-char boilerplate", async () => {
    // Regression: when a sub-agent exhausted its iteration budget AND the
    // synthesis-after-max-iterations attempt didn't produce a real text
    // answer (model kept emitting tool calls or threw), the runtime used to
    // discard everything the agent had already gathered and return a
    // single-line "reached the maximum number of tool-call iterations"
    // boilerplate. The parent then had nothing to work with. Now the
    // max-iterations path routes through buildInterruptedSubAgentOutput so
    // recovered tool-result snippets propagate up under the
    // "Recovered evidence snippets from completed tools:" header that the
    // parent runtime extracts.
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-max-iter-evidence-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaultContainerized: false,
      },
      subAgents: {
        researcher_with_search: {
          description: "Research agent for max-iterations evidence test",
          systemPrompt: "Research the topic.",
          tools: ["web_search"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "web_search",
      description: "Web search for the test.",
      parameters: { type: "object", properties: {} },
      async execute(_args: Record<string, unknown>) {
        return {
          success: true,
          output: "**Web Search Results for:** \"IM73A135V01 MEMS microphone datasheet\" (via searxng) **IM73A135V01 datasheet PDF — MEMS microphone | Infineon** https://datasheet4u.com/datasheets/Infineon/IM73A135V01/1559625 The IM73A135V01 is designed for applications which require a microphone with high SNR and a flat response. **Datasheet PDF** https://www.alldatasheet.com/datasheet-pdf/pdf/1388108/INFINEON/IM73A135V01.html",
        };
      },
    });

    completeMock
      // Iteration 1: emit a web_search call (uses up the maxIterations=1 budget).
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "search-1",
          name: "web_search",
          arguments: { query: "IM73A135V01 MEMS microphone datasheet" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // Synthesis-after-max-iterations call: model misbehaves and tries to
      // call another tool instead of producing text. This is the failure
      // mode the audit captured (`synthesizedAfterMaxIterations: false`).
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "search-2",
          name: "web_search",
          arguments: { query: "another query" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "researcher_with_search",
        task: "Verify the IM73A135V01 microphone specs.",
        parentSessionId: "parent-max-iter-evidence",
        workspacePath: tempDir,
      });

      // Must NOT be the 112-char boilerplate.
      expect(result.output).not.toBe(
        "Sub-agent 'researcher_with_search' reached the maximum number of tool-call iterations (1). Partial result may be incomplete.",
      );
      // Must include the recovered-evidence header so the parent runtime's
      // extractor can pull the tool result content.
      expect(result.output).toContain("Recovered evidence snippets from completed tools:");
      // And must include the actual web_search content the agent collected.
      expect(result.output).toMatch(/IM73A135V01|Infineon/);
      expect(result.stats.terminalState).toBe("max_iterations");
      expect(result.stats.outcome).toBe("partial");
    } finally {
      unregisterTool("web_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("does not promote workflow no-match bookkeeping to recovered evidence", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-no-match-filter-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coordinator_agent: {
          description: "Coordinator that tries workflow discovery",
          systemPrompt: "Coordinate the topic.",
          tools: ["search_workflows"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "search_workflows",
      description: "Mock workflow search",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: 'No workflows matched "hardware design guide BOM" strongly enough. Fall back to search_agents or direct coordinator planning for this request shape.',
          metadata: { workflowMatches: [] },
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "workflow-search-1",
          name: "search_workflows",
          arguments: { query: "hardware design guide BOM" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "workflow-search-2",
          name: "search_workflows",
          arguments: { query: "hardware design guide BOM retry" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coordinator_agent",
        task: "Create a topic-related portable recorder guide.",
        parentSessionId: "parent-no-match-filter",
        workspacePath: tempDir,
      });

      expect(result.output).not.toContain("No workflows matched");
      expect(result.output).not.toContain("Recovered evidence snippets from completed tools");
      expect(result.output).toContain("before producing usable topic-related output");
      expect(result.stats.terminalState).toBe("max_iterations");
      expect(result.stats.outcome).toBe("failure");
    } finally {
      unregisterTool("search_workflows");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("classifies a max-iterations run that published shared findings as partial, not failure", async () => {
    // A guardrail-limited run is not a failed run if it gathered usable
    // information. Here the researcher published a finding to shared memory
    // (concrete gathered knowledge), then exhausted its iteration budget and the
    // synthesis pass kept emitting tool calls. Even with no recoverable evidence
    // snippet in the narrative, the published finding means the run is
    // partial-with-evidence — the chain must not treat it as a total failure.
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-shared-finding-partial-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        researcher_shares: {
          description: "Researcher that publishes a finding before running out of budget",
          systemPrompt: "Research and publish findings.",
          tools: ["share_finding"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "share_finding",
      description: "Publish a finding to shared memory",
      parameters: { type: "object", properties: {} },
      // Keep the output short (< the 180-char snippet threshold) so it is NOT
      // buffered as a recovered evidence snippet — this isolates the
      // shared-findings signal as the sole reason the run is partial.
      async execute() {
        return { success: true, output: "Finding published: key=k1." };
      },
    });

    completeMock
      // Iteration 1: publish a finding (uses up maxIterations=1).
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "share-1", name: "share_finding", arguments: { key: "k1", value: "v1" } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // Synthesis-after-max-iterations: model misbehaves and tries another tool
      // call, so it falls through to the terminal max-iterations classification.
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "share-2", name: "share_finding", arguments: { key: "k2", value: "v2" } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "researcher_shares",
        task: "Research and publish a finding.",
        parentSessionId: "parent-shared-finding-partial",
        workspacePath: tempDir,
      });

      expect(result.stats.terminalState).toBe("max_iterations");
      expect(result.stats.outcome).toBe("partial");
    } finally {
      unregisterTool("share_finding");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("preserves all source-sensitive parallel delegation slices while anchoring them to the parent task", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-source-parallel-"));
    const configPath = join(tempDir, "starlingai.json");
    const parentTask = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        source_sensitive_coordinator: {
          description: "Source-sensitive coordinator",
          systemPrompt: "Coordinate source-sensitive research.",
          tools: ["parallel_delegate"],
          maxIterations: 2,
        },
        researcher_a: { description: "Researcher A", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_b: { description: "Researcher B", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_c: { description: "Researcher C", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
      },
      orchestration: { maxParallelSlices: 3 },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    const childPrompts: string[] = [];
    let callIndex = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "parallel-1",
            name: "parallel_delegate",
            arguments: {
              tasks: [
                { agentName: "researcher_a", task: "Verify the VendorX ZX-9000 USB-C interface.", context: "VendorX is already confirmed." },
                { agentName: "researcher_b", task: "Find ST ZX-9000 pricing and supplier data." },
                { agentName: "researcher_c", task: "Prepare layout advice assuming I2S output." },
              ],
            },
          }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        });
      }

      const prompt = messages.map((message) => message.content ?? "").join("\n");
      if (prompt.includes("SOURCE-SENSITIVE DELEGATION SLICE")) {
        childPrompts.push(prompt);
      }

      return Promise.resolve({
        content: "Observed evidence: source-backed placeholder finding.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "source_sensitive_coordinator",
        task: parentTask,
        parentSessionId: "parent-source-sensitive-parallel",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Observed evidence");
      expect(childPrompts).toHaveLength(3);
      expect(new Set(childPrompts).size).toBe(3);
      expect(childPrompts.join("\n")).toContain(parentTask);
      expect(childPrompts.join("\n")).toContain("SLICE 1/3");
      expect(childPrompts.join("\n")).toContain("SLICE 2/3");
      expect(childPrompts.join("\n")).toContain("SLICE 3/3");
      expect(childPrompts.join("\n")).toContain("Focus for this slice");
      // Topic-agnostic, gather-framed verification focus (replaced the overfit per-topic buckets).
      expect(childPrompts.join("\n")).toContain("gather and confirm every concrete fact");
      expect(childPrompts.join("\n")).not.toContain("VendorX is already confirmed");
      expect(childPrompts.join("\n")).not.toContain("ST ZX-9000");
      expect(childPrompts.join("\n")).not.toContain("assuming I2S");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("collapses re-fan-out when the task already arrived sliced from upstream (no compounding tree)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-source-nested-"));
    const configPath = join(tempDir, "starlingai.json");
    // The coordinator's OWN task already carries an upstream cross-check slice
    // label — i.e. an ancestor (orchestrator) already fanned this out. A second
    // fan-out here would only spawn identical canonical copies and compound the
    // tree 2→4→8, which is the runaway-latency failure mode.
    const parentTask = "SOURCE-SENSITIVE DELEGATION SLICE 1/2:\n"
      + "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        source_sensitive_coordinator: {
          description: "Source-sensitive coordinator",
          systemPrompt: "Coordinate source-sensitive research.",
          tools: ["parallel_delegate"],
          maxIterations: 2,
        },
        researcher_a: { description: "Researcher A", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_b: { description: "Researcher B", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_c: { description: "Researcher C", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
      },
      orchestration: { maxParallelSlices: 3 },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    const allPrompts: string[] = [];
    let callIndex = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "parallel-nested-1",
            name: "parallel_delegate",
            arguments: {
              tasks: [
                { agentName: "researcher_a", task: "Verify vendor identity from current sources." },
                { agentName: "researcher_b", task: "Find pricing and supplier data." },
                { agentName: "researcher_c", task: "Prepare layout advice." },
              ],
            },
          }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        });
      }
      allPrompts.push(messages.map((message) => message.content ?? "").join("\n"));
      return Promise.resolve({
        content: "Observed evidence: source-backed placeholder finding.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "source_sensitive_coordinator",
        task: parentTask,
        parentSessionId: "parent-already-sliced",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Observed evidence");
      // Collapsed to a single canonical child: exactly one dispatched child task
      // carries the unlabelled header ("…DELEGATION:" — no SLICE), and no second
      // or third re-fan-out slice was dispatched.
      const collapsedChildPrompts = allPrompts.filter((p) => p.includes("SOURCE-SENSITIVE DELEGATION:"));
      expect(collapsedChildPrompts).toHaveLength(1);
      expect(allPrompts.join("\n")).not.toContain("SLICE 2/");
      expect(allPrompts.join("\n")).not.toContain("SLICE 3/");
      // The canonical request still reaches the single child.
      expect(collapsedChildPrompts[0]).toContain("ZX-9000");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("blocks further delegation once a sub-agent is at the delegation depth ceiling", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-depth-ceiling-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        deep_coordinator: {
          description: "Coordinator running deep in the tree",
          systemPrompt: "Coordinate.",
          tools: ["delegate_to_agent"],
          maxIterations: 2,
        },
        leaf_specialist: {
          description: "Leaf specialist that should never be reached",
          systemPrompt: "LEAF_SPECIALIST_SYSTEM_PROMPT_MARKER",
          tools: [],
          maxIterations: 1,
        },
      },
      orchestration: { maxDelegationDepth: 2 },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    const allPrompts: string[] = [];
    let callIndex = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      callIndex += 1;
      allPrompts.push(messages.map((message) => message.content ?? "").join("\n"));
      if (callIndex === 1) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "deep-delegate-1",
            name: "delegate_to_agent",
            arguments: { agentName: "leaf_specialist", task: "Do the leaf work." },
          }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        });
      }
      return Promise.resolve({
        content: "Answered directly without delegating further.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      // parentSessionId already carries one `sub:` hop, so this run is depth 2 —
      // at the configured ceiling, so its delegation must be blocked.
      const result = await runSubAgentWithStats({
        agentName: "deep_coordinator",
        task: "Coordinate the deep work.",
        parentSessionId: "sub:root-depth:mission_coordinator:111",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Answered directly without delegating further");
      // The leaf specialist was never delegated to (its system prompt never ran).
      expect(allPrompts.join("\n")).not.toContain("LEAF_SPECIALIST_SYSTEM_PROMPT_MARKER");
      // The coordinator got a depth-ceiling nudge back as the tool result.
      expect(allPrompts.join("\n")).toContain("delegation levels deep (limit 2)");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("caps source-sensitive parallel delegation fan-out at three slices before dispatch", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-source-parallel-cap-"));
    const configPath = join(tempDir, "starlingai.json");
    const parentTask = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        source_sensitive_coordinator: {
          description: "Source-sensitive coordinator",
          systemPrompt: "Coordinate source-sensitive research.",
          tools: ["parallel_delegate"],
          maxIterations: 2,
        },
        researcher_a: { description: "Researcher A", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_b: { description: "Researcher B", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_c: { description: "Researcher C", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
        researcher_d: { description: "Researcher D", systemPrompt: "Research from sources.", tools: [], maxIterations: 1 },
      },
      orchestration: { maxParallelSlices: 3 },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    const childPrompts: string[] = [];
    let callIndex = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "parallel-cap-1",
            name: "parallel_delegate",
            arguments: {
              tasks: [
                { agentName: "researcher_a", task: "Verify vendor identity from current sources." },
                { agentName: "researcher_b", task: "Verify interface evidence from current sources." },
                { agentName: "researcher_c", task: "Verify package and analog front-end evidence from current sources." },
                { agentName: "researcher_d", task: "Verify battery and charging BOM evidence from current sources." },
              ],
            },
          }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        });
      }

      const prompt = messages.map((message) => message.content ?? "").join("\n");
      if (prompt.includes("SOURCE-SENSITIVE DELEGATION SLICE")) {
        childPrompts.push(prompt);
      }

      return Promise.resolve({
        content: "Observed evidence: source-backed placeholder finding.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "source_sensitive_coordinator",
        task: parentTask,
        parentSessionId: "parent-source-sensitive-parallel-cap",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Observed evidence");
      expect(childPrompts).toHaveLength(3);
      expect(childPrompts.join("\n")).toContain("SLICE 1/3");
      expect(childPrompts.join("\n")).toContain("SLICE 2/3");
      expect(childPrompts.join("\n")).toContain("SLICE 3/3");
      expect(childPrompts.join("\n")).not.toContain("SLICE 4/4");
      expect(childPrompts.join("\n")).not.toContain("researcher_d");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("adds default research fallbacks before the first source-sensitive delegation escapes the coordinator", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-source-fallback-"));
    const configPath = join(tempDir, "starlingai.json");
    const parentTask = "Use current sources to verify the exact ZX-9000 product manufacturer and interface before recommending parts.";

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        source_sensitive_coordinator: {
          description: "Source-sensitive coordinator",
          systemPrompt: "Coordinate source-sensitive research.",
          tools: ["delegate_to_agent"],
          maxIterations: 2,
        },
        researcher: {
          description: "Researcher",
          systemPrompt: "Research from sources.",
          tools: [],
          maxIterations: 1,
        },
        mission_coordinator: {
          description: "Fallback mission coordinator",
          systemPrompt: "Coordinate fallback research.",
          tools: [],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    let callIndex = 0;
    completeMock.mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.resolve({
          content: "",
          tool_calls: [{
            id: "delegate-1",
            name: "delegate_to_agent",
            arguments: {
              agentName: "researcher",
              task: "Research the ST ZX-9000 from VendorX as an I2S-only product and prepare recommendations.",
              context: "VendorX and I2S are already established facts.",
            },
          }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        });
      }

      return Promise.resolve({
        content: "Observed evidence: source-backed placeholder finding.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });
    });

    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "source_sensitive_coordinator",
        task: parentTask,
        parentSessionId: "parent-source-sensitive-fallback",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Observed evidence");

      const delegateStartEvent = auditEvents.find(
        (event) => event.type === "sub_agent_tool_call"
          && event.data.tool === "delegate_to_agent"
          && event.data.phase === "start",
      );
      expect(delegateStartEvent).toBeDefined();
      expect(delegateStartEvent?.data.args).toMatchObject({
        agentName: "researcher",
        fallbackAgents: ["mission_coordinator"],
      });
      expect(String((delegateStartEvent?.data.args as Record<string, unknown>)?.["task"] ?? "")).toContain("SOURCE-SENSITIVE DELEGATION");
      expect(String((delegateStartEvent?.data.args as Record<string, unknown>)?.["task"] ?? "")).toContain(parentTask);
      expect(String((delegateStartEvent?.data.args as Record<string, unknown>)?.["task"] ?? "")).not.toContain("VendorX");
      expect(String((delegateStartEvent?.data.args as Record<string, unknown>)?.["task"] ?? "")).not.toContain("I2S-only");
    } finally {
      unsubscribe();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  // QUARANTINED (DEVPLAN P0): premise no longer matches the strip design. extractKeyFacts caps each
  // finding at 600 chars and cumulativeUsefulEvidenceBytes sums those, so a single web_fetch can
  // contribute <=600 bytes and never reach SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES (12_000, ~20 findings).
  // Decide intended behavior: strip after one large single result, or rewrite fixture to ~20 distinct findings.
  it.skip("removes evidence-gathering tools after a large enough useful evidence result", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-sufficient-evidence-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        research_agent: {
          description: "Research agent with web tools",
          systemPrompt: "Research and answer from evidence.",
          tools: ["web_fetch", "web_search"],
          maxIterations: 4,
          turnTimeoutMs: 5000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const fetchOutput = [
      "Verified source evidence:",
      ...Array.from({ length: 140 }, (_, index) => `Fact ${index + 1}: source-backed implementation detail with integration constraints and quality implications.`),
    ].join("\n");

    registerTool({
      name: "web_fetch",
      description: "Fetch a page.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: fetchOutput };
      },
    });
    registerTool({
      name: "web_search",
      description: "Search the web.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "This should not be called after sufficient evidence." };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "fetch-1", name: "web_fetch", arguments: { url: "https://example.test/mic" } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockImplementationOnce((_messages: unknown, tools: Array<{ name: string }>) => {
        expect(tools.map((tool) => tool.name)).not.toContain("web_fetch");
        expect(tools.map((tool) => tool.name)).not.toContain("web_search");
        return Promise.resolve({
          content: "Final answer from collected evidence.",
          tool_calls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        });
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "research_agent",
        task: "Verify the microphone hardware design.",
        parentSessionId: "parent-sufficient-evidence",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Final answer from collected evidence.");
      const { readAllFacts } = await import("../swarm/memory.js");
      const facts = await readAllFacts("parent-sufficient-evidence");
      expect(Object.values(facts).join("\n")).toContain("Verified source evidence");
      expect(completeMock).toHaveBeenCalledTimes(2);
    } finally {
      unregisterTool("web_fetch");
      unregisterTool("web_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("synthesizes gathered evidence when timeout hits after tool work", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-timeout-synthesis-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        research_agent: {
          description: "Timeout synthesis test agent",
          systemPrompt: "Research the topic and return the findings.",
          tools: ["get_swarm_state"],
          maxIterations: 3,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.useFakeTimers();
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "get_swarm_state",
      description: "Return a verified protocol fact",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "MCP official docs: MCP is an open protocol for connecting AI systems to external tools and data. Source: https://modelcontextprotocol.io/",
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "fact-1",
            name: "get_swarm_state",
            arguments: {},
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockImplementationOnce((_messages: unknown, _tools: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => resolve({
          content: "",
          tool_calls: [
            {
              id: "extra-1",
              name: "get_swarm_state",
              arguments: {},
            },
          ],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        }), 1100);
      }))
      .mockResolvedValueOnce({
        content: "MCP is an open protocol that standardizes how AI applications connect to external tools and data sources. Source: https://modelcontextprotocol.io/",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const resultPromise = runSubAgentWithStats({
        agentName: "research_agent",
        task: "Summarize MCP.",
        parentSessionId: "parent-timeout-synthesis",
        workspacePath: tempDir,
      });
      await vi.advanceTimersByTimeAsync(1100);
      const result = await resultPromise;

      expect(result.output).toContain("MCP is an open protocol");
      expect(result.output).not.toContain("timed out after 1000ms");
      expect(result.stats.terminalState).toBe("completed");
      expect(result.stats.outcome).toBe("success");
      expect(completeMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      unregisterTool("get_swarm_state");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  // "Done is done" (audit 2445da2e): a BUILD run that already persisted its
  // deliverable must complete deterministically when the timeout hits — no
  // final-synthesis LLM call, no timeout/partial branding of finished work
  // (content_writer wrote the paper at 171s, then died at 270s waiting for a
  // stalled final message).
  it("completes deterministically at timeout when the build artifact already exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-artifact-done-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        builder_agent: {
          description: "Deterministic completion test agent",
          systemPrompt: "Build the requested file.",
          tools: ["get_swarm_state"],
          maxIterations: 3,
          turnTimeoutMs: 1000,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.useFakeTimers();
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "get_swarm_state",
      description: "Write the deliverable file",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "File written: generated/app/index.html (9000 chars)",
          metadata: {
            artifactKind: "workspace_file",
            outputPath: "generated/app/index.html",
            filename: "index.html",
            contentType: "text/html; charset=utf-8",
            size: 9000,
          },
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "build-1",
            name: "get_swarm_state",
            arguments: {},
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // The next call drags past the turn timeout and comes back wanting MORE
      // tool work — the timeout latch must route to completion instead.
      .mockImplementationOnce((_messages: unknown, _tools: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => resolve({
          content: "",
          tool_calls: [
            {
              id: "extra-build",
              name: "get_swarm_state",
              arguments: {},
            },
          ],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        }), 1100);
      }));

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const resultPromise = runSubAgentWithStats({
        agentName: "builder_agent",
        task: "Erstelle die Lernplattform als einzelne Datei index.html mit Quiz.",
        parentSessionId: "parent-artifact-done",
        workspacePath: tempDir,
      });
      await vi.advanceTimersByTimeAsync(1200);
      const result = await resultPromise;

      // The finished build is returned as a SUCCESS with the artifact listed —
      // not branded timeout/partial, and without another LLM synthesis call.
      expect(result.output).toContain("Deliverable completed");
      expect(result.output).toContain("generated/app/index.html");
      expect(result.stats.outcome).toBe("success");
      expect(result.stats.terminalState).toBe("completed");
      expect(result.artifacts?.some((a) => a["outputPath"] === "generated/app/index.html")).toBe(true);
      // No third LLM call: the deterministic completion replaced the synthesis pass.
      expect(completeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      unregisterTool("get_swarm_state");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("rescues final output that becomes empty after hallucinated tool markup is stripped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-sanitize-rescue-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        research_agent: {
          description: "Sanitized output rescue test agent",
          systemPrompt: "Research the topic and return the findings.",
          tools: ["get_swarm_state"],
          maxIterations: 3,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "get_swarm_state",
      description: "Return a verified protocol fact",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "MCP official docs: MCP is an open protocol for connecting AI systems to external tools and data. Source: https://modelcontextprotocol.io/",
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "fact-1",
            name: "get_swarm_state",
            arguments: {},
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "<tool_call><function=share_finding>{\"fact\":\"mcp\"}</function></tool_call>",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: "MCP is an open protocol that standardizes how AI applications connect to external tools and data sources. Source: https://modelcontextprotocol.io/",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "research_agent",
        task: "Summarize MCP.",
        parentSessionId: "parent-sanitize-rescue",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("MCP is an open protocol");
      expect(result.output).not.toContain("<tool_call>");
      expect(result.stats.terminalState).toBe("completed");
      expect(result.stats.outcome).toBe("success");
      expect(completeMock).toHaveBeenCalledTimes(3);
    } finally {
      unregisterTool("get_swarm_state");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("returns partial recovered evidence when final synthesis times out after successful research tools", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-final-timeout-partial-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research the topic and return grounded evidence.",
          tools: ["web_search", "share_finding"],
          maxIterations: 3,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "web_search",
      description: "Return grounded microphone evidence",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "Official microphone evidence: Infineon IM73A135V01 uses analog differential output rather than I2S. Datasheet source confirms 73 dB(A) SNR, 124 dB AOP, and 2.3-3.3 V supply.",
        };
      },
    });
    registerTool({
      name: "share_finding",
      description: "Publish a finding to shared memory",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "Finding published to shared session memory: 'im73a135v01_critical_specs' = \"Infineon IM73A135V01: Analog differential output MEMS microphone (NOT I2S/digital). SNR 73 dB(A), AOP 124 dB.\"",
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "search-1",
            name: "web_search",
            arguments: { query: "IM73A135V01 datasheet" },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "share-1",
            name: "share_finding",
            arguments: { key: "im73a135v01_critical_specs", value: "Infineon IM73A135V01 analog mic" },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockRejectedValueOnce(new Error("OpenAI-compatible request failed (model: qwen3.6-35b-a3b): Request timed out."));

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "researcher",
        task: "Verify IM73A135V01 microphone evidence.",
        parentSessionId: "parent-final-timeout-partial",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("timed out while finalizing the answer after substantive work");
      expect(result.output).toContain("Recovered evidence snippets from completed tools");
      expect(result.output).toContain("analog differential output");
      expect(result.stats.terminalState).toBe("timeout");
      expect(result.stats.outcome).toBe("partial");
      expect(completeMock).toHaveBeenCalledTimes(3);
    } finally {
      unregisterTool("web_search");
      unregisterTool("share_finding");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats a synthesized max-iteration result as successful when a deliverable artifact was already produced", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-max-iter-artifact-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        writer_agent: {
          description: "Artifact-producing writer",
          systemPrompt: "Write the requested report and stop once the document is saved.",
          tools: ["generate_document"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/document-output.js");

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "doc-1",
            name: "generate_document",
            arguments: {
              title: "Protocol Comparison",
              content: "# Protocol Comparison\n\nMCP vs A2A",
              format: "markdown",
              output_file: "reports/protocol-comparison.md",
              overwrite: true,
            },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "The report was written successfully and saved as a markdown artifact.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "writer_agent",
        task: "Write the protocol comparison report.",
        parentSessionId: "parent-artifact-success",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("written successfully");
      expect(result.stats.outcome).toBe("success");
      expect(result.stats.terminalState).toBe("completed");
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          outputPath: "generated/reports/protocol-comparison.md",
          previewMode: "markdown",
          sourceTool: "generate_document",
        }),
      ]);

      const completionEvent = auditEvents.find((event) => event.type === "sub_agent_completed" && event.data.agentName === "writer_agent");
      expect(completionEvent).toBeDefined();
      expect(completionEvent?.data.outcome).toBe("success");
      expect(completionEvent?.data.completedFromArtifact).toBe(true);
    } finally {
      unsubscribe();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("gives coordinator agents (with run_task_graph) an elevated default timeout floor", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-coordinator-timeout-"));
    const configPath = join(tempDir, "starlingai.json");
    const turnTimeoutMs = 900_000; // 15 min gateway turn timeout

    writeFileSync(configPath, JSON.stringify({
      gateway: { turnTimeoutMs },
      subAgents: {
        coord_agent: {
          description: "Coordinator that uses run_task_graph",
          systemPrompt: "Coordinate work.",
          tools: ["run_task_graph", "parallel_delegate", "delegate_to_agent"],
          maxIterations: 4,
          // NO turnTimeoutMs — should get 85% of gateway turn timeout as floor
        },
      },
    }), "utf8");

    // Seed short outcome history so adaptive would normally pick a LOW timeout
    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");
    const makeOutcome = (durationMs: number): OutcomeEntry => ({
      ts: new Date().toISOString(),
      agent: "coord_agent",
      task: "simple delegation",
      outcome: "success",
      iterations: 2,
      totalTokens: 100,
      durationMs,
      timeoutMs: 60_000,
    });
    // 3 short completions that would produce an adaptive timeout of ~45s × 1.5 = 67.5s
    for (const durationMs of [40_000, 42_000, 45_000]) {
      appendFileSync(outcomesFile, JSON.stringify(makeOutcome(durationMs)) + "\n");
    }

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    // Mock LLM to immediately return so we can inspect the audit event
    completeMock.mockResolvedValue({
      content: "coordinated",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    // Capture audit events via subscriber
    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coord_agent",
        task: "Run a complex task graph.",
        parentSessionId: "parent-coord",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("coordinated");

      // The coordinator default floor = 900_000 * 0.85 = 765_000 ms.
      // Adaptive p95 from history = 45_000 * 1.5 = 67_500, but Math.max(67_500, 765_000) = 765_000.
      // So the resolved timeout should be >= 765_000 ms (the coordinator floor wins).
      const startEvent = auditEvents.find(
        (e) => e.type === "sub_agent_started" && e.data?.agentName === "coord_agent",
      );
      expect(startEvent).toBeDefined();
      // timeoutMs should be at least the coordinator floor (765s), NOT the short adaptive value (67.5s)
      expect(startEvent!.data.timeoutMs).toBeGreaterThanOrEqual(765_000);
    } finally {
      unsubscribe();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it("records an adaptive timeout budget without creating an internal abort signal", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-adaptive-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        performance: {
          subAgentTurnSloMs: 60_000,
        },
      },
      subAgents: {
        adaptive_agent: {
          description: "Adaptive timeout test agent",
          systemPrompt: "Finish quickly.",
          tools: [],
          maxIterations: 1,
        },
      },
    }), "utf8");

    const stateDir = join(tempDir, ".starlingai");
    mkdirSync(stateDir, { recursive: true });
    const outcomesFile = join(stateDir, "agent_outcomes.ndjson");
    // Clean (non-timed-out) but slow finishes under a generous budget: history
    // shows the agent legitimately takes ~100s, so the adaptive budget should
    // grow above the 60s default. (durationMs must stay below timeoutMs, else
    // the run counts as timed-out and is excluded from the baseline.)
    const makeOutcome = (durationMs: number): OutcomeEntry => ({
      ts: new Date().toISOString(),
      agent: "adaptive_agent",
      task: "historical",
      outcome: "success",
      iterations: 1,
      totalTokens: 50,
      durationMs,
      timeoutMs: 200_000,
    });
    for (const durationMs of [90_000, 100_000, 110_000]) {
      appendFileSync(outcomesFile, JSON.stringify(makeOutcome(durationMs)) + "\n");
    }

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "done",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "adaptive_agent",
        task: "Use adaptive timeout.",
        parentSessionId: "parent-2",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("done");
      expect(completeMock).toHaveBeenCalledTimes(1);
      const passedSignal = completeMock.mock.calls[0]?.[2] as AbortSignal | undefined;
      expect(passedSignal).toBeUndefined();
      const startEvent = auditEvents.find(
        (event) => event.type === "sub_agent_started" && event.data.agentName === "adaptive_agent",
      );
      expect(startEvent).toBeDefined();
      expect(startEvent!.data.timeoutMs).toBeGreaterThan(60_000);
    } finally {
      unsubscribe();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("disables the turn timeout when an agent declares turnTimeoutMs: \"unbound\"", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-unbound-timeout-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        long_builder: {
          description: "Long-running builder that must not be cut off",
          systemPrompt: "Build the whole thing.",
          tools: [],
          maxIterations: 1,
          turnTimeoutMs: "unbound",
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "built",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "long_builder",
        task: "Build a large deliverable.",
        parentSessionId: "parent-unbound",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("built");
      // No internal abort signal is created when the turn timeout is unbound.
      const passedSignal = completeMock.mock.calls[0]?.[2] as AbortSignal | undefined;
      expect(passedSignal).toBeUndefined();
      // The start audit omits timeoutMs entirely (no wall-clock deadline).
      const startEvent = auditEvents.find(
        (event) => event.type === "sub_agent_started" && event.data.agentName === "long_builder",
      );
      expect(startEvent).toBeDefined();
      expect(startEvent!.data.timeoutMs).toBeUndefined();
    } finally {
      unsubscribe();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reduces computer-use agents to read-only tools for observation tasks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-computer-observe-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        computer_use_agent: {
          description: "Computer use agent",
          systemPrompt: "Inspect the user's desktop.",
          tools: [
            "computer_list_nodes",
            "computer_list_sessions",
            "computer_session_start",
            "computer_session_attach",
            "computer_list_windows",
            "computer_snapshot",
            "computer_capture_region",
            "computer_click",
            "computer_type",
            "computer_hotkey",
          ],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const stubToolNames = [
      "computer_list_nodes",
      "computer_list_sessions",
      "computer_session_start",
      "computer_session_attach",
      "computer_list_windows",
      "computer_snapshot",
      "computer_capture_region",
      "computer_click",
      "computer_type",
      "computer_hotkey",
    ];
    for (const toolName of stubToolNames) {
      registerTool({
        name: toolName,
        description: `Stub tool ${toolName}`,
        parameters: { type: "object", properties: {} },
        async execute() {
          return { success: true, output: `${toolName} ok` };
        },
      });
    }

    completeMock.mockImplementationOnce(async (_messages: unknown, tools: unknown) => {
      const toolNames = Array.isArray(tools)
        ? (tools as Array<{ name?: string }>).map((tool) => tool.name).filter(Boolean)
        : [];
      expect(toolNames).toContain("computer_snapshot");
      expect(toolNames).not.toContain("computer_click");
      expect(toolNames).not.toContain("computer_type");
      expect(toolNames).not.toContain("computer_hotkey");
      return {
        content: "snapshot reviewed",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "computer_use_agent",
        task: "Take a screenshot of the remote PC and describe what is visible on screen.",
        parentSessionId: "parent-observe",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("snapshot reviewed");
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      for (const toolName of stubToolNames) {
        unregisterTool(toolName);
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats maxIterationsOverride=0 as unlimited for delegated sub-agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-unlimited-iterations-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        unlimited_agent: {
          description: "Unlimited iteration test agent",
          systemPrompt: "Inspect the workspace before replying.",
          tools: ["read_file"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "read_file",
      description: "Stub read tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "workspace overview" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "read-1",
            name: "read_file",
            arguments: { path: "workspace/README.md" },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "finished after reading",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "unlimited_agent",
        task: "Review the workspace.",
        parentSessionId: "parent-unlimited",
        workspacePath: tempDir,
        maxIterationsOverride: 0,
      });

      expect(result.output).toBe("finished after reading");
      expect(result.stats.toolCount).toBe(1);
      expect(result.stats.iterations).toBe(1);
      expect(completeMock).toHaveBeenCalledTimes(2);
    } finally {
      unregisterTool("read_file");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects coordinator-style completion claims when no tool calls were executed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-hallucinated-completion-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        pentest_coordinator: {
          description: "Pentest coordinator",
          systemPrompt: "Coordinate a pentest and report results.",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph", "pentest_set_scope"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: [
        "Let me check the agent outputs directly. The task graph completed successfully, which means all phases were executed.",
        "Passive Reconnaissance - osint_agent completed",
        "Comprehensive Report Generation - report_writer_agent completed",
      ].join("\n"),
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "pentest_coordinator",
        task: "Run the pentest.",
        parentSessionId: "parent-3",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("claimed delegated work completed without executing any tool calls");
      expect(result.stats.toolCount).toBe(0);
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("injects explicit tool inventory and delegate catalog guidance for coordinator agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-coordinator-guidance-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        mission_coordinator: {
          description: "Mission coordinator",
          systemPrompt: "Coordinate the work.",
          tools: ["list_agents", "search_agents", "delegate_to_agent", "run_task_graph"],
          maxIterations: 2,
        },
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research things.",
          tools: ["read_file"],
          maxIterations: 1,
        },
        coder: {
          description: "Coding specialist",
          systemPrompt: "Write code.",
          tools: ["write_file"],
          maxIterations: 1,
        },
        browser_agent: {
          description: "Browser specialist",
          systemPrompt: "Browse pages.",
          tools: ["browser_navigate"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "Coordinator finished.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Coordinate a repo maintenance task.",
        parentSessionId: "parent-coordinator-guidance",
        workspacePath: tempDir,
        allowedAgents: ["researcher", "coder"],
      });

      expect(completeMock).toHaveBeenCalledTimes(1);
      const messages = completeMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
      const systemMessage = messages?.find((message) => message.role === "system")?.content ?? "";

      expect(systemMessage).toContain("TOOL INVENTORY");
      expect(systemMessage).toContain("You may use only these tools in this run: list_agents, search_agents, delegate_to_agent, run_task_graph");
      expect(systemMessage).toContain("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, use search_agents and then delegate_to_agent to route the work to a research-capable specialist before answering.");
      expect(systemMessage).toContain("AGENT DISCOVERY");
      expect(systemMessage).toContain("Delegation in this run is restricted to these agents: researcher, coder");
      expect(systemMessage).toContain("- researcher: Research specialist");
      expect(systemMessage).toContain("- coder: Coding specialist");
      expect(systemMessage).not.toContain("browser_agent");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rewrites source-sensitive discovery retries to delegate_to_agent after a no-match result", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-no-match-fallback-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        mission_coordinator: {
          description: "Mission coordinator",
          systemPrompt: "Coordinate source-sensitive work.",
          tools: ["search_agents", "search_workflows", "delegate_to_agent"],
          maxIterations: 3,
        },
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research from sources.",
          tools: ["read_file"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const searchAgentsMock = vi.fn(async () => ({
      success: true,
      output: 'No agents matched "electronics hardware component selection circuit design embedded systems". Do not call search_agents again for this turn. Delegate without an agentName so autonomous routing can bid on the original task.',
      metadata: { query: "electronics hardware component selection circuit design embedded systems", resultCount: 0 },
    }));
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: 'No workflows matched "hardware design electronics BOM circuit layout component selection" strongly enough. Fall back to search_agents or direct coordinator planning for this request shape.',
      metadata: { workflowMatches: [] },
    }));
    const delegateExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nGrounded component evidence.",
      metadata: {
        agentName: String(args["agentName"] ?? ""),
        attemptedAgents: [String(args["agentName"] ?? "")],
        delegationSucceeded: true,
        terminalState: "completed",
      },
    }));

    registerTool({
      name: "search_agents",
      description: "Mock search_agents",
      parameters: { type: "object", properties: {} },
      execute: searchAgentsMock,
    });
    registerTool({
      name: "search_workflows",
      description: "Mock search_workflows",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    registerTool({
      name: "delegate_to_agent",
      description: "Mock delegate_to_agent",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          {
            id: "search-1",
            name: "search_agents",
            arguments: { query: "electronics hardware component selection circuit design embedded systems" },
          },
          {
            id: "workflow-1",
            name: "search_workflows",
            arguments: { query: "hardware design electronics BOM circuit layout component selection" },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Grounded component evidence.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Use current sources to verify the exact microphone component choice and recommend a grounded PCB layout.",
        parentSessionId: "parent-no-match-fallback",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Grounded component evidence");
      expect(searchAgentsMock).toHaveBeenCalledTimes(1);
      expect(searchWorkflowsMock).not.toHaveBeenCalled();
      expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.stats.toolNames).toEqual(["search_agents", "delegate_to_agent"]);
      const delegateArgs = delegateExecuteMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(delegateArgs["agentName"]).toBe("researcher");
      expect(String(delegateArgs["taskTitle"])).toContain("Source-sensitive researcher task");
      expect(String(delegateArgs["task"])).toContain("Use current sources to verify the exact microphone component choice");
      expect(completeMock).toHaveBeenCalledTimes(2);
    } finally {
      unregisterTool("search_agents");
      unregisterTool("search_workflows");
      unregisterTool("delegate_to_agent");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses source-sensitive child task titles so fallback delegation does not collide with the running parent coordinator", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-child-task-title-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research from sources.",
          tools: [],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const summarizeForSignature = (text: string, maxLength: number): string => {
      const compact = text.replace(/\s+/g, " ").trim();
      return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
    };

    const parentTask = [
      "SOURCE-SENSITIVE DELEGATION:",
      "The user's original request below is the only canonical task.",
      "Original user request:",
      "Verify current component facts for a portable recorder.",
    ].join("\n");
    const parentTitle = summarizeForSignature(parentTask, 80);
    const parentSignature = `${parentTitle.toLowerCase()}::${summarizeForSignature(parentTask, 240).toLowerCase()}::`;
    const startedAt = new Date().toISOString();

    completeMock.mockResolvedValueOnce({
      content: "Researcher gathered verified component evidence.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      await import("../tools/sub-agent.js");
      const { getTool } = await import("../tools/registry.js");
      const delegateToAgent = getTool("delegate_to_agent");
      expect(delegateToAgent).toBeDefined();

      const result = await delegateToAgent!.execute({
        agentName: "researcher",
        task: parentTask,
        taskTitle: "Source-sensitive researcher task: fallback after agent discovery no-match",
      }, {
        sessionId: "parent-child-title",
        workspacePath: tempDir,
        swarmState: {
          objective: parentTask,
          startedAt,
          updatedAt: startedAt,
          tasks: {
            task_1: {
              id: "task_1",
              title: parentTitle,
              status: "running",
              dependsOn: [],
              signature: parentSignature,
              selectedAgent: "mission_coordinator",
              attempts: [{ agentName: "mission_coordinator", status: "running", startedAt }],
            },
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Researcher gathered verified component evidence");
      expect(result.output).not.toContain("already running via mission_coordinator");
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("caps repeated source-sensitive agent discovery after no-match fallback", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-search-agent-cap-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        mission_coordinator: {
          description: "Mission coordinator",
          systemPrompt: "Coordinate source-sensitive work.",
          tools: ["search_agents", "delegate_to_agent"],
          maxIterations: 5,
        },
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research from sources.",
          tools: [],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const searchAgentsMock = vi.fn(async () => ({
      success: true,
      output: 'No agents matched "hardware electronics component selection". Do not call search_agents again for this turn.',
      metadata: { query: "hardware electronics component selection", resultCount: 0, topResult: null, trippedAgents: ["researcher"] },
    }));
    const delegateExecuteMock = vi.fn(async () => ({
      success: true,
      output: "Task 'SOURCE-SENSITIVE DELEGATION: The user's original request below is the only canon...' is already running via mission_coordinator.",
      metadata: { inFlight: true, reused: true },
    }));

    registerTool({
      name: "search_agents",
      description: "Mock search_agents",
      parameters: { type: "object", properties: {} },
      execute: searchAgentsMock,
    });
    registerTool({
      name: "delegate_to_agent",
      description: "Mock delegate_to_agent",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "search-1",
          name: "search_agents",
          arguments: { query: "hardware electronics component selection" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "search-2",
          name: "search_agents",
          arguments: { query: "embedded systems firmware IoT" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "search-3",
          name: "search_agents",
          arguments: { query: "audio microphone PCB design" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "search-4",
          name: "search_agents",
          arguments: { query: "ESP32 embedded development firmware IoT" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "No reliable evidence was gathered before discovery exhausted its limits.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Use current sources to verify hardware component recommendations.",
        parentSessionId: "parent-search-agent-cap",
        workspacePath: tempDir,
      });

      expect(searchAgentsMock).toHaveBeenCalledTimes(2);
      expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
      const fallbackArgs = (delegateExecuteMock.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
      expect(fallbackArgs["agentName"]).toBeUndefined();
      expect(String(fallbackArgs["taskTitle"])).toContain("Source-sensitive specialist task");
      expect(result.stats.toolNames).toEqual(["search_agents", "delegate_to_agent", "search_agents", "search_agents"]);
      expect(result.output).toContain("No reliable evidence was gathered");
    } finally {
      unregisterTool("search_agents");
      unregisterTool("delegate_to_agent");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite search_agents after a workflow no-match in source-sensitive coordinator runs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-workflow-no-match-agent-search-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        mission_coordinator: {
          description: "Mission coordinator",
          systemPrompt: "Coordinate source-sensitive work.",
          tools: ["search_workflows", "search_agents", "delegate_to_agent"],
          maxIterations: 4,
        },
        researcher: {
          description: "Research specialist",
          systemPrompt: "Research from sources.",
          tools: ["read_file"],
          maxIterations: 1,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const searchWorkflowsMock = vi.fn(async () => ({
      success: true,
      output: 'No workflows matched "hardware design guide BOM component selection electronics" strongly enough. Fall back to search_agents or direct coordinator planning for this request shape.',
      metadata: { workflowMatches: [] },
    }));
    const searchAgentsMock = vi.fn(async () => ({
      success: true,
      output: 'NEXT ACTION: Call delegate_to_agent(agentName="researcher", task="<your task>") NOW. Do NOT call search_agents again.\n\nAgents matching "hardware design guide BOM" [hybrid search, 1 result(s)]:\n\n**researcher** — high confidence',
      metadata: {
        query: "hardware design guide BOM",
        routingMode: "hybrid",
        semanticConfigured: true,
        semanticAvailable: true,
        resultCount: 1,
        weakCount: 0,
        topResult: "researcher",
      },
    }));
    const delegateExecuteMock = vi.fn(async (args: Record<string, unknown>) => ({
      success: true,
      output: "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\nGrounded hardware evidence.",
      metadata: {
        agentName: String(args["agentName"] ?? ""),
        attemptedAgents: [String(args["agentName"] ?? "")],
        delegationSucceeded: true,
        terminalState: "completed",
      },
    }));

    registerTool({
      name: "search_workflows",
      description: "Mock search_workflows",
      parameters: { type: "object", properties: {} },
      execute: searchWorkflowsMock,
    });
    registerTool({
      name: "search_agents",
      description: "Mock search_agents",
      parameters: { type: "object", properties: {} },
      execute: searchAgentsMock,
    });
    registerTool({
      name: "delegate_to_agent",
      description: "Mock delegate_to_agent",
      parameters: { type: "object", properties: {} },
      execute: delegateExecuteMock,
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "workflow-no-match-1",
          name: "search_workflows",
          arguments: { query: "hardware design guide BOM component selection electronics" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "agent-search-1",
          name: "search_agents",
          arguments: { query: "hardware design guide BOM" },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "delegate-1",
          name: "delegate_to_agent",
          arguments: {
            agentName: "researcher",
            task: "Verify hardware guide facts from sources.",
          },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Grounded hardware evidence.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Use current sources to create a source-sensitive hardware design guide with verified component facts.",
        parentSessionId: "parent-workflow-no-match-agent-search",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Grounded hardware evidence");
      expect(searchWorkflowsMock).toHaveBeenCalledTimes(1);
      expect(searchAgentsMock).toHaveBeenCalledTimes(1);
      expect(delegateExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.stats.toolNames).toEqual(["search_workflows", "search_agents", "delegate_to_agent"]);
    } finally {
      unregisterTool("search_workflows");
      unregisterTool("search_agents");
      unregisterTool("delegate_to_agent");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects narrated tool-call markup when no tool calls were executed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-narrated-tool-call-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        pentest_specialist: {
          description: "Pentest specialist",
          systemPrompt: "Use tools to test the target.",
          tools: ["browser_navigate", "browser_snapshot"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: [
        "<tool_call>",
        "<function=mcp_playwright_browser_navigate>",
        "<parameter=url>",
        "https://steffen-hebestreit.com/swagger-ui.html",
        "</parameter>",
        "</function>",
        "</tool_call>",
      ].join("\n"),
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "pentest_specialist",
        task: "Open the target in the browser.",
        parentSessionId: "parent-4",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("emitted narrated tool-call text without executing any tool calls");
      expect(result.stats.toolCount).toBe(0);
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported scan-blocking claims when no tool calls were executed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-scan-blocking-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        recon_agent: {
          description: "Recon agent",
          systemPrompt: "Run recon and report blockers truthfully.",
          tools: ["nmap_scan", "pentest_exec"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValue({
      content: "I am unable to proceed with active reconnaissance due to persistent HTTP 403 Forbidden responses when attempting browser navigation and scanning.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "recon_agent",
        task: "Run reconnaissance.",
        parentSessionId: "parent-5",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("reported scan blocking or HTTP findings without executing any tool calls");
      expect(result.stats.toolCount).toBe(0);
      expect(completeMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reduces mail_agent tools for simple inbox-read tasks", async () => {
    const { getEffectiveToolNames } = await import("../agent/sub-agent.js");

    const toolNames = getEffectiveToolNames(
      "mail_agent",
      [
        "mail_list_accounts",
        "mail_list_mailboxes",
        "mail_search",
        "mail_read",
        "mail_list_unread",
        "mail_prepare_draft",
        "mail_update_draft",
        "mail_get_draft",
        "mail_categorize",
        "mail_send_draft",
        "read_shared_facts",
        "share_finding",
      ],
      "Check mal ob ich neue email bekommen habe",
    );

    expect(toolNames).toEqual([
      "mail_list_accounts",
      "mail_list_mailboxes",
      "mail_search",
      "mail_read",
      "mail_list_unread",
    ]);
  });

  it("only treats explicit unread inbox checks as deterministic unread tasks", async () => {
    const { isExplicitUnreadMailInboxTask } = await import("../agent/sub-agent.js");

    expect(isExplicitUnreadMailInboxTask("Check mal ob ich neue email bekommen habe")).toBe(true);
    expect(isExplicitUnreadMailInboxTask("Zeig mir die letzten 10 E-Mails, auch gelesen")).toBe(false);
    expect(isExplicitUnreadMailInboxTask("Suche mir alle E-Mails aus diesem Jahr aus dem Posteingang")).toBe(false);
  });

  it("completes simple inbox checks through deterministic mail tools without invoking the LLM", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-mail-deterministic-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "lmstudio/gemma-4-26b-a4b-it",
            temperature: 0.1,
            maxTokens: 1024,
          },
        },
      },
      subAgents: {
        mail_agent: {
          description: "Mail agent",
          systemPrompt: "Use mail tools first.",
          tools: [
            "mail_list_accounts",
            "mail_list_unread",
            "mail_read",
          ],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");

    registerTool({
      name: "mail_list_accounts",
      description: "List mail accounts",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "- work: user@example.com <user@example.com>",
          metadata: { accounts: [{ id: "work", address: "user@example.com" }] },
        };
      },
    });

    registerTool({
      name: "mail_list_unread",
      description: "List unread messages",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "- [work] Project Update from boss@example.com (INBOX#101 on 2026-04-03)",
          metadata: {
            messages: [{
              accountId: "work",
              mailbox: "INBOX",
              uid: 101,
              subject: "Project Update",
              from: "boss@example.com",
              date: "2026-04-03",
            }],
          },
        };
      },
    });

    registerTool({
      name: "mail_read",
      description: "Read a message",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "Project Update body",
          metadata: {
            message: {
              textBody: "Here is the latest project update with the next milestones and owners.",
            },
          },
        };
      },
    });

    completeMock.mockResolvedValue({
      content: "should not be used",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mail_agent",
        task: "Check mal ob ich neue email bekommen habe",
        parentSessionId: "parent-mail-2",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Unread messages found: 1.");
      expect(result.output).toContain("Project Update");
      expect(result.stats.toolCount).toBe(3);
      expect(completeMock).not.toHaveBeenCalled();
    } finally {
      unregisterTool("mail_list_accounts");
      unregisterTool("mail_list_unread");
      unregisterTool("mail_read");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps mail_agent in-process when defaultContainerized is enabled", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-mail-no-container-"));
    const configPath = join(tempDir, "starlingai.json");
    const runSubAgentInContainerMock = vi.fn(async () => ({
      output: "container path should not run",
      metrics: {
        containerColdStartMs: 1,
        containerBootstrapMs: 1,
        containerRuntimeMs: 1,
        heartbeatSupported: true,
      },
    }));

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaultContainerized: true,
        defaults: {
          model: {
            primary: "lmstudio/gemma-4-26b-a4b-it",
            temperature: 0.1,
            maxTokens: 1024,
          },
        },
      },
      subAgents: {
        mail_agent: {
          description: "Mail agent",
          systemPrompt: "Use mail tools first.",
          tools: [
            "mail_list_accounts",
            "mail_list_unread",
            "mail_read",
          ],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    vi.doMock("../agent/container-runner.js", () => ({
      runSubAgentInContainer: runSubAgentInContainerMock,
    }));

    const { registerTool, unregisterTool } = await import("../tools/registry.js");

    registerTool({
      name: "mail_list_accounts",
      description: "List mail accounts",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "- work: user@example.com <user@example.com>",
          metadata: { accounts: [{ id: "work", address: "user@example.com" }] },
        };
      },
    });

    registerTool({
      name: "mail_list_unread",
      description: "List unread messages",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "- [work] Project Update from boss@example.com (INBOX#101 on 2026-04-03)",
          metadata: {
            messages: [{
              accountId: "work",
              mailbox: "INBOX",
              uid: 101,
              subject: "Project Update",
              from: "boss@example.com",
              date: "2026-04-03",
            }],
          },
        };
      },
    });

    registerTool({
      name: "mail_read",
      description: "Read a message",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: "Project Update body",
          metadata: {
            message: {
              textBody: "Here is the latest project update with the next milestones and owners.",
            },
          },
        };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mail_agent",
        task: "Check mal ob ich neue email bekommen habe",
        parentSessionId: "parent-mail-containerized",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Unread messages found: 1.");
      expect(runSubAgentInContainerMock).not.toHaveBeenCalled();
    } finally {
      unregisterTool("mail_list_accounts");
      unregisterTool("mail_list_unread");
      unregisterTool("mail_read");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards computer callbacks into delegated tool execution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-computer-callbacks-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        computer_use_agent: {
          description: "Computer automation agent",
          systemPrompt: "Use the computer tools.",
          tools: ["workspace_search"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "workspace_search",
      description: "Emit synthetic computer callbacks for tests.",
      parameters: { type: "object", properties: {} },
      async execute(_args, context) {
        context.onComputerSessionState?.({ computerSessionId: "session-test", state: "active" });
        context.onComputerAction?.({ computerSessionId: "session-test", actionType: "snapshot" });
        context.onComputerScreenshot?.({
          computerSessionId: "session-test",
          dataUrl: "data:image/png;base64,AA==",
          width: 1,
          height: 1,
        });
        return { success: true, output: "callback emitted" };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call-1", name: "workspace_search", arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "done",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    const seenStates: string[] = [];
    const seenActions: string[] = [];
    const seenScreenshots: string[] = [];

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "computer_use_agent",
        task: "Emit a synthetic computer event.",
        parentSessionId: "parent-callbacks",
        workspacePath: tempDir,
        onComputerSessionState(event) {
          seenStates.push(event.state);
        },
        onComputerAction(event) {
          seenActions.push(event.actionType);
        },
        onComputerScreenshot(event) {
          seenScreenshots.push(event.dataUrl);
        },
      });

      expect(result.output).toBe("done");
      expect(seenStates).toEqual(["active"]);
      expect(seenActions).toEqual(["snapshot"]);
      expect(seenScreenshots).toEqual(["data:image/png;base64,AA=="]);
    } finally {
      unregisterTool("workspace_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates consecutive identical tool calls and returns cached result", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-dedup-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        dedup_agent: {
          description: "Dedup test agent",
          systemPrompt: "Use tools as needed.",
          tools: ["workspace_search"],
          maxIterations: 5,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    let executeCount = 0;
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "workspace_search",
      description: "A searchable tool.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      async execute() {
        executeCount++;
        return { success: true, output: "search result: found 3 items" };
      },
    });

    completeMock
      // Iteration 1: model calls workspace_search twice with identical args
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "call-1", name: "workspace_search", arguments: { query: "hello" } },
          { id: "call-2", name: "workspace_search", arguments: { query: "hello" } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // Iteration 2: model calls it AGAIN with same args
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "call-3", name: "workspace_search", arguments: { query: "hello" } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      // Iteration 3: model returns final answer
      .mockResolvedValueOnce({
        content: "Found 3 items.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "dedup_agent",
        task: "Search for things.",
        parentSessionId: "parent-dedup",
        workspacePath: tempDir,
      });

      expect(result.output).toBe("Found 3 items.");
      // The tool should only have been ACTUALLY executed once (first call).
      // The second call in iteration 1 and the call in iteration 2 should be deduped.
      expect(executeCount).toBe(1);
      // But all 3 tool calls should be counted
      expect(result.stats.toolCount).toBe(3);
    } finally {
      unregisterTool("workspace_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves failed task-graph output across identical cached retries", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-graph-failure-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        coord_agent: {
          description: "Coordinator failure preservation test agent",
          systemPrompt: "Use the task graph tool when needed.",
          tools: ["run_task_graph"],
          maxIterations: 5,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    unregisterTool("run_task_graph");
    registerTool({
      name: "run_task_graph",
      description: "Stub task graph tool for failure preservation testing.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: false,
          output: [
            "Swarm task graph complete.",
            "- evidence_mcp [completed] researcher",
            "- draft_paper [failed] paper_author",
          ].join("\n"),
        };
      },
    });

    const seenToolMessages: string[][] = [];
    completeMock.mockImplementation(async (messages: unknown) => {
      const toolMessages = Array.isArray(messages)
        ? messages
            .filter((message): message is { role?: string; content?: unknown } => typeof message === "object" && message !== null && "role" in message && (message as { role?: string }).role === "tool")
            .map((message) => String(message.content ?? ""))
        : [];
      seenToolMessages.push(toolMessages);

      if (seenToolMessages.length === 1) {
        return {
          content: "",
          tool_calls: [
            { id: "graph-1", name: "run_task_graph", arguments: { nodes: [{ id: "evidence_mcp", task: "Gather evidence" }] } },
          ],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        };
      }

      if (seenToolMessages.length === 2) {
        return {
          content: "",
          tool_calls: [
            { id: "graph-2", name: "run_task_graph", arguments: { nodes: [{ id: "evidence_mcp", task: "Gather evidence" }] } },
          ],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        };
      }

      return {
        content: "Use the existing partial graph result.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    });

    const { subscribeToAudit } = await import("../audit/logger.js");
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToAudit((event) => {
      auditEvents.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "coord_agent",
        task: "Coordinate a source-grounded paper workflow.",
        parentSessionId: "parent-graph-failure",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Use the existing partial graph result.");
      expect(seenToolMessages[1]?.[0]).toContain("Swarm task graph complete.");
      expect(seenToolMessages[1]?.[0]).not.toContain("Error: unknown");
      expect(seenToolMessages[2]?.at(-1)).toContain("Swarm task graph complete.");
      expect(seenToolMessages[2]?.at(-1)).toContain("cached failed result");

      const doneEvents = auditEvents.filter(
        (event) => event.type === "sub_agent_tool_call"
          && event.data.tool === "run_task_graph"
          && event.data.phase === "done",
      );
      expect(doneEvents).toHaveLength(2);
      expect(doneEvents[0]?.data.success).toBe(false);
      expect(doneEvents[0]?.data.resultPreview).toContain("Swarm task graph complete.");
      expect(doneEvents[1]?.data.success).toBe(false);
      expect(doneEvents[1]?.data.cachedResult).toBe(true);
      expect(doneEvents[1]?.data.resultPreview).toContain("Swarm task graph complete.");
    } finally {
      unsubscribe();
      unregisterTool("run_task_graph");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns direct ssh_exec output for simple shell remote tasks without letting the model overwrite it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-direct-remote-cli-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        shell_agent: {
          description: "Shell and SSH specialist",
          systemPrompt: "Run direct remote commands.",
          tools: ["ssh_exec"],
          maxIterations: 3,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "ssh_exec",
      description: "Execute SSH command",
      parameters: { type: "object", properties: { nodeName: { type: "string" }, command: { type: "string" } } },
      async execute() {
        return {
          success: true,
          output: [
            "CONTAINER ID   IMAGE                    COMMAND                  CREATED       STATUS       PORTS                                           NAMES",
            "661979c7e8af   steffen-n8n              \"tini -- /docker-ent…\"   2 weeks ago   Up 12 days   0.0.0.0:80->80/tcp, [::]:80->80/tcp, 5678/tcp   steffen-n8n-1",
            "2ba1788eef7a   ankane/pgvector:latest   \"docker-entrypoint.s…\"   2 weeks ago   Up 12 days   0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp     steffen-postgres-1",
          ].join("\n"),
        };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [
          { id: "ssh-1", name: "ssh_exec", arguments: { nodeName: "n8n-server", command: "docker ps" } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Die Ausfuehrung des Befehls docker ps ist fehlgeschlagen. Moegliche Ursachen ...",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "shell_agent",
        task: "Pruefe, welche Docker-Container auf dem n8n-Server laufen. Fuehre den Befehl docker ps aus.",
        parentSessionId: "parent-direct-remote-cli",
        workspacePath: tempDir,
        approvalCallback: async () => true,
      });

      expect(result.output).toContain("steffen-n8n-1");
      expect(result.output).toContain("steffen-postgres-1");
      expect(result.output).not.toContain("fehlgeschlagen");
      expect(completeMock).toHaveBeenCalledTimes(1);
      expect(result.stats.outcome).toBe("success");
      expect(result.stats.toolCount).toBe(1);
    } finally {
      unregisterTool("ssh_exec");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps boilerplate tool results in history so every tool_use id stays answered (audit f0143008)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sub-boilerplate-result-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        facts_agent: {
          description: "Boilerplate tool-result regression agent",
          systemPrompt: "Check shared facts, then answer.",
          tools: ["read_shared_facts"],
          maxIterations: 3,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "read_shared_facts",
      description: "Returns the no-facts boilerplate that used to be dropped from history",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "No shared facts available yet for this session." };
      },
    });

    completeMock
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "facts-1", name: "read_shared_facts", arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Final answer after checking facts.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "facts_agent",
        task: "Answer using shared facts.",
        parentSessionId: "parent-boilerplate-result",
        workspacePath: tempDir,
      });

      expect(result.output).toContain("Final answer after checking facts.");
      expect(completeMock).toHaveBeenCalledTimes(2);
      // The second LLM call's history MUST contain a tool message answering
      // facts-1. Before the fix, the boilerplate classifier `continue`d past
      // the toolResults.push, the result vanished from history, and the
      // strict Anthropic API rejected the whole next request with a 400.
      const secondCallMessages = completeMock.mock.calls[1]![0] as Array<{
        role: string; content: unknown; tool_call_id?: string;
      }>;
      const toolMessage = secondCallMessages.find((m) => m.role === "tool" && m.tool_call_id === "facts-1");
      expect(toolMessage).toBeDefined();
      expect(String(toolMessage!.content)).toContain("No shared facts available yet");
    } finally {
      unregisterTool("read_shared_facts");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);
});