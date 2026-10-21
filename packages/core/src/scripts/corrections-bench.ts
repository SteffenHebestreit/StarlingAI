/// <reference types="node" />
/**
 * corrections:bench — how well the routing tier tells a correction of the previous answer from anything
 * else (decision point corrects_previous, agent/user-correction.ts), measured on hand-labelled cases
 * before skillLibrary.userCorrectionSignal is switched on, and again whenever the routing model changes.
 *
 *   pnpm --filter @starlingai/core corrections:bench [--cases eval/decisions/corrects_previous.example.jsonl] [--repeat 1]
 *
 * It asks the judge a turn asks (the routing tier, the same prompt), directly and not through decide():
 * no decision ledger is written, so nothing here trains Laya. A missed correction leaves a wrong success
 * in the skill statistics, a false one turns a good turn into a failure: both are reported, per language.
 *
 * Exit codes: 0 measured, 2 a usage mistake, 3 more than a fifth of the cases got no verdict.
 */
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

interface CorrectionCase {
  id: string;
  language: string;
  state: { previousAnswer: string; message: string };
  gold: "corrects" | "continues";
  tags?: string[];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const here = resolve(process.cwd());
  const root = resolve(REPO_ROOT);
  if (process.platform === "win32" ? here.toLowerCase() !== root.toLowerCase() : here !== root) {
    process.stderr.write(`corrections:bench: run from the repository root (${REPO_ROOT}); the package script does \`cd ../..\` first.\n`);
    return 2;
  }
  const casesFile = arg("cases") ?? join("eval", "decisions", "corrects_previous.example.jsonl");
  const repeat = Number(arg("repeat") ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1) {
    process.stderr.write("corrections:bench: --repeat takes a whole number, 1 or more\n");
    return 2;
  }
  const cases = readFileSync(isAbsolute(casesFile) ? casesFile : resolve(REPO_ROOT, casesFile), "utf8")
    .split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("//"))
    .map((line) => JSON.parse(line) as CorrectionCase);

  const outDir = resolve(REPO_ROOT, ".starlingai", "live-check", "corrections-bench", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  // This run's provider calls are audited here, never in the gateway's log.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");
  const { loadConfig } = await import("../config/loader.js");
  loadConfig({ skipCompiledWrite: true });
  const { initProviders } = await import("../providers/index.js");
  await initProviders();
  const { resolveRoutingTierProvider, routingTierModelId } = await import("../agent/routing-tier-provider.js");
  const { CORRECTION_JUDGE_SYSTEM, correctionJudgeUser, parseCorrectionVerdict } = await import("../agent/user-correction.js");
  const provider = resolveRoutingTierProvider();

  type Row = { id: string; language: string; gold: string; verdict: string; ms: number; tags: string[] };
  const rows: Row[] = [];
  for (let round = 1; round <= repeat; round += 1) {
    for (const c of cases) {
      const started = Date.now();
      let verdict: string;
      try {
        const response = await provider.complete(
          [{ role: "system", content: CORRECTION_JUDGE_SYSTEM }, { role: "user", content: correctionJudgeUser(c.state.previousAnswer, c.state.message) }],
          [],
        );
        const parsed = parseCorrectionVerdict(response.content);
        verdict = parsed === undefined ? "none" : parsed ? "corrects" : "continues";
      } catch {
        verdict = "error";
      }
      rows.push({ id: c.id, language: c.language, gold: c.gold, verdict, ms: Date.now() - started, tags: c.tags ?? [] });
    }
  }

  const slice = (language: string | null) => {
    const own = rows.filter((r) => language === null || r.language === language);
    const judged = own.filter((r) => r.verdict === "corrects" || r.verdict === "continues");
    const tp = judged.filter((r) => r.gold === "corrects" && r.verdict === "corrects").length;
    const fp = judged.filter((r) => r.gold === "continues" && r.verdict === "corrects").length;
    const fn = judged.filter((r) => r.gold === "corrects" && r.verdict === "continues").length;
    const correct = judged.filter((r) => r.gold === r.verdict).length;
    return {
      cases: own.length,
      noVerdict: own.length - judged.length,
      accuracy: judged.length ? correct / judged.length : null,
      correctsPrecision: tp + fp ? tp / (tp + fp) : null,
      correctsRecall: tp + fn ? tp / (tp + fn) : null,
      falseCorrections: fp,
      missedCorrections: fn,
    };
  };
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const report = {
    model: routingTierModelId(),
    casesFile,
    repeat,
    all: slice(null),
    de: slice("de"),
    en: slice("en"),
    p50Ms: ms[Math.floor(ms.length / 2)] ?? null,
    misses: rows.filter((r) => r.verdict !== r.gold).map((r) => ({ id: r.id, gold: r.gold, verdict: r.verdict, tags: r.tags })),
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.all.noVerdict > rows.length / 5 ? 3 : 0;
}

main().then((code) => process.exit(code), (err: unknown) => {
  process.stderr.write(`corrections:bench failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(3);
});
