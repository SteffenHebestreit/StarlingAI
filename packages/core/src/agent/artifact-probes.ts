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
import { dirname, resolve, sep } from "node:path";
import { childLogger } from "../logger.js";
import { validateArtifactBytes, checkFormatMatchesExtension, validateHtmlText, extensionOf } from "./artifact-validators.js";
import type { QaJudgeArtifactRef } from "./qa-tool-judge.js";
import { UNFINISHED_STUB_MARKER } from "./sub-agent-prompt-guidance.js";

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

// ── Structural completeness (unfilled placeholders) ──────────────────────────

/**
 * Is the file FINISHED, or is it a scaffold with the content never filled in?
 *
 * The measured failure this exists for: a staged build wrote a skeleton holding block
 * comments reading CSS_STUB, JS_PART1 and JS_PART2, filled the CSS, then ran out of
 * iterations. The delivered 2,684-byte page was a complete, balanced HTML document
 * whose <script> contained nothing but the two markers — so `exists` passed, and
 * `html_structure` passed, and the probe report said "pass" over a dead file. Every
 * validator asks "is this WELL-FORMED"; none asked "is anything actually IN it".
 *
 * The signal is structural, not a table of this run's strings. A comment that carries
 * no prose of its own and consists of one screaming-case token drawn from the stub
 * vocabulary is not an annotation — it is a slot where content was supposed to go.
 * Two rules, in order of how much they prove:
 *
 *   A. The comment's ENTIRE content is one screaming-case token containing a stub
 *      word — a block comment reading JS_PART1 or CSS_STUB, an `<!-- TODO -->`. The
 *      comment contributes nothing, so it stands in for something missing. Hard fail.
 *   B. A block that should hold code — an inline <script>/<style>, or a whole code
 *      file — has NO content besides comments, and one of those comments carries a
 *      compound screaming-case stub identifier (`<!-- BEGIN JS_PART2 -->`). Here the
 *      emptiness is the proof and the marker only names the hole. Hard fail.
 *
 * What deliberately does NOT fire, because a false fail burns a rebuild and can
 * replace a good deliverable with a worse one (see artifact-validators.ts):
 *
 *   - prose or a code sample: "TODO" in body text, in a <pre> tutorial block, or in a
 *     string literal is not inside a comment at all;
 *   - a real annotation: `// TODO: handle the resize when the canvas is detached`
 *     carries lowercase prose, so it is not a bare token — it documents work, it does
 *     not replace it;
 *   - a section banner reading `===== PART 2: RENDERING =====` is several tokens, not
 *     one, and rule B needs the surrounding block to be empty of code;
 *   - a legitimate identifier: `TODO_LIST_KEY` mentioned inside a sentence-bearing
 *     comment in a to-do app — rule A needs the comment to be nothing else, rule B
 *     needs the block around it to be dead;
 *   - a word that merely starts with one: PARTICLES, PARTITION, DEPARTMENT. The stub
 *     word has to be a whole segment of the token, never a substring of it.
 *
 * Prose formats (.md/.txt/.csv/.json/.xml) are out of scope entirely: there a stub
 * word is content, not structure, and markdown fences are full of `// TODO` samples.
 *
 * Swept over this repo's 800 committed .html/.css/.js/.ts files, including its real
 * `// TODO: platform-specific implementation` annotations: zero fire. The only hits
 * are the fixtures for this check and the two test files that carry marker strings as
 * DATA — block comments are matched textually, so a marker inside a string literal
 * reports too. In a deliverable that is the right answer anyway.
 */
const COMPLETENESS_EXTENSIONS = new Set([".html", ".htm", ".svg", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

/**
 * Stub vocabulary — words, not the exact strings any one run happened to emit, and
 * matched as a whole SEGMENT of the token (optionally numbered). Substring matching
 * would read PARTICLES, PARTITION and DEPARTMENT as "PART" and hard-fail a game
 * bundle over its own particle system.
 */
const STUB_SEGMENT = /^(?:STUB|PART|PLACEHOLDER|TODO|FIXME|TBD)\d*$/;
/** One screaming-case token and nothing else: TODO, CSS_STUB, JS_PART1, PLACEHOLDER-2. */
const CAPS_TOKEN = /^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)*$/;
/** Screaming-case WITH a separator — machine-generated by construction, never prose. */
const CAPS_COMPOUND = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
const C_BLOCK_COMMENT = /\/\*([\s\S]*?)\*\//g;

/** Comment bodies inside CODE — a script/style body, or a whole code file. */
function codeComments(text: string): string[] {
  const bodies: string[] = [];
  for (const match of text.matchAll(C_BLOCK_COMMENT)) bodies.push(match[1] ?? "");
  // A `//` is only a comment when the WHOLE line is one. Matching it mid-line would
  // read `https://…` and any `"// TODO"` string literal as comments and fail valid files.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) bodies.push(trimmed.slice(2));
  }
  return bodies;
}

/**
 * Every comment in the artifact — and in HTML, ONLY the real ones. Outside a
 * script/style element `/* …` and `//` are ordinary text: a `<pre>` tutorial block
 * showing `// TODO` is a code SAMPLE, and scanning the raw document would fail a
 * perfectly good page over it. So HTML is scanned as HTML comments over the whole
 * document plus code comments within each inline script/style body.
 */
