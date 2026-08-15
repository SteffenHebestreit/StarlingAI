/**
 * Deterministic artifact probes (QA-304). No model calls: parse structured
 * files, structurally sanity-check HTML, hash every artifact, and health-check
 * served URLs — each probe returns a reproducible receipt (probe name, target,
 * content hash, timing). A failing probe is objective ground for a QA FAIL that
 * no reviewer prose can rubber-stamp past; a passing set gives the verdict
 * evidence receipts. Bounded: per-probe and overall time caps, size caps.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";
import { validateArtifactBytes, checkFormatMatchesExtension, validateHtmlText } from "./artifact-validators.js";
import type { QaJudgeArtifactRef } from "./qa-tool-judge.js";

const log = childLogger("agent:artifact-probes");

const MAX_PROBE_BYTES = 8 * 1024 * 1024;
const PER_PROBE_TIMEOUT_MS = 5_000;
const OVERALL_TIMEOUT_MS = 20_000;

export interface ArtifactProbeReceipt {
  target: string;
  /** Probe name — "exists", "served_health", or a validator name (see artifact-validators.ts). */
  probe: string;
  status: "pass" | "fail" | "unverifiable";
  detail: string;
  /** Only hard failures are grounds for failing the report; soft ones are reported and ignored. */
  severity?: "hard" | "soft";
  contentHash?: string;
  bytes?: number;
  durationMs: number;
}

export interface ArtifactProbeReport {
  /** "unverifiable" = nothing was proven broken, but at least one artifact could not be checked. */
  status: "pass" | "fail" | "unverifiable" | "not_applicable";
  receipts: ArtifactProbeReceipt[];
  probedCount: number;
}

/** Human-readable one-liner for the receipts that failed — used in diagnostics and caveats. */
export function summarizeProbeFailures(report: ArtifactProbeReport, limit = 4): string {
  return report.receipts
    .filter((r) => r.status === "fail" && r.severity !== "soft")
    .map((r) => `${r.target}: ${r.detail}`)
    .slice(0, limit)
    .join("; ");
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

/**
 * Structural HTML sanity. Delegates to the shared validator so this module, the
 * sub-agent truncation check, and any future caller all apply the SAME rules.
 *
 * The previous implementation counted `<script`/`</script>` with a regex over the
 * whole file, which reported "unclosed <script>" on any valid page that printed
 * markup inside a JS string or a <pre> tutorial block. The shared validator strips
 * comments and script/style bodies before counting.
 */
export function probeHtmlStructure(content: string): { ok: boolean; detail: string } {
  const result = validateHtmlText(content);
  return { ok: result.status !== "fail", detail: result.detail };
}

async function probeFile(workspacePath: string, location: string): Promise<ArtifactProbeReceipt[]> {
  const started = Date.now();
  const absolute = resolve(workspacePath, location);
  const receipts: ArtifactProbeReceipt[] = [];
  let content: Buffer;
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size === 0) {
      return [{ target: location, probe: "exists", status: "fail", detail: info.isFile() ? "zero-byte file" : "not a file", durationMs: Date.now() - started }];
    }
    if (info.size > MAX_PROBE_BYTES) {
      // "Too big to check" is NOT "checked and fine" — reporting pass here told the
      // QA gate an unexamined 40 MB file was verified.
      return [{ target: location, probe: "exists", status: "unverifiable", detail: `exists (${info.size} bytes) but is over the ${MAX_PROBE_BYTES}-byte probe cap — contents were NOT checked`, bytes: info.size, severity: "soft", durationMs: Date.now() - started }];
    }
    content = await readFile(absolute);
  } catch (error) {
    return [{ target: location, probe: "exists", status: "fail", detail: `unreadable: ${error instanceof Error ? error.message : String(error)}`, durationMs: Date.now() - started }];
  }
  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  receipts.push({ target: location, probe: "exists", status: "pass", detail: "readable", contentHash, bytes: content.length, durationMs: Date.now() - started });

  const bytes = new Uint8Array(content);

  // Does the content match what the filename promises? This is what catches a .docx
  // handed over as "your PDF" — a defect no per-format validator sees, because the
  // bytes are a perfectly valid document of the WRONG kind.
  const t0 = Date.now();
  const mismatch = checkFormatMatchesExtension(location, bytes);
  if (mismatch) {
    receipts.push({ target: location, probe: mismatch.probe, status: mismatch.status, detail: mismatch.detail, severity: mismatch.severity, contentHash, durationMs: Date.now() - t0 });
    return receipts; // the format is wrong; per-format validation below would only restate it
  }

  const t1 = Date.now();
  const verdict = await validateArtifactBytes(location, bytes);
  receipts.push({ target: location, probe: verdict.probe, status: verdict.status, detail: verdict.detail, severity: verdict.severity, contentHash, durationMs: Date.now() - t1 });
  return receipts;
}

