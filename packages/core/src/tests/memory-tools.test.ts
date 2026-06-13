import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome } from "../agent/outcomes.js";
import { readAllFacts, resetSharedMemoryForTests, writeSharedFact } from "../swarm/memory.js";

describe("memory tools", () => {
  const dirs: string[] = [];

  beforeAll(async () => {
    await import("../tools/memory.js");
  });

  afterEach(async () => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    await resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches across workspace and session memory through memory_search", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    const { executeTool } = await import("../tools/registry.js");
    await executeTool("memory_store", {
      key: "project_focus",
      content: "Optimize retrieval precision before adding more memory volume.",
      kind: "decision",
      tags: ["memory", "quality"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });
    await writeSharedFact("parent-session", "active_focus", "Optimize retrieval precision in this session.");

    const result = await executeTool("memory_search", {
      query: "retrieval precision",
      scopes: ["workspace", "session"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[workspace/decision]");
    expect(result.output).toContain("[session/fact]");
  });

  it("surfaces agent lessons through memory_search when filtering agent scope", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    appendOutcome(workspacePath, {
      ts: "2026-04-01T12:00:00.000Z",
      agent: "browser_agent",
      task: "Avoid browser loops",
      outcome: "success",
      iterations: 2,
      totalTokens: 800,
      lesson: "Stop retrying when the page state is stable and the needed evidence is already visible.",
    });

    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("memory_search", {
      query: "browser loops",
      scopes: ["agent"],
      targetAgent: "browser_agent",
      kinds: ["lesson"],
    }, {
      sessionId: "sub:parent-session:planner:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[agent/lesson]");
    expect(result.output).toContain("browser loops");
  });

  it("promotes session memory into durable workspace memory through memory_promote", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    await writeSharedFact("parent-session", "meeting_notes", "Summarize and keep only the action items.");

    const { executeTool } = await import("../tools/registry.js");
    const promoteResult = await executeTool("memory_promote", {
      query: "action items",
      scopes: ["session"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(promoteResult.success).toBe(true);
    expect(promoteResult.output).toContain("Workspace memory promotion completed");

    const searchResult = await executeTool("memory_search", {
      query: "action items",
      scopes: ["workspace"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[workspace/fact]");
  });

  // Regression: in a 2-level swarm (main → coordinator → researcher),
  // share_finding from the researcher silently wrote to bucket `sub:sub`
  // while the main assistant looked under the root UUID. The fix derives
  // all sub/sub-sub session IDs back to the same root bucket so cross-agent
  // fact propagation works at any depth.
  it("propagates share_finding facts from a 2-level nested sub-agent to the root session bucket", async () => {
    const { executeTool } = await import("../tools/registry.js");

    // Researcher running 2 levels deep — under mission_coordinator inside
    // the user's b4fba9c4 turn.
    const nestedSessionId =
      "sub:sub:b4fba9c4-ab15-4ae3-a0b6-f39b9df5d317:mission_coordinator:1777925176190:researcher:1777925221848";

    await executeTool("share_finding", {
      key: "nested_research_fact_correction",
      value: "The nested researcher found the corrected source-backed fact for the requested component.",
      claim: "Nested researcher source-backed correction.",
      sourceTitle: "Official Component Datasheet",
      sourceUrl: "https://example.test/component-datasheet.pdf",
      publisher: "Example Components",
      evidenceType: "primary",
      accuracyScore: 0.95,
      trustworthinessScore: 0.98,
    }, {
      sessionId: nestedSessionId,
      workspacePath: "/workspace",
    });

    // The fact must land under the ROOT bucket (b4fba9c4-...), not under
    // `sub:sub` or any other intermediate scope.  The main assistant runs
    // under that root and reads from there.
    const rootFacts = await readAllFacts("b4fba9c4-ab15-4ae3-a0b6-f39b9df5d317");
    expect(rootFacts["nested_research_fact_correction"]).toContain("corrected source-backed fact");

    // Negative checks: the broken old derivation would have written under
    // `sub:sub`.  Make sure we don't double-write or leak there.
    const subSubFacts = await readAllFacts("sub:sub");
    expect(subSubFacts["nested_research_fact_correction"]).toBeUndefined();
  });

  it("stores source metadata and validation scores through share_finding", async () => {
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("share_finding", {
      key: "mcp_origin_fact",
      value: "Anthropic introduced the Model Context Protocol.",
      claim: "Anthropic introduced the Model Context Protocol.",
      sourceTitle: "Introducing the Model Context Protocol",
      sourceUrl: "https://www.anthropic.com/news/model-context-protocol",
      publisher: "Anthropic",
      publishedAt: "2024-11-25",
      retrievedAt: "2026-04-11",
      evidenceType: "official",
      accuracyScore: 1,
      trustworthinessScore: 1,
      corroborationScore: 0.9,
      validationStatus: "validated",
      notes: "Official announcement source",
    }, {
      sessionId: "sub:parent-session:researcher:1",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);

    const facts = await readAllFacts("parent-session");
    expect(facts["mcp_origin_fact"]).toContain("Anthropic introduced the Model Context Protocol.");
    expect(facts["mcp_origin_fact"]).toContain("source_title: Introducing the Model Context Protocol");
    expect(facts["mcp_origin_fact"]).toContain("source_url: https://www.anthropic.com/news/model-context-protocol");
    expect(facts["mcp_origin_fact"]).toContain("validation_status: validated");
    expect(facts["mcp_origin_fact"]).toContain("trustworthiness_score: 1");
  });

  it("requires full provenance and scores through share_evidence", async () => {
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("share_evidence", {
      key: "mcp_origin_validated",
      value: "Anthropic introduced the Model Context Protocol.",
      claim: "Anthropic introduced the Model Context Protocol.",
      sourceTitle: "Introducing the Model Context Protocol",
      sourceUrl: "https://www.anthropic.com/news/model-context-protocol",
      publisher: "Anthropic",
      publishedAt: "2024-11-25",
      retrievedAt: "2026-04-11",
      evidenceType: "official",
      accuracyScore: 1,
      trustworthinessScore: 1,
      corroborationScore: 0.9,
      validationStatus: "validated",
      notes: "Official announcement source",
    }, {
      sessionId: "sub:parent-session:researcher:1",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);

    const facts = await readAllFacts("parent-session");
    expect(facts["mcp_origin_validated"]).toContain("record_type: evidence");
    expect(facts["mcp_origin_validated"]).toContain("source_title: Introducing the Model Context Protocol");
    expect(facts["mcp_origin_validated"]).toContain("validation_status: validated");
  });

  it("exports a validated evidence ledger artifact and publishes its path", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-evidence-ledger-"));
    dirs.push(workspacePath);

    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("export_evidence_ledger", {
      title: "MCP Validation Ledger",
      format: "json",
      output_file: "artifacts/reports/mcp-validation-ledger.json",
      entries: [
        {
          key: "mcp_origin_validated",
          finding: "Anthropic introduced the Model Context Protocol.",
          claim: "Anthropic introduced the Model Context Protocol.",
          sourceTitle: "Introducing the Model Context Protocol",
          sourceUrl: "https://www.anthropic.com/news/model-context-protocol",
          publisher: "Anthropic",
          publishedAt: "2024-11-25",
          retrievedAt: "2026-04-11",
          evidenceType: "official",
          accuracyScore: 1,
          trustworthinessScore: 1,
          corroborationScore: 0.9,
          validationStatus: "validated",
          notes: "Official announcement source",
        },
      ],
    }, {
      sessionId: "sub:parent-session:source_verifier:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      artifactKind: "evidence_ledger",
      outputPath: "artifacts/reports/mcp-validation-ledger.json",
      format: "json",
      entryCount: 1,
    });

    const ledgerPath = join(workspacePath, "artifacts", "reports", "mcp-validation-ledger.json");
    expect(existsSync(ledgerPath)).toBe(true);

    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: Array<{ key: string; validationStatus: string }> };
    expect(ledger.entries[0]).toMatchObject({
      key: "mcp_origin_validated",
      validationStatus: "validated",
    });

    const facts = await readAllFacts("parent-session");
    expect(facts["validated_evidence_ledger_path"]).toBe("artifacts/reports/mcp-validation-ledger.json");
    expect(facts["validated_evidence_ledger_format"]).toBe("json");
  });

  it("compacts paraphrased durable memory through memory_compact", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    dirs.push(workspacePath);

    const { executeTool } = await import("../tools/registry.js");
    await executeTool("memory_store", {
      key: "quality_summary",
      subject: "Quality goal",
      content: "Prefer retrieval precision over raw memory volume.",
      kind: "summary",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });
    await executeTool("memory_store", {
      key: "quality_detail",
      subject: "Quality goal",
      content: "Keep durable memory focused on retrieval precision instead of accumulating every temporary note.",
      kind: "decision",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    const result = await executeTool("memory_compact", {}, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Removed: 1");

    const searchResult = await executeTool("memory_search", {
      query: "temporary note",
      scopes: ["workspace"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[workspace/decision]");
    expect(searchResult.output).toContain("retrieval precision");
  });

  it("stores and searches user-global memory through memory_store and memory_search", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-tools-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    const { executeTool } = await import("../tools/registry.js");
    const storeResult = await executeTool("memory_store", {
      key: "response_style",
      subject: "Response style",
      content: "Prefer terse answers unless the user explicitly asks for depth.",
      kind: "preference",
      scope: "user",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
      userId: "test-user",
    });

    expect(storeResult.success).toBe(true);
    expect(storeResult.output).toContain("User memory stored");

    const searchResult = await executeTool("memory_search", {
      query: "terse answers",
      scopes: ["user"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[user/preference]");
  });

  it("downgrades a user-scope memory_store to workspace when no user is logged in (token mode)", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-tools-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    const { executeTool } = await import("../tools/registry.js");
    // No userId in the tool context — gateway-token session without login.
    const storeResult = await executeTool("memory_store", {
      key: "preferred_assistant_name",
      subject: "Preferred assistant name",
      content: "The user prefers to call the assistant 'Luna'.",
      kind: "preference",
      scope: "user",
    }, {
      sessionId: "token-session",
      workspacePath,
    });

    expect(storeResult.success).toBe(true);
    expect(storeResult.output).toContain("Workspace memory stored");
    expect(storeResult.output).toContain("no authenticated user");
    expect(storeResult.metadata?.["scope"]).toBe("workspace");
    expect(storeResult.metadata?.["requestedScope"]).toBe("user");

    // Nothing may land in the user-global store.
    const userSearch = await executeTool("memory_search", {
      query: "Luna",
      scopes: ["user"],
    }, { sessionId: "token-session", workspacePath });
    expect(userSearch.output).not.toContain("[user/preference]");

    // The record is retrievable from workspace scope instead.
    const workspaceSearch = await executeTool("memory_search", {
      query: "Luna",
      scopes: ["workspace"],
    }, { sessionId: "token-session", workspacePath });
    expect(workspaceSearch.output).toContain("[workspace/preference]");
  });

  it("promotes workspace memory into user-global memory through memory_promote", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-tools-"));
    const userMemoryPath = mkdtempSync(join(tmpdir(), "starlingai-user-memory-tools-"));
    dirs.push(workspacePath, userMemoryPath);
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryPath;

    const { executeTool } = await import("../tools/registry.js");
    await executeTool("memory_store", {
      key: "writing_style",
      subject: "Writing style",
      content: "The user prefers concise answers with direct next steps.",
      kind: "preference",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    const promoteResult = await executeTool("memory_promote", {
      query: "concise answers",
      scopes: ["workspace"],
      destinationScope: "user",
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
      userId: "test-user",
    });

    expect(promoteResult.success).toBe(true);
    expect(promoteResult.output).toContain("User memory promotion completed");

    const searchResult = await executeTool("memory_search", {
      query: "concise answers",
      scopes: ["user"],
    }, {
      sessionId: "sub:parent-session:productivity_agent:1",
      workspacePath,
    });

    expect(searchResult.success).toBe(true);
    expect(searchResult.output).toContain("[user/preference]");
  });

  it("rejects near-duplicate share_finding when token overlap ≥85%", async () => {
    const { executeTool } = await import("../tools/registry.js");

    // Write first finding
    const first = await executeTool("share_finding", {
      key: "headline_bbc",
      value: "BBC: UK economy grows for second consecutive quarter, beating analyst expectations.",
    }, { sessionId: "sub:dedup-sess:researcher:1", workspacePath: "" });
    expect(first.success).toBe(true);
    expect(first.metadata?.["deduplicated"]).toBeUndefined();

    // Write near-duplicate (same tokens, different key)
    const second = await executeTool("share_finding", {
      key: "headline_bbc_copy",
      value: "BBC: UK economy grows for second consecutive quarter, beating analyst expectations.",
    }, { sessionId: "sub:dedup-sess:researcher:1", workspacePath: "" });
    expect(second.success).toBe(true);
    expect(second.metadata?.["deduplicated"]).toBe(true);
    expect(second.output).toContain("similar to existing fact");
  });

  it("allows share_finding when values are sufficiently different", async () => {
    const { executeTool } = await import("../tools/registry.js");

    await executeTool("share_finding", {
      key: "headline_weather",
      value: "Sunny skies expected in Berlin throughout the week.",
    }, { sessionId: "sub:dedup-sess2:researcher:1", workspacePath: "" });

    const second = await executeTool("share_finding", {
      key: "headline_stocks",
      value: "DAX index closes up 1.4% driven by technology gains.",
    }, { sessionId: "sub:dedup-sess2:researcher:1", workspacePath: "" });
    expect(second.success).toBe(true);
    expect(second.metadata?.["deduplicated"]).toBeUndefined();
  });

  it("always allows overwriting the same key via share_finding", async () => {
    const { executeTool } = await import("../tools/registry.js");

    await executeTool("share_finding", {
      key: "current_price",
      value: "Apple stock: $195.00",
    }, { sessionId: "sub:dedup-sess3:researcher:1", workspacePath: "" });

    const update = await executeTool("share_finding", {
      key: "current_price",
      value: "Apple stock: $195.00",
    }, { sessionId: "sub:dedup-sess3:researcher:1", workspacePath: "" });
    expect(update.success).toBe(true);
    // Same key → no dedup rejection (overwrite is expected)
    expect(update.metadata?.["deduplicated"]).toBeUndefined();
  });
});