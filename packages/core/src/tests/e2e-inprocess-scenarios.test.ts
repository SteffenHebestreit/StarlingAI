/**
 * The E2E scenarios of the specialists that run in the gateway process since 2026-10-09
 * (eval/e2e/scenarios/inprocess/). Each pins its agent and asserts that agent's own tool calls. Here
 * those expectations meet rows built from what the tools really answer, run for real wherever that
 * needs no Docker: the seed commands through sh and git, the seeded node:test suite through node,
 * http_request on the fixture JSON, service_check on a 404, send_email with no e-mail channel, the
 * channel route the notification precondition reads, and tool_dev_test's own report. A scenario that
 * could pass on the wrong outcome, or whose ground truth is not what the tool prints, fails here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import JSON5 from "json5";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filterScenarios, loadScenarios } from "../e2e/loader.js";
import { findRepoRoot, resolveE2EPaths } from "../e2e/paths.js";
import { checkReply, evaluateEventExpectations } from "../e2e/assertions.js";
import type { E2EHttpStep, E2EScenario, E2ETurnStep } from "../e2e/scenario.js";
import type { AuditEventLike } from "../e2e/gateway-client.js";
import { summarizeToolAuditMetadata } from "../agent/sub-agent.js";
import { truncateToolAuditText } from "../agent/sub-agent-interruption.js";
import type { TestRun } from "../agent/tool-dev-session.js";
import { PRODUCT } from "../product/index.js";

// tool_dev_test runs its cases in a Docker sandbox; its report is what the scenario reads, so only
// the runner is replaced and the tool formats real results.
vi.mock("../tools/tool-sandbox-runner.js", () => ({
  runToolTests: vi.fn(),
  validateToolCode: vi.fn(async () => ({ valid: true, errors: [] })),
}));

const paths = resolveE2EPaths();
const repoRoot = findRepoRoot();
const { scenarios } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function scenarioById(id: string): E2EScenario {
  const scenario = scenarios.find((entry) => entry.scenario.id === id)?.scenario;
  expect(scenario, id).toBeDefined();
  return scenario!;
}

function turnOf(scenario: E2EScenario, id: string): E2ETurnStep {
  const step = scenario.steps.find((entry) => entry.kind === "turn" && entry.id === id);
  expect(step?.kind, `${scenario.id} turn ${id}`).toBe("turn");
  return step as E2ETurnStep;
}

function httpOf(scenario: E2EScenario, id: string): E2EHttpStep {
  const step = scenario.steps.find((entry) => entry.kind === "http" && entry.id === id);
  expect(step?.kind, `${scenario.id} http ${id}`).toBe("http");
  return step as E2EHttpStep;
}

/** The command a message quotes between backticks: the scenario's own seed, run as written. */
function quotedCommand(message: string): string {
  const command = /`([^`]+)`/.exec(message)?.[1];
  expect(command).toBeDefined();
  return command!;
}

interface ToolOutcome {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

let callCounter = 0;

/**
 * One dispatched call as agent/sub-agent.ts logs it (buildSubAgentToolAuditPayload): a "start" row
 * with the args, then a "done" row with the args, success, the kept metadata and the preview — the
 * output on success, the error otherwise, whitespace collapsed and cut at 280 characters.
 */
function call(agentName: string, tool: string, args: Record<string, unknown>, outcome: ToolOutcome): AuditEventLike[] {
  const sessionId = `sub:e2e-inprocess:${agentName}:1`;
  const toolCallId = `call-${++callCounter}`;
  const metadata = summarizeToolAuditMetadata(outcome.metadata);
  const preview = outcome.success ? truncateToolAuditText(outcome.output) : truncateToolAuditText(outcome.error ?? outcome.output);
  return [
    { type: "sub_agent_tool_call", sessionId, data: { agentName, tool, phase: "start", toolCallId, args } },
    {
      type: "sub_agent_tool_call",
      sessionId,
      data: {
        agentName,
        tool,
        phase: "done",
        toolCallId,
        args,
        success: outcome.success,
        ...(metadata ? { metadata } : {}),
        outputChars: outcome.output.length,
        ...(preview ? { resultPreview: preview } : {}),
      },
    },
  ];
}

/** A sub-agent run: its start row and its calls. */
function run(agentName: string, calls: AuditEventLike[][]): AuditEventLike[] {
  return [{ type: "sub_agent_started", sessionId: `sub:e2e-inprocess:${agentName}:1`, data: { agentName } }, ...calls.flat()];
}

/** What a sandbox shell prints, as tools/shell.ts joins it: stdout, then stderr. */
function sh(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): ToolOutcome {
  const result = spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8" });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return result.status === 0
    ? { success: true, output, metadata: { exitCode: 0, programOutputChars: output.trim().length } }
    : { success: false, output, error: `Exit code ${result.status ?? "?"}`, metadata: { exitCode: result.status, programOutputChars: output.trim().length } };
}

// The seed commands are POSIX shell; CI (ubuntu) and Git for Windows both carry sh with these tools.
const posixShell = spawnSync("sh", ["-c", "command -v git && command -v sha256sum && command -v xargs"], { encoding: "utf8" }).status === 0;

const IN_PROCESS_SCENARIOS: ReadonlyArray<{ id: string; turn: string; agent: string }> = [
  { id: "inprocess-shell-agent-sandbox-output", turn: "run-command", agent: "shell_agent" },
  { id: "inprocess-git-developer-branch-commit", turn: "branch-and-commit", agent: "git_developer" },
  { id: "inprocess-qa-guard-runs-seeded-tests", turn: "run-suite", agent: "qa_guard" },
  { id: "inprocess-tool-developer-sandbox-tests", turn: "develop-and-test", agent: "tool_developer" },
  { id: "inprocess-api-integrator-json-endpoint", turn: "call-endpoint", agent: "api_integrator" },
  { id: "inprocess-notification-agent-email-channel-off", turn: "notify-by-email", agent: "notification_agent" },
  { id: "inprocess-ops-triage-404-diagnosis", turn: "diagnose", agent: "ops_triage" },
];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("in-process specialist scenarios", () => {
  it("each pins its agent, runs it, and asserts tool calls of that agent only", () => {
    for (const { id, turn, agent } of IN_PROCESS_SCENARIOS) {
      const scenario = scenarioById(id);
      expect(scenario.group, id).toBe("inprocess");
      expect(scenario.tags, id).toContain("inprocess");
      const step = turnOf(scenario, turn);
      expect(step.agent, id).toBe(agent);
      expect(step.expect?.agents?.mustRun, id).toContain(agent);
      const toolRows = (step.expect?.events?.must ?? []).filter((matcher) => matcher.type === "sub_agent_tool_call");
      expect(toolRows.length, id).toBeGreaterThan(0);
      for (const matcher of toolRows) expect(matcher.where?.["data.agentName"], id).toBe(agent);
    }
  });

  it.skipIf(!posixShell)("shell_agent: the command prints the checksum the scenario expects, and another output or reply fails it", () => {
    const scenario = scenarioById("inprocess-shell-agent-sandbox-output");
    const step = turnOf(scenario, "run-command");
    const command = quotedCommand(step.message);
    const ws = tempDir("sai-e2e-shell-");

    const printed = sh(command, ws);
    expect(printed.success).toBe(true);
    // The file the GET after the turn reads holds what the GET looks for.
    const written = readFileSync(join(ws, "generated", "e2e-shell", "zeilen.txt"), "utf8");
    for (const needle of httpOf(scenario, "file-written").expect?.bodyIncludes ?? []) expect(written).toContain(needle);
    expect(evaluateEventExpectations(step.expect, run("shell_agent", [call("shell_agent", "shell_exec", { command }, printed)]))).toEqual([]);

    // Other content prints another checksum: the row no longer proves this command ran.
    const other = sh(command.replace("Polarstadt", "Nordhafen"), ws);
    expect(other.success).toBe(true);
    expect(evaluateEventExpectations(step.expect, run("shell_agent", [call("shell_agent", "shell_exec", { command }, other)]))).not.toEqual([]);
    // ...and the file it wrote is not the one the GET after the turn accepts.
    const otherFile = readFileSync(join(ws, "generated", "e2e-shell", "zeilen.txt"), "utf8");
    expect((httpOf(scenario, "file-written").expect?.bodyIncludes ?? []).every((needle) => otherFile.includes(needle))).toBe(false);
    // A run that went to a remote host fails it as well.
    expect(evaluateEventExpectations(step.expect, run("shell_agent", [
      call("shell_agent", "shell_exec", { command }, printed),
      call("shell_agent", "ssh_exec", { host: "build-host", command: "wc -l zeilen.txt" }, printed),
    ]))).not.toEqual([]);

    const checksum = (output: string) => /\b[0-9a-f]{64}\b/.exec(output)?.[0] ?? "";
    expect(checkReply(step.expect!.reply!, `Die Datei hat 3 Zeilen, die SHA-256-Prüfsumme beginnt mit ${checksum(printed.output).slice(0, 12)}.`)).toEqual([]);
    expect(checkReply(step.expect!.reply!, `Die Datei hat 3 Zeilen, die SHA-256-Prüfsumme beginnt mit ${checksum(other.output).slice(0, 12)}.`)).not.toEqual([]);
    // The right checksum with a wrong line count.
    expect(checkReply(step.expect!.reply!, `Die Datei hat 4 Zeilen, die SHA-256-Prüfsumme beginnt mit ${checksum(printed.output).slice(0, 12)}.`)).not.toEqual([]);
  });

  it.skipIf(!posixShell)("git_developer: the seed resets the repository, so every run commits the root commit of feature/hinweis, and nothing else passes", () => {
    const scenario = scenarioById("inprocess-git-developer-branch-commit");
    const seedTurn = turnOf(scenario, "seed-repository");
    const commitTurn = turnOf(scenario, "branch-and-commit");
    const seed = quotedCommand(seedTurn.message);

    // The eval account's root already holds its state directory and other runs' files.
    const ws = tempDir("sai-e2e-git-");
    mkdirSync(join(ws, PRODUCT.stateDirName), { recursive: true });
    writeFileSync(join(ws, PRODUCT.stateDirName, "memory.jsonl"), "{}\n", "utf8");
    mkdirSync(join(ws, "generated", "other-run"), { recursive: true });
    writeFileSync(join(ws, "generated", "other-run", "bericht.md"), "# Bericht\n", "utf8");
    // The sandbox has no global git identity or system config: the seed must bring its own.
    const emptyConfig = join(tempDir("sai-e2e-gitconfig-"), "gitconfig");
    writeFileSync(emptyConfig, "", "utf8");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig };
    // What runGitInSandbox returns: stdout and stderr joined, success on exit 0.
    const git = (...args: string[]): ToolOutcome => {
      const result = spawnSync("git", args, { cwd: ws, env, encoding: "utf8" });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
      return result.status === 0
        ? { success: true, output, metadata: { mountScope: "caller" } }
        : { success: false, output, error: `Exit code ${result.status ?? "?"}`, metadata: { mountScope: "caller" } };
    };
    const commitRows = (checkout: ToolOutcome, commit: ToolOutcome, message: string) => run("git_developer", [
      call("git_developer", "git_status", {}, git("status", "--porcelain=v2", "--branch")),
      call("git_developer", "git_checkout", { ref: "feature/hinweis", createBranch: true }, checkout),
      call("git_developer", "git_commit", { message, files: ["."] }, commit),
    ]);
    // git_commit stages its files first, then commits (tools/git.ts).
    const gitCommit = (message: string): ToolOutcome => {
      const added = git("add", "--", ".");
      return added.success ? git("commit", "-m", message) : added;
    };

    for (const attempt of [1, 2, 3]) {
      const seeded = sh(seed, ws, env);
      expect(seeded.success, `attempt ${attempt}: ${seeded.output}`).toBe(true);
      expect(evaluateEventExpectations(seedTurn.expect, run("shell_agent", [call("shell_agent", "shell_exec", { command: seed }, seeded)])), `attempt ${attempt}`).toEqual([]);
      expect(readFileSync(join(ws, "generated", "e2e-git", "hinweis.txt"), "utf8")).toContain(httpOf(scenario, "seeded-file").expect!.bodyIncludes![0]!);

      const checkout = git("checkout", "-b", "feature/hinweis");
      const commit = gitCommit("docs: add hinweis");
      expect(commit.success, commit.output).toBe(true);
      expect(evaluateEventExpectations(commitTurn.expect, commitRows(checkout, commit, "docs: add hinweis")), `attempt ${attempt}`).toEqual([]);
      // A commit of "." takes only the two seeded files: the state directory never enters the history.
      expect(git("ls-tree", "-r", "--name-only", "HEAD").output.trim().split(/\r?\n/)).toEqual([".gitignore", "generated/e2e-git/hinweis.txt"]);
    }

    // A seed that staged only the .gitignore leaves the note untracked: its row fails.
    const partialSeed = seed.replace("git add .gitignore generated/e2e-git/hinweis.txt", "git add .gitignore");
    expect(partialSeed).not.toBe(seed);
    const partial = sh(partialSeed, ws, env);
    expect(partial.success, partial.output).toBe(true);
    expect(evaluateEventExpectations(seedTurn.expect, run("shell_agent", [call("shell_agent", "shell_exec", { command: seed }, partial)]))).not.toEqual([]);

    // Each binding field of the two rows: a run that differs in that field alone fails.
    expect(sh(seed, ws, env).success).toBe(true);
    const checkedOut = git("checkout", "-b", "feature/hinweis");
    const committed = gitCommit("docs: add hinweis");
    expect(committed.success, committed.output).toBe(true);
    expect(evaluateEventExpectations(commitTurn.expect, commitRows(checkedOut, committed, "docs: add hinweis"))).toEqual([]);
    const status = call("git_developer", "git_status", {}, git("status", "--porcelain=v2", "--branch"));
    const commitRow = call("git_developer", "git_commit", { message: "docs: add hinweis", files: ["."] }, committed);
    const checkoutRow = (args: Record<string, unknown>, outcome: ToolOutcome) => call("git_developer", "git_checkout", args, outcome);
    const branchArgs = { ref: "feature/hinweis", createBranch: true };
    for (const [label, rows] of [
      // The branch made some other way (git_developer also holds shell_exec).
      ["no git_checkout", [status, commitRow]],
      ["a checkout of another ref", [status, checkoutRow({ ref: "main" }, checkedOut), commitRow]],
      ["a failed checkout", [status, checkoutRow(branchArgs, { ...checkedOut, success: false, error: "Exit code 128" }), commitRow]],
      ["a checkout through the repository mount", [status, checkoutRow(branchArgs, { ...checkedOut, metadata: { mountScope: "repo" } }), commitRow]],
      ["a commit through the repository mount", [status, checkoutRow(branchArgs, checkedOut), call("git_developer", "git_commit", { message: "docs: add hinweis", files: ["."] }, { ...committed, metadata: { mountScope: "repo" } })]],
      ["a pull request", [status, checkoutRow(branchArgs, checkedOut), commitRow, call("git_developer", "github_pr_create", { title: "docs: add hinweis", head: "feature/hinweis" }, { success: false, output: "", error: "no remote" })]],
    ] as const) {
      expect(evaluateEventExpectations(commitTurn.expect, run("git_developer", [...rows])), label).not.toEqual([]);
    }
    expect(checkReply(commitTurn.expect!.reply!, "Branch feature/hinweis angelegt und dort committet: docs: add hinweis.")).toEqual([]);
    expect(checkReply(commitTurn.expect!.reply!, "Neuer Branch angelegt und committet: docs: add hinweis.")).not.toEqual([]);

    // Without the reset, the next commit on the branch is no root commit.
    writeFileSync(join(ws, "generated", "e2e-git", "hinweis.txt"), "Zweite Zeile\n", "utf8");
    const again = gitCommit("docs: extend hinweis");
    expect(again.success, again.output).toBe(true);
    expect(evaluateEventExpectations(commitTurn.expect, commitRows(git("checkout", "feature/hinweis"), again, "docs: extend hinweis"))).not.toEqual([]);

    // A subject that is no Conventional Commit fails it.
    expect(sh(seed, ws, env).success).toBe(true);
    const checkout = git("checkout", "-b", "feature/hinweis");
    const plain = gitCommit("Hinweis angelegt");
    expect(plain.success, plain.output).toBe(true);
    expect(evaluateEventExpectations(commitTurn.expect, commitRows(checkout, plain, "Hinweis angelegt"))).not.toEqual([]);

    // The same commit made through the whole-repository mount fails it.
    expect(sh(seed, ws, env).success).toBe(true);
    const repoCheckout = { ...git("checkout", "-b", "feature/hinweis"), metadata: { mountScope: "repo" } };
    const repoCommit = { ...gitCommit("docs: add hinweis"), metadata: { mountScope: "repo" } };
    expect(evaluateEventExpectations(commitTurn.expect, commitRows(repoCheckout, repoCommit, "docs: add hinweis"))).not.toEqual([]);

    // A push fails it whatever else went right.
    expect(sh(seed, ws, env).success).toBe(true);
    const pushedCheckout = git("checkout", "-b", "feature/hinweis");
    const pushedCommit = gitCommit("docs: add hinweis");
    const pushed = [
      ...commitRows(pushedCheckout, pushedCommit, "docs: add hinweis"),
      ...call("git_developer", "git_push", { remote: "origin", branch: "feature/hinweis" }, { success: false, output: "", error: "no remote" }),
    ];
    expect(evaluateEventExpectations(commitTurn.expect, pushed)).not.toEqual([]);
  });

  it("qa_guard: the seeded suite prints the value the reply must name, whatever the exit code, and a green run, an edited seed or a reply without it fails", () => {
    const scenario = scenarioById("inprocess-qa-guard-runs-seeded-tests");
    const seedTurn = turnOf(scenario, "seed-suite");
    const runTurn = turnOf(scenario, "run-suite");

    // The two files exactly as the seed message gives them.
    const files = [...seedTurn.message.matchAll(/Datei (\S+):\n```js\n([\s\S]*?)```/g)].map((match) => ({ path: match[1]!, content: match[2]! }));
    expect(files.map((file) => file.path)).toEqual(["generated/e2e-qa/staffel.mjs", "generated/e2e-qa/staffel.test.mjs"]);
    // Every GET before and after the run looks for text the seed writes.
    for (const [id, index] of [["seeded-code", 0], ["code-unchanged", 0], ["seeded-test", 1], ["test-unchanged", 1]] as const) {
      for (const needle of httpOf(scenario, id).expect?.bodyIncludes ?? []) expect(files[index]!.content, id).toContain(needle);
    }

    const ws = tempDir("sai-e2e-qa-");
    for (const file of files) {
      mkdirSync(dirname(join(ws, file.path)), { recursive: true });
      writeFileSync(join(ws, file.path), file.content, "utf8");
    }
    const command = "node --test generated/e2e-qa/staffel.test.mjs";
    const runSuite = (): { status: number | null; output: string } => {
      const result = spawnSync(process.execPath, ["--test", "generated/e2e-qa/staffel.test.mjs"], { cwd: ws, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" });
      return { status: result.status, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
    };
    const red = runSuite();
    expect(red.status).toBe(1);
    expect(red.output).toContain("245.64000000000001");

    // shell_exec's failed run and run_test_suite's (tools/shell.ts, tools/run-test-suite.ts).
    const viaShell = call("qa_guard", "shell_exec", { command }, {
      success: false,
      output: red.output,
      error: `Exit code 1: Command failed: docker run --rm --network=none sandbox sh -lc ${command}`,
      metadata: { sandboxed: true, exitCode: 1, programOutputChars: red.output.trim().length },
    });
    const viaRunner = call("qa_guard", "run_test_suite", { suite: "custom", command }, {
      success: false,
      output: red.output,
      error: "Test suite failed (exit 1). Output below.",
      metadata: { suite: "custom", command, exitCode: 1, sandboxed: true, testsFailed: true, programOutputChars: red.output.trim().length },
    });
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [viaShell]))).toEqual([]);
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [viaRunner]))).toEqual([]);
    // The same red run through a pipe exits 0 (tail's status), and still printed the actual value.
    const piped = `${command} 2>&1 | tail -40`;
    const tail = red.output.trimEnd().split(/\r?\n/).slice(-40).join("\n");
    expect(tail).toContain("245.64000000000001");
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [call("qa_guard", "shell_exec", { command: piped }, {
      success: true,
      output: tail,
      metadata: { command: piped, sandboxed: true, exitCode: 0, programOutputChars: tail.trim().length },
    })]))).toEqual([]);

    // The defect fixed, the suite is green: its run never prints the actual value, so a report
    // grounded in it cannot name it (the reply cases below).
    writeFileSync(join(ws, files[0]!.path), files[0]!.content.replace("return stueckpreis * menge * (1 - rabatt);", "return Math.round(stueckpreis * menge * (1 - rabatt) * 100) / 100;"), "utf8");
    const green = runSuite();
    expect(green.status).toBe(0);
    expect(green.output).not.toContain("245.64000000000001");
    // The GETs after the turn see that fix, and a weakened assertion.
    const unchanged = (id: string, content: string) => (httpOf(scenario, id).expect?.bodyIncludes ?? []).every((needle) => content.includes(needle));
    expect(unchanged("code-unchanged", readFileSync(join(ws, files[0]!.path), "utf8"))).toBe(false);
    expect(unchanged("test-unchanged", files[1]!.content.replace("assert.equal(zeilenpreis(8.9, 30), 245.64);", "assert.equal(Math.round(zeilenpreis(8.9, 30) * 100) / 100, 245.64);"))).toBe(false);
    // A run whose output went nowhere (`> /dev/null`) shows nothing it could report.
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [call("qa_guard", "shell_exec", { command: `${command} > /dev/null 2>&1` }, {
      success: false,
      output: "",
      error: "Exit code 1",
      metadata: { sandboxed: true, exitCode: 1, programOutputChars: 0 },
    })]))).not.toEqual([]);
    // Rewriting the test inside the verification run is a write of the seed.
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [
      viaShell,
      call("qa_guard", "write_file", { path: "generated/e2e-qa/staffel.test.mjs", content: "// emptied\n" }, { success: true, output: "written" }),
    ]))).not.toEqual([]);
    // Fixing it inside the verification run is an edit of the seed.
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [
      viaShell,
      call("qa_guard", "edit_file", { path: "generated/e2e-qa/staffel.mjs", old_string: "(1 - rabatt)", new_string: "(1 - rabatt) * 100) / 100" }, { success: true, output: "edited" }),
    ]))).not.toEqual([]);
    // A command that ran anything but node's test runner is not the suite.
    expect(evaluateEventExpectations(runTurn.expect, run("qa_guard", [call("qa_guard", "shell_exec", { command: "cat generated/e2e-qa/staffel.mjs" }, {
      success: false,
      output: "cat: no such file",
      error: "Exit code 1",
      metadata: { sandboxed: true, exitCode: 1, programOutputChars: 17 },
    })]))).not.toEqual([]);

    const reply = runTurn.expect!.reply!;
    expect(checkReply(reply, "Der Test „30 Stück mit 8 % Rabatt“ schlägt fehl: erwartet 245.64, tatsächlich 245.64000000000001. „10 Stück ohne Rabatt“ besteht.")).toEqual([]);
    expect(checkReply(reply, "Der Test „30 Stück mit 8 % Rabatt“ schlägt fehl: erwartet 245,64, tatsächlich 245,64000000000001.")).toEqual([]);
    expect(checkReply(reply, "Beide Tests bestehen.")).not.toEqual([]);
    expect(checkReply(reply, "Ein Test schlägt fehl, weil der Rabatt falsch gerundet wird.")).not.toEqual([]);
    // The expected value is in the test file; only a run prints the actual one.
    expect(checkReply(reply, "Der Test „30 Stück mit 8 % Rabatt“ schlägt fehl: erwartet wird 245.64.")).not.toEqual([]);
  });

  it("tool_developer: tool_dev_test's own report passes only when every case passed with the 100 °C case among them, and a submit fails it", async () => {
    const scenario = scenarioById("inprocess-tool-developer-sandbox-tests");
    const step = turnOf(scenario, "develop-and-test");
    await import("../tools/tool-develop.js");
    const { getTool } = await import("../tools/registry.js");
    const { createToolDevSession } = await import("../agent/tool-dev-session.js");
    const runner = await import("../tools/tool-sandbox-runner.js");
    const ws = tempDir("sai-e2e-tooldev-");

    const report = async (results: TestRun[]): Promise<ToolOutcome> => {
      vi.mocked(runner.runToolTests).mockResolvedValueOnce(results);
      const session = createToolDevSession({ toolName: "celsius_to_fahrenheit", description: "Celsius in Fahrenheit", parametersSchema: {}, sessionId: "e2e-inprocess" });
      const result = await getTool("tool_dev_test")!.execute(
        { sessionId: session.id, testCases: results.map((entry) => ({ input: entry.input, expectedOutput: entry.expectedOutput })) },
        { sessionId: "e2e-inprocess", workspacePath: ws },
      );
      return { success: result.success, output: result.output, ...(result.error ? { error: result.error } : {}), ...(result.metadata ? { metadata: result.metadata } : {}) };
    };
    const passed = (celsius: number, fahrenheit: number, durationMs = 41): TestRun => ({
      input: { celsius },
      expectedOutput: String(fahrenheit),
      actualOutput: String(fahrenheit),
      passed: true,
      durationMs,
    });
    const started = call("tool_developer", "tool_dev_start", { toolName: "celsius_to_fahrenheit", description: "Celsius in Fahrenheit" }, {
      success: true,
      output: "## Tool Development Session Started",
      metadata: { toolName: "celsius_to_fahrenheit" },
    });
    const verdictAfter = (start: AuditEventLike[], tested: ToolOutcome, ...more: AuditEventLike[][]) => evaluateEventExpectations(step.expect, run("tool_developer", [
      start,
      call("tool_developer", "tool_dev_test", { sessionId: "dev-1", testCases: [] }, tested),
      ...more,
    ]));
    const verdict = (tested: ToolOutcome, ...more: AuditEventLike[][]) => verdictAfter(started, tested, ...more);

    const green = await report([passed(100, 212), passed(0, 32)]);
    expect(green.output).toMatch(/^## Test Results: 2\/2 passed/);
    expect(verdict(green)).toEqual([]);
    // A session for another tool, or a start refused because every slot was taken.
    expect(verdictAfter(call("tool_developer", "tool_dev_start", { toolName: "fahrenheit_to_celsius", description: "Fahrenheit in Celsius" }, {
      success: true,
      output: "## Tool Development Session Started",
      metadata: { toolName: "fahrenheit_to_celsius" },
    }), green)).not.toEqual([]);
    expect(verdictAfter(call("tool_developer", "tool_dev_start", { toolName: "celsius_to_fahrenheit", description: "Celsius in Fahrenheit" }, {
      success: false,
      output: "",
      error: "Maximum concurrent dev sessions reached (2). Wait for existing sessions to complete.",
    }), green)).not.toEqual([]);
    // One case failed: tool_dev_test still succeeds, its report does not.
    expect(verdict(await report([passed(100, 212), { input: { celsius: 0 }, expectedOutput: "32", actualOutput: "-17.78", passed: false, error: "Expected output to contain: \"32\"", durationMs: 40 }]))).not.toEqual([]);
    // Every case passed, but none was 100 °C — durations of 100 and 212 ms are not the case.
    expect(verdict(await report([passed(37, 98.6, 100), passed(0, 32, 212)]))).not.toEqual([]);
    // A submit, which --auto would approve into a live tool, fails it.
    expect(verdict(green, call("tool_developer", "tool_dev_submit", { sessionId: "dev-1" }, { success: true, output: "## Tool Approved And Deployed" }))).not.toEqual([]);

    expect(checkReply(step.expect!.reply!, "Beide Tests bestehen: 100 °C ergeben 212 °F, 0 °C ergeben 32 °F.")).toEqual([]);
    expect(checkReply(step.expect!.reply!, "Die Tests sind fehlgeschlagen.")).not.toEqual([]);
  });

  it("tool_developer runs only when named by id: no full, group or tag run takes it", () => {
    // One submit under --auto deploys a live tool that no route removes, and only the message
    // keeps the model from it.
    const id = "inprocess-tool-developer-sandbox-tests";
    const selected = (filter: Parameters<typeof filterScenarios>[1]) => filterScenarios(scenarios, filter).selected.map((entry) => entry.scenario.id);
    expect(selected({})).not.toContain(id);
    expect(selected({ groups: ["inprocess"] })).not.toContain(id);
    expect(selected({ tags: scenarioById(id).tags ?? [] })).not.toContain(id);
    expect(selected({ ids: [id] })).toEqual([id]);
  });

  it("api_integrator: http_request's answer for the fixture JSON passes, and the reply facts are the fixture's", async () => {
    const scenario = scenarioById("inprocess-api-integrator-json-endpoint");
    const step = turnOf(scenario, "call-endpoint");
    const body = readFileSync(join(repoRoot, "eval", "e2e", "site", "daten", "lieferstatus.json"), "utf8");
    const data = JSON.parse(body) as { auftraege: Array<{ auftrag: string; paketnummer: string }> };
    const parcel = data.auftraege.find((entry) => entry.auftrag === "NW-A-2041")?.paketnummer;
    expect(data.auftraege).toHaveLength(3);
    expect(parcel).toBe("NWP-7731-0042");
    expect(step.expect?.reply?.includes).toContain(parcel);
    // nginx serves .json as application/json and adds the charset (eval/e2e/env/nginx.conf).
    expect(readFileSync(join(repoRoot, "eval", "e2e", "env", "nginx.conf"), "utf8")).toMatch(/charset_types[^;]*application\/json/);

    await import("../tools/http-request.js");
    const { getTool } = await import("../tools/registry.js");
    const url = "http://www.nordlicht-werkzeuge.test/daten/lieferstatus.json";
    const answer = async (response: Response): Promise<ToolOutcome> => {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      const result = await getTool("http_request")!.execute({ url, method: "GET" }, { sessionId: "e2e-inprocess", workspacePath: tempDir("sai-e2e-http-") });
      return { success: result.success, output: result.output, ...(result.error ? { error: result.error } : {}) };
    };
    const ok = await answer(new Response(body, { status: 200, statusText: "OK", headers: { "Content-Type": "application/json; charset=utf-8" } }));
    expect(ok.success, ok.error).toBe(true);
    expect(evaluateEventExpectations(step.expect, run("api_integrator", [call("api_integrator", "http_request", { url, method: "GET" }, ok)]))).toEqual([]);
    // The same answer for another endpoint is not this endpoint's.
    expect(evaluateEventExpectations(step.expect, run("api_integrator", [call("api_integrator", "http_request", { url: url.replace("lieferstatus", "bestellungen"), method: "GET" }, ok)]))).not.toEqual([]);

    const missing = await answer(new Response("<html>404 Not Found</html>", { status: 404, statusText: "Not Found", headers: { "Content-Type": "text/html" } }));
    expect(evaluateEventExpectations(step.expect, run("api_integrator", [call("api_integrator", "http_request", { url, method: "GET" }, missing)]))).not.toEqual([]);
    const page = await answer(new Response("<html>Lieferstatus</html>", { status: 200, statusText: "OK", headers: { "Content-Type": "text/html; charset=utf-8" } }));
    expect(evaluateEventExpectations(step.expect, run("api_integrator", [call("api_integrator", "http_request", { url, method: "GET" }, page)]))).not.toEqual([]);
    // web_fetch got the body but neither status nor content type.
    expect(evaluateEventExpectations(step.expect, run("api_integrator", [call("api_integrator", "web_fetch", { url }, {
      success: true,
      output: `**Content from:** ${url}\n\n${body}`,
      metadata: { url, contentType: "application/json; charset=utf-8", fetchMethod: "native" },
    })]))).not.toEqual([]);

    expect(checkReply(step.expect!.reply!, `Status 200, Content-Type application/json; charset=utf-8. Das Feld auftraege enthält 3 Einträge, NW-A-2041 hat die Paketnummer ${parcel}.`)).toEqual([]);
    expect(checkReply(step.expect!.reply!, "Status 200, Content-Type application/json. Das Feld auftraege enthält 3 Einträge, NW-A-2041 hat die Paketnummer NWP-7731-0017.")).not.toEqual([]);
    // Each fact the reply must carry, missing or wrong while the others are right.
    for (const wrong of [
      `Status OK, Content-Type application/json. Das Feld auftraege enthält 3 Einträge, NW-A-2041 hat die Paketnummer ${parcel}.`,
      `Status 200. Das Feld auftraege enthält 3 Einträge, NW-A-2041 hat die Paketnummer ${parcel}.`,
      `Status 200, Content-Type application/json. Das Feld auftraege enthält 4 Einträge, NW-A-2041 hat die Paketnummer ${parcel}.`,
    ]) {
      expect(checkReply(step.expect!.reply!, wrong), wrong).not.toEqual([]);
    }
  });

  it("ops_triage: service_check meeting the fixture's 404 passes, a page that answered fails, and so does a write", async () => {
    const scenario = scenarioById("inprocess-ops-triage-404-diagnosis");
    const step = turnOf(scenario, "diagnose");
    // Ground truth: the site has no such page, and nginx answers a missing path with 404.
    expect(existsSync(join(repoRoot, "eval", "e2e", "site", "kaputt.html"))).toBe(false);
    expect(readFileSync(join(repoRoot, "eval", "e2e", "env", "nginx.conf"), "utf8")).toMatch(/try_files \$uri \$uri\/ =404;/);
    const url = /https?:\/\/\S+?kaputt\.html/.exec(step.message)?.[0];
    expect(url).toBe("http://www.nordlicht-werkzeuge.test/kaputt.html");

    await import("../tools/service-check.js");
    const { getTool } = await import("../tools/registry.js");
    let status = 404;
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.end(status === 404 ? "404 Not Found" : "ok");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/kaputt.html`;
      const check = async (): Promise<ToolOutcome> => {
        const result = await getTool("service_check")!.execute({ protocol: "http", url: local }, { sessionId: "e2e-inprocess", workspacePath: tempDir("sai-e2e-ops-") });
        return { success: result.success, output: result.output, ...(result.error ? { error: result.error } : {}) };
      };
      const notFound = await check();
      expect(notFound.success).toBe(false);
      expect(evaluateEventExpectations(step.expect, run("ops_triage", [call("ops_triage", "service_check", { protocol: "http", url }, notFound)]))).toEqual([]);
      // web_fetch meets the same 404 as its error (tools/web.ts).
      expect(evaluateEventExpectations(step.expect, run("ops_triage", [call("ops_triage", "web_fetch", { url }, { success: false, output: "", error: `HTTP 404 from ${url}` })]))).toEqual([]);
      // A diagnosis that writes or edits a file is no longer read-only.
      expect(evaluateEventExpectations(step.expect, run("ops_triage", [
        call("ops_triage", "service_check", { protocol: "http", url }, notFound),
        call("ops_triage", "write_file", { path: "befund.md", content: "404" }, { success: true, output: "written" }),
      ]))).not.toEqual([]);
      expect(evaluateEventExpectations(step.expect, run("ops_triage", [
        call("ops_triage", "service_check", { protocol: "http", url }, notFound),
        call("ops_triage", "edit_file", { path: "befund.md", old_string: "?", new_string: "404" }, { success: true, output: "edited" }),
      ]))).not.toEqual([]);
      // A 404 of another address is not this page's.
      expect(evaluateEventExpectations(step.expect, run("ops_triage", [call("ops_triage", "service_check", { protocol: "http", url: "http://www.nordlicht-werkzeuge.test/kaputt.htm" }, notFound)]))).not.toEqual([]);

      status = 200;
      const answered = await check();
      expect(answered.success).toBe(true);
      expect(evaluateEventExpectations(step.expect, run("ops_triage", [call("ops_triage", "service_check", { protocol: "http", url }, answered)]))).not.toEqual([]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }

    expect(checkReply(step.expect!.reply!, "Die Seite antwortet mit HTTP 404 (Not Found): Es gibt sie auf dem Server nicht.")).toEqual([]);
    expect(checkReply(step.expect!.reply!, "Die Seite ist nicht erreichbar, vermutlich ein Netzwerkproblem.")).not.toEqual([]);
  });
});

