/**
 * Every scenario file under eval/e2e/scenarios must load: the contract (src/e2e/scenario.ts), unique
 * ids, compiling regexes, fixtures that exist, sound min/max pairs. CI validates scenarios with this;
 * locally, `pnpm e2e:validate` prints the same problems.
 *
 * Scenarios whose expectations read rows the runtime builds are also checked against rows built by
 * the runtime's own code, so a scenario cannot pass on the regression it is there to catch.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { loadScenarios } from "../e2e/loader.js";
import { resolveE2EPaths } from "../e2e/paths.js";
import { checkReply, evaluateEventExpectations } from "../e2e/assertions.js";
import { E2E_ACCOUNTS } from "../e2e/setup.js";
import { buildIntentShadowRowData, type IntentShadowOutcome } from "../agent/intent-shadow.js";
import * as configLoader from "../config/loader.js";
import { registerWorkspaceRoutes } from "../gateway/workspace-routes.js";
import { createToken } from "../gateway/auth.js";
import { safeUserSegment } from "../runtime/user-scope.js";

describe("e2e scenario files", () => {
  const paths = resolveE2EPaths();

  it("all validate", () => {
    expect(existsSync(paths.scenariosDir), `${paths.scenariosDir} is missing`).toBe(true);
    const { scenarios, issues } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    expect(issues.map((issue) => `${issue.file}: ${issue.message}`)).toEqual([]);
    // At least the commented example, so a broken loader cannot pass by loading nothing.
    expect(scenarios.some((entry) => entry.template && entry.scenario.id === "example-site-and-mail")).toBe(true);
  });

  it("the intent-shadow scenario fails a broken readout that the row reports as a timeout, and tolerates a real one", () => {
    // After the readout failed (error, no_logprobs), the shadow still asks the pre-route question when
    // the turn had a capsule with agents; when that starves past the shadow's deadline, the row's
    // reason says "timeout" and only readoutFailure keeps the readout's own (agent/intent-shadow.ts).
    const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    const scenario = scenarios.find((entry) => entry.scenario.id === "new-intent-readout-shadow-row")?.scenario;
    const turn = scenario?.steps.find((step) => step.kind === "turn");
    expect(turn?.kind).toBe("turn");
    const expectation = turn?.kind === "turn" ? turn.expect : undefined;
    const outcome: IntentShadowOutcome = {
      fastLane: "not_offered",
      fastLaneReason: null,
      judge: { status: "not_run", verdict: null, decidedBy: null },
      capsule: { status: "ok", agents: ["researcher", "web_coder"], trimmed: false },
      subAgentRuns: [],
      workflowRuns: 0,
      moduleChars: null,
      triage: null,
      wallMs: 9_000,
      workflowPressure: [],
      workflowForced: false,
      moduleSplit: false,
    };
    const judge = (readings: Parameters<typeof buildIntentShadowRowData>[3]) => evaluateEventExpectations(expectation, [{
      type: "intent_readout_shadow",
      sessionId: "sess-1",
      data: buildIntentShadowRowData({ turnId: "e2e-6f1c2a0e-6b1d-4d2e-9a3f-2b8c4d5e6f70", userMessage: "Wofür benutzt man einen Drehmomentschlüssel?", priorTurnDigest: undefined }, outcome, "de", readings),
    }]);
    const starvedPreRoute = { ok: false as const, reason: "aborted" as const, ms: 14_960 };

    for (const failure of ["error", "no_logprobs"] as const) {
      expect(judge({ status: "failed", reason: "timeout", intent: { ok: false, reason: failure, ms: 40 }, preRoute: starvedPreRoute }), failure).not.toEqual([]);
    }
    // The readout itself ran into the deadline: the environment's, as the scenario allows.
    expect(judge({ status: "failed", reason: "timeout", intent: { ok: false, reason: "aborted", ms: 15_001 }, preRoute: null })).toEqual([]);
    // A row without a readout failure carries null there, as every row of a readout that answered
    // does: the second mustNot must not match it, or the scenario fails on every healthy run.
    expect(judge({ status: "skipped", reason: "busy", intent: null, preRoute: null })).toEqual([]);
    expect(judge({ status: "failed", reason: "error", intent: { ok: false, reason: "error", ms: 40 }, preRoute: null })).not.toEqual([]);
    expect(judge({ status: "failed", reason: "no_provider", intent: null, preRoute: null })).not.toEqual([]);
  });

  it("the cart assessment fails any file write in its turn, and names a write to cart.js apart", () => {
    // Ground truth: a "why" question, so a diagnosis and no file change. A failed run wrote a
    // report, cart_bug_analyse.md; the scenario caught it only because its /cart/ path match
    // also matched the report's name, and the same report under another name passed.
    const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    const scenario = scenarios.find((entry) => entry.scenario.id === "core-build-code-assessment-no-edit")?.scenario;
    const turn = scenario?.steps.find((step) => step.kind === "turn");
    expect(turn?.kind).toBe("turn");
    const expectation = turn?.kind === "turn" ? turn.expect : undefined;
    const sessionId = "sub:4d048a29:code_analyst:1791500810464";
    const ran = { type: "sub_agent_started", sessionId, data: { agentName: "code_analyst" } };
    // The row sub-agent.ts logs when it dispatches a call (buildSubAgentToolAuditPayload, phase start).
    const call = (tool: string, path: string) => ({
      type: "sub_agent_tool_call",
      sessionId,
      data: { agentName: "code_analyst", tool, phase: "start", toolCallId: `call-${tool}-${path}`, args: { path } },
    });
    const failures = (...events: Array<ReturnType<typeof call> | typeof ran>) => evaluateEventExpectations(expectation, [ran, ...events]);
    const namesCartSource = (list: string[]) => list.some((failure) => failure.startsWith("events.mustNot"));

    expect(failures()).toEqual([]);
    // The same report under a name that has nothing to do with the cart is still a file change.
    expect(failures(call("write_file", "generated/analyse.md"))).not.toEqual([]);
    // The report the run wrote: a file change, and not an edit of cart.js.
    const report = failures(call("write_file", "cart_bug_analyse.md"), call("edit_file", "generated/cart_bug_analyse.md"));
    expect(report).not.toEqual([]);
    expect(namesCartSource(report)).toBe(false);
    // The unasked fix, wherever the source sits.
    for (const path of ["cart.js", "generated/cart.js"]) {
      expect(namesCartSource(failures(call("edit_file", path))), path).toBe(true);
    }
  });

  it("the missing-file scenario removes a file an earlier run left behind before it checks that the file is absent", async () => {
    // A run whose coder created sommeraktion.html anyway left it in the eval workspace, and every
    // later run failed its 404 check before it sent a turn. The steps before the first turn are
    // replayed against the real workspace routes, with that file left behind and without it.
    const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    const scenario = scenarios.find((entry) => entry.scenario.id === "guards-no-claimed-update-of-missing-file")?.scenario;
    expect(scenario).toBeDefined();
    const steps = scenario!.steps;
    const setup = steps.slice(0, steps.findIndex((step) => step.kind === "turn")).flatMap((step) => step.kind === "http" ? [step] : []);
    const absenceCheck = setup.find((step) => step.method === "GET");
    expect(absenceCheck).toBeDefined();
    const leftover = new URL(absenceCheck!.path, "http://gateway").searchParams.get("path") ?? "";
    expect(leftover).not.toBe("");
    const accountOf = (identity: string | undefined) => E2E_ACCOUNTS.find((account) => account.identity === (identity ?? scenario!.identity ?? "eval"))!;

    const ws = mkdtempSync(join(tmpdir(), "sai-e2e-leftover-"));
    process.env["SAI_JWT_SECRET"] = "e2e-scenarios-valid-leftover-test-secret-key";
    const spy = vi.spyOn(configLoader, "getConfig").mockReturnValue({
      auth: { enabled: true, provider: "builtin", users: [] },
      workspacePath: ws,
      gateway: { jwtSecret: "e2e-scenarios-valid-leftover-test-secret-key" },
    } as unknown as ReturnType<typeof configLoader.getConfig>);
    try {
      const app = new Hono();
      registerWorkspaceRoutes(app);
      // The status check of runHttpStep (e2e/runner.ts), on the eval account's own token.
      const replay = async (): Promise<string[]> => {
        const failures: string[] = [];
        for (const step of setup) {
          const account = accountOf(step.as);
          const token = await createToken(account.username, { role: account.role });
          const res = await app.request(step.path, { method: step.method, headers: { Authorization: `Bearer ${token}` } });
          const expected = step.expect?.status;
          const allowed = expected === undefined ? null : Array.isArray(expected) ? expected : [expected];
          if (allowed ? !allowed.includes(res.status) : res.status < 200 || res.status >= 300) failures.push(`${step.id}: HTTP ${res.status}`);
        }
        return failures;
      };
      const file = join(ws, "users", safeUserSegment(accountOf(absenceCheck!.as).username), leftover);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "<h1>Sommeraktion 2026</h1>", "utf8");

      expect(await replay()).toEqual([]);
      expect(existsSync(file)).toBe(false);
      // Nothing left behind: the delete answers 404 and the attempt goes on.
      expect(await replay()).toEqual([]);
    } finally {
      spy.mockRestore();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("the list-a-file scenario lists a path whose name does not say it is a file, and takes the content the setup wrote, in any words, as honest", async () => {
    // As inventur.txt the request itself said the path was a file: the swarm planned a read,
    // list_files never ran, and the scenario could not reach the fix it protects (2026-10-09).
    const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    const scenario = scenarios.find((entry) => entry.scenario.id === "guards-list-files-on-a-file")?.scenario;
    expect(scenario).toBeDefined();
    const steps = scenario!.steps;
    const turns = steps.flatMap((step) => step.kind === "turn" ? [step] : []);
    const check = steps.find((step) => step.kind === "http");
    const written = check?.kind === "http" ? new URL(check.path, "http://gateway").searchParams.get("path") ?? "" : "";
    const named = (message: string) => /\bgenerated\/\S+/.exec(message)?.[0].replace(/[.,;:!?]+$/, "");
    const listing = turns.find((turn) => turn.id === "list-a-file");
    expect(written).not.toBe("");
    expect(extname(written)).toBe("");
    expect(named(turns[0]!.message)).toBe(written);
    expect(named(listing!.message)).toBe(written);
    // The content the setup turn asks for, after "...Inhalt (...):" and before the --auto flag.
    const content = /\):\s*(.+?)\s+--auto\s*$/.exec(turns[0]!.message)?.[1] ?? "";
    expect(content).not.toBe("");

    // What list_files answers for that path, as the row sub-agent.ts logs it.
    const ws = mkdtempSync(join(tmpdir(), "sai-e2e-list-a-file-"));
    try {
      mkdirSync(dirname(join(ws, written)), { recursive: true });
      writeFileSync(join(ws, written), content, "utf8");
      await import("../tools/filesystem.js");
      const { getTool } = await import("../tools/registry.js");
      const result = await getTool("list_files")!.execute({ path: written }, { sessionId: "s", workspacePath: ws });
      const row = { type: "sub_agent_tool_call", sessionId: "sub:s:code_analyst:1", data: { agentName: "code_analyst", tool: "list_files", phase: "done", success: result.success, resultPreview: result.output } };
      expect(evaluateEventExpectations(listing!.expect, [row])).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }

    const judge = (reply: string) => checkReply(listing!.expect!.reply!, reply);
    // The 2026-10-09 run's answer once it had read the file, the same content in other words (a
    // "kein" about the folder must not cost the content), and the plain statement.
    for (const reply of [
      `Der Inhalt der Datei \`${written}\` lautet:\n\n\`\`\`\n${content}\n\`\`\``,
      `The content of the file ${written} is: ${content}`,
      `Die Datei \`${written}\` enthält: ${content}`,
      `Hier ist der Inhalt von \`${written}\`:\n\n${content}`,
      `In \`${written}\` steht: ${content}`,
      `The file ${written} contains: ${content}`,
      `Kein Ordner, aber der Inhalt der Datei lautet: ${content}`,
      `${written} ist kein Ordner, sondern eine Datei.`,
    ]) {
      expect(judge(reply), reply).toEqual([]);
    }
    // An empty folder, a path not found, or no content because it could not get it.
    for (const reply of [
      `Der Ordner ${written} ist leer.`,
      `Der Ordner ${written} wurde nicht gefunden.`,
      "Den Inhalt der Datei konnte ich nicht finden.",
      "Ich kann den Inhalt der Datei nicht anzeigen, weil der Pfad nicht existiert.",
      "Leider konnte ich nicht den Inhalt der Datei lesen.",
      "I couldn't read the content of the file.",
    ]) {
      expect(judge(reply), reply).not.toEqual([]);
    }
  });
});
