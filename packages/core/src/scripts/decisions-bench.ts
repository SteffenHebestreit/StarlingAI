/**
 * decisions:bench — does Laya pay off at a decision point? Each labelled case goes to the point's incumbent, the
 * routing-tier call a turn makes today, and to the Laya sidecar, one after the other. The report compares both with
 * the gold label and with each other, replays the adaptive gate on held-out cases and projects the seconds it
 * would save (agent/decisions-bench.ts has the arithmetic and why agreement alone is not enough).
 *
 *   pnpm --filter @starlingai/core decisions:bench [--points fast_lane,source_sensitive] [--cases <jsonl>]
 *     [--laya-url http://127.0.0.1:18080] [--no-incumbent] [--no-laya] [--repeat 1] [--split all|calibration|test]
 *     [--target 0.9] [--min 30] [--audit-rate 0.1] [--max-rare-miss 0.1]
 *     [--frequency fast_lane=0.6,source_sensitive=1] [--prior fast_lane=0.06] [--train-out <jsonl>] [--out <dir>]
 *     [--negation] [--order-swap]
 *
 * The incumbent arm is the production path: the configured routing tier (from the repo root, the llama-swap
 * address in .env and the tier's model selector), with the incumbents' own prompts and parsers
 * (scripts/decisions-bootstrap.ts labelFastLane and labelSourceSensitive — neither touches the decision layer).
 * The fast lane's front-desk gate runs first, as on a turn: a message it would not hand to its model is recorded as
 * gated and neither arm is asked. The Laya arm is decisions/laya-client.ts askLaya itself, so the question, the
 * options, the state and the timeout are the ones a turn sends. The two arms alternate which goes first, one case
 * at a time, so a backend that slows down during the run weighs on both.
 *
 * Never written: the gateway's audit log and decision ledger. This run's provider calls are audited to <out>/audit.jsonl,
 * and the per-case rows (the ledger's format plus the gold label and the case id) go to <out>/rows.jsonl. That file
 * holds the messages: it stays under .starlingai, which git ignores. The report is <out>/report.json and report.md.
 *
 * --train-out writes the calibration half, labelled by the incumbent, in the fine-tuning format of
 * decisions:export. A checkpoint trained on it is scored on cases it never saw with --split test.
 *
 * --negation adds the negation minimal pairs (eval/decisions/negation.example.jsonl) for the selected points: both
 * arms answer them, and the report shows per pair whether an arm read the negation. They take no part in the gate
 * replay, the projection or the verdict, and --split leaves them whole. --order-swap asks Laya every case a second
 * time with the point's options in reverse order and reports how often its choice changed with the order.
 *
 * Exit codes: 0 judged and nothing unsafe, 1 a point's replayed gate would take cases it gets wrong or lose its rare
 * class, 2 a usage mistake or nothing could be judged, 3 the environment is suspect (a backend unreachable, or more
 * than a fifth of the calls failed). pnpm reports every non-zero code as 1, so the verdict is also printed.
 */
// MUST be first: loads .env before config/loader.ts is evaluated with an empty environment.
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  benchLedgerRow,
  benchSplit,
  buildBenchReport,
  caseMessage,
  isBenchPoint,
  lintDecisionCases,
  parseDecisionCases,
  profileDataset,
  readTimings,
  renderBenchMarkdown,
  reversedOptions,
  type BenchPointId,
  type BenchReportSettings,
  type BenchResult,
  type BenchRow,
  type DecisionBenchCase,
} from "../agent/decisions-bench.js";
import { captureEvaluationHardwareState, captureEvaluationSourceState } from "../agent/evaluation-provenance.js";
import { classifyFrontDesk } from "../agent/receptionist.js";
import { resolveRoutingTierProvider } from "../agent/routing-tier-provider.js";
import { detectTextLanguage, warmTextLanguageDetector } from "../agent/text-language.js";
import { subscribeToAudit } from "../audit/logger.js";
import type { AuditEvent } from "../audit/schema.js";
import { getConfig, loadConfig } from "../config/loader.js";
import { languageBucket } from "../decisions/gate.js";
import { askLaya, layaHealth } from "../decisions/laya-client.js";
import { DECISION_POINTS } from "../decisions/points.js";
import { getChatProviderForTier } from "../providers/index.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { labelFastLane, labelSourceSensitive } from "./decisions-bootstrap.js";
import { buildTrainingItems } from "./decisions-export.js";
import { buildDecisionReport } from "./decisions-report.js";

