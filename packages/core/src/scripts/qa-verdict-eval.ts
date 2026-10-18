/// <reference types="node" />
/**
 * Live eval of the QA delivery verdict (never in CI): does it pass correct answers and fail
 * fabricated or incomplete ones? Today's prompt against the one with the turn's sources
 * (orchestration.qaVerdictSeesSources), on agent/qa-verdict-eval-scenarios.ts.
 *
 * Each call is the verdict call runQaDeliveryGate makes: buildQaVerdictInstruction, the reviewer's
 * system prompt, reasoning off (qaVerdictCallOptions), on the configured orchestrator model, and
 * parseQaVerdict on the reply. The source block comes from formatQaSourceBlock over the scenario's
 * history, so the collector is measured as well. What is left out: the turn-record block (the
 * scenarios produce no files and carry no separate user words) and the disputed-evidence block.
 *
 * Usage (from the repo root; the package script changes there first):
 *   pnpm --filter @starlingai/core qa:verdict-eval [--reps 5] [--variants today,sources]
 *     [--scenarios mail_summary,...] [--header-file <path>] [--model <id>] [--out <dir>]
 * --model defaults to the configured primary model; the run prints it before the first call. Run
 * it with the gateway's .env in scope (the repo's .env is loaded when present; elsewhere, e.g. in a
 * worktree, pass it to node: NODE_OPTIONS=--env-file=<path to .env>).
 * --header-file replaces the source block's header (QA_SOURCE_HEADER) to try a wording.
 * Output: <out>/report.json and <out>/report.md, default .starlingai/live-check/qa-verdict/<time>/.
 * Report rows hold scenario names, answer kinds and counts; reasons are kept for the verdicts that
 * were wrong, clipped. Load: scenarios x answers x variants x reps calls, one after another.
 */
// MUST be first: loads .env before config/loader.ts freezes its resolution (see that module).
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { loadConfig } from "../config/loader.js";

type Variant = "today" | "sources";
const VARIANTS: readonly Variant[] = ["today", "sources"];

