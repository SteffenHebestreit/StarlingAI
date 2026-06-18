#!/usr/bin/env node
/**
 * audit-agent-prompts — surface "manual, not map" prompt bloat.
 *
 * A swarm agent's system prompt should be a MAP (who it is, when to act, which
 * tools/skills to reach for) — not a 1000-line MANUAL that embeds every rule
 * inline. A bloated prompt crowds out the actual task in a scarce context window,
 * drowns the important constraints among the trivial, and rots as the codebase
 * moves. This makes that bloat measurable (like config:audit-flags for dead flags
 * and /api/observability/recovery-nets for dead scaffolding) so it can be trimmed
 * deliberately instead of guessed at.
 *
 * Read-only: reads the generated starlingai.json and reports per-agent systemPrompt
 * sizes, flagging any over the threshold. Never edits prompts.
 *
 * Usage: node scripts/audit-agent-prompts.mjs [--threshold <chars>] [--json]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "starlingai.json");

const args = process.argv.slice(2);
const thresholdIdx = args.indexOf("--threshold");
const THRESHOLD = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) || 2500 : 2500;
const asJson = args.includes("--json");

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (err) {
  console.error(`Could not read ${CONFIG_PATH} — run \`pnpm config:build\` first.\n${err.message}`);
  process.exit(2);
}

const subAgents = config.subAgents && typeof config.subAgents === "object" ? config.subAgents : {};
const rows = Object.entries(subAgents)
  .map(([name, def]) => ({ name, chars: typeof def?.systemPrompt === "string" ? def.systemPrompt.length : 0 }))
  .filter((r) => r.chars > 0)
  .sort((a, b) => b.chars - a.chars);

const overs = rows.filter((r) => r.chars > THRESHOLD);

if (asJson) {
  console.log(JSON.stringify({ threshold: THRESHOLD, count: rows.length, over: overs, all: rows }, null, 2));
  process.exit(0);
}

const total = rows.reduce((s, r) => s + r.chars, 0);
const mean = rows.length ? Math.round(total / rows.length) : 0;
console.log(`Agent system prompts     : ${rows.length}`);
console.log(`Mean length              : ${mean} chars`);
console.log(`"Manual smell" threshold : ${THRESHOLD} chars`);
console.log(`Over threshold (trim?)   : ${overs.length}\n`);

const top = rows.slice(0, 12);
const width = Math.max(...top.map((r) => r.name.length), 8);
for (const r of top) {
  const flag = r.chars > THRESHOLD ? "  ⚠ manual" : "";
  console.log(`  ${r.name.padEnd(width)}  ${String(r.chars).padStart(6)} chars${flag}`);
}

if (overs.length) {
  console.log(`\nConsider moving inline rules in the flagged agents into reusable skills (list_skills/recall_context)`);
  console.log(`or scenes, leaving the prompt a short map. This is advisory — prompts tuned to prevent a specific`);
  console.log(`failure (e.g. chunked-write discipline) may justify their length; trim deliberately, with eval.`);
}
