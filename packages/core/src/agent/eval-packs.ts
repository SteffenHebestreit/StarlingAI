/**
 * EVL-402: scenario pack framework (slice 1 — the PR-deterministic suite).
 *
 * The distributed-correctness invariants (races, crash recovery, budget
 * exhaustion, evidence conflicts, side-effect discipline) are already encoded
 * as deterministic vitest suites. What was missing for EVL-402 is COMPARABLE
 * PUBLISHING: pack-scoped results in the same UnifiedEvalReport envelope the
 * live agent/scene harnesses emit, so a PR run, a nightly live run, and a
 * weekly chaos run of the same pack can be diffed by the same tooling.
 *
 * A pack is a named set of test files (deterministic), an eval plan (live), or
 * a chaos scenario (deferred). The runner executes deterministic packs via
 * vitest's JSON reporter and maps each test FILE to a unified case; test-level
 * failures become the case's failures list.
 */
import { randomUUID } from "node:crypto";
import type { UnifiedEvalReport, UnifiedEvalCase } from "./eval-report.js";

export type EvalPackKind = "deterministic" | "live" | "chaos";

export interface EvalPackDefinition {
  name: string;
  kind: EvalPackKind;
  description?: string;
  /** deterministic packs: vitest files (relative to packages/core). */
  testFiles?: string[];
  /** live packs: the eval plan to run via `pnpm agents:evaluate` (documented, not run here). */
  plan?: string;
  /** free-form operator note (e.g. how/when a non-deterministic pack runs). */
  note?: string;
}

export interface EvalPackManifest {
  packs: EvalPackDefinition[];
}

/** Validate a parsed manifest shape; throws with a precise reason on mismatch. */
export function validatePackManifest(raw: unknown): EvalPackManifest {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { packs?: unknown }).packs)) {
    throw new Error("pack manifest must be an object with a `packs` array");
  }
  const packs = (raw as { packs: unknown[] }).packs.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`pack[${i}] is not an object`);
    const pack = p as Record<string, unknown>;
    if (typeof pack["name"] !== "string" || !pack["name"]) throw new Error(`pack[${i}] is missing a name`);
    const kind = pack["kind"];
    if (kind !== "deterministic" && kind !== "live" && kind !== "chaos") {
      throw new Error(`pack "${String(pack["name"])}" has invalid kind "${String(kind)}"`);
    }
    if (kind === "deterministic" && (!Array.isArray(pack["testFiles"]) || pack["testFiles"].length === 0)) {
      throw new Error(`deterministic pack "${String(pack["name"])}" needs a non-empty testFiles list`);
    }
    return pack as unknown as EvalPackDefinition;
  });
  return { packs };
}

/** The subset of vitest's `--reporter=json` output the mapper consumes. */
export interface VitestJsonOutput {
  success?: boolean;
  testResults?: Array<{
    name?: string;
    status?: string;
    startTime?: number;
    endTime?: number;
    assertionResults?: Array<{
      status?: string;
      fullName?: string;
      title?: string;
      failureMessages?: string[];
    }>;
  }>;
}

function relativizeTestPath(absOrRel: string): string {
  // vitest reports absolute paths; keep the stable tail so reports are
  // comparable across machines/checkout locations.
  const normalized = absOrRel.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("src/tests/");
  return marker >= 0 ? normalized.slice(marker) : normalized;
}

/** Map one pack's vitest JSON output into the unified envelope. Pure. */
export function vitestJsonToUnifiedReport(
  pack: EvalPackDefinition,
  json: VitestJsonOutput,
  opts: { workspacePath: string; generatedAt?: string },
): UnifiedEvalReport {
  const files = json.testResults ?? [];
  const cases: UnifiedEvalCase[] = files.map((file) => {
    const assertions = file.assertionResults ?? [];
    const failed = assertions.filter((a) => a.status === "failed");
    const durationMs = file.startTime !== undefined && file.endTime !== undefined
      ? Math.max(0, Math.round(file.endTime - file.startTime))
      : 0;
    // A file that did not pass yet has no failed assertions crashed at collection
    // time (import error, config failure) — that is an environment error, not a
    // test failure.
    const isError = file.status !== "passed" && failed.length === 0;
    const failures = failed.map((a) => {
      const message = (a.failureMessages?.[0] ?? "").split("\n")[0]?.slice(0, 200) ?? "";
      return message ? `${a.fullName ?? a.title ?? "test"}: ${message}` : (a.fullName ?? a.title ?? "test failed");
    });
    if (isError) failures.push("test file crashed before running (collection/import error)");
    return {
      name: relativizeTestPath(file.name ?? "unknown"),
      subject: pack.name,
      status: file.status === "passed" ? "passed" : isError ? "error" : "failed",
      passed: file.status === "passed",
      durationMs,
      failures,
      attempts: assertions.length,
      passCount: assertions.filter((a) => a.status === "passed").length,
    };
  });

  const reasons: string[] = [];
  if (cases.length === 0) {
    reasons.push("pack produced no test results — glob/config mismatch, not a green run");
  }
  const errored = cases.filter((c) => c.status === "error").length;
  if (cases.length > 0 && errored > 0) {
    reasons.push(`${errored}/${cases.length} test files crashed before running — environment failure, not test quality`);
  }

  return {
    schemaVersion: 1,
    harness: "pack",
    suite: pack.name,
    runId: randomUUID(),
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    summary: {
      total: cases.length,
      passed: cases.filter((c) => c.passed).length,
      failed: cases.filter((c) => !c.passed).length,
      errored,
    },
    environment: { suspect: reasons.length > 0, reasons },
    workspacePath: opts.workspacePath,
    cases,
  };
}
