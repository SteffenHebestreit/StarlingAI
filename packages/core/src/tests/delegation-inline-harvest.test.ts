import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

// Delegation-boundary inline-app harvest (audit 1ac79471): browser_agent "won" a build
// delegation, its completion cap cut the write_file call, and it returned the COMPLETE
// 14KB app as fenced HTML in its result text with zero artifacts. The delegation was
// classified success, nobody saved the document, and the turn went on to two more failed
// builds. The harvest writes the inline document at the delegation boundary so the
// deliverable survives no matter which agent produced it.

const runSubAgentMock = vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`);
const INLINE_APP =
  "<!DOCTYPE html>\n<html lang=\"de\">\n<head><title>Trainer</title><style>.q{padding:2px}</style></head>\n<body>"
  + "<div class=\"q\">Frage zur Prüfung</div>\n".repeat(60)
  + "<script>let i=0;</script>\n</body>\n</html>";

const buildStats = (args: SubAgentRunOptions, toolNames: string[]) => ({
  agentName: args.agentName,
  sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
  promptChars: 0,
  userContentChars: String(args.task ?? "").length,
  toolCount: toolNames.length,
  toolNames,
  iterations: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 5,
  model: "mock",
  capabilities: [],
  terminalState: "completed" as const,
  outcome: "success" as const,
});

const runSubAgentWithStatsMock = vi.fn(
  async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
    output: `Ich konnte die Datei nicht schreiben. Hier ist die vollständige App:\n\n\`\`\`html\n${INLINE_APP}\n\`\`\``,
    stats: buildStats(args, ["read_shared_facts"]),
  }),
);

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

describe("delegation-boundary inline-app harvest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-deleg-harvest-"));
    runSubAgentMock.mockClear();
    runSubAgentWithStatsMock.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes the inline HTML document as a real artifact when a build delegation returns none", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
      import("../tools/filesystem.js"), // registers the real write_file used by the harvest
    ]);
    const delegate = getTool("delegate_to_agent");

    const result = await delegate!.execute(
      { agentName: "web_coder", task: "Erstelle eine interaktive Lern-WebApp als einzelne HTML-Datei mit Quiz." },
      { sessionId: "session-deleg-harvest", workspacePath: tempDir, swarmState: freshSwarmState() },
    );

    expect(result.success).toBe(true);
    // The document was physically written into the working zone …
    expect(existsSync(join(tempDir, "generated", "app", "index.html"))).toBe(true);
    // … surfaced as a delegation artifact …
    const artifacts = result.metadata?.["artifacts"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts!.some((a) => a["outputPath"] === "generated/app/index.html")).toBe(true);
    // … and the result text tells the orchestrator the file now exists.
    expect(result.output).toContain("[INLINE DOCUMENT HARVESTED]");
  }, 30_000);

  it("does not harvest from a prose result without an inline document", async () => {
    runSubAgentWithStatsMock.mockImplementationOnce(
      async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
        output: "Recherche-Ergebnis: Die Prüfung umfasst ca. 40 Fragen (Quelle: isaqb.org). " + "Weitere Details folgen. ".repeat(80),
        stats: buildStats(args, ["web_search"]),
      }),
    );
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
      import("../tools/filesystem.js"),
    ]);
    const delegate = getTool("delegate_to_agent");

    const result = await delegate!.execute(
      { agentName: "researcher", task: "Erstelle eine Übersicht der Prüfungsfakten." },
      { sessionId: "session-deleg-no-harvest", workspacePath: tempDir, swarmState: freshSwarmState() },
    );

    expect(result.success).toBe(true);
    expect(existsSync(join(tempDir, "generated", "app", "index.html"))).toBe(false);
    expect(result.output).not.toContain("[INLINE DOCUMENT HARVESTED]");
  }, 30_000);
});
