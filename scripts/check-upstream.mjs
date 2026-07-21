#!/usr/bin/env node
/**
 * check-upstream.mjs — drift report for FORKS of this repo: what does the
 * upstream remote have that this fork doesn't, and which commits are
 * fork-only? Uses git patch-equivalence (--cherry-mark) so commits that were
 * cherry-picked in either direction don't count as drift.
 *
 * Usage (from a fork, with a remote pointing at upstream):
 *   node scripts/check-upstream.mjs [--fetch] [--base develop] [--remote upstream] [--strict]
 *
 * Reports two independent things:
 *   1. COMMIT drift — how far the histories have diverged.
 *   2. SURFACE drift — which upstream-shipped FILES this fork modified or
 *      deleted. Only this second number predicts rebase conflicts, and driving
 *      it to zero is the whole point of the fork-owned-surfaces model.
 *
 * Exit code 1 when upstream commits are missing from the fork — usable as a
 * cron/job signal; --strict also fails when the surface audit is non-empty.
 * A JSON report is written to <stateDir>/upstream-reports/
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

function readProduct() {
  try {
    const productFile = resolve(ROOT, "product.json");
    if (existsSync(productFile)) return JSON.parse(readFileSync(productFile, "utf8"));
  } catch {
    // fall through to upstream defaults
  }
  return {};
}

const PRODUCT = readProduct();

function stateDirName() {
  const name = PRODUCT.stateDirName;
  return typeof name === "string" && name.startsWith(".") ? name : ".starlingai";
}

const REPORT_DIR = resolve(ROOT, stateDirName(), "upstream-reports");

/**
 * Lowest numeric prefix a FORK may use for its own config/workspace shards.
 * Upstream ships 00–50 today and reserves 51–59 for its own growth, so a fork
 * starting at 60 can never collide with a future upstream shard — and because
 * later shards merge last, a fork shard always wins over the upstream one it
 * customises.
 */
const FORK_SHARD_FLOOR = 60;

/**
 * Fork-owned surface test, derived from product.json `slug`.
 *
 * Ownership is keyed on the slug (not on a hand-maintained list) so that this
 * repo and EVERY fork of it use disjoint filenames by construction: two forks
 * can be compared, or even composed into one tree, without either colliding
 * with upstream or with each other. Upstream itself ships no product.json, so
 * upstream has no slug and therefore owns none of these paths.
 *
 * Owned:
 *   product.json
 *   packages/{core,web}/src/extensions/<slug>/**
 *   config/<slug>/**  and  workspace/<slug>/**
 *   config|workspace/<group>/<NN>-<slug>*.{jsonc,json}   (NN >= FORK_SHARD_FLOOR)
 *   docker-compose.<slug>.yml
 *   anything product.json `rootAllowlist` declares
 */
function surfaceNames() {
  // `slug` is the canonical surface name — a fork's paths are named after it so
  // ownership is decidable without a hand-maintained list. Forks that adopted a
  // shorter directory name before this convention existed may declare extra
  // `surfaceNames` rather than renaming their whole extension tree; new forks
  // should just use the slug.
  const names = [];
  if (typeof PRODUCT.slug === "string") names.push(PRODUCT.slug);
  for (const extra of PRODUCT.surfaceNames ?? []) {
    if (typeof extra === "string" && !names.includes(extra)) names.push(extra);
  }
  return names;
}

const SHARD_RE = /^(?:config|workspace)\/[^/]+\/(\d{2})-([^/]+)\.jsonc?$/;

function makeForkOwnedMatcher() {
  const names = surfaceNames();
  const allow = PRODUCT.rootAllowlist ?? {};
  const rootFiles = new Set(allow.files ?? []);
  const rootDirs = allow.directories ?? [];

  return function isForkOwned(path) {
    if (path === "product.json") return true;
    if (rootFiles.has(path)) return true;
    if (rootDirs.some((d) => path === d || path.startsWith(`${d}/`))) return true;
    if (!names.length) return false;

    for (const name of names) {
      if (path.startsWith(`packages/core/src/extensions/${name}/`)) return true;
      if (path.startsWith(`packages/web/src/extensions/${name}/`)) return true;
      if (path.startsWith(`config/${name}/`) || path.startsWith(`workspace/${name}/`)) return true;
      if (path === `docker-compose.${name}.yml` || path === `docker-compose.${name}.yaml`) return true;
    }

    const shard = SHARD_RE.exec(path);
    if (shard && Number(shard[1]) >= FORK_SHARD_FLOOR) {
      if (names.some((n) => shard[2].startsWith(n))) return true;
    }

    return false;
  };
}