function commentBodiesFor(text: string, ext: string): string[] {
  if (!isMarkupExtension(ext)) return codeComments(text);
  const bodies = [...text.matchAll(HTML_COMMENT)].map((match) => match[1] ?? "");
  for (const block of codeBlocks(text, ext)) bodies.push(...codeComments(block.body));
  return bodies;
}

function withoutCodeComments(text: string): string {
  return text.replace(C_BLOCK_COMMENT, "").replace(HTML_COMMENT, "")
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

function isMarkupExtension(ext: string): boolean {
  return ext === ".html" || ext === ".htm" || ext === ".svg";
}

/** True when one of the token's segments IS a stub word — PART1 yes, PARTICLES no. */
function hasStubSegment(token: string): boolean {
  return token.split(/[_-]/).some((segment) => STUB_SEGMENT.test(segment));
}

/** Rule A: the comment's whole content, minus decoration, is one stub token. */
function placeholderTokenOf(body: string): string | null {
  const core = body.replace(/^[\s*=~+#.!:<>-]+/, "").replace(/[\s*=~+#.!:<>-]+$/, "");
  return core && CAPS_TOKEN.test(core) && hasStubSegment(core) ? core : null;
}

/** Rule B: a compound screaming-case stub identifier anywhere in the comment. */
function compoundStubTokenIn(body: string): string | null {
  for (const token of body.match(CAPS_COMPOUND) ?? []) {
    if (hasStubSegment(token)) return token;
  }
  return null;
}

/**
 * Blocks that are supposed to hold code. For HTML/SVG those are the INLINE
 * <script>/<style> elements — one carrying src/href is a reference to an external
 * resource, where an empty body is exactly right. For a code file it is the file.
 */
function codeBlocks(text: string, ext: string): Array<{ label: string; body: string }> {
  if (!isMarkupExtension(ext)) return [{ label: "file", body: text }];
  const blocks: Array<{ label: string; body: string }> = [];
  for (const match of text.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    if (/\b(?:src|href)\s*=/i.test(match[2] ?? "")) continue;
    blocks.push({ label: `<${match[1]!.toLowerCase()}>`, body: match[3] ?? "" });
  }
  return blocks;
}

/** null when the extension is out of scope for this check. */
export function checkStructuralCompleteness(location: string, text: string): { status: "pass" | "fail"; detail: string } | null {
  // THE HARNESS'S OWN MARKER, checked before anything else and before the extension gate.
  //
  // The rules below read COMMENT BODIES, and run 2dc5832c is what that misses: the staged-build
  // directive asks for `throw new Error("UNFINISHED_STUB: core");` — deliberately executable, so
  // the half-built file fails loudly instead of looking finished — and executable code is not a
  // comment. The delivered file carried eight of them, threw on its first line in the user's
  // browser, and this probe reported `artifactProbeStatus: "pass"`.
  //
  // No extension gate: the marker is a token this codebase invented and only this codebase emits,
  // so its presence is unambiguous in any file type (run a7b8fe3e left one in a .css, where an
  // unfilled marker is SILENT — the page loads unstyled and looks merely ugly rather than broken).
  const stubCount = text.split(UNFINISHED_STUB_MARKER).length - 1;
  if (stubCount > 0) {
    return {
      status: "fail",
      detail: `${stubCount} ${UNFINISHED_STUB_MARKER} marker(s) still in the file — the staged build wrote a `
        + "skeleton and never filled these subsystems, so this is a scaffold, not a finished artifact",
    };
  }

  const ext = extensionOf(location);
  if (!COMPLETENESS_EXTENSIONS.has(ext)) return null;

  const markers = [...new Set(commentBodiesFor(text, ext).map(placeholderTokenOf).filter((t): t is string => t !== null))];
  if (markers.length > 0) {
    return {
      status: "fail",
      detail: `${markers.length} unfilled placeholder marker(s) left in the file (${markers.slice(0, 4).join(", ")}) — `
        + "the build wrote a skeleton and never filled these slots, so the deliverable is a scaffold, not a finished file",
    };
  }

  for (const block of codeBlocks(text, ext)) {
    if (!block.body.trim() || withoutCodeComments(block.body).trim()) continue; // empty by design, or has real content
    const token = codeComments(block.body).map(compoundStubTokenIn).find((t) => t != null);
    if (token) {
      return {
        status: "fail",
        detail: `${block.label} holds no code at all — only the placeholder marker ${token} — so the block was never filled in`,
      };
    }
  }
  return { status: "pass", detail: "no unfilled placeholder markers" };
}

/**
 * Local .css/.js the page still points at instead of carrying inline.
 *
 * SOFT, permanently, and the reasoning is the point: linking your own stylesheet is
 * what a normal multi-file site does, and this module cannot see the request, so it
 * cannot know whether "inline everything" was ever asked for. Failing on it would
 * burn a rebuild on correct deliverables, which is the asymmetry this codebase spends
 * a page of artifact-validators.ts protecting. Reported because it is real evidence a
 * reviewer wants — and no recall is lost on the measured failure, which the
 * placeholder rule above already hard-fails.
 */
export function findLocalAssetRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/<(?:link[^>]*?href|script[^>]*?src)\s*=\s*["']([^"']+)["']/gi)) {
    const url = (match[1] ?? "").trim();
    if (!url || url.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // absolute, protocol-relative, data:
    if (!/\.(?:css|m?js)(?:[?#].*)?$/i.test(url)) continue;
    refs.push(url);
  }
  return [...new Set(refs)];
}

/**
 * Open the .css/.js a page loads and check THEM for unfinished markers.
 *
 * Bounded on every axis a page could abuse: at most MAX_FOLLOWED_REFS files, each under
 * the same byte cap as a probed artifact, each resolved and then checked to still sit
 * inside the workspace so a crafted `href="../../etc/passwd"` cannot walk out.
 */
const MAX_FOLLOWED_REFS = 6;

async function probeReferencedAssets(
  workspacePath: string,
  htmlLocation: string,
  refs: readonly string[],
): Promise<ArtifactProbeReceipt[]> {
  const receipts: ArtifactProbeReceipt[] = [];
  const workspaceRoot = resolve(workspacePath);
  const htmlDir = dirname(resolve(workspacePath, htmlLocation));

  for (const ref of refs.slice(0, MAX_FOLLOWED_REFS)) {
    const started = Date.now();
    const absolute = resolve(htmlDir, ref);
    if (absolute !== workspaceRoot && !absolute.startsWith(workspaceRoot + sep)) continue;
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size === 0 || info.size > MAX_PROBE_BYTES) continue;
      const assetText = (await readFile(absolute)).toString("utf8");
      const completeness = checkStructuralCompleteness(ref, assetText);
      if (completeness?.status === "fail") {
        receipts.push({
          target: `${htmlLocation} → ${ref}`,
          probe: "completeness",
          status: "fail",
          severity: "hard",
          detail: `the page loads '${ref}', and that file is unfinished: ${completeness.detail}`,
          durationMs: Date.now() - started,
        });
      }
    } catch {
      // Missing or unreadable — soft by design (it may be produced at serve time), and the
      // self_contained receipt above already names the reference.
    }
  }
  return receipts;
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

  // Well-formed is not the same as finished. The validators above sign off on a page
  // whose <script> holds nothing but placeholder comments; this asks whether the
  // content was ever written.
  const t2 = Date.now();
  const text = content.toString("utf8");
  const completeness = checkStructuralCompleteness(location, text);
  if (completeness) {
    receipts.push({ target: location, probe: "completeness", status: completeness.status, detail: completeness.detail, severity: "hard", contentHash, durationMs: Date.now() - t2 });
  }
  // FINISHED IS NOT THE SAME AS WORKING. Everything above reads the file; none of it runs
  // it, so this signed off `probe: "pass"` on the validation-run page that dies with
  // `ReferenceError: state is not defined` before drawing a thing. The QA gate then had a
  // passing probe and a failing verdict and no idea which to believe. Executing the page is
  // the whole point of verify_page and costs one bounded run.
  if (/^\.html?$/.test(extensionOf(location))) {
    const t3 = Date.now();
    const { checkBuiltPage } = await import("../tools/page-check.js");
    const runs = await checkBuiltPage(absolute, location);
    receipts.push({
      target: location,
      probe: "runs",
      status: runs.ok ? "pass" : "fail",
      detail: runs.ok ? "executes without uncaught errors and paints inside its canvas" : runs.detail,
      severity: "hard",
      contentHash,
      durationMs: Date.now() - t3,
    });
  }

  const localRefs = /^\.html?$/.test(extensionOf(location)) ? findLocalAssetRefs(text) : [];
  if (localRefs.length > 0) {
    receipts.push({
      target: location,
      probe: "self_contained",
      status: "fail",
      severity: "soft", // see findLocalAssetRefs — reported, never grounds for a rebuild
      detail: `still references ${localRefs.length} local asset file(s) (${localRefs.slice(0, 4).join(", ")}) rather than carrying them inline — correct for a multi-file site, wrong if the page was meant to stand alone`,
      contentHash,
      durationMs: 0,
    });
    // THE DELIVERABLE IS THE PAGE, NOT THE FILE THAT HAPPENED TO BE WRITTEN LAST.
    //
    // Run db88fa5b: the probed artifact was index.html — clean, no markers — while the
    // styles.css it loads on the very next line still carried `UNFINISHED_STUB: styles`.
    // The report said `artifactProbeStatus: "pass"` and the user was handed an unstyled,
    // half-built page. The refs were ALREADY discovered here (a soft note is written about
    // them two lines up); they were simply never opened.
    //
    // A marker in a file the page loads is a hard failure of the page, exactly as it would
    // be inline: `<link href="styles.css">` makes that file part of the artifact. A
    // MISSING ref stays soft — it may legitimately be produced at serve time — so only
    // content that is present and demonstrably unfinished can spend a rebuild.
    receipts.push(...await probeReferencedAssets(workspacePath, location, localRefs));
  }
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
