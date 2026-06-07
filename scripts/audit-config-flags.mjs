// Dead config-flag detector: schema fields with zero references in source.
//
// Read-only. Heuristic — a flag could in principle be read via dynamic/bracket
// access, so VERIFY each hit before removing. Run: node scripts/audit-config-flags.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";

const SCHEMA = "packages/core/src/config/schema.ts";
const schemaText = readFileSync(SCHEMA, "utf8");

// Config flags = `fieldName: z.…` declarations in the schema.
const fields = [...schemaText.matchAll(/^\s{2,}([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*z\./gm)].map((m) => m[1]);
const unique = [...new Set(fields)];

// Build a corpus of all source EXCEPT the schema itself and test files.
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = `${dir}/${entry}`;
    const s = statSync(p);
    if (s.isDirectory()) {
      if (!/(node_modules|dist|\/tests)/.test(p)) walk(p);
    } else if (/\.(ts|vue|mjs)$/.test(p) && !p.endsWith("schema.ts") && !p.endsWith(".test.ts")) {
      files.push(p);
    }
  }
}
walk("packages/core/src");
walk("packages/web/src");
walk("packages/mail-service/src");
const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");

const dead = unique.filter((f) => (corpus.match(new RegExp(`\\b${f}\\b`, "g")) || []).length === 0);

console.log(`Source files scanned : ${files.length}`);
console.log(`Schema flags         : ${unique.length}`);
console.log(`Unreferenced (dead?) : ${dead.length}`);
if (dead.length) console.log("\n" + dead.map((f) => `  - ${f}`).join("\n"));