/**
 * A fork shard numbered inside UPSTREAM's reserved range is the one kind of
 * "added" file worth flagging. Shards merge in lexicographic path order and the
 * later one wins (config/loader.ts collectShardPaths + mergeConfigObjects), so a
 * fork shard at NN merges BEFORE every upstream shard numbered above NN: any key
 * it means to override is silently re-overridden by upstream. It also risks a
 * hard filename collision if upstream later ships that same number.
 */
function isShardRangeViolation(path) {
  const shard = SHARD_RE.exec(path);
  return Boolean(shard) && Number(shard[1]) < FORK_SHARD_FLOOR;
}

const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
// Fail the run when the fork has touched upstream-shipped files. Off by default
// so an existing fork can adopt the report before it becomes a gate.
const strict = args.includes("--strict");
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

  // ── Surface audit ──────────────────────────────────────────────────────────
  // Commit counts say how far apart the histories are; they do NOT say whether
  // the fork will REBASE CLEANLY. That is decided purely by which FILES the
  // fork touched: an upstream-shipped file the fork modified or deleted is a
  // guaranteed conflict the next time upstream touches it, while a change
  // confined to fork-owned paths can never conflict. Diff from the merge-base
  // so we see only the fork's own changes (not upstream commits it lacks).
  const isForkOwned = makeForkOwnedMatcher();
  let conflictSurface = [];
  let unownedAdditions = [];
  let shardRangeViolations = [];
  try {
    const mergeBase = git("merge-base", base, upstreamRef);
    const changes = git("diff", "--name-status", "-M", mergeBase, base)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status[0], path: rest[rest.length - 1] };
      });

    // Modified/deleted an upstream file = the real rebase-conflict surface.
    conflictSurface = changes
      .filter((c) => (c.status === "M" || c.status === "D") && !isForkOwned(c.path))
      .map((c) => ({ status: c.status, path: c.path }));

    // Added outside fork-owned paths. Most of these are harmless (a fork's own
    // new service/scripts directory), so they are counted but not listed —
    // except shards numbered in upstream's range, which are actively wrong.
    unownedAdditions = changes
      .filter((c) => c.status === "A" && !isForkOwned(c.path))
      .map((c) => c.path);
    shardRangeViolations = unownedAdditions.filter(isShardRangeViolation);
  } catch {
    // No common ancestor (unrelated histories) — skip rather than fail the run.
  }

  const report = {
    timestamp: new Date().toISOString(),
    base,
    remote,
    localTip,
    upstreamTip,
    upstreamCommitsNotInFork: newUpstream.map((l) => l.slice(2)),
    forkOnlyCommits: forkOnly.map((l) => l.slice(2)),
    productSlug: PRODUCT.slug ?? null,
    surfaceNames: surfaceNames(),
    conflictSurface,
    unownedAdditions,
    shardRangeViolations,
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

  if (PRODUCT.slug) {
    console.log(`\n--- Surface audit (fork "${PRODUCT.slug}") ---`);
    console.log(`upstream files modified/deleted by this fork: ${conflictSurface.length}`);
    for (const c of conflictSurface.slice(0, 30)) console.log(`  ${c.status} ${c.path}`);
    if (conflictSurface.length > 30) console.log(`  … and ${conflictSurface.length - 30} more`);
    if (unownedAdditions.length) {
      console.log(`files added outside fork-owned paths: ${unownedAdditions.length} (informational)`);
    }
    if (shardRangeViolations.length) {
      console.log(
        `shards below ${FORK_SHARD_FLOOR} (overridden by higher-numbered upstream shards): ${shardRangeViolations.length}`,
      );
      for (const p of shardRangeViolations) console.log(`  ! ${p}`);
    }
    if (conflictSurface.length === 0) {
      console.log("Clean: every fork change lives in a fork-owned path.");
    } else {
      console.log(`\nMove each of the above onto a fork-owned surface (slug "${PRODUCT.slug}"):`);
      console.log(`  config/workspace shards → <NN>-${PRODUCT.slug}*.jsonc with NN >= ${FORK_SHARD_FLOOR}`);
      console.log(`  code → packages/{core,web}/src/extensions/${PRODUCT.slug}/`);
      console.log("  extra root entries → product.json rootAllowlist");
      console.log("  See docs/forking.md for the full convention.");
    }
  }

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

  if (strict && (conflictSurface.length > 0 || shardRangeViolations.length > 0)) {
    console.error(
      `\n--strict: ${conflictSurface.length} upstream file(s) modified/deleted, ` +
        `${shardRangeViolations.length} shard(s) below the fork range.`,
    );
    process.exitCode = 1;
  }
}

main();
