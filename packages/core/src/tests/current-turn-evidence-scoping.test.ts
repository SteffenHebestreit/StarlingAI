import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every recovery backstop that reads delegated evidence out of the history must stay on the
 * current turn. Unscoped, the scan reaches back across turns and a prior turn's richer deliverable
 * wins the "best evidence" contest — audit 2f4f5fe6 shipped a turn-2 news digest as the answer to
 * an unrelated turn-4 question, and the same scan fed the failed-research backstop, the terminal
 * synthesis backstop and the delegation-loop reply. The one legitimate cross-turn reader is the
 * follow-up prompt that deliberately offers the previous turn's evidence for reuse.
 */
const AGENT_DIR = fileURLToPath(new URL("../agent/", import.meta.url));
const CROSS_TURN_ALLOWED = new Set(["runtime.ts:priorDelegateEvidenceForFollowUp"]);

describe("delegated-evidence backstops are scoped to the current turn", () => {
  it("passes scopeToCurrentTurn at every call site except the follow-up reuse prompt", () => {
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of readdirSync(AGENT_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = readFileSync(`${AGENT_DIR}${file}`, "utf8");
      const re = /(?:const|let)\s+(\w+)\s*=\s*findRecentDelegateEvidence\(([^;]*?)\);/g;
      for (const m of src.matchAll(re)) {
        const tag = `${file}:${m[1]}`;
        seen.push(tag);
        if (CROSS_TURN_ALLOWED.has(tag)) continue;
        if (!/scopeToCurrentTurn:\s*true/.test(m[2]!)) offenders.push(tag);
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(6);   // the scan is looking at the real call sites
    expect(offenders).toEqual([]);
  });
});
