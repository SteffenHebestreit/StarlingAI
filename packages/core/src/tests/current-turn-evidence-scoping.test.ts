import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every recovery backstop that reads delegated evidence out of the history must stay on the
 * current turn. Unscoped, the scan reaches back across turns and a prior turn's richer deliverable
 * wins the "best evidence" contest — audit 2f4f5fe6 shipped a turn-2 news digest as the answer to
 * an unrelated turn-4 question, and the same scan fed the failed-research backstop, the terminal
 * synthesis backstop and the delegation-loop reply. The one legitimate cross-turn reader is the
 * follow-up prompt that deliberately offers the previous turn's evidence for reuse.
 *
 * The scan is paren-balanced over the whole source tree (not a one-line regex over one directory),
 * so a call split across lines, an inline call inside a condition, or a new call site in another
 * folder cannot slip past it.
 */
const SRC = fileURLToPath(new URL("../", import.meta.url));
const CROSS_TURN_ALLOWED = new Set(["agent/runtime.ts:priorDelegateEvidenceForFollowUp"]);
const CALL = "findRecentDelegateEvidence(";

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "tests" || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) yield full;
  }
}

/** The argument text of the call starting at `open` (index of its "("), paren-balanced. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return text.slice(open + 1);
}

describe("delegated-evidence backstops are scoped to the current turn", () => {
  it("passes scopeToCurrentTurn at every call site except the follow-up reuse prompt", () => {
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(SRC, file).replace(/\\/g, "/");
      let at = text.indexOf(CALL);
      while (at !== -1) {
        const before = text.slice(Math.max(0, at - 200), at);
        if (!/function\s+$/.test(before)) {                       // not the definition
          const name = /(?:const|let)\s+(\w+)\s*=\s*$/.exec(before)?.[1] ?? "(inline)";
          const tag = `${rel}:${name}`;
          seen.push(tag);
          const args = callArguments(text, at + CALL.length - 1);
          if (!CROSS_TURN_ALLOWED.has(tag) && !/scopeToCurrentTurn\s*:\s*true/.test(args)) offenders.push(tag);
        }
        at = text.indexOf(CALL, at + CALL.length);
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(10);   // the real call-site count at the time of writing
    expect(offenders).toEqual([]);
  });
});