function parseArgs(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(`usage: ${flag} needs a value`);
    values.set(flag.slice(2), value);
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reps = Number(args.get("reps") ?? 5);
  if (!Number.isInteger(reps) || reps < 1 || reps > 20) throw new Error("--reps takes a whole number from 1 to 20");
  const variants = (args.get("variants") ?? VARIANTS.join(",")).split(",").map((v) => v.trim()) as Variant[];
  for (const v of variants) if (!VARIANTS.includes(v)) throw new Error(`--variants: unknown variant "${v}"`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outArg = args.get("out");
  const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg)) : resolve(REPO_ROOT, ".starlingai", "live-check", "qa-verdict", stamp);
  await mkdir(outDir, { recursive: true });
  // Whatever an imported module audits (the provider's model-call rows) lands beside the report.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");

  const config = loadConfig({ skipCompiledWrite: true });
  const { buildQaVerdictInstruction, parseQaVerdict, QA_VERDICT_SYSTEM_PROMPT } = await import("../agent/qa-delivery-loop.js");
  const { formatQaSourceBlock } = await import("../agent/qa-source-block.js");
  const { QA_VERDICT_EVAL_SCENARIOS, EXPECTED_PASS } = await import("../agent/qa-verdict-eval-scenarios.js");
  const { getChatProvider, getChatProviderWithOverride } = await import("../providers/index.js");

  const wanted = args.get("scenarios")?.split(",").map((s) => s.trim());
  const scenarios = QA_VERDICT_EVAL_SCENARIOS.filter((s) => !wanted || wanted.includes(s.name));
  if (scenarios.length === 0) throw new Error("--scenarios names no scenario");
  const headerFile = args.get("header-file");
  const header = headerFile ? (await readFile(headerFile, "utf8")).trim() : undefined;

  const model = args.get("model");
  const provider = model ? getChatProviderWithOverride({ primary: model }) : getChatProvider();
  console.log(`model: ${model ?? config.agents.defaults.model.primary} | scenarios: ${scenarios.length} | variants: ${variants.join(",")} | reps: ${reps}`);

  type Cell = { scenario: string; kind: string; variant: Variant; expectedPass: boolean; passes: number; runs: number; wrongReasons: string[] };
  const cells: Cell[] = [];
  for (const scenario of scenarios) {
    for (const variant of variants) {
      const sourceBlock = variant === "sources" ? formatQaSourceBlock(scenario.history, header ? { header } : {}) : "";
      if (variant === "sources" && !sourceBlock) console.log(`  ${scenario.name}: no source block (nothing fits) — the variant equals today here`);
      for (const [kind, answer] of Object.entries(scenario.answers)) {
        const expectedPass = EXPECTED_PASS[kind as keyof typeof EXPECTED_PASS];
        const cell: Cell = { scenario: scenario.name, kind, variant, expectedPass, passes: 0, runs: 0, wrongReasons: [] };
        const instruction = buildQaVerdictInstruction({ criteria: scenario.criteria, answer, requireEvidence: true, sourceBlock });
        for (let i = 0; i < reps; i += 1) {
          const reply = await provider.complete(
            [{ role: "system", content: QA_VERDICT_SYSTEM_PROMPT }, { role: "user", content: instruction }],
            [],
            undefined,
            { controls: { enableThinking: false, reasoningEffort: "none" } },
          );
          const verdict = parseQaVerdict(reply.content ?? "");
          cell.runs += 1;
          if (verdict.pass) cell.passes += 1;
          if (verdict.pass !== expectedPass && cell.wrongReasons.length < 2) {
            cell.wrongReasons.push((verdict.pass ? `PASS ${verdict.evidence ?? ""}` : `FAIL ${verdict.flaws ?? ""}`).slice(0, 200));
          }
        }
        cells.push(cell);
        console.log(`  ${scenario.name.padEnd(18)} ${variant.padEnd(7)} ${kind.padEnd(10)} ${cell.passes}/${cell.runs} pass (want ${expectedPass ? "pass" : "fail"})`);
      }
    }
  }

  const summary = variants.map((variant) => {
    const own = cells.filter((c) => c.variant === variant);
    const good = own.filter((c) => c.expectedPass);
    const bad = own.filter((c) => !c.expectedPass);
    const sum = (list: Cell[], f: (c: Cell) => number) => list.reduce((n, c) => n + f(c), 0);
    const goodRuns = sum(good, (c) => c.runs);
    const badRuns = sum(bad, (c) => c.runs);
    return {
      variant,
      goodPassed: `${sum(good, (c) => c.passes)}/${goodRuns}`,
      badFailed: `${sum(bad, (c) => c.runs - c.passes)}/${badRuns}`,
      accuracy: Number(((sum(good, (c) => c.passes) + sum(bad, (c) => c.runs - c.passes)) / Math.max(1, goodRuns + badRuns)).toFixed(3)),
    };
  });
  console.log("\nsummary:");
  for (const s of summary) console.log(`  ${s.variant.padEnd(7)} good passed ${s.goodPassed}, bad failed ${s.badFailed}, accuracy ${s.accuracy}`);

  const report = { generatedAt: new Date().toISOString(), model: model ?? config.agents.defaults.model.primary, reps, header: header ? "custom" : "default", summary, cells };
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const md = [
    "# QA verdict eval", "", `model ${report.model}, ${reps} reps, source header ${report.header}`, "",
    "| variant | good passed | bad failed | accuracy |", "|---|---|---|---|",
    ...summary.map((s) => `| ${s.variant} | ${s.goodPassed} | ${s.badFailed} | ${s.accuracy} |`), "",
    "| scenario | variant | answer | passes | want |", "|---|---|---|---|---|",
    ...cells.map((c) => `| ${c.scenario} | ${c.variant} | ${c.kind} | ${c.passes}/${c.runs} | ${c.expectedPass ? "pass" : "fail"} |`),
  ].join("\n");
  await writeFile(join(outDir, "report.md"), md);
  console.log(`\nreport: ${join(outDir, "report.md")}`);
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
