import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentIndex,
  buildAgentSearchDocument,
  inferAgentSearchKeywords,
  resetEmbeddingSearchStateForTests,
  scoreAgentKeywordMatch,
  searchByEmbedding,
} from "../providers/embeddings.js";
import { isCircuitOpen } from "../tools/sub-agent.js";
import type { OutcomeEntry } from "../agent/outcomes.js";

describe("agent search helpers", () => {
  afterEach(() => {
    resetEmbeddingSearchStateForTests();
  });

  it("indexes tool and prompt context for semantic search", () => {
    const document = buildAgentSearchDocument("browser_agent", {
      description: "Automates browser logins and form submissions.",
      capabilities: ["browser automation", "login flows"],
      tags: ["browser"],
      systemPrompt: "Use stored credentials, inspect the page, then fill the login form.",
      tools: ["get_site_credentials", "mcp__playwright__browser_click", "mcp__playwright__browser_type"],
      maxIterations: 6,
    });

    expect(document).toContain("Tools: get_site_credentials");
    expect(document).toContain("Capabilities:");
    expect(document).toContain("Prompt: Use stored credentials");
  });

  it("infers capability keywords from tool grants", () => {
    const keywords = inferAgentSearchKeywords("browser_agent", {
      description: "Automates browser logins and form submissions.",
      capabilities: [],
      tags: [],
      tools: ["get_site_credentials", "site_fill_credentials", "mcp__playwright__browser_click", "mcp__playwright__browser_type"],
      maxIterations: 6,
    });

    expect(keywords).toContain("login");
    expect(keywords).toContain("browser");
    expect(keywords).toContain("forms");
  });

  it("adds secure credential typing keywords for desktop login specialists", () => {
    const keywords = inferAgentSearchKeywords("computer_use_agent", {
      description: "Controls desktop login flows.",
      capabilities: [],
      tags: [],
      tools: ["computer_type_credential"],
      maxIterations: 6,
    });

    expect(keywords).toContain("credentials");
    expect(keywords).toContain("desktop");
    expect(keywords).toContain("login");
  });

  it("ranks capability matches ahead of generic description matches", () => {
    const browserScore = scoreAgentKeywordMatch("login form automation", "browser_agent", {
      description: "Automates browser logins and form submissions.",
      capabilities: [],
      tags: [],
      systemPrompt: "Inspect the page, then fill the login form and submit it.",
      tools: ["get_site_credentials", "mcp__playwright__browser_click", "mcp__playwright__browser_type"],
      maxIterations: 6,
    });
    const researcherScore = scoreAgentKeywordMatch("login form automation", "researcher", {
      description: "Finds facts on the web and summarizes them.",
      capabilities: [],
      tags: [],
      systemPrompt: "Use search to gather sources.",
      tools: ["web_search", "web_fetch"],
      maxIterations: 4,
    });

    expect(browserScore.score).toBeGreaterThan(researcherScore.score);
    expect(browserScore.matchedTerms).toContain("login");
  });

  it("caches repeated embedding queries until the agent index changes", async () => {
    const embedMock = vi.fn(async (texts: string[]) => {
      if (texts.every((text) => text.startsWith("Agent:"))) {
        return [
          new Float32Array([1, 0]),
          new Float32Array([0, 1]),
        ];
      }

      return [new Float32Array([1, 0])];
    });

    const provider = { embed: embedMock } as unknown as import("../providers/lmstudio.js").LMStudioProvider;
    const initialAgents = {
      browser_agent: {
        description: "Automates browser logins and form submissions.",
        capabilities: ["browser automation"],
        tags: ["browser"],
        tools: ["get_site_credentials", "mcp__playwright__browser_click"],
        maxIterations: 6,
      },
      researcher: {
        description: "Finds facts on the web and summarizes them.",
        capabilities: ["research"],
        tags: ["research"],
        tools: ["web_search"],
        maxIterations: 4,
      },
    };

    await buildAgentIndex(initialAgents, provider, "lmstudio/qwen-embed");

    const first = await searchByEmbedding("login forms", provider, 5);
    const second = await searchByEmbedding("login forms", provider, 5);

    expect(first[0]?.agentName).toBe("browser_agent");
    expect(second[0]?.agentName).toBe("browser_agent");
    expect(embedMock).toHaveBeenCalledTimes(2);

    const updatedAgents = {
      browser_agent: initialAgents.browser_agent,
      writer: {
        description: "Drafts polished written responses.",
        capabilities: ["writing"],
        tags: ["writing"],
        tools: ["write_file"],
        maxIterations: 3,
      },
    };

    await buildAgentIndex(updatedAgents, provider, "lmstudio/qwen-embed");
    await searchByEmbedding("login forms", provider, 5);

    expect(embedMock).toHaveBeenCalledTimes(4);
  });
});

