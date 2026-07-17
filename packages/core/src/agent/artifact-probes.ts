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
import type { QaJudgeArtifactRef } from "./qa-tool-judge.js";

const log = childLogger("agent:artifact-probes");

const MAX_PROBE_BYTES = 8 * 1024 * 1024;
const PER_PROBE_TIMEOUT_MS = 5_000;
const OVERALL_TIMEOUT_MS = 20_000;

export interface ArtifactProbeReceipt {
  target: string;
  probe: "exists" | "json_parse" | "html_structure" | "served_health";
  status: "pass" | "fail";
  detail: string;
  contentHash?: string;
  bytes?: number;
  durationMs: number;
}

export interface ArtifactProbeReport {
  status: "pass" | "fail" | "not_applicable";
  receipts: ArtifactProbeReceipt[];
  probedCount: number;
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

/** Structural HTML sanity: non-empty, no truncation mid-tag, opened script/body/html closed. */
export function probeHtmlStructure(content: string): { ok: boolean; detail: string } {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, detail: "empty file" };
  // Truncation heuristic: file ends inside an unterminated tag.
  const lastOpen = trimmed.lastIndexOf("<");
  const lastClose = trimmed.lastIndexOf(">");
  if (lastOpen > lastClose) return { ok: false, detail: "ends mid-tag (truncated write)" };
  for (const tag of ["script", "body", "html"]) {
    const opens = (trimmed.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
    const closes = (trimmed.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
    if (opens > closes) return { ok: false, detail: `unclosed <${tag}> (${opens} opened, ${closes} closed)` };
  }
  return { ok: true, detail: "structure balanced" };
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
      return [{ target: location, probe: "exists", status: "pass", detail: `exists (${info.size} bytes; content probes skipped over size cap)`, bytes: info.size, durationMs: Date.now() - started }];
    }
    content = await readFile(absolute);
  } catch (error) {
    return [{ target: location, probe: "exists", status: "fail", detail: `unreadable: ${error instanceof Error ? error.message : String(error)}`, durationMs: Date.now() - started }];
  }
  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  receipts.push({ target: location, probe: "exists", status: "pass", detail: "readable", contentHash, bytes: content.length, durationMs: Date.now() - started });

  const lower = location.toLowerCase();
  if (lower.endsWith(".json")) {
    const t0 = Date.now();
    try {
      JSON.parse(content.toString("utf8"));
      receipts.push({ target: location, probe: "json_parse", status: "pass", detail: "valid JSON", contentHash, durationMs: Date.now() - t0 });
    } catch (error) {
      receipts.push({ target: location, probe: "json_parse", status: "fail", detail: `invalid JSON: ${error instanceof Error ? error.message.slice(0, 120) : "parse error"}`, contentHash, durationMs: Date.now() - t0 });
    }
  } else if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    const t0 = Date.now();
    const result = probeHtmlStructure(content.toString("utf8"));
    receipts.push({ target: location, probe: "html_structure", status: result.ok ? "pass" : "fail", detail: result.detail, contentHash, durationMs: Date.now() - t0 });
  }
  return receipts;
}

async function probeUrl(location: string): Promise<ArtifactProbeReceipt[]> {
  const started = Date.now();
  try {
    const response = await withTimeout(fetch(location, { method: "GET" }), PER_PROBE_TIMEOUT_MS, `GET ${location}`);
    const body = await withTimeout(response.text(), PER_PROBE_TIMEOUT_MS, `read ${location}`);
    const ok = response.ok && body.trim().length > 0;
    return [{
      target: location,
      probe: "served_health",
      status: ok ? "pass" : "fail",
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
        : await probeUrl(ref.location)));
    } catch (error) {
      receipts.push({ target: ref.location, probe: "exists", status: "fail", detail: `probe error: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`, durationMs: 0 });
    }
  }
  return {
    status: receipts.some((receipt) => receipt.status === "fail") ? "fail" : "pass",
    receipts,
    probedCount: receipts.length,
  };
}