async function probeUrl(location: string, cited: boolean): Promise<ArtifactProbeReceipt[]> {
  const started = Date.now();
  try {
    const response = await withTimeout(fetch(location, { method: "GET" }), PER_PROBE_TIMEOUT_MS, `GET ${location}`);
    const body = await withTimeout(response.text(), PER_PROBE_TIMEOUT_MS, `read ${location}`);
    const ok = response.ok && body.trim().length > 0;
    return [{
      target: location,
      probe: "served_health",
      status: ok ? "pass" : "fail",
      // A URL we SERVE is our artifact — dead means the app is broken, so that stays
      // hard. A URL we merely CITED is someone else's page: 403/404 to a bare GET is
      // routine and says nothing about our deliverable, so it is soft. Without the
      // distinction, a cited news link told a rebuild agent "a file you produced this
      // turn is CORRUPT on disk" about a third-party web page.
      ...(cited ? { severity: "soft" as const } : {}),
      detail: ok ? `HTTP ${response.status}, ${body.length} bytes` : `HTTP ${response.status}${body.trim().length === 0 ? ", empty body" : ""}`,
      contentHash: createHash("sha256").update(body).digest("hex").slice(0, 16),
      bytes: body.length,
      durationMs: Date.now() - started,
    }];
  } catch (error) {
    return [{
      target: location,
      probe: "served_health",
      status: "fail",
      ...(cited ? { severity: "soft" as const } : {}),   // see above
      detail: `unreachable: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
      durationMs: Date.now() - started,
    }];
  }
}

/** Probe every artifact ref deterministically within a bounded time budget. */
export async function probeArtifacts(
  refs: ReadonlyArray<QaJudgeArtifactRef>,
  opts: { workspacePath: string },
): Promise<ArtifactProbeReport> {
  if (refs.length === 0) return { status: "not_applicable", receipts: [], probedCount: 0 };
  const started = Date.now();
  const receipts: ArtifactProbeReceipt[] = [];
  for (const ref of refs) {
    if (Date.now() - started > OVERALL_TIMEOUT_MS) {
      log.warn({ probed: receipts.length, total: refs.length }, "Artifact probe budget exhausted — remaining refs unprobed");
      break;
    }
    try {
      receipts.push(...(ref.kind === "file"
        ? await withTimeout(probeFile(opts.workspacePath, ref.location), PER_PROBE_TIMEOUT_MS * 2, `probe ${ref.location}`)
        : await probeUrl(ref.location, ref.external === true)));
    } catch (error) {
      // A probe that ERRORED proved nothing about the artifact — soft, not a defect.
      receipts.push({ target: ref.location, probe: "exists", status: "fail", severity: "soft", detail: `probe error: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`, durationMs: 0 });
    }
  }
  // Only a HARD failure is grounds for failing the report and spending a rebuild.
  // A soft failure is reported in the receipts and otherwise ignored; an
  // unverifiable artifact means "nothing was proven broken, but nothing was proven
  // sound either" — an honest caveat, never a rebuild.
  const hardFail = receipts.some((receipt) => receipt.status === "fail" && receipt.severity !== "soft");
  const anyUnverifiable = receipts.some((receipt) => receipt.status === "unverifiable");
  return {
    status: hardFail ? "fail" : anyUnverifiable ? "unverifiable" : "pass",
    receipts,
    probedCount: receipts.length,
  };
}
