// Config feature registry and dead-flag detector.
//
// Read-only unless --write is supplied. It inventories every Zod field in the
// root configuration schema and its schema shards, including declared defaults,
// effective compiled-config paths, non-schema production read sites, and docs
// references. Run `pnpm config:audit-flags -- --strict --require-effective` in CI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const strictDocs = args.includes("--strict-docs");
const verbose = args.includes("--verbose");
const requireEffective = args.includes("--require-effective");
const writeIndex = args.indexOf("--write");
const writePath = writeIndex >= 0 ? args[writeIndex + 1] : undefined;

if (writeIndex >= 0 && (!writePath || writePath.startsWith("--"))) {
  console.error("--write requires an output path");
  process.exit(2);
}

const ROOT = process.cwd();
const SCHEMA_ROOT = "packages/core/src/config";
const EFFECTIVE_CONFIG = "runtime loader";
const SOURCE_ROOTS = ["packages/core/src", "packages/web/src", "packages/mail-service/src"];
const DOC_ROOTS = ["README.md", "config/README.md", "docs"];

function normalized(path) {
  return path.replace(/\\/g, "/");
}

function walk(dir, filter = () => true) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      // Anchor to whole path segments: a substring test would silently skip
      // e.g. src/distributed/ or src/discovery/. normalized() yields "/"-separated paths.
      if (!/(^|\/)(node_modules|dist|coverage)(\/|$)/.test(normalized(path))) files.push(...walk(path, filter));
    } else if (filter(path)) {
      files.push(path);
    }
  }
  return files;
}

function sourceLine(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function schemaEntries(path) {
  const text = readFileSync(path, "utf8");
  const fields = [];
  for (const match of text.matchAll(/^[ \t]{2,}([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*z\./gm)) {
    const lineStart = match.index ?? 0;
    const line = text.slice(lineStart, text.indexOf("\n", lineStart) === -1 ? text.length : text.indexOf("\n", lineStart));
    const defaultMatch = /\.default\(([^)]*)\)/.exec(line);
    fields.push({
      name: match[1],
      schemaFile: normalized(path),
      line: sourceLine(text, lineStart),
      defaultExpression: defaultMatch?.[1]?.trim() ?? null,
    });
  }
  return fields;
}

function flattenEffective(value, path = []) {
  if (Array.isArray(value)) return [{ path, value }];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) => flattenEffective(nested, [...path, key]));
  }
  return [{ path, value }];
}

function redactEffectiveValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return `<string:${value.length}>`;
  if (Array.isArray(value)) return `<array:${value.length}>`;
  return "<object>";
}

const schemaFiles = walk(SCHEMA_ROOT, (path) => {
  const normalizedPath = normalized(path);
  return normalizedPath.endsWith("/schema.ts") || normalizedPath.includes("/schemas/") && normalizedPath.endsWith(".ts");
});
const schemaFieldEntries = schemaFiles.flatMap(schemaEntries);
const fieldNames = [...new Set(schemaFieldEntries.map((entry) => entry.name))].sort((left, right) => left.localeCompare(right));
const schemaFileSet = new Set(schemaFiles.map(normalized));

const sourceFiles = SOURCE_ROOTS.flatMap((root) => walk(root, (path) => {
  const normalizedPath = normalized(path);
  return /\.(ts|vue|mjs)$/.test(normalizedPath)
    && !normalizedPath.endsWith(".test.ts")
    && !schemaFileSet.has(normalizedPath);
}));
const sourceContents = sourceFiles.map((path) => ({ path: normalized(path), text: readFileSync(path, "utf8") }));

const docFiles = DOC_ROOTS.flatMap((root) => {
  if (!existsSync(root)) return [];
  if (statSync(root).isDirectory()) return walk(root, (path) => path.endsWith(".md"));
  return [root];
});
const docContents = docFiles.map((path) => ({ path: normalized(path), text: readFileSync(path, "utf8") }));

