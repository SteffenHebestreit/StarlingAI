/**
 * SEC-105 (ADR-007): data-only plugin manifests + trust-time compatibility scan.
 *
 * A `plugin.manifest.json` describes a plugin WITHOUT executing any of its
 * code: identity, entry file, declared tools, and requested capabilities
 * (network hosts, env vars). Parsing and validating it is pure data work, so
 * everything here runs BEFORE the trust gate ever considers importing the
 * plugin. The manifest is optional for legacy in-process plugins (the digest
 * trust receipt still gates them); when present it is ENFORCED — a manifest
 * that contradicts the on-disk reality (wrong id, missing entry) rejects the
 * plugin outright.
 *
 * The compatibility scanner is a static heuristic pass over the plugin source
 * that flags reliance on gateway process state (raw env access, child
 * processes, reaching into core internals) — the things that will break or
 * become security findings when the plugin moves into the isolated worker.
 * Heuristic by design: it produces WARNINGS for the trust decision, never a
 * silent pass/fail.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PluginManifest {
  name: string;
  version: string;
  /** Entry file relative to the plugin directory (e.g. "index.js"). */
  entry: string;
  description?: string;
  tools?: Array<{ name: string; description?: string }>;
  capabilities?: {
    /** Hosts the plugin intends to reach (future worker bridges fetch to these). */
    network?: string[];
    /** Env var NAMES the plugin needs (future worker exposes only these). */
    env?: string[];
  };
}

export type ManifestResult =
  | { status: "absent" }
  | { status: "valid"; manifest: PluginManifest }
  | { status: "invalid"; reason: string };

const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,32}$/;

/** Read + validate `plugin.manifest.json` for a plugin DIRECTORY. Pure data —
 *  no plugin code is imported. Single-file plugins have no manifest (absent). */
export function readPluginManifest(pluginDir: string, expectedId: string): ManifestResult {
  const manifestPath = join(pluginDir, "plugin.manifest.json");
  let stats;
  try { stats = statSync(pluginDir); } catch { return { status: "absent" }; }
  if (!stats.isDirectory() || !existsSync(manifestPath)) return { status: "absent" };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { status: "invalid", reason: `manifest is not valid JSON: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== "object") return { status: "invalid", reason: "manifest must be a JSON object" };
  const m = raw as Record<string, unknown>;

  if (typeof m["name"] !== "string" || !NAME_PATTERN.test(m["name"])) {
    return { status: "invalid", reason: "manifest.name missing or not a valid plugin id" };
  }
  if (m["name"] !== expectedId) {
    return { status: "invalid", reason: `manifest.name "${m["name"]}" does not match the plugin directory id "${expectedId}"` };
  }
  if (typeof m["version"] !== "string" || m["version"].length === 0) {
    return { status: "invalid", reason: "manifest.version missing" };
  }
  if (typeof m["entry"] !== "string" || m["entry"].includes("..") || m["entry"].startsWith("/")) {
    return { status: "invalid", reason: "manifest.entry missing or escapes the plugin directory" };
  }
  if (!existsSync(join(pluginDir, m["entry"]))) {
    return { status: "invalid", reason: `manifest.entry "${m["entry"]}" does not exist` };
  }
  if (m["tools"] !== undefined) {
    if (!Array.isArray(m["tools"]) || m["tools"].some((t) => !t || typeof (t as Record<string, unknown>)["name"] !== "string")) {
      return { status: "invalid", reason: "manifest.tools must be an array of { name } objects" };
    }
  }
  const caps = m["capabilities"] as Record<string, unknown> | undefined;
  if (caps !== undefined) {
    if (typeof caps !== "object" || caps === null) return { status: "invalid", reason: "manifest.capabilities must be an object" };
    for (const key of ["network", "env"] as const) {
      if (caps[key] !== undefined && (!Array.isArray(caps[key]) || (caps[key] as unknown[]).some((v) => typeof v !== "string"))) {
        return { status: "invalid", reason: `manifest.capabilities.${key} must be an array of strings` };
      }
    }
  }
  return { status: "valid", manifest: m as unknown as PluginManifest };
}

export interface CompatFinding {
  file: string;
  pattern: string;
  detail: string;
}

/** Reliance patterns that break (or become findings) under worker isolation.
 *  `envAllowlist` suppresses process.env hits for declared capability vars. */
const COMPAT_PATTERNS: Array<{ re: RegExp; pattern: string; detail: string }> = [
  { re: /process\.env(?:\.|\[)/, pattern: "process_env", detail: "reads gateway process env — the worker gets only manifest-declared vars" },
  { re: /child_process|node:child_process/, pattern: "child_process", detail: "spawns processes — not available inside the isolated worker" },
  { re: /require\(["']\.\.\/|from ["']\.\.\//, pattern: "core_internals", detail: "imports outside the plugin directory — core internals are not part of the SDK surface" },
  { re: /process\.exit\s*\(/, pattern: "process_exit", detail: "exits the process — would kill the shared gateway today, the worker later" },
  { re: /globalThis\.|global\./, pattern: "global_mutation", detail: "touches shared globals — no cross-plugin state under isolation" },
];

const SCAN_EXTENSIONS = [".js", ".mjs", ".cjs"];
const MAX_SCAN_FILES = 200;
const MAX_SCAN_BYTES = 1024 * 1024;

/** Static heuristic scan of a plugin's source for worker-isolation risks. */
export function scanPluginCompatibility(sourcePath: string, envAllowlist: string[] = []): CompatFinding[] {
  const findings: CompatFinding[] = [];
  const files: Array<{ abs: string; rel: string }> = [];
  const stats = statSync(sourcePath);
  if (stats.isFile()) {
    files.push({ abs: sourcePath, rel: sourcePath.split(/[\\/]/).pop() ?? sourcePath });
  } else {
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const abs = join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, relPath);
        else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && files.length < MAX_SCAN_FILES) {
          files.push({ abs, rel: relPath });
        }
      }
    };
    walk(sourcePath, "");
  }

  for (const file of files) {
    let content: string;
    try {
      if (statSync(file.abs).size > MAX_SCAN_BYTES) continue;
      content = readFileSync(file.abs, "utf8");
    } catch { continue; }
    for (const { re, pattern, detail } of COMPAT_PATTERNS) {
      if (!re.test(content)) continue;
      // Declared env vars are legitimate: suppress the env finding when every
      // process.env access in the file names an allowlisted var.
      if (pattern === "process_env" && envAllowlist.length > 0) {
        const accesses = [...content.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["']([^"']+)["']\])/g)]
          .map((m) => m[1] ?? m[2])
          .filter((v): v is string => typeof v === "string");
        if (accesses.length > 0 && accesses.every((v) => envAllowlist.includes(v))) continue;
      }
      findings.push({ file: file.rel, pattern, detail });
    }
  }
  return findings;
}
