/**
 * decisions:readout — does the incumbent read by its logits answer as the incumbent does? Each case goes to the
 * point's parsed incumbent (the routing-tier call and parser a turn makes today) and to the logit readout of the
 * same point on the same model (decisions/logit-readout.ts: one token, thinking off, the option letters' top list),
 * and once more to the readout with the options in reverse order. agent/decisions-readout.ts scores the run:
 *
 *   (a) whether top_logprobs arrive, (b) agreement with the parsed answer (target 95%), (c) wall time per call,
 *   (d) ECE before and after a temperature fitted on the calibration half, on the test half, (e) flips under the
 *   swapped order — per point and language — and the temperatures to configure (decisions.readout.temperatures).
 *
 *   pnpm --filter @starlingai/core decisions:readout [--points fast_lane,source_sensitive] [--cases <jsonl>]
 *     [--bootstrap <jsonl> | --no-bootstrap] [--per-language 20] [--top-logprobs 20] [--min-mass 0.5]
 *     [--target 0.95] [--no-swap] [--out <dir>]
 *
 * Cases: the hand-labelled eval/decisions/<point>.jsonl (or .example.jsonl), then the bootstrap ledger's synthetic
 * messages (.starlingai/decisions/bootstrap-ledger.jsonl), up to --per-language per point and language (0: all).
 * The parsed arm is scripts/decisions-bootstrap.ts labelFastLane / labelSourceSensitive, exactly as decisions:bench
 * runs it; a fast-lane message the front desk would not hand to its model is left out before the quota, as no turn
 * would ask it.
 * The arms alternate which goes first, one case at a time. Calls run one after another, never in parallel.
 *
 * Never written: the gateway's audit log and ledgers. This run's provider calls are audited to <out>/audit.jsonl;
 * the per-case rows (they hold the messages) go to <out>/rows.jsonl, under .starlingai, which git ignores. The
 * report is <out>/report.json and report.md, default .starlingai/live-check/decisions-readout/<time>/.
 *
 * About 3 calls per case (2 without the swap): at the defaults, 80 cases and ~240 calls of ~1 s.
 *
 * Exit codes: 0 every point measured meets the target, 1 a point is below it or no top list arrived, 2 a usage
 * mistake or nothing could be judged, 3 the environment is suspect (the model unreachable, or more than a fifth of
 * the calls failed). pnpm reports every non-zero code as 1, so the verdict is also printed.
 */
// MUST be first: loads .env before config/loader.ts is evaluated with an empty environment.
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { benchSplit, caseMessage, isBenchPoint, lintDecisionCases, parseDecisionCases, type BenchPointId, type DecisionBenchCase } from "../agent/decisions-bench.js";
import {
  buildReadoutReport,
  casesFromBootstrap,
  casesFromFixtures,
  DEFAULT_AGREEMENT_TARGET,
  DEFAULT_PER_LANGUAGE,
  readoutArm,
  renderReadoutMarkdown,
  selectCases,
  swappedOrder,
  type ReadoutBenchCase,
  type ReadoutBenchResult,
} from "../agent/decisions-readout.js";
import { captureEvaluationHardwareState, captureEvaluationSourceState } from "../agent/evaluation-provenance.js";
import { classifyFrontDesk } from "../agent/receptionist.js";
import { resolveRoutingTierProvider } from "../agent/routing-tier-provider.js";
import { warmTextLanguageDetector } from "../agent/text-language.js";
import { getConfig, loadConfig } from "../config/loader.js";
import { readLedgerRows } from "../decisions/ledger.js";
import { askReadout, DEFAULT_MIN_LETTER_MASS, MAX_TOP_LOGPROBS } from "../decisions/logit-readout.js";
import { DECISION_POINTS } from "../decisions/points.js";
import { getChatProviderForTier } from "../providers/index.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { labelFastLane, labelSourceSensitive } from "./decisions-bootstrap.js";

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["points", "cases", "bootstrap", "per-language", "top-logprobs", "min-mass", "target", "out"]);
const SWITCHES = new Set(["no-bootstrap", "no-swap"]);
/** More failed calls than this share and the run describes the environment, not the readout. */
const MAX_FAILURE_SHARE = 0.2;
const WARM_UP_MESSAGE = "Warm-up.";
const AGENT_NAME: Record<BenchPointId, string> = { fast_lane: "receptionist", source_sensitive: "source_sensitivity_judge" };

