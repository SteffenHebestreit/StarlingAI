/**
 * EVL-402: scenario pack runner (slice 1 — deterministic packs).
 *
 * Usage (from packages/core, or repo root via `pnpm packs:evaluate`):
 *   pnpm packs:evaluate [manifest.jsonc] [--pack name]... [--out dir]
 *
 * Runs every deterministic pack in the manifest through vitest's JSON reporter
 * and publishes ONE UnifiedEvalReport per pack (the same envelope the agent and
 * scene harnesses emit), so PR runs are directly comparable with nightly live
 * runs and future chaos runs of the same pack. Live/chaos packs are listed and
 * skipped — they run through their own transports (agents:evaluate --via-gateway,
 * the weekly chaos driver) on their own cadence.
 *
 * Exit contract (matches the EVL-401 CLIs):
 *   0 — every deterministic pack green
 *   1 — a pack has failing tests
 *   3 — environment-suspect (vitest crashed, unparsable output, empty pack)
 */
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import {
  validatePackManifest,
  vitestJsonToUnifiedReport,
  type EvalPackDefinition,
  type VitestJsonOutput,
} from "./eval-packs.js";
import type { UnifiedEvalReport } from "./eval-report.js";

function findManifest(explicit?: string): string {
  const candidates = explicit
    ? [resolve(explicit)]
    : [resolve(process.cwd(), "eval/packs/packs.jsonc"), resolve(process.cwd(), "../../eval/packs/packs.jsonc")];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`pack manifest not found (tried: ${candidates.join(", ")})`);
}

/** Run vitest for one pack; returns the parsed JSON output or an error string. */
async function runVitestPack(pack: EvalPackDefinition): Promise<{ json?: VitestJsonOutput; error?: string }> {
  const outputFile = join(tmpdir(), `sai-pack-${pack.name}-${randomUUID()}.json`);
  const vitest = resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
  if (!existsSync(vitest)) return { error: `vitest not found at ${vitest} — run from packages/core` };
  const args = [vitest, "run", ...(pack.testFiles ?? []), "--reporter=json", `--outputFile=${outputFile}`];
  // vitest exits non-zero on test failure — that is DATA here, not an error;
  // only a missing/unparsable output file is an environment problem.
  await new Promise<void>((done) => {
    execFile(process.execPath, args, { timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, () => done());
  });
  try {
    const raw = await readFile(outputFile, "utf8");
    await rm(outputFile, { force: true });
    return { json: JSON.parse(raw) as VitestJsonOutput };
  } catch (err) {
    return { error: `vitest produced no parsable JSON output (${err instanceof Error ? err.message : String(err)})` };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outArg = outIndex !== -1 ? args[outIndex + 1] : undefined;
  const only = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pack" && args[i + 1]) only.add(args[i + 1]!);
  }
  const flagValues = new Set<number>();
  if (outIndex !== -1) flagValues.add(outIndex + 1);
  args.forEach((a, i) => { if (a === "--pack") flagValues.add(i + 1); });
  const positional = args.filter((a, i) => !a.startsWith("--") && !flagValues.has(i));

  const manifestPath = findManifest(positional[0]);
  const repoRoot = resolve(dirname(manifestPath), "../..");
  const outDir = resolve(outArg ?? join(repoRoot, "artifacts/evaluations/packs"));
  const manifest = validatePackManifest(JSON5.parse(await readFile(manifestPath, "utf8")));

  const selected = manifest.packs.filter((p) => only.size === 0 || only.has(p.name));
  if (selected.length === 0) {
    console.error(`No packs matched ${[...only].join(", ")} in ${manifestPath}`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const reports: UnifiedEvalReport[] = [];
  let anySuspect = false;

  for (const pack of selected) {
    if (pack.kind !== "deterministic") {
      console.log(`- ${pack.name} [${pack.kind}] SKIPPED — ${pack.note ?? (pack.plan ? `runs via agents:evaluate ${pack.plan}` : "runs on its own cadence")}`);
      continue;
    }
    console.log(`- ${pack.name} [deterministic] running ${pack.testFiles!.length} test file(s)…`);
    const { json, error } = await runVitestPack(pack);
    const report = json
      ? vitestJsonToUnifiedReport(pack, json, { workspacePath: repoRoot })
      : ({
          schemaVersion: 1, harness: "pack", suite: pack.name, runId: randomUUID(),
          generatedAt: new Date().toISOString(),
          summary: { total: 0, passed: 0, failed: 0, errored: 0 },
          environment: { suspect: true, reasons: [error ?? "unknown runner failure"] },
          workspacePath: repoRoot, cases: [],
        } satisfies UnifiedEvalReport);
    reports.push(report);
    const outPath = join(outDir, `${pack.name}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    if (report.environment.suspect) {
      anySuspect = true;
      console.log(`  ENVIRONMENT-SUSPECT: ${report.environment.reasons.join("; ")}`);
    } else {
      console.log(`  ${report.summary.passed}/${report.summary.total} files green → ${outPath}`);
      for (const c of report.cases.filter((x) => !x.passed)) {
        console.log(`    FAIL ${c.name}: ${c.failures[0] ?? ""}`);
      }
    }
  }

  const failed = reports.reduce((n, r) => n + r.summary.failed, 0);
  const total = reports.reduce((n, r) => n + r.summary.total, 0);
  console.log(`\nPacks: ${reports.length} run, ${total} test files, ${failed} failing${anySuspect ? ", ENVIRONMENT-SUSPECT" : ""}`);
  if (anySuspect) process.exit(3);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(3);
});