let effectiveConfig;
let effectiveConfigError;
try {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const env = { ...process.env, LOG_LEVEL: "silent" };
  if (!env.SAI_CONFIG_PATH) env.SAI_CONFIG_PATH = resolve(ROOT, "config");
  if (!env.SAI_WORKSPACE_CONFIG_PATH) env.SAI_WORKSPACE_CONFIG_PATH = resolve(ROOT, "workspace");
  const output = execFileSync(
    pnpm,
    ["--filter", "@starlingai/core", "exec", "tsx", "src/scripts/print-effective-config.ts"],
    { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" },
  );
  effectiveConfig = JSON.parse(output);
} catch (error) {
  effectiveConfigError = error instanceof Error ? error.message : String(error);
}
if (effectiveConfig === undefined && existsSync("starlingai.json")) {
  try {
    effectiveConfig = JSON.parse(readFileSync("starlingai.json", "utf8"));
    effectiveConfigError = "Runtime loader unavailable; using merged starlingai.json without schema-default expansion.";
  } catch (error) {
    effectiveConfigError = error instanceof Error ? error.message : String(error);
  }
} else if (effectiveConfig === undefined && !effectiveConfigError) {
  effectiveConfigError = "Unable to load effective configuration.";
}
const effectiveLeaves = effectiveConfig === undefined ? [] : flattenEffective(effectiveConfig);

const fields = fieldNames.map((name) => {
  const word = new RegExp(`\\b${name}\\b`);
  const declarations = schemaFieldEntries.filter((entry) => entry.name === name);
  const effective = effectiveLeaves
    .filter((leaf) => leaf.path.at(-1) === name)
    .map((leaf) => ({ path: leaf.path.join("."), value: redactEffectiveValue(leaf.value) }));
  return {
    name,
    declarations,
    defaults: [...new Set(declarations.map((entry) => entry.defaultExpression).filter(Boolean))],
    effective,
    readSites: sourceContents.filter((source) => word.test(source.text)).map((source) => source.path),
    documentedIn: docContents.filter((doc) => word.test(doc.text)).map((doc) => doc.path),
  };
});

const unreferenced = fields.filter((field) => field.readSites.length === 0);
const documentedButNotEffective = effectiveConfig === undefined
  ? []
  : fields.filter((field) => field.documentedIn.length > 0 && field.effective.length === 0);
const registry = {
  version: 1,
  generatedAt: new Date().toISOString(),
  schemaFiles: schemaFiles.map(normalized).sort(),
  sourceFilesScanned: sourceFiles.length,
  effectiveConfig: {
    path: effectiveConfigError?.startsWith("Runtime loader unavailable") ? "starlingai.json (fallback)" : EFFECTIVE_CONFIG,
    available: effectiveConfig !== undefined,
    ...(effectiveConfigError ? { error: effectiveConfigError } : {}),
  },
  fields,
};

if (writePath) {
  const resolved = resolve(ROOT, writePath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  if (!asJson) console.log(`Feature registry written: ${normalized(relative(ROOT, resolved))}`);
}

if (asJson) {
  console.log(JSON.stringify(registry, null, 2));
} else {
  console.log(`Schema files scanned : ${schemaFiles.length}`);
  console.log(`Source files scanned : ${sourceFiles.length}`);
  console.log(`Schema fields         : ${fields.length}`);
  console.log(`Effective config      : ${effectiveConfig === undefined ? "unavailable" : EFFECTIVE_CONFIG}`);
  console.log(`Unreferenced (dead?) : ${unreferenced.length}`);
  console.log(`Documented but absent : ${documentedButNotEffective.length} (optional/deployment-specific)`);
  if (unreferenced.length) console.log("\nUnreferenced fields:\n" + unreferenced.map((field) => `  - ${field.name}`).join("\n"));
  if (documentedButNotEffective.length && (verbose || strictDocs)) {
    console.log("\nDocumented fields absent from effective config:\n" + documentedButNotEffective.map((field) => `  - ${field.name}`).join("\n"));
  }
}

if (requireEffective && effectiveConfig === undefined) process.exitCode = 2;
if ((strict && unreferenced.length > 0) || (strictDocs && documentedButNotEffective.length > 0)) process.exitCode = 1;
