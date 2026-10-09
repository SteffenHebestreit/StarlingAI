/**
 * intent:bench — how well does the intent readout read each facet of a request? Every labelled case of
 * eval/intent goes to the readout (decisions/intent-readout.ts askIntentReadout: one grammar-bound call on
 * the routing tier, thinking off, each facet's letter read off its top list), and with --with-triage to
 * the generative facet triage it would replace (agent/triage.ts runTriage, the turn's own call and
 * parser). agent/intent-bench.ts scores the run per facet and language: accuracy against gold and against
 * the always-majority baseline and triage, the confusion matrix, ECE before and after a temperature
 * fitted on the calibration half (applied to the test half), coverage and accuracy over confidence and
 * margin levels, flips under --order-swap, wall ms, and whether German cases get a restatement. With
 * --order-swap also the order-agreement rate, and the reversed pass alone and both passes averaged per
 * option (askIntentReadout bothOrders' combination) scored the same way: the averaged readout's verdict
 * is printed beside each facet's as an extra column and never sets the exit code.
 *
 *   pnpm --filter @starlingai/core intent:bench [--cases <jsonl> [--cases <jsonl> …]] [--with-triage]
 *     [--order-swap] [--split all|calibration|test] [--limit n] [--top-logprobs 20] [--min-mass 0.5]
 *     [--sampling-temperature 0] [--triage-timeout-ms 8000] [--timeout-ms 60000] [--out <dir>]
 *
 * Cases: eval/intent/intent.jsonl when a deployment keeps its own, else intent.example.jsonl.
 * One case at a time, calls one after another. With --with-triage the two arms alternate which goes
 * first. --order-swap asks every case once more AFTER the main pass, with every facet's options in
 * reverse order, so the main pass's prefix is not interleaved with a second one. One untimed warm-up
 * call per prefix comes first. About 312 calls at the defaults (≈1 s each once warm), twice that with
 * each switch.
 *
 * Never written: the gateway's audit log and ledgers. This run's provider calls are audited to
 * <out>/audit.jsonl; the report is <out>/report.json and report.md, default
 * .starlingai/live-check/intent-bench/<time>/. <out>/rows.jsonl holds one row per case and pass WITH the
 * message (under .starlingai, which git ignores): keep it local. No row, report or log line holds the
 * restatement, only its length.
 *
 * Exit codes: 0 no facet fails (each holds, or too few calls were asked to judge it), 1 a facet fails —
 * no better than the constant answer in either language or both, not significantly better, read on too
 * few of the calls, or significantly worse than triage — or no top list arrived at all, 2 a usage
 * mistake or nothing could be judged, 3 the
 * environment is suspect (the routing tier unreachable, the warm-up call failed, or more than a fifth of
 * an arm's calls failed). pnpm reports every non-zero code as 1, so the verdict is also printed.
 */
// MUST be first: loads .env before config/loader.ts is evaluated with an empty environment.
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { benchSplit, readTimings } from "../agent/decisions-bench.js";
import { captureEvaluationHardwareState, captureEvaluationSourceState } from "../agent/evaluation-provenance.js";
import {
  buildIntentBenchReport,
  casesDigest,
  IntentBenchUsageError,
  lintIntentCases,
  orderSwapCell,
  parseIntentBenchArgs,
  parseIntentCases,
  profileIntentCases,
  readoutArmFrom,
  renderIntentBenchMarkdown,
  reversedFacets,
  selectIntentCases,
  triageArmFrom,
  type IntentBenchArgs,
  type IntentBenchCase,
  type IntentBenchResult,
  type ReadoutArm,
  type TriageArm,
} from "../agent/intent-bench.js";
import { resolveRoutingTierProvider } from "../agent/routing-tier-provider.js";
import { warmTextLanguageDetector } from "../agent/text-language.js";
import { runTriage, type TriageInput } from "../agent/triage.js";
import { subscribeToAudit } from "../audit/logger.js";
import type { AuditEvent } from "../audit/schema.js";
import { loadConfig } from "../config/loader.js";
import { askIntentReadout, type IntentFacetDefinition } from "../decisions/intent-readout.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { runWithCallAttribution } from "../runtime/request-context.js";

/** More failed calls than this share and the run describes the environment, not the readout. */
const MAX_FAILURE_SHARE = 0.2;
const WARM_UP_MESSAGE = "Warm-up.";
/** The attribution each arm's provider rows carry, so their llama-server timings can be told apart. */
const AGENT = { readout: "intent_readout", swapped: "intent_readout_swapped", triage: "triage" } as const;