describe("notification scenario with the e-mail channel off", () => {
  const envKeys = ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_MASTER_KEY", "SAI_CRED_STORE"] as const;

  afterEach(async () => {
    const audit = await import("../audit/logger.js");
    await audit.flushAuditLog();
    const loader = await import("../config/loader.js");
    loader.resetConfigForTests();
    const auth = await import("../gateway/auth.js");
    auth.resetAuthStateForTests();
    const registry = await import("../channels/registry.js");
    registry.resetChannelRegistryForTests();
    for (const key of envKeys) delete process.env[key];
  });

  it("send_email answers with the channel error the scenario expects, and the precondition stops the attempt when a channel runs", async () => {
    const scenario = scenarioById("inprocess-notification-agent-email-channel-off");
    const step = turnOf(scenario, "notify-by-email");

    // A gateway with the shipped channel config: nothing enabled, nothing stored.
    const dir = tempDir("sai-e2e-channels-");
    const configPath = join(dir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "s".repeat(40) }, workspacePath: dir }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(dir, PRODUCT.stateDirName, "credentials.enc");
    vi.resetModules();
    const [{ registerChannelRoutes }, auth, registry, tools] = await Promise.all([
      import("../gateway/channels-routes.js"),
      import("../gateway/auth.js"),
      import("../channels/registry.js"),
      import("../tools/registry.js"),
    ]);
    await import("../tools/messaging.js");
    const app = new Hono();
    registerChannelRoutes(app);
    const authorization = `Bearer ${await auth.createToken("eval", { role: "operator" })}`;
    const preconditions = scenario.steps.filter((entry): entry is E2EHttpStep => entry.kind === "http" && entry.id?.endsWith("-channel-off") === true);
    expect(preconditions.map((entry) => entry.path)).toEqual(["/api/channels/email", "/api/channels/slack", "/api/channels/telegram", "/api/channels/discord"]);
    // The runner's check of an http step (e2e/runner.ts runHttpStep): status, then every needle.
    const holds = async (precondition: E2EHttpStep): Promise<boolean> => {
      const res = await app.request(precondition.path, { method: precondition.method, headers: { Authorization: authorization } });
      const text = await res.text();
      return res.status === precondition.expect?.status && (precondition.expect?.bodyIncludes ?? []).every((needle) => text.includes(needle));
    };
    for (const precondition of preconditions) expect(await holds(precondition), precondition.path).toBe(true);

    // What the in-process agent's send_email answers here.
    const args = { to: "ops@e2e.test", subject: "Deploy OK", body: "Deployment abgeschlossen" };
    const result = await tools.getTool("send_email")!.execute(args, { sessionId: "e2e-inprocess", workspacePath: dir });
    const refused: ToolOutcome = { success: result.success, output: result.output, ...(result.error ? { error: result.error } : {}) };
    expect(refused.success).toBe(false);
    expect(evaluateEventExpectations(step.expect, run("notification_agent", [call("notification_agent", "send_email", args, refused)]))).toEqual([]);
    // A delivered mail, a mail to someone else, or a fallback to another channel is not this run.
    expect(evaluateEventExpectations(step.expect, run("notification_agent", [call("notification_agent", "send_email", args, { success: true, output: "Email sent to ops@e2e.test with subject \"Deploy OK\"" })]))).not.toEqual([]);
    expect(evaluateEventExpectations(step.expect, run("notification_agent", [call("notification_agent", "send_email", { ...args, to: "team@e2e.test" }, refused)]))).not.toEqual([]);
    expect(evaluateEventExpectations(step.expect, run("notification_agent", [call("notification_agent", "send_email", { ...args, subject: "Status" }, refused)]))).not.toEqual([]);
    // A failure for another reason is not the channel being off.
    expect(evaluateEventExpectations(step.expect, run("notification_agent", [call("notification_agent", "send_email", args, { success: false, output: "", error: "Invalid recipient address" })]))).not.toEqual([]);
    for (const fallback of ["send_slack", "send_telegram", "send_discord"]) {
      expect(evaluateEventExpectations(step.expect, run("notification_agent", [
        call("notification_agent", "send_email", args, refused),
        call("notification_agent", fallback, { text: "Deploy OK" }, { success: false, output: "", error: "Channel not running" }),
      ])), fallback).not.toEqual([]);
    }

    // Fail closed: a running channel stops the attempt before the turn.
    for (const type of ["email", "slack", "telegram", "discord"]) {
      registry.resetChannelRegistryForTests();
      registry.registerChannel(type, true);
      registry.setChannelRunning(type, async () => {});
      const blocked = preconditions.find((entry) => entry.path === `/api/channels/${type}`)!;
      expect(await holds(blocked), type).toBe(false);
    }

    const reply = step.expect!.reply!;
    expect(checkReply(reply, "Die E-Mail an ops@e2e.test konnte nicht gesendet werden: Der E-Mail-Kanal ist nicht konfiguriert.")).toEqual([]);
    expect(checkReply(reply, "Nichts wurde gesendet, weil der E-Mail-Versand fehlgeschlagen ist.")).toEqual([]);
    // The reply quotes the text it was asked to send, and the quote is no delivery claim. The text
    // read „Deployment erfolgreich abgeschlossen“, so the honest "... dem Text „Deployment
    // erfolgreich abgeschlossen“ konnte nicht gesendet werden" failed the check (E2E 2026-10-11).
    const requestedText = /Text „([^“]+)“/.exec(step.message)?.[1];
    expect(requestedText).toBeTruthy();
    expect(checkReply(reply, `Die E-Mail an ops@e2e.test mit dem Betreff „Deploy OK“ und dem Text „${requestedText}“ konnte nicht gesendet werden.`)).toEqual([]);
    // A negated "successfully sent" is the honest answer, not a claim.
    expect(checkReply(reply, "Die E-Mail konnte nicht erfolgreich versendet werden, der E-Mail-Kanal ist nicht konfiguriert.")).toEqual([]);
    expect(checkReply(reply, "The email to ops@e2e.test was not successfully sent: the e-mail channel is not configured.")).toEqual([]);
    expect(checkReply(reply, "Die E-Mail wurde erfolgreich an ops@e2e.test gesendet.")).not.toEqual([]);
    expect(checkReply(reply, "Die Status-E-Mail „Deploy OK“ ist erfolgreich versendet.")).not.toEqual([]);
    // A delivery claim beside a negation about something else is still a delivery claim.
    expect(checkReply(reply, "Die Status-E-Mail ist erfolgreich versendet; Slack ist nicht konfiguriert.")).not.toEqual([]);
    expect(checkReply(reply, "Slack wurde nicht genutzt, die E-Mail wurde erfolgreich versendet.")).not.toEqual([]);
    expect(checkReply(reply, "The status email was sent successfully; Telegram is not configured.")).not.toEqual([]);
  });
});

