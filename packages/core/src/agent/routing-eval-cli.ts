/**
 * Routing eval CLI.
 *
 *   pnpm routing:eval                              # decision mode — offline, deterministic
 *   pnpm routing:eval -- --mode live               # real catalog + embeddings, no classifier
 *   pnpm routing:eval -- --mode live --triage      # ...and the real facet triage
 *   pnpm routing:eval -- --cases eval/routing/my-cases.jsonl --json out.json
 *
 * DECISION mode needs nothing but this repo, so it runs in CI and guards the rule order.
 * LIVE mode needs the generated catalog and a reachable embedding backend, and guards
 * retrieval. Neither can stand in for the other: the rules can be perfect while the
 * embedding gate admits nothing, which is exactly the shape of the e1151d8 regression.
 *
 * Exit codes: 0 pass · 1 the gate failed · 2 INCONCLUSIVE — the run could not measure.
 * `pnpm` collapses any non-zero code to 1, so the distinction lives in the output too.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_EVAL_THRESHOLDS,
  decisionResolver,
  formatRoutingEvalReport,
  lintCases,
  parseCaseFile,
  runRoutingEval,
  type RoutingEvalCase,
  type RoutingEvalResolver,
  type RoutingEvalThresholds,
} from "./routing-eval.js";

const DEFAULT_DECISION_CASES = "eval/routing/decision-cases.jsonl";
const DEFAULT_LIVE_CASES = "eval/routing/live-cases.jsonl";

/**
 * Point the config loader at the REPO-ROOT catalog before anything imports it.
 *
 * Same trap as the canary: `pnpm routing:eval` delegates into the core package, where a
 * `starlingai.json` declaring ZERO agents also sits. Loading that one produces an eval that
 * routes against an empty catalog and blames the backend.
 */
function resolveRepoRoot(): { root: string; configPath: string } | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const configPath = process.env["SAI_CONFIG_PATH"] ?? join(dir, "starlingai.json");
      return { root: dir, configPath };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Everything an entry advertises about itself — the text a case must not simply echo. */
function catalogTextFor(entry: { description?: string; capabilities?: string[]; tags?: string[] } | undefined): string {
  if (!entry) return "";
  return [entry.description ?? "", ...(entry.capabilities ?? []), ...(entry.tags ?? [])].join(" ");
}