function fromRoot(path: string): string {
  if (isAbsolute(path)) return path;
  const fromCwd = resolve(process.cwd(), path);
  return existsSync(fromCwd) ? fromCwd : resolve(REPO_ROOT, path);
}

/** The committed example unless the deployment keeps its own cases beside it (eval/decisions' rule). */
function defaultCaseFile(): string {
  const own = join(REPO_ROOT, "eval", "intent", "intent.jsonl");
  return existsSync(own) ? own : join(REPO_ROOT, "eval", "intent", "intent.example.jsonl");
}

function inputOf(benchCase: IntentBenchCase): TriageInput {
  return { userMessage: benchCase.message, ...(benchCase.prior ? { priorTurnDigest: benchCase.prior } : {}) };
}

async function main(): Promise<number> {
  const args: IntentBenchArgs = parseIntentBenchArgs(process.argv.slice(2));
  // Under `pnpm --filter` the working directory is packages/core, whose stub starlingai.json declares no routing
  // tier: the readout would ask a different model from the one a turn asks. Windows paths compare without case.
  const here = resolve(process.cwd());
  const root = resolve(REPO_ROOT);
  if (!process.env["SAI_CONFIG_PATH"]?.trim() && (process.platform === "win32" ? here.toLowerCase() !== root.toLowerCase() : here !== root)) {
    throw new IntentBenchUsageError(`run from the repository root (${REPO_ROOT}); the package script does \`cd ../..\` first. Here the config loader would read ${process.cwd()}.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.out ? fromRoot(args.out) : join(REPO_ROOT, ".starlingai", "live-check", "intent-bench", stamp);
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
  config.decisions.ledger = { ...config.decisions.ledger, enabled: false };

  // The cases.
  const files = args.cases ? args.cases.map(fromRoot) : [defaultCaseFile()];
  const texts: string[] = [];
  const cases: IntentBenchCase[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => { throw new IntentBenchUsageError(`cannot read the case file ${file}`); });
    texts.push(text);
    try {
      cases.push(...parseIntentCases(text));
    } catch (err) {
      throw new IntentBenchUsageError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const problems = lintIntentCases(cases);
  if (problems.length) throw new IntentBenchUsageError(`the cases cannot be measured:\n  - ${problems.join("\n  - ")}`);
  const selected = selectIntentCases(cases, args.split, args.limit);
  if (selected.length === 0) throw new IntentBenchUsageError("no case matches --split and --limit");

  await warmTextLanguageDetector();
  const provider: ChatProvider = resolveRoutingTierProvider();
  const tierModel = config.agents.defaults.model.tiers?.["routing"] ?? config.agents.defaults.model.primary;
  const settings = {
    casesFiles: files.map((file) => file.replace(REPO_ROOT, ".")),
    casesSha256: texts.length === 1 ? createHash("sha256").update(texts[0]!).digest("hex") : casesDigest(texts),
    split: args.split,
    withTriage: args.withTriage,
    orderSwap: args.orderSwap,
    samplingTemperature: args.samplingTemperature,
    topLogprobs: args.topLogprobs,
    minMass: args.minMass,
    ...(args.withTriage ? { triageTimeoutMs: args.triageTimeoutMs } : {}),
    model: tierModel,
  };
  const profile = profileIntentCases(selected);
  const header = [
    `Run ${stamp}, git ${source.revision?.slice(0, 12) ?? "?"}${source.status?.trim() ? " (dirty tree)" : ""}.`,
    `Model: routing tier ${tierModel} at ${config.providers.lmstudio?.baseUrl ?? "?"}.`,
    `Cases: ${selected.length} (${settings.casesFiles.join(" + ")}; ${profile.byLanguage["de"] ?? 0} de, ${profile.byLanguage["en"] ?? 0} en), split ${args.split}`
      + `${args.limit !== undefined ? `, limit ${args.limit}` : ""}; triage ${args.withTriage ? `on (timeout ${args.triageTimeoutMs} ms)` : "off"}; order swap ${args.orderSwap ? "on" : "off"}.`,
  ];
  console.log(header.join("\n"));
  const reportPath = join(outDir, "report.json");
  const markdownPath = join(outDir, "report.md");
  const environment: string[] = [];
  const suspect = async (): Promise<number> => {
    await writeFile(reportPath, `${JSON.stringify({ verdict: "environment-suspect", environment, header, source: { revision: source.revision }, hardware }, null, 2)}\n`, "utf8");
    console.error(`\nENVIRONMENT: ${environment.join("; ")}\nNo verdict.`);
    return 3;
  };
  const health = await provider.checkHealth().catch((err: unknown) => ({ healthy: false, error: err instanceof Error ? err.message : String(err) }));
  if (!health.healthy) {
    environment.push(`the routing tier (${config.providers.lmstudio?.baseUrl ?? "?"}, ${tierModel}) is unreachable${health.error ? `: ${health.error}` : ""}`);
    return suspect();
  }

  // Every provider row a call produces: the last one of an arm carries llama-server's own timings.
  let callRows: AuditEvent[] = [];
  const unsubscribe = subscribeToAudit((event) => {
    if (event.type === "provider_model_call") callRows.push(event);
  });
  const timingsOf = (agentName: string) => readTimings(callRows.filter((row) => row.data["agentName"] === agentName).at(-1)?.data["timings"]);

  const readoutOptions = (facets?: readonly IntentFacetDefinition[]) => ({
    topLogprobs: args.topLogprobs,
    minMass: args.minMass,
    samplingTemperature: args.samplingTemperature,
    signal: AbortSignal.timeout(args.timeoutMs),
    ...(facets ? { facets } : {}),
  });
  const askReadout = async (input: TriageInput, agentName: string, facets?: readonly IntentFacetDefinition[]): Promise<ReadoutArm> => {
    callRows = [];
    const arm = readoutArmFrom(await runWithCallAttribution({ callSite: "routing_tier", agentName }, () => askIntentReadout(provider, input, readoutOptions(facets))));
    const timings = timingsOf(agentName);
    return timings ? { ...arm, timings } : arm;
  };
  const askTriage = async (input: TriageInput): Promise<TriageArm> => {
    callRows = [];
    // runTriage stops waiting at its timeout but cannot cancel the call; aborting it here keeps a late
    // reply from running on beside the next case's call.
    const controller = new AbortController();
    try {
      const outcome = await runWithCallAttribution({ callSite: "routing_tier", agentName: AGENT.triage }, () => runTriage(input, {
        timeoutMs: args.triageTimeoutMs,
        complete: async (messages, options) => (await provider.complete(messages, [], controller.signal, {
          maxTokens: options.maxTokens,
          controls: options.controls,
          responseFormat: options.responseFormat,
        })).content ?? "",
      }));
      const arm = triageArmFrom(outcome);
      const timings = timingsOf(AGENT.triage);
      return timings ? { ...arm, timings } : arm;
    } finally {
      controller.abort();
    }
  };

  const swapFacets = args.orderSwap ? reversedFacets() : undefined;
  const results: IntentBenchResult[] = [];
  const rowsPath = join(outDir, "rows.jsonl");
  try {
    // Warm-up, untimed, on a message outside the dataset: a cold prefix measures the load, not the readout, and a
    // server that refuses the grammar or sends no top list answers here, before 300 calls say the same.
    const warm = await askReadout({ userMessage: WARM_UP_MESSAGE }, AGENT.readout);
    if (!warm.ok && warm.failure !== "no_logprobs") {
      environment.push(`the warm-up readout failed (${warm.failure}${warm.error ? `: ${warm.error}` : ""})`);
      return await suspect();
    }
    if (!warm.ok) {
      const report = buildIntentBenchReport([{ caseId: "warm-up", language: "en", split: "test", gold: { mode: "converse", domain: "other", deliverable: "none", multi: "no", alone: "yes", source_sensitive: "no", decision: "answer_direct" }, readout: warm }], settings);
      await writeFile(reportPath, `${JSON.stringify({ exitCode: 1, header, source: { revision: source.revision }, hardware, report }, null, 2)}\n`, "utf8");
      console.error("\nNO TOP LIST: the warm-up readout came back without logprobs; the server does not send them, so there is no readout. No case was run.");
      return 1;
    }
    if (args.withTriage) await askTriage({ userMessage: WARM_UP_MESSAGE });
    console.log(`Warm-up: ${warm.tokens} tokens, ${Object.keys(warm.facets).length} facets read, ${Math.round(warm.ms)} ms.`);

    let index = 0;
    for (const benchCase of selected) {
      const input = inputOf(benchCase);
      const result: IntentBenchResult = {
        caseId: benchCase.id,
        language: benchCase.language,
        split: benchSplit(benchCase.id),
        gold: benchCase.gold,
        ...(benchCase.tags?.length ? { tags: benchCase.tags } : {}),
      };
      const runReadout = async () => { result.readout = await askReadout(input, AGENT.readout); };
      const runTriageArm = async () => { result.triage = await askTriage(input); };
      if (args.withTriage) {
        // Alternate which arm goes first, so a server that slows down during the run weighs on both.
        result.first = index % 2 === 0 ? "readout" : "triage";
        for (const arm of result.first === "readout" ? [runReadout, runTriageArm] : [runTriageArm, runReadout]) await arm();
      } else {
        await runReadout();
      }
      index += 1;
      results.push(result);
      await appendFile(rowsPath, `${JSON.stringify({ pass: "main", ...result, message: benchCase.message, ...(benchCase.prior ? { prior: benchCase.prior } : {}) })}\n`, { encoding: "utf8", mode: 0o600 });
      const readout = result.readout!;
      const read = Object.keys(readout.facets).length;
      const right = Object.entries(readout.facets).filter(([name, reading]) => reading.choice === benchCase.gold[name as keyof typeof benchCase.gold]).length;
      console.log(`  [${index}/${selected.length}] ${benchCase.id} readout ${readout.ok ? `${right}/${read} right of 7, ${Math.round(readout.ms)} ms` : readout.failure}`
        + (result.triage ? ` | triage ${result.triage.verdict ? `${Object.entries(result.triage.verdict).filter(([name, value]) => value === benchCase.gold[name as keyof typeof benchCase.gold]).length}/7 right` : result.triage.failure}, ${Math.round(result.triage.ms)} ms` : ""));
    }

    if (swapFacets) {
      await askReadout({ userMessage: WARM_UP_MESSAGE }, AGENT.swapped, swapFacets);
      let swapIndex = 0;
      for (const result of results) {
        const benchCase = selected.find((entry) => entry.id === result.caseId)!;
        result.swapped = await askReadout(inputOf(benchCase), AGENT.swapped, swapFacets);
        swapIndex += 1;
        await appendFile(rowsPath, `${JSON.stringify({ pass: "swapped", caseId: result.caseId, swapped: result.swapped })}\n`, { encoding: "utf8", mode: 0o600 });
        const before = result.readout?.facets ?? {};
        const flips = Object.entries(result.swapped.facets).filter(([name, reading]) => {
          const first = before[name as keyof typeof before];
          return first !== undefined && first.choice !== reading.choice;
        }).length;
        console.log(`  [swap ${swapIndex}/${results.length}] ${result.caseId} ${result.swapped.ok ? `${flips} facet(s) changed` : result.swapped.failure}`);
      }
    }
  } finally {
    unsubscribe();
  }

  const failedShare = (count: number, of: number) => of > 0 && count / of > MAX_FAILURE_SHARE;
  if (failedShare(results.filter((result) => result.readout?.failure === "error" || result.readout?.failure === "aborted").length, results.length)) {
    environment.push(`more than ${MAX_FAILURE_SHARE * 100}% of the readout calls failed`);
  }
  const triaged = results.filter((result) => result.triage);
  if (failedShare(triaged.filter((result) => result.triage!.failure === "error" || result.triage!.failure === "timeout").length, triaged.length)) {
    environment.push(`more than ${MAX_FAILURE_SHARE * 100}% of the triage calls failed or timed out`);
  }

  const report = buildIntentBenchReport(results, settings);
  const exitCode = environment.length ? 3 : report.exitCode;
  await writeFile(reportPath, `${JSON.stringify({ exitCode, environment, header, source: { revision: source.revision, dirty: Boolean(source.status?.trim()) }, hardware, dataset: profile, report }, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderIntentBenchMarkdown(report, [...header, ...(environment.length ? [`ENVIRONMENT-SUSPECT: ${environment.join("; ")}`] : [])]), "utf8");

  console.log("");
  for (const entry of report.facets) {
    const averaged = orderSwapCell(entry);
    console.log(`  ${entry.facet.padEnd(17)} ${entry.verdict.toUpperCase().padEnd(15)} ${entry.reasons.join("; ")}${averaged ? `\n  ${"".padEnd(17)} both orders averaged (extra column): ${averaged}` : ""}`);
  }
  if (environment.length) console.error(`\nENVIRONMENT-SUSPECT RUN — not a verdict:\n  - ${environment.join("\n  - ")}`);
  console.log(`\nReport: ${markdownPath}\nJSON:   ${reportPath}\nRows:   ${rowsPath} (holds the messages; keep it local)`);
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch((err: unknown) => {
    if (err instanceof IntentBenchUsageError) {
      console.error(`usage: ${err.message}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(3);
  });
}
