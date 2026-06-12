#!/usr/bin/env node
/**
 * One-shot codemod for the fork-boilerplate refactor (docs/fork-boilerplate-plan.md WS1):
 * replace hardcoded `.starlingai` state-dir literals in packages/core/src with
 * references to the product-identity module, inserting the import where needed.
 *
 *   node scripts/codemod-product-identity.mjs [--write]
 *
 * Without --write it prints the would-be changes per file (dry run).
 * Deliberately conservative: only quoted string literals are rewritten —
 * comments, markdown, and template-literal display strings are left for
 * manual review.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SRC = resolve(ROOT, "packages/core/src");
const WRITE = process.argv.includes("--write");

const files = globSync("**/*.ts", { cwd: SRC, exclude: (p) => p.startsWith("product") })
  .map((p) => resolve(SRC, p));

let changedCount = 0;
for (const file of files) {
  const original = readFileSync(file, "utf8");
  let content = original;
  const hits = [];

  // ".starlingai" / '.starlingai' as a standalone path segment.
  content = content.replace(/(["'])\.starlingai\1/g, () => {
    hits.push("segment");
    return "PRODUCT.stateDirName";
  });

  // ".starlingai/rest/of/path" → `${PRODUCT.stateDirName}/rest/of/path`
  // (no spaces allowed in the tail: literals with spaces are prose/fixtures, not paths)
  content = content.replace(/(["'])\.starlingai\/([^"'`\\\n ]+)\1/g, (_m, _q, rest) => {
    hits.push(`path:${rest}`);
    return "`${PRODUCT.stateDirName}/" + rest + "`";
  });

  if (!hits.length) continue;
  changedCount++;

  // Insert the PRODUCT import if the file doesn't already have one.
  if (!/from "[^"]*\/product\/index\.js"/.test(content) && !/from "\.\.?\/product/.test(content)) {
    let rel = relative(dirname(file), resolve(SRC, "product/index.js")).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    const importLine = `import { PRODUCT } from "${rel}";\n`;
    // After the last top-of-file import; before first non-import statement.
    const importBlock = [...content.matchAll(/^import [^;]+;\s*$/gm)];
    if (importBlock.length > 0) {
      const last = importBlock[importBlock.length - 1];
      const at = last.index + last[0].length;
      content = content.slice(0, at) + "\n" + importLine + content.slice(at);
    } else {
      content = importLine + content;
    }
  }

  console.log(`${relative(ROOT, file)}: ${hits.join(", ")}`);
  if (WRITE) writeFileSync(file, content, "utf8");
}

console.log(`\n${changedCount} file(s) ${WRITE ? "rewritten" : "would change (dry run — pass --write)"}`);
