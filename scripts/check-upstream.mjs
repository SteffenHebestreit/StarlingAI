#!/usr/bin/env node
/**
 * check-upstream.mjs — drift report for FORKS of this repo: what does the
 * upstream remote have that this fork doesn't, and which commits are
 * fork-only? Uses git patch-equivalence (--cherry-mark) so commits that were
 * cherry-picked in either direction don't count as drift.
 *
 * Usage (from a fork, with a remote pointing at upstream):
 *   node scripts/check-upstream.mjs [--fetch] [--base develop] [--remote upstream]
 *
 * Exit code 1 when upstream commits are missing from the fork — usable as a
 * cron/job signal. A JSON report is written to <stateDir>/upstream-reports/
 * (state dir name comes from product.json, defaulting to .starlingai).
 *
 * Run from upstream itself this is a no-op ("fully synced") as long as the
 * compared refs match. See docs/fork-boilerplate-plan.md for the fork model.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stateDirName() {
  try {
    const productFile = resolve(ROOT, "product.json");
    if (existsSync(productFile)) {
      const parsed = JSON.parse(readFileSync(productFile, "utf8"));
      if (typeof parsed.stateDirName === "string" && parsed.stateDirName.startsWith(".")) {
        return parsed.stateDirName;
      }
    }
  } catch {
    // fall through to default
  }
  return ".starlingai";
}

const REPORT_DIR = resolve(ROOT, stateDirName(), "upstream-reports");

const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "develop";
const remote = args.includes("--remote") ? args[args.indexOf("--remote") + 1] : "origin";
const upstreamRef = `${remote}/${base}`;

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}

function main() {
  if (doFetch) {
    console.log(`Fetching ${remote}…`);
    git("fetch", remote);
  }

  let upstreamTip;
  try {
    upstreamTip = git("rev-parse", "--short", upstreamRef);
  } catch {
    console.error(`Cannot resolve ${upstreamRef} — is '${remote}' configured and fetched?`);
    process.exit(2);
  }
  const localTip = git("rev-parse", "--short", base);

  // Commits upstream that have no patch-equivalent on the fork ("+" marks).
  const upstreamOnly = git(
    "log", "--oneline", "--cherry-mark", "--right-only",
    `${base}...${upstreamRef}`,
  ).split("\n").filter(Boolean);
  const newUpstream = upstreamOnly.filter((l) => l.startsWith("+ "));

  // Commits the fork carries that upstream doesn't (the fork's domain layer).
  const forkOnly = git(
    "log", "--oneline", "--cherry-mark", "--left-only",
    `${base}...${upstreamRef}`,
  ).split("\n").filter(Boolean).filter((l) => l.startsWith("+ "));

  const report = {
    timestamp: new Date().toISOString(),
    base,
    remote,
    localTip,
    upstreamTip,
    upstreamCommitsNotInFork: newUpstream.map((l) => l.slice(2)),
    forkOnlyCommits: forkOnly.map((l) => l.slice(2)),
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, "-").slice(0, 19);
  const reportFile = resolve(REPORT_DIR, `upstream-${stamp}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));

  console.log(`\n=== Upstream drift report (${base} vs ${upstreamRef}) ===`);
  console.log(`local: ${localTip}   upstream: ${upstreamTip}`);
  console.log(`upstream commits not in fork: ${newUpstream.length}`);
  for (const l of newUpstream.slice(0, 20)) console.log(`  + ${l.slice(2)}`);
  if (newUpstream.length > 20) console.log(`  … and ${newUpstream.length - 20} more`);
  console.log(`fork-only commits (domain layer): ${forkOnly.length}`);
  console.log(`Report: ${reportFile}`);

  if (newUpstream.length > 0) {
    console.log("\nNext step — fork-owned-surfaces model (docs/fork-boilerplate-plan.md):");
    console.log(`  git fetch ${remote} && git rebase ${upstreamRef}`);
    console.log("  (or merge, if your fork's history policy prefers it)");
    console.log("  then: pnpm -r check && pnpm build && run the core test suite");
    process.exitCode = 1; // signal "drift found" for cron/job consumers
  } else {
    console.log("\nFork is fully synced with upstream.");
  }
}

main();
