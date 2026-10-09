import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * TWO LEDGERS ARE DEPLOYMENT-SCOPED, AND THE RULE IS NOT EXPRESSIBLE IN THE TYPE.
 *
 * The agent outcomes ledger and the promoted-agents catalog describe THIS DEPLOYMENT's agents.
 * Every reader of them resolves the shared root from config — around twenty sites. Their functions
 * take a `workspacePath: string`, and since workspaces became per-user, a caller that passes its own
 * execution root (`ctx.workspacePath` / `opts.workspacePath`) is passing one account's directory.
 *
 * Nothing fails when that happens. The promotion is written where nothing reads it; the success
 * rate that decided it was computed from a fraction of the history; the routing circuit sees an
 * empty ledger. Five call sites had drifted that way, and an ephemeral agent that earned promotion
 * could never appear.
 *
 * A type cannot say "this string must be the shared root". This test can: no call to these
 * functions may take its root from the execution context.
 */
const LEDGER_FUNCTIONS = [
  "appendOutcome",
  "readRecentOutcomes",
  "readPromotedAgents",
  "promoteEphemeralAgent",
  "writePromotedAgents",
];

/** The execution-context roots — per-user since the workspace isolation work. */
const EXECUTION_ROOT_ARGS = /^(ctx|opts|session|request|input\.ctx)\./;

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "tests" || entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the deployment ledgers are never read or written against a per-user root", () => {
  it("has no call site taking its workspace root from the execution context", () => {
    const offenders: string[] = [];
    const pattern = new RegExp(`\\b(${LEDGER_FUNCTIONS.join("|")})\\(\\s*([A-Za-z_.]+)`, "g");

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        const [, fn, firstArg] = match;
        if (!firstArg || !EXECUTION_ROOT_ARGS.test(firstArg)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${file.slice(SRC.length + 1).replace(/\\/g, "/")}:${line} ${fn}(${firstArg}…)`);
      }
    }

    expect(offenders, [
      "These pass a per-user execution root to a deployment-scoped ledger.",
      "Use getConfig().workspacePath — every reader of these ledgers does.",
    ].join(" ")).toEqual([]);
  });
});