function parseArgs(argv: readonly string[]): { values: Map<string, string>; switches: Set<string> } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    // pnpm passes a separating "--" through to the script.
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument "${token}"`);
    const name = token.slice(2);
    if (SWITCHES.has(name)) {
      switches.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      values.set(name, value);
      i += 1;
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { values, switches };
}

function numberFlag(values: Map<string, string>, name: string, fallback: number, check: (n: number) => boolean, what: string): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !check(value)) throw new UsageError(`--${name} takes ${what} (got "${raw}")`);
  return value;
}

function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/** The committed example unless the deployment keeps its own cases beside it (decisions:bench's rule). */
function defaultCaseFile(point: BenchPointId): string {
  const own = join(REPO_ROOT, "eval", "decisions", `${point}.jsonl`);
  return existsSync(own) ? own : join(REPO_ROOT, "eval", "decisions", `${point}.example.jsonl`);
}

/** Would the front desk hand this message to its model? The same gate and settings labelFastLane applies. */
function frontDeskLets(message: string): boolean {
  const settings = getConfig().receptionist;
  const confidenceAttempt = settings?.confidenceAttempt === true;
  return classifyFrontDesk(message, {
    alwaysEscalateTerms: settings?.alwaysEscalateTerms,
    confidenceAttempt,
    ...(settings?.confidenceAttemptMaxChars !== undefined ? { confidenceMaxChars: settings.confidenceAttemptMaxChars } : {}),
  }).fastLane;
}

async function main(): Promise<number> {
  const { values, switches } = parseArgs(process.argv.slice(2));
  // Under `pnpm --filter` the working directory is packages/core, whose stub config declares no routing tier and no
  // receptionist: the parsed arm would be a different call from the one a turn makes.
  const here = resolve(process.cwd());
  const root = resolve(REPO_ROOT);
  if (!process.env["SAI_CONFIG_PATH"]?.trim() && (process.platform === "win32" ? here.toLowerCase() !== root.toLowerCase() : here !== root)) {
    throw new UsageError(`run from the repository root (${REPO_ROOT}); the package script does \`cd ../..\` first. Here the config loader would read ${process.cwd()}.`);
  }
  const points = (values.get("points") ?? "fast_lane,source_sensitive").split(",").map((point) => point.trim()).filter(Boolean);
  for (const point of points) {
    if (!isBenchPoint(point)) throw new UsageError(`--points: "${point}" has no parsed incumbent this bench can run (fast_lane, source_sensitive)`);
  }
  const perLanguage = numberFlag(values, "per-language", DEFAULT_PER_LANGUAGE, (n) => Number.isInteger(n) && n >= 0, "a whole number of cases, 0 for all");
  const topLogprobs = numberFlag(values, "top-logprobs", MAX_TOP_LOGPROBS, (n) => Number.isInteger(n) && n >= 2 && n <= MAX_TOP_LOGPROBS, `a whole number from 2 to ${MAX_TOP_LOGPROBS}`);
  const minMass = numberFlag(values, "min-mass", DEFAULT_MIN_LETTER_MASS, (n) => n >= 0 && n <= 1, "a share between 0 and 1");
  const target = numberFlag(values, "target", DEFAULT_AGREEMENT_TARGET, (n) => n > 0 && n <= 1, "an agreement between 0 and 1");
  const swap = !switches.has("no-swap");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = fromRoot(values.get("out") ?? join(".starlingai", "live-check", "decisions-readout", stamp));
  await mkdir(outDir, { recursive: true });
  // This run's provider calls are audited here, never in the gateway's log; nothing writes a ledger, and should
  // anything try, it lands here too.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");
  process.env["SAI_DECISIONS_LEDGER"] = join(outDir, "unused-decision-ledger.jsonl");
  const source = captureEvaluationSourceState(REPO_ROOT);
  const hardware = captureEvaluationHardwareState();

  // Loaded without writing its compiled copy: from the repo root that is ./starlingai.json, the live gateway's config.
  const config = loadConfig({ skipCompiledWrite: true });
  config.workspacePath = outDir;
  // The parsed arm must be the parsed call alone: no Laya, no readout wrapped around it.
  config.decisions.baseUrl = "";
  config.decisions.readout = { ...config.decisions.readout, defaultMode: "off", points: {} };
  config.decisions.ledger = { ...config.decisions.ledger, enabled: false };

  // The cases.
  const fixtures: DecisionBenchCase[] = [];
  const caseFiles = values.get("cases") ? [fromRoot(values.get("cases")!)] : points.map((point) => defaultCaseFile(point as BenchPointId));
  for (const file of caseFiles) {
    const text = await readFile(file, "utf8").catch(() => { throw new UsageError(`cannot read the case file ${file}`); });
    fixtures.push(...parseDecisionCases(text));
  }
  const problems = lintDecisionCases(fixtures);
  if (problems.length) throw new UsageError(`the cases cannot be measured:\n  - ${problems.join("\n  - ")}`);
  const bootstrapPath = values.get("bootstrap") ? fromRoot(values.get("bootstrap")!) : join(REPO_ROOT, ".starlingai", "decisions", "bootstrap-ledger.jsonl");
  const bootstrap = switches.has("no-bootstrap") ? [] : casesFromBootstrap(await readLedgerRows(bootstrapPath));
  // The front desk hands only short conversational messages to its model; any other message never reaches the fast
  // lane's question on a turn. Left out before the quota, so each point and language still gets its cases asked.
  const candidates = [...casesFromFixtures(fixtures), ...bootstrap];
  const gated = candidates.filter((c) => c.point === "fast_lane" && !frontDeskLets(caseMessage(c)));
  const selected: ReadoutBenchCase[] = selectCases(candidates.filter((c) => !gated.includes(c)), points, perLanguage);
  if (selected.length === 0) throw new UsageError("no case matches --points");

  await warmTextLanguageDetector();
  const judgeProvider = resolveRoutingTierProvider();
  // The receptionist's lane runs its tier with reasoning off (agent/receptionist.ts); its readout asks the same model.
  const receptionistProvider = getChatProviderForTier("routing", { reasoningEffort: "none" }) ?? judgeProvider;
  const providerFor = (point: BenchPointId): ChatProvider => (point === "fast_lane" ? receptionistProvider : judgeProvider);
  const tierModel = config.agents.defaults.model.tiers?.["routing"] ?? config.agents.defaults.model.primary;
  const environment: string[] = [];
  const health = await judgeProvider.checkHealth().catch((err: unknown) => ({ healthy: false, error: err instanceof Error ? err.message : String(err) }));
  if (!health.healthy) environment.push(`the routing tier (${config.providers.lmstudio?.baseUrl ?? "?"}, ${tierModel}) is unreachable${health.error ? `: ${health.error}` : ""}`);
  const header = [
    `Run ${stamp}, git ${source.revision?.slice(0, 12) ?? "?"}${source.status?.trim() ? " (dirty tree)" : ""}.`,
    `Model: routing tier ${tierModel} at ${config.providers.lmstudio?.baseUrl ?? "?"}; readout top ${topLogprobs}, min letter mass ${minMass}.`,
    `Cases: ${selected.length} (${selected.filter((c) => c.source === "fixture").length} hand-labelled, ${selected.filter((c) => c.source === "bootstrap").length} bootstrap), up to ${perLanguage || "all"} per point and language; `
      + `${gated.length} fast-lane message(s) left out, which the front desk would not hand to its model; order swap ${swap ? "on" : "off"}.`,
  ];
  console.log(header.join("\n"));
  const reportPath = join(outDir, "report.json");
  const markdownPath = join(outDir, "report.md");
  if (environment.length) {
    await writeFile(reportPath, `${JSON.stringify({ verdict: "environment-suspect", environment, header, source: { revision: source.revision }, hardware }, null, 2)}\n`, "utf8");
    console.error(`\nENVIRONMENT: ${environment.join("; ")}\nNo case was run.`);
    return 3;
  }

  // (a) first, on a message outside the dataset, untimed: a cold model measures the load, and a server that sends no
  // top list at all is the answer to (a) — the rest would only be misses.
  const probes: Record<string, unknown> = {};
  for (const point of points as BenchPointId[]) {
    const probe = await runWithCallAttribution({ callSite: "routing_tier", agentName: `${AGENT_NAME[point]}_readout` }, () =>
      askReadout(providerFor(point), DECISION_POINTS[point], { message: WARM_UP_MESSAGE }, { topLogprobs, minMass }));
    probes[point] = readoutArm(probe);
    await (point === "fast_lane" ? labelFastLane(receptionistProvider, WARM_UP_MESSAGE) : labelSourceSensitive(judgeProvider, WARM_UP_MESSAGE)).catch(() => undefined);
  }
  console.log(`Top lists on the warm-up: ${Object.entries(probes).map(([point, arm]) => `${point} ${(arm as { logprobs: boolean }).logprobs ? "arrived" : "MISSING"}`).join(", ")}`);

  const rowsPath = join(outDir, "rows.jsonl");
  const results: ReadoutBenchResult[] = [];
  let index = 0;
  for (const benchCase of selected) {
    const point = benchCase.point;
    const message = String(benchCase.state["message"] ?? "");
    const result: ReadoutBenchResult = {
      caseId: benchCase.id,
      point,
      language: benchCase.language,
      split: benchSplit(benchCase.id),
      source: benchCase.source,
      ...(benchCase.gold !== undefined ? { gold: benchCase.gold } : {}),
    };
    const provider = providerFor(point);
    const runParsed = async () => {
      const started = performance.now();
      try {
        const choice = await runWithCallAttribution({ callSite: "routing_tier", agentName: AGENT_NAME[point] }, () =>
          (point === "fast_lane" ? labelFastLane(provider, message) : labelSourceSensitive(provider, message)));
        result.parsed = { ...(choice !== undefined ? { choice } : { error: "the reply held no answer" }), ms: performance.now() - started };
      } catch (err) {
        result.parsed = { ms: performance.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const ask = (order?: readonly string[]) => runWithCallAttribution({ callSite: "routing_tier", agentName: `${AGENT_NAME[point]}_readout` }, () =>
      askReadout(provider, DECISION_POINTS[point], benchCase.state, { topLogprobs, minMass, signal: AbortSignal.timeout(60_000), ...(order ? { order } : {}) }));
    const runReadout = async () => {
      result.readout = readoutArm(await ask());
    };
    // Alternate which arm goes first, so a server that slows down during the run weighs on both.
    const arms = index % 2 === 0 ? [runParsed, runReadout] : [runReadout, runParsed];
    for (const arm of arms) await arm();
    if (swap) result.swapped = readoutArm(await ask(swappedOrder(point)));
    index += 1;
    results.push(result);
    await appendFile(rowsPath, `${JSON.stringify({ ...result, state: benchCase.state })}\n`, { encoding: "utf8", mode: 0o600 });
    const shown = `parsed ${result.parsed?.choice ?? result.parsed?.error ?? "–"} ${Math.round(result.parsed?.ms ?? 0)} ms | readout ${result.readout?.choice ? `${result.readout.choice} ${result.readout.top?.toFixed(2)}` : result.readout?.miss ?? "–"} ${Math.round(result.readout?.ms ?? 0)} ms`
      + (result.swapped ? ` | swapped ${result.swapped.choice ?? result.swapped.miss ?? "–"}` : "");
    console.log(`  [${index}/${selected.length}] ${benchCase.id} (${benchCase.language}${benchCase.gold ? `, gold ${benchCase.gold}` : ""}) ${shown}`);
  }

  const asked = results.filter((result) => !result.gated);
  const failedShare = (count: number) => asked.length > 0 && count / asked.length > MAX_FAILURE_SHARE;
  if (failedShare(asked.filter((result) => result.parsed?.error !== undefined && result.parsed.error !== "the reply held no answer").length)) {
    environment.push(`more than ${MAX_FAILURE_SHARE * 100}% of the parsed calls failed`);
  }
  if (failedShare(asked.filter((result) => result.readout?.miss === "error").length)) {
    environment.push(`more than ${MAX_FAILURE_SHARE * 100}% of the readout calls failed`);
  }
  const report = buildReadoutReport(results, target);
  const exitCode = environment.length ? 3 : report.exitCode;
  await writeFile(reportPath, `${JSON.stringify({ exitCode, environment, header, probes, source: { revision: source.revision, dirty: Boolean(source.status?.trim()) }, hardware, report }, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderReadoutMarkdown(report, [...header, ...(environment.length ? [`ENVIRONMENT-SUSPECT: ${environment.join("; ")}`] : [])]), "utf8");

  console.log("");
  for (const entry of report.points) console.log(`  ${entry.point.padEnd(17)} ${entry.verdict.toUpperCase().padEnd(13)} ${entry.reasons.join("; ")}`);
  if (environment.length) console.error(`\nENVIRONMENT-SUSPECT RUN — not a verdict:\n  - ${environment.join("\n  - ")}`);
  console.log(`\nReport: ${markdownPath}\nJSON:   ${reportPath}\nRows:   ${rowsPath} (holds the messages; keep it local)`);
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`usage: ${err.message}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(3);
  });
}