class UsageError extends Error {}

const VALUE_FLAGS = new Set([
  "points", "cases", "laya-url", "repeat", "split", "target", "min", "audit-rate", "max-rare-miss", "frequency", "prior", "train-out", "out",
]);
const SWITCHES = new Set(["no-incumbent", "no-laya", "negation", "order-swap"]);
const DEFAULT_LAYA_URL = "http://127.0.0.1:18080";
/** More failed calls than this share and the run describes the environment, not the decision. */
const MAX_FAILURE_SHARE = 0.2;
const WARM_UP_MESSAGE = "Warm-up.";

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

/** "fast_lane=0.6,source_sensitive=1" → per point. */
function perPointFlag(values: Map<string, string>, name: string, check: (n: number) => boolean): Partial<Record<BenchPointId, number>> {
  const raw = values.get(name);
  const out: Partial<Record<BenchPointId, number>> = {};
  if (raw === undefined) return out;
  for (const part of raw.split(",")) {
    const [point, value] = part.split("=").map((piece) => piece.trim());
    const n = Number(value);
    if (!point || !isBenchPoint(point) || !Number.isFinite(n) || !check(n)) throw new UsageError(`--${name} takes point=value pairs for fast_lane or source_sensitive (got "${part}")`);
    out[point] = n;
  }
  return out;
}

function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/** The committed example unless the deployment keeps its own cases beside it (eval/routing's pattern). */
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

/** The state a turn hands the point (agent/receptionist.ts, agent/runtime.ts). */
function stateFor(point: BenchPointId, message: string): Record<string, unknown> {
  return { message: point === "source_sensitive" ? message.slice(0, 2_000) : message };
}

const AGENT_NAME: Record<BenchPointId, string> = { fast_lane: "receptionist", source_sensitive: "source_sensitivity_judge" };