async function buildLiveResolver(
  configPath: string,
  useTriage: boolean,
): Promise<{ resolver: RoutingEvalResolver; catalogText: Record<string, string> } | { error: string }> {
  process.env["SAI_CONFIG_PATH"] = configPath;
  // Dynamic, so SAI_CONFIG_PATH is set before the loader is evaluated. ESM hoists static
  // imports, which would make the assignment above arrive too late.
  const { getConfig } = await import("../config/loader.js");
  const { SEMANTIC_AGENT_ROUTING_MIN_SCORE, resolveAgentRouting } = await import("../tools/agent-routing.js");
  const { resolveRoutingTaxonomy } = await import("./routing-taxonomy.js");
  const { fuseRouting } = await import("./routing-fusion.js");
  const { buildAgentIndex, isEmbeddingAvailable, getEmbeddingSearchStatus } = await import("../providers/embeddings.js");
  const { getEmbeddingProvider } = await import("../providers/index.js");

  const config = getConfig();
  const agentCount = Object.keys(config.subAgents).length;
  process.stdout.write(`Catalog: ${configPath} (${agentCount} agents)\n`);
  if (agentCount === 0) {
    return { error: "that config declares no sub-agents. Run `pnpm config:build` at the repo root." };
  }
  const embeddingModel = config.agents.defaults.model.embeddingModel ?? "";
  if (!embeddingModel) {
    return { error: "no embedding model is configured (agents.defaults.model.embeddingModel)." };
  }
  try {
    await buildAgentIndex(config.subAgents, getEmbeddingProvider(), embeddingModel);
  } catch (err) {
    return { error: `embedding index build failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isEmbeddingAvailable()) {
    return { error: `embedding search is unavailable (${JSON.stringify(getEmbeddingSearchStatus())}).` };
  }

  let runTriageCase: ((query: string) => Promise<import("./triage.js").TriageVerdict | null>) | null = null;
  if (useTriage) {
    const { runTriage } = await import("./triage.js");
    // The product's own tier resolution, imported rather than reimplemented: an eval that
    // picks its own model measures a deployment nobody runs.
    const { resolveRoutingTierProvider } = await import("./runtime.js");
    const provider = resolveRoutingTierProvider();
    runTriageCase = async (query) => {
      const outcome = await runTriage({ userMessage: query }, {
        timeoutMs: 20_000,
        complete: async (messages, options) => (await provider.complete(messages, [], undefined, {
          maxTokens: options.maxTokens,
          controls: options.controls,
          responseFormat: options.responseFormat,
        })).content ?? "",
      });
      return outcome.verdict;
    };
  }

  const catalogText: Record<string, string> = {};
  for (const [name, entry] of Object.entries(config.subAgents)) {
    catalogText[name] = catalogTextFor(entry);
  }

  const resolver: RoutingEvalResolver = async (evalCase) => {
    const started = Date.now();
    const resolution = await resolveAgentRouting(evalCase.query, { minConfidence: "high" });
    const candidates = resolution.results.map((candidate) => {
      const taxonomy = resolveRoutingTaxonomy(config.subAgents[candidate.name]);
      return {
        name: candidate.name,
        family: "agent" as const,
        score: candidate.score,
        floor: SEMANTIC_AGENT_ROUTING_MIN_SCORE,
        admittedByRawQuery: true,
        ...(taxonomy ? { taxonomy } : {}),
      };
    });
    const verdict = runTriageCase ? await runTriageCase(evalCase.query) : null;
    const decision = fuseRouting({
      candidates,
      verdict,
      ...(evalCase.flags ? { flags: evalCase.flags } : {}),
    });
    return {
      decision,
      // Every admitted candidate, not the cut shortlist: recall@K asks whether retrieval
      // found the entry at all, which is a different question from whether K kept it.
      ranked: candidates.map((candidate) => candidate.name),
      gated: resolution.gated || candidates.length === 0,
      hasVerdict: Boolean(verdict),
      elapsedMs: Date.now() - started,
    };
  };
  return { resolver, catalogText };
}

function parseThresholds(argv: readonly string[]): RoutingEvalThresholds {
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    minTargetRate: read("--min-target", DEFAULT_EVAL_THRESHOLDS.minTargetRate),
    minRecallRate: read("--min-recall", DEFAULT_EVAL_THRESHOLDS.minRecallRate),
    minBranchRate: read("--min-branch", DEFAULT_EVAL_THRESHOLDS.minBranchRate),
    maxGatedRate: read("--max-gated", DEFAULT_EVAL_THRESHOLDS.maxGatedRate),
    leakOverlap: read("--leak-overlap", DEFAULT_EVAL_THRESHOLDS.leakOverlap),
  };
}

export async function runRoutingEvalCli(argv: readonly string[]): Promise<number> {
  const modeIndex = argv.indexOf("--mode");
  const mode = (modeIndex >= 0 ? argv[modeIndex + 1] : "decision") === "live" ? "live" : "decision";
  const useTriage = argv.includes("--triage");
  const casesIndex = argv.indexOf("--cases");
  const jsonIndex = argv.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : undefined;
  const thresholds = parseThresholds(argv);

  const repo = resolveRepoRoot();
  if (!repo) {
    process.stderr.write("INCONCLUSIVE: could not locate the repo root (pnpm-workspace.yaml).\n");
    return 2;
  }
  const casesPath = resolve(
    casesIndex >= 0
      ? argv[casesIndex + 1]!
      : join(repo.root, mode === "live" ? DEFAULT_LIVE_CASES : DEFAULT_DECISION_CASES),
  );
  if (!existsSync(casesPath)) {
    process.stderr.write(
      `INCONCLUSIVE: no case file at ${casesPath}.\n`
      + (mode === "live"
        ? "Live cases are deployment-specific — write them against YOUR catalog; see eval/routing/README.md.\n"
        : "Expected the committed decision cases. Pass --cases to point elsewhere.\n"),
    );
    return 2;
  }

  let cases: RoutingEvalCase[];
  try {
    cases = parseCaseFile(readFileSync(casesPath, "utf8"));
  } catch (err) {
    process.stderr.write(`Could not read ${casesPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const problems = lintCases(cases);
  if (mode === "decision") {
    for (const evalCase of cases) {
      if (!evalCase.candidates) problems.push(`[${evalCase.id}] has no candidates, so decision mode cannot score it`);
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`The case file is not usable:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    return 1;
  }
  if (cases.length === 0) {
    process.stderr.write(`INCONCLUSIVE: ${casesPath} contains no cases.\n`);
    return 2;
  }

  let resolver: RoutingEvalResolver;
  let catalogText: Record<string, string> | undefined;
  if (mode === "live") {
    const built = await buildLiveResolver(repo.configPath, useTriage);
    if ("error" in built) {
      process.stderr.write(`INCONCLUSIVE: ${built.error}\n`);
      return 2;
    }
    resolver = built.resolver;
    catalogText = built.catalogText;
    // Say what is NOT measured. Production scores agents only; scenes and jobs have labels
    // but no scorer, so a live run says nothing about workflow retrieval.
    process.stdout.write("Live mode scores the AGENT family only — there is no scene/job scorer in production yet.\n");
    if (!useTriage) {
      process.stdout.write("No classifier: branch and source-sensitivity checks will be skipped. Add --triage to include them.\n");
    }
  } else {
    resolver = decisionResolver();
  }

  const report = await runRoutingEval(cases, resolver, {
    mode,
    thresholds,
    ...(catalogText ? { catalogText } : {}),
  });
  process.stdout.write(`${formatRoutingEvalReport(report)}\n`);

  if (jsonPath) {
    const target = resolve(jsonPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`Wrote ${target}\n`);
  }

  if (report.inconclusive) return 2;
  return report.passedGate ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith("routing-eval-cli.ts") || process.argv[1].endsWith("routing-eval-cli.js"));
if (invokedDirectly) {
  runRoutingEvalCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`Routing eval failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