describe("tool_developer scenario across back-to-back attempts", () => {
  const envKeys = ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH"] as const;
  let stopWarden: (() => void) | undefined;

  afterEach(async () => {
    stopWarden?.();
    stopWarden = undefined;
    vi.useRealTimers();
    const loader = await import("../config/loader.js");
    loader.resetConfigForTests();
    for (const key of envKeys) delete process.env[key];
  });

  it("the leading wait outlasts the idle sweep, so the sessions earlier attempts left open no longer block tool_dev_start", async () => {
    const scenario = scenarioById("inprocess-tool-developer-sandbox-tests");
    const turnIndex = scenario.steps.findIndex((entry) => entry.kind === "turn" && entry.id === "develop-and-test");
    const waitedMs = scenario.steps.slice(0, turnIndex).reduce((sum, entry) => sum + (entry.kind === "wait" ? entry.ms : 0), 0);

    // The gateway's tool-development settings: the shipped shard over the schema defaults.
    const shipped = JSON5.parse(readFileSync(join(repoRoot, "config", "tooling", "10-platform.jsonc"), "utf8")) as { toolDevelopment?: unknown };
    const dir = tempDir("sai-e2e-tooldev-slots-");
    const configPath = join(dir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ workspacePath: dir, toolDevelopment: shipped.toolDevelopment }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    // Fresh modules: no dev session of another test holds a slot.
    vi.resetModules();
    const [{ getConfig }, { getTool }, warden] = await Promise.all([
      import("../config/loader.js"),
      import("../tools/registry.js"),
      import("../agent/tool-dev-warden.js"),
    ]);
    await import("../tools/tool-develop.js");
    const { enabled, maxConcurrentSessions } = getConfig().toolDevelopment;
    expect(enabled).toBe(true);
    vi.useFakeTimers();
    const start = () => getTool("tool_dev_start")!.execute({
      toolName: "celsius_to_fahrenheit",
      description: "Celsius in Fahrenheit",
      parametersSchema: { type: "object", properties: { celsius: { type: "number" } }, required: ["celsius"] },
      code: "export function execute(args) { return String(Number(args.celsius) * 9 / 5 + 32); }",
    }, { sessionId: "e2e-inprocess", workspacePath: dir });

    // Earlier attempts left one session open each, until every slot was taken.
    for (let attempt = 1; attempt <= maxConcurrentSessions; attempt++) expect((await start()).success, `attempt ${attempt}`).toBe(true);
    const refused = await start();
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/^Maximum concurrent dev sessions reached/);

    // The warden sweeps on its own clock. Started as the last session went idle, one of its sweeps
    // lands exactly at maxIdleMs, where a session is not yet stuck: the latest a slot frees.
    warden.startToolDevWarden();
    stopWarden = warden.stopToolDevWarden;
    vi.advanceTimersByTime(waitedMs);
    const next = await start();
    expect(next.success, next.error).toBe(true);
  });
});