async function main(): Promise<number> {
  const { values, switches } = parseArgs(process.argv.slice(2));
  // Under `pnpm --filter` the working directory is packages/core, whose stub starlingai.json declares no agents, no
  // receptionist and no routing tier: the incumbent would be a different call from the one a turn makes.
  // Windows paths compare without case: a shell may report the drive as f: where Node reports F:.
  const here = resolve(process.cwd());
  const root = resolve(REPO_ROOT);
  if (!process.env["SAI_CONFIG_PATH"]?.trim() && (process.platform === "win32" ? here.toLowerCase() !== root.toLowerCase() : here !== root)) {
    throw new UsageError(`run from the repository root (${REPO_ROOT}); the package script does \`cd ../..\` first. Here the config loader would read ${process.cwd()}.`);
  }
  const useIncumbent = !switches.has("no-incumbent");
  const useLaya = !switches.has("no-laya");
  if (!useIncumbent && !useLaya) throw new UsageError("--no-incumbent and --no-laya together leave nothing to run");
  const points = (values.get("points") ?? "fast_lane,source_sensitive").split(",").map((point) => point.trim()).filter(Boolean);
  for (const point of points) if (!isBenchPoint(point)) throw new UsageError(`--points: "${point}" has no bench incumbent (fast_lane, source_sensitive)`);
  const repeat = numberFlag(values, "repeat", 1, (n) => Number.isInteger(n) && n >= 1, "a whole number of runs per case, 1 or more");
  const split = values.get("split") ?? "all";
  if (!["all", "calibration", "test"].includes(split)) throw new UsageError(`--split takes all, calibration or test (got "${split}")`);
  const trainOut = values.get("train-out");
  if (trainOut && !useIncumbent) throw new UsageError("--train-out writes the incumbent's labels: it needs the incumbent arm");
  const layaUrl = (values.get("laya-url") ?? DEFAULT_LAYA_URL).trim();
  const orderSwap = switches.has("order-swap");
  if (orderSwap && !useLaya) throw new UsageError("--order-swap asks Laya twice: it needs the Laya arm");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = fromRoot(values.get("out") ?? join(".starlingai", "live-check", "decisions-bench", stamp));
  await mkdir(outDir, { recursive: true });
  // This run's provider calls are audited here, never in the gateway's log; nothing writes a decision ledger, and
  // should anything try, it lands here too, never where the gateway rebuilds its gate from.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");
  process.env["SAI_DECISIONS_LEDGER"] = join(outDir, "unused-decision-ledger.jsonl");
  const source = captureEvaluationSourceState(REPO_ROOT);
  const hardware = captureEvaluationHardwareState();

  // Loaded without writing its compiled copy: from the repo root that is ./starlingai.json, the live gateway's config.
  const config = loadConfig({ skipCompiledWrite: true });
  config.workspacePath = outDir;
  config.decisions.baseUrl = useLaya ? layaUrl : "";
  config.decisions.defaultMode = "off";
  config.decisions.points = {};
  config.decisions.ledger = { ...config.decisions.ledger, enabled: false };
  const target = numberFlag(values, "target", config.decisions.adaptive.targetAgreement, (n) => n >= 0.5 && n <= 1, "an agreement between 0.5 and 1");
  const min = numberFlag(values, "min", config.decisions.adaptive.minSamples, (n) => Number.isInteger(n) && n >= 1, "a whole number of cases");
  const auditRate = numberFlag(values, "audit-rate", config.decisions.adaptive.auditRate, (n) => n >= 0 && n <= 1, "a share between 0 and 1");
  const maxRareMiss = numberFlag(values, "max-rare-miss", 0.1, (n) => n >= 0 && n <= 1, "a share between 0 and 1");
  const frequencies = perPointFlag(values, "frequency", (n) => n >= 0);
  const priors = perPointFlag(values, "prior", (n) => n > 0 && n < 1);

  // The cases.
  const casesArg = values.get("cases");
  const files = casesArg ? [fromRoot(casesArg)] : points.map((point) => defaultCaseFile(point as BenchPointId));
  if (switches.has("negation")) files.push(join(REPO_ROOT, "eval", "decisions", "negation.example.jsonl"));
  const cases: DecisionBenchCase[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => { throw new UsageError(`cannot read the case file ${file}`); });
    cases.push(...parseDecisionCases(text));
  }
  const problems = lintDecisionCases(cases);
  if (problems.length) throw new UsageError(`the cases cannot be measured:\n  - ${problems.join("\n  - ")}`);
  // A negation pair is kept whole: its two cases are compared with each other, not split between halves.
  const selected = cases.filter((benchCase) => points.includes(benchCase.point) && (split === "all" || benchCase.pair !== undefined || benchSplit(benchCase.id) === split));
  if (selected.length === 0) throw new UsageError("no case matches --points and --split");
  if (!config.receptionist?.enabled && points.includes("fast_lane")) {
    console.warn("receptionist.enabled is off in this config: no turn asks fast_lane, whatever this run measures.");
  }

  // The production path, and a check that both ends answer before any case is run.
  await warmTextLanguageDetector();
  const judgeProvider = resolveRoutingTierProvider();
  // The receptionist's lane runs its tier with reasoning off (agent/receptionist.ts).
  const receptionistProvider = getChatProviderForTier("routing", { reasoningEffort: "none" }) ?? judgeProvider;
  const tierModel = config.agents.defaults.model.tiers?.["routing"] ?? config.agents.defaults.model.primary;
  const environment: string[] = [];
  if (useIncumbent) {
    const health = await judgeProvider.checkHealth().catch((err: unknown) => ({ healthy: false, error: err instanceof Error ? err.message : String(err) }));
    if (!health.healthy) environment.push(`the routing tier (${config.providers.lmstudio?.baseUrl ?? "?"}, ${tierModel}) is unreachable${health.error ? `: ${health.error}` : ""}`);
  }
  let laya: Record<string, unknown> | null = null;
  if (useLaya) {
    laya = await layaHealth(5_000);
    if (!laya) environment.push(`the Laya sidecar at ${layaUrl} does not answer /health`);
  }
  const header = [
    `Run ${stamp}, git ${source.revision?.slice(0, 12) ?? "?"}${source.status?.trim() ? " (dirty tree)" : ""}.`,
    useIncumbent ? `Incumbent: routing tier ${tierModel} at ${config.providers.lmstudio?.baseUrl ?? "?"}.` : "Incumbent: not run (--no-incumbent); the gate is replayed against gold.",
    useLaya ? `Laya: ${layaUrl}, ${String(laya?.["device"] ?? "device unknown")}, timeout ${config.decisions.timeoutMs} ms${orderSwap ? ", every case asked again with the options reversed (--order-swap)" : ""}.` : "Laya: not run (--no-laya).",
    `Cases: ${selected.length} (${files.map((file) => file.replace(REPO_ROOT, ".")).join(", ")}), split ${split}, repeat ${repeat}.`,
  ];
  console.log(header.join("\n"));
  const reportPath = join(outDir, "report.json");
  const markdownPath = join(outDir, "report.md");
  if (environment.length) {
    await writeFile(reportPath, `${JSON.stringify({ verdict: "environment-suspect", environment, header, laya, source: { revision: source.revision }, hardware }, null, 2)}\n`, "utf8");
    console.error(`\nENVIRONMENT: ${environment.join("; ")}\nNo case was run.`);
    return 3;
  }

  // Warm both ends once, untimed, on a message outside the dataset: the first call to a cold model or a cold
  // sidecar measures the load, not the decision.
  for (const point of points as BenchPointId[]) {
    if (useLaya) await askLaya(DECISION_POINTS[point], stateFor(point, WARM_UP_MESSAGE));
    if (useIncumbent) {
      await (point === "fast_lane" ? labelFastLane(receptionistProvider, WARM_UP_MESSAGE) : labelSourceSensitive(judgeProvider, WARM_UP_MESSAGE)).catch(() => undefined);
    }
  }

  // Every provider row the incumbent's call produces: more than one is a retry or a failover, and the last one
  // carries llama-server's own timings once the provider records them.
  let callRows: AuditEvent[] = [];
  const unsubscribe = subscribeToAudit((event) => {
    if (event.type === "provider_model_call") callRows.push(event);
  });

  const rowsPath = join(outDir, "rows.jsonl");
  const results: BenchResult[] = [];
  const rows: BenchRow[] = [];
  let index = 0;
  try {
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      for (const benchCase of selected) {
        const point = benchCase.point as BenchPointId;
        const message = caseMessage(benchCase);
        const state = stateFor(point, message);
        const result: BenchResult = {
          caseId: benchCase.id,
          point,
          language: benchCase.language,
          gateLanguage: languageBucket(detectTextLanguage(message)?.code),
          ...(benchCase.gold !== undefined ? { gold: benchCase.gold } : {}),
          split: benchSplit(benchCase.id),
          attempt,
          ...(benchCase.tags?.length ? { tags: benchCase.tags } : {}),
          ...(benchCase.pair !== undefined ? { pair: benchCase.pair } : {}),
        };
        if (point === "fast_lane" && !frontDeskLets(message)) {
          result.gated = true;
        } else {
          const runIncumbent = async () => {
            callRows = [];
            const started = performance.now();
            const provider = point === "fast_lane" ? receptionistProvider : judgeProvider;
            try {
              const choice = await runWithCallAttribution({ callSite: "routing_tier", agentName: AGENT_NAME[point] }, () =>
                (point === "fast_lane" ? labelFastLane(provider as ChatProvider, message) : labelSourceSensitive(provider as ChatProvider, message)));
              result.incumbent = { ...(choice !== undefined ? { choice } : { error: "the reply held no answer" }), ms: performance.now() - started };
            } catch (err) {
              result.incumbent = { ms: performance.now() - started, error: err instanceof Error ? err.message : String(err) };
            }
            const mine = callRows.filter((row) => row.data["agentName"] === AGENT_NAME[point]);
            const last = mine.at(-1);
            result.incumbent.calls = mine.length;
            if (typeof last?.data["model"] === "string") result.incumbent.model = last.data["model"];
            const timings = readTimings(last?.data["timings"]);
            if (timings) result.incumbent.timings = timings;
          };
          const runLaya = async () => {
            const started = performance.now();
            const answer = await askLaya(DECISION_POINTS[point], state);
            if (answer) result.laya = answer;
            else result.layaFailure = { ms: performance.now() - started, error: "no usable answer: timed out, failed, or answered outside the options" };
            if (orderSwap) {
              // The same question with the options reversed: the option under A is now under B.
              const swapped = { ...DECISION_POINTS[point], options: reversedOptions(DECISION_POINTS[point].options) };
              const again = await askLaya(swapped, state);
              if (again) result.layaSwapped = again;
            }
          };
          // Alternate which arm goes first.
          const arms = [...(useIncumbent ? [runIncumbent] : []), ...(useLaya ? [runLaya] : [])];
          if (index % 2 === 1) arms.reverse();
          for (const arm of arms) await arm();
        }
        index += 1;
        results.push(result);
        const row = benchLedgerRow(result, state, new Date().toISOString());
        rows.push(row);
        await appendFile(rowsPath, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
        const shown = result.gated ? "gated" : `incumbent ${result.incumbent?.choice ?? (useIncumbent ? "–" : "off")} ${result.incumbent ? `${Math.round(result.incumbent.ms)} ms` : ""} | laya ${result.laya ? `${result.laya.choice} ${result.laya.top.toFixed(2)} ${Math.round(result.laya.ms)} ms` : useLaya ? "failed" : "off"}`;
        console.log(`  [${index}/${selected.length * repeat}] ${benchCase.id} (${benchCase.gold ?? "?"}) ${shown}`);
      }
    }
  } finally {
    unsubscribe();
  }

  const settings: BenchReportSettings = {
    gate: { targetAgreement: target, minSamples: min },
    reference: useIncumbent ? "incumbent" : "gold",
    projection: { auditRate, timeToFirstTokenMs: 8_200, turnMs: 46_700 },
    verdict: { targetAgreement: target, maxRareMiss },
    overrides: Object.fromEntries((points as BenchPointId[]).map((point) => [point, {
      ...(frequencies[point] !== undefined ? { frequencyPerTurn: frequencies[point] } : {}),
      ...(priors[point] !== undefined ? { rareClassPrior: priors[point] } : {}),
    }])),
  };
  const report = buildBenchReport(results, settings);

  const asked = results.filter((result) => !result.gated);
  const failed = (count: number) => asked.length > 0 && count / asked.length > MAX_FAILURE_SHARE;
  if (useIncumbent && failed(asked.filter((result) => result.incumbent?.error && result.incumbent.error !== "the reply held no answer").length)) {
    environment.push(`more than ${MAX_FAILURE_SHARE * 100}% of the incumbent's calls failed`);
  }
  if (useLaya && failed(asked.filter((result) => result.layaFailure).length)) environment.push(`more than ${MAX_FAILURE_SHARE * 100}% of Laya's answers failed`);

  let trainItems = 0;
  if (trainOut) {
    // Not the negation pairs: they measure whether a checkpoint reads a negation, and must stay unseen by it.
    const calibration = rows.filter((row) => row.split === "calibration" && !row.gated && !row.pair && row.incumbent);
    const items = buildTrainingItems(calibration);
    const path = fromRoot(trainOut);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""), "utf8");
    trainItems = items.length;
    console.log(`\nWrote ${items.length} calibration cases, labelled by the incumbent, to ${path}.`);
  }

  // Laya never answered: an incumbent-only run is judged by whether the incumbent could be scored against gold.
  const incumbentOnlyScored = !useLaya && asked.some((result) => result.incumbent?.choice !== undefined && result.gold !== undefined);
  const exitCode = environment.length ? 3 : incumbentOnlyScored ? 0 : report.exitCode;
  const json = {
    verdict: environment.length ? "environment-suspect" : report.points.map((point) => ({ point: point.point, model: point.model, verdict: point.verdict, reasons: point.reasons })),
    exitCode,
    environment,
    header,
    laya,
    source: { revision: source.revision, dirty: Boolean(source.status?.trim()) },
    hardware,
    datasets: profileDataset(selected),
    trainItems,
    report,
    // The ledger's own view of the same rows: agreement per confidence level, as decisions:report prints it.
    ledgerView: buildDecisionReport(rows.filter((row) => !row.gated && !row.pair), target, min),
  };
  await writeFile(reportPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderBenchMarkdown(report, [...header, ...(environment.length ? [`ENVIRONMENT-SUSPECT: ${environment.join("; ")}`] : [])]), "utf8");

  console.log("");
  for (const point of report.points) console.log(`  ${point.point.padEnd(17)} ${point.verdict.toUpperCase().padEnd(13)} ${point.reasons.join("; ")}`);
  if (!useLaya) console.log("  (incumbent only: no Laya verdict)");
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