describe("search_agents tool", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("returns the best capability match for keyword queries", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agent-search-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      subAgents: {
        researcher: {
          description: "Finds facts on the web and summarizes them.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
        browser_agent: {
          description: "Logs into sites and automates forms in the browser.",
          systemPrompt: "Use stored credentials, inspect the page, and fill the login form.",
          tools: ["get_site_credentials", "mcp__playwright__browser_click", "mcp__playwright__browser_type"],
          maxIterations: 6,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }, { resolveAgentRouting }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    try {
      const searchAgents = getTool("search_agents");
      expect(searchAgents).toBeDefined();

      const result = await searchAgents!.execute(
        { query: "login form automation" },
        { sessionId: "test-session", workspacePath: "/workspace" }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("browser_agent");
      const firstAgentLine = result.output
        .split("\n")
        .find(line => line.startsWith("**"));
      expect(firstAgentLine).toContain("browser_agent");
      expect(result.output).toContain("Confidence:");
      expect(result.output).toContain("Matches: login");

      const gated = await searchAgents!.execute(
        { query: "login taxonomy regulatory", minConfidence: "high" },
        { sessionId: "test-session", workspacePath: "/workspace" }
      );

      expect(gated.success).toBe(true);
      expect(gated.output).toContain("No agents matched");
      expect(gated.output).toContain("minConfidence=low");
      expect(gated.output).toContain("Top weak candidates");

      const resolution = await resolveAgentRouting("login form automation", { minConfidence: "medium" });
      expect(resolution.mode === "keyword" || resolution.mode === "hybrid").toBe(true);
      expect(resolution.results[0]).toMatchObject({
        name: "browser_agent",
        confidence: "high",
      });
      expect(resolution.results[0]?.capabilities).toEqual([]);

      const gatedResolution = await resolveAgentRouting("login taxonomy regulatory", { minConfidence: "high" });
      expect(gatedResolution.results).toHaveLength(0);
      expect(gatedResolution.weakCandidates[0]?.name).toBe("browser_agent");
      expect(gatedResolution.gated).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("keeps documentation research away from communication-only agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-agent-search-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      subAgents: {
        researcher: {
          description: "Finds official documentation and public technical references on the web.",
          capabilities: ["web research", "documentation lookup"],
          tags: ["research", "docs"],
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        },
        email_drafter: {
          description: "Drafts polished emails and platform messages.",
          capabilities: ["email drafting", "business communication"],
          tags: ["writing", "email"],
          tools: ["read_file", "write_file"],
          maxIterations: 3,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ resolveAgentRouting }] = await Promise.all([
      import("../tools/sub-agent.js"),
    ]);

    try {
      const resolution = await resolveAgentRouting("Find official MCP specification and A2A design principles", { minConfidence: "medium" });
      expect(resolution.results[0]?.name).toBe("researcher");
      expect(resolution.results.find((candidate) => candidate.name === "email_drafter")).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});

describe("circuit breaker", () => {
  it("does not trip with fewer than 3 samples", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-circuit-"));
    try {
      const dir = join(tempDir, ".starlingai");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "agent_outcomes.ndjson");
      const entry = (outcome: "success" | "failure"): OutcomeEntry => ({
        ts: new Date().toISOString(), agent: "researcher", task: "t",
        outcome, iterations: 1, totalTokens: 100,
      });
      appendFileSync(file, JSON.stringify(entry("failure")) + "\n");
      appendFileSync(file, JSON.stringify(entry("failure")) + "\n");
      // only 2 samples — should not trip
      expect(isCircuitOpen("researcher", tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("trips when failure rate exceeds 60% over last 10 calls", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-circuit-"));
    try {
      const dir = join(tempDir, ".starlingai");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "agent_outcomes.ndjson");
      const entry = (outcome: "success" | "failure"): OutcomeEntry => ({
        ts: new Date().toISOString(), agent: "researcher", task: "t",
        outcome, iterations: 1, totalTokens: 100,
      });
      // 7 failures, 3 successes = 70% failure rate — should trip
      for (let i = 0; i < 7; i++) appendFileSync(file, JSON.stringify(entry("failure")) + "\n");
      for (let i = 0; i < 3; i++) appendFileSync(file, JSON.stringify(entry("success")) + "\n");
      expect(isCircuitOpen("researcher", tempDir)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not trip at exactly 60% failures (must exceed threshold)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-circuit-"));
    try {
      const dir = join(tempDir, ".starlingai");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "agent_outcomes.ndjson");
      const entry = (outcome: "success" | "failure"): OutcomeEntry => ({
        ts: new Date().toISOString(), agent: "researcher", task: "t",
        outcome, iterations: 1, totalTokens: 100,
      });
      // exactly 60% failure = threshold, not exceeded
      for (let i = 0; i < 3; i++) appendFileSync(file, JSON.stringify(entry("failure")) + "\n");
      for (let i = 0; i < 2; i++) appendFileSync(file, JSON.stringify(entry("success")) + "\n");
      expect(isCircuitOpen("researcher", tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("only looks at the last 10 outcomes for an agent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-circuit-"));
    try {
      const dir = join(tempDir, ".starlingai");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "agent_outcomes.ndjson");
      const entry = (outcome: "success" | "failure", agent = "researcher"): OutcomeEntry => ({
        ts: new Date().toISOString(), agent, task: "t",
        outcome, iterations: 1, totalTokens: 100,
      });
      // 20 old failures — but the last 10 are successes — should NOT trip
      for (let i = 0; i < 20; i++) appendFileSync(file, JSON.stringify(entry("failure")) + "\n");
      for (let i = 0; i < 10; i++) appendFileSync(file, JSON.stringify(entry("success")) + "\n");
      expect(isCircuitOpen("researcher", tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});