import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

const completeMock = vi.fn();
const audit = vi.hoisted(() => vi.fn());

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (...args: Parameters<typeof actual.logAudit>) => { audit(...args); return actual.logAudit(...args); },
  };
});

/**
 * AN AGENT THAT ONLY READS THE OPEN BROWSER TAB, WHICH SHOWED NO PAGE, READ NOTHING.
 *
 * E2E 2026-10-10 (71d42257): vision_browser_analyst, which can view the shared tab but not open a
 * page, was handed "Besuche die Website …" with browser_agent and researcher queued behind it. It
 * snapshotted about:blank five times, described "a blue header with logo and navigation" it never
 * saw, and ended as a success, so the agents behind it never ran. The tab-reader rule of the
 * research gate holds such a step only on a turn the up-front judge flagged; this holds on any turn.
 */
type Message = { role: string; content?: string | null };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;
const systemIncludes = (messages: Message[], marker: string) =>
  messages.some((m) => m.role === "system" && String(m.content ?? "").includes(marker));

const label = (mode: string, input: string) =>
  ({ mode, domain: ["software"], riskTier: "read_only", executionShape: "single_agent", surface: ["browser"], inputModality: [input] });

const SITE = "http://www.nordlicht-werkzeuge.test/";
const TASK = `Besuche die Website ${SITE} und ermittle Gründungsjahr und Mitarbeiterzahl.`;
/** A Playwright MCP snapshot answer, as the shared tab gives it. */
const snapshotOf = (pageUrl: string, yaml: string) => `### Page\n- Page URL: ${pageUrl}\n- Page Title: \n### Snapshot\n\`\`\`yaml\n${yaml}\`\`\``;
const BLANK = snapshotOf("about:blank", "");
const SITE_PAGE = snapshotOf(SITE, "- heading \"Nordlicht Werkzeuge GmbH\" [level=1] [ref=e2]\n- paragraph [ref=e3]: Gegründet 1987, heute 146 Mitarbeiter.\n");
/** The tab reader's account of 71d42257: a page it never saw, long enough to pass for evidence. */
const INVENTED = "Die Website der Nordlicht Werkzeuge GmbH zeigt einen blauen Header mit Logo und Navigation. "
  + "Darunter befindet sich ein Bereich mit Produktkategorien und ein Kontaktformular. Gründungsjahr: nicht ermittelt. "
  + "Mitarbeiterzahl: nicht ermittelt. Die Seite wirkt modern und übersichtlich gestaltet.";

describe("an agent that only reads the open browser tab", () => {
  let tempDir = "";
  /** The page the shared tab shows; browser_navigate moves it. */
  let tab = BLANK;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-blank-tab-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      subAgents: {
        vision_browser_analyst: {
          description: "Reads the page the shared browser tab shows.",
          systemPrompt: "TABREADER-Q1 Describe the page in the browser.",
          tools: ["browser_snapshot", "browser_screenshot"],
          maxIterations: 4,
          routingGenerated: label("GATHER", "image"),
        },
        browser_agent: {
          description: "Opens pages in the shared browser and reads them.",
          systemPrompt: "DRIVER-Q2 Open the page and read it.",
          tools: ["browser_navigate", "browser_snapshot"],
          maxIterations: 4,
          routingGenerated: label("ACT", "url"),
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    tab = BLANK;
    audit.mockClear();
    completeMock.mockImplementation(async (messages: Message[]) => {
      const done = toolResultsIn(messages);
      if (systemIncludes(messages, "TABREADER-Q1")) {
        return done === 0 ? call("s1", "browser_snapshot", {}) : answer(tab === BLANK ? INVENTED : "Gründungsjahr 1987, 146 Mitarbeiter (laut Startseite).");
      }
      if (done === 0) return call("n1", "browser_navigate", { url: SITE });
      const opened = messages.some((m) => m.role === "tool" && String(m.content ?? "").includes("Gegründet 1987"));
      return answer(opened ? "Gründungsjahr 1987, 146 Mitarbeiter (laut Startseite)." : "Die Seite konnte nicht geöffnet werden.");
    });
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Registered after tools/sub-agent.js and the gateway's own browser tools, so these handlers are the ones that run. */
  const registerBrowser = async () => {
    await import("../tools/sub-agent.js");
    await import("../tools/multimodal.js");
    const { registerTool } = await import("../tools/registry.js");
    registerTool({
      name: "browser_snapshot",
      description: "Snapshot the open tab.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: tab };
      },
    });
    registerTool({
      name: "browser_navigate",
      description: "Open a page.",
      parameters: { type: "object", properties: {} },
      async execute() {
        tab = SITE_PAGE;
        return { success: true, output: tab };
      },
    });
    return (await import("../tools/registry.js")).getTool("delegate_to_agent")!;
  };
  const ctxFor = (sessionId: string): ToolContext => ({
    sessionId,
    workspacePath: tempDir,
    swarmState: { objective: "t", startedAt: "", updatedAt: "", tasks: {} },
  });
  const rows = (type: string): Array<Record<string, unknown>> =>
    audit.mock.calls.filter((entry) => entry[0] === type).map((entry) => entry[1] as Record<string, unknown>);

  it("hands back the pages its views of the tab reported", async () => {
    await registerBrowser();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({ agentName: "vision_browser_analyst", task: TASK, parentSessionId: "parent-blank-views", workspacePath: tempDir });

    expect(result.viewedTabPages).toEqual(["about:blank"]);
  }, 30_000);

  it("fails when every view showed the empty page, so the agent queued behind it runs (71d42257, a turn with no verdict)", async () => {
    const delegate = await registerBrowser();
    const result = await delegate.execute({ agentName: "vision_browser_analyst", fallbackAgents: ["browser_agent"], task: TASK, deliverable: "answer" }, ctxFor("s-blank-queued"));

    expect(result.success).toBe(true);
    expect(result.metadata?.["agentName"]).toBe("browser_agent");
    expect(result.metadata?.["attemptedAgents"]).toEqual(["vision_browser_analyst", "browser_agent"]);
    expect(result.output).toContain("Gründungsjahr 1987");
    expect(result.output).not.toContain("blauen Header");
    expect(rows("delegation_tab_reader_saw_blank_tab")).toEqual([
      expect.objectContaining({ agentName: "vision_browser_analyst", viewedTabPages: ["about:blank"] }),
    ]);
  }, 30_000);

  it("says what it saw when nothing is queued behind it", async () => {
    const delegate = await registerBrowser();
    const result = await delegate.execute({ agentName: "vision_browser_analyst", task: TASK, deliverable: "answer" }, ctxFor("s-blank-alone"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("saw only an empty browser tab (about:blank)");
    expect(`${result.output}${result.error}`).not.toContain("blauen Header");
  }, 30_000);

  it("leaves an agent that opens pages alone, though its one view of the tab came before it opened one", async () => {
    completeMock.mockImplementation(async (messages: Message[]) => {
      const done = toolResultsIn(messages);
      if (done === 0) return call("s1", "browser_snapshot", {});
      if (done === 1) return call("n1", "browser_navigate", { url: SITE });
      return answer("Gründungsjahr 1987, 146 Mitarbeiter (laut Startseite).");
    });
    const delegate = await registerBrowser();
    const result = await delegate.execute({ agentName: "browser_agent", task: TASK, deliverable: "answer" }, ctxFor("s-driver-blank-first"));

    expect(result.success).toBe(true);
    expect(result.metadata?.["agentName"]).toBe("browser_agent");
    expect(rows("delegation_tab_reader_saw_blank_tab")).toEqual([]);
  }, 30_000);

  it("keeps a run that read a page the tab showed", async () => {
    const delegate = await registerBrowser();
    tab = SITE_PAGE;
    const result = await delegate.execute({ agentName: "vision_browser_analyst", fallbackAgents: ["browser_agent"], task: TASK, deliverable: "answer" }, ctxFor("s-page-open"));

    expect(result.success).toBe(true);
    expect(result.metadata?.["agentName"]).toBe("vision_browser_analyst");
    expect(rows("delegation_tab_reader_saw_blank_tab")).toEqual([]);
  }, 30_000);
});
