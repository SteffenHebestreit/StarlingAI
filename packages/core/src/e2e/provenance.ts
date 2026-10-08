/**
 * What a run ran on, read without a gateway route: the git state of the checkout the harness runs
 * from (its scenarios and assertions), and the image the stack's gateway container runs, with its
 * build time and the commit `sai start` stamped into its labels, from `pnpm e2e:env status --json`.
 *
 * Twice (2026-09-05, 2026-10-06) the stack ran an image older than the code under test, and only
 * grepping the baked dist showed it. A report now names the image that answered, and warns when
 * that image was built from another commit than the harness's HEAD (for an image without the
 * label: when it was built before HEAD was committed).
 */
import { execFileSync } from "node:child_process";
import { isRecord } from "./gateway-client.js";
import type { EnvironmentStatusSource } from "./services.js";

export interface HarnessSource {
  /** HEAD of the checkout the harness ran from. */
  sha: string;
  /** Uncommitted changes, tracked or untracked: the scenarios or the harness may differ from `sha`. */
  dirty: boolean;
  /** HEAD's committer date. */
  committedAt: string | null;
}

export interface GatewayImage {
  /** The image id the gateway container runs (sha256:…). */
  id: string;
  /** When Docker says the image was built. */
  createdAt: string | null;
  /**
   * The commit the image was built from, and whether that tree had uncommitted changes: the labels
   * `sai start` stamps (docker/gateway/Dockerfile). null for an image built before them or another way.
   */
  revision: string | null;
  dirty: boolean | null;
}

export interface E2EProvenance {
  harness: HarnessSource | null;
  gatewayImage: GatewayImage | null;
  /** Why a part above is null. */
  missing: string[];
  /** What a reader must know before taking the verdicts as verdicts on the code at HEAD. */
  warnings: string[];
}

/** Runs git in repoRoot: its trimmed output, or null when git failed or is missing. */
export type GitRunner = (repoRoot: string, args: string[]) => string | null;

const runGit: GitRunner = (repoRoot, args) => {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, windowsHide: true }).trim();
  } catch {
    return null;
  }
};

/** A full git object name: SHA-1, or SHA-256 in a repository that uses it. */
const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** HEAD, dirty flag and commit date of the checkout at repoRoot; null when git cannot tell. */
export function readHarnessSource(repoRoot: string, git: GitRunner = runGit): HarnessSource | null {
  const sha = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!sha || !COMMIT_SHA.test(sha)) return null;
  const status = git(repoRoot, ["status", "--porcelain=v1"]);
  return {
    sha,
    // A status git could not produce is not a clean tree.
    dirty: status === null || status.length > 0,
    committedAt: git(repoRoot, ["log", "-1", "--format=%cI", "HEAD"]) || null,
  };
}

/** The gateway image block of the e2e environment status; null when the status names none. */
export function gatewayImageFromStatus(json: unknown): GatewayImage | null {
  const gateway = isRecord(json) && isRecord(json["gateway"]) ? json["gateway"] : null;
  const image = gateway && isRecord(gateway["image"]) ? gateway["image"] : null;
  const id = image?.["id"];
  if (typeof id !== "string" || !id) return null;
  const created = image?.["created"];
  const revision = image?.["revision"];
  const dirty = image?.["dirty"];
  return {
    id,
    createdAt: typeof created === "string" && created ? created : null,
    revision: typeof revision === "string" && COMMIT_SHA.test(revision) ? revision : null,
    dirty: typeof dirty === "boolean" ? dirty : null,
  };
}

/** "3bb86782e028": Docker's short form of an image id. */
export function shortImageId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function shortSha(source: HarnessSource): string {
  return `${source.sha.slice(0, 7)}${source.dirty ? " (dirty)" : ""}`;
}

/** "3bb86782e028 from 92ade50 (dirty)", or the bare id when the image carries no revision. */
function imageName(image: GatewayImage): string {
  return `${shortImageId(image.id)}${image.revision ? ` from ${image.revision.slice(0, 7)}${image.dirty ? " (dirty)" : ""}` : ""}`;
}

/**
 * Whether the stack may not run the code under test. An image that names its commit is compared
 * with HEAD: another commit, or uncommitted changes the checkout no longer has. Without that label
 * only its build time can tell: an image built before HEAD was committed cannot hold HEAD.
 */
export function provenanceWarnings(harness: HarnessSource | null, gatewayImage: GatewayImage | null): string[] {
  if (!harness || !gatewayImage) return [];
  const image = shortImageId(gatewayImage.id);
  const head = harness.sha.slice(0, 7);
  if (gatewayImage.revision) {
    if (gatewayImage.revision !== harness.sha) {
      return [`the gateway image ${image} was built from ${gatewayImage.revision.slice(0, 7)}, but the harness runs ${head}: the stack may not run the code under test`];
    }
    if (gatewayImage.dirty === true && !harness.dirty) {
      return [`the gateway image ${image} was built from ${head} with uncommitted changes the checkout no longer has: the stack may not run the code under test`];
    }
    return [];
  }
  const built = Date.parse(gatewayImage.createdAt ?? "");
  const committed = Date.parse(harness.committedAt ?? "");
  if (!Number.isFinite(built) || !Number.isFinite(committed) || built >= committed) return [];
  return [`the gateway image ${image} was built ${gatewayImage.createdAt}, before the harness's HEAD ${head} was committed (${harness.committedAt}): the stack may not run the code under test`];
}

export async function captureProvenance(repoRoot: string, environment: EnvironmentStatusSource | null, git: GitRunner = runGit): Promise<E2EProvenance> {
  const missing: string[] = [];
  const harness = readHarnessSource(repoRoot, git);
  if (!harness) missing.push(`harness: git could not read the checkout at ${repoRoot}`);
  let gatewayImage: GatewayImage | null = null;
  if (!environment) {
    missing.push("gateway image: scripts/e2e-env.mjs not found");
  } else {
    const status = await environment();
    if ("error" in status) missing.push(`gateway image: ${status.error}`);
    else {
      gatewayImage = gatewayImageFromStatus(status.json);
      if (!gatewayImage) missing.push("gateway image: the e2e environment status names none (no running gateway container of this checkout)");
    }
  }
  return { harness, gatewayImage, missing, warnings: provenanceWarnings(harness, gatewayImage) };
}

/** "harness 92ade50 (dirty) · gateway image 3bb86782e028 from 92ade50 (dirty) built 2026-10-07T21:09:32Z" */
export function describeProvenance(provenance: E2EProvenance): string {
  const harness = provenance.harness ? `harness ${shortSha(provenance.harness)}` : "harness unknown";
  const image = provenance.gatewayImage;
  return `${harness} · ${image ? `gateway image ${imageName(image)}${image.createdAt ? ` built ${image.createdAt}` : ""}` : "gateway image unknown"}`;
}

/**
 * What differs between two runs' builds, for reading a baseline comparison: a verdict across a
 * new gateway image or harness commit may be the change's, or the build's. null when either run
 * recorded no provenance (reports before 2026-10-08).
 */
export function buildChanges(baseline: E2EProvenance | undefined, now: E2EProvenance | undefined): string[] | null {
  if (!baseline || !now) return null;
  const changes: string[] = [];
  const before = baseline.gatewayImage;
  const after = now.gatewayImage;
  if (!before || !after) changes.push(`gateway image unknown in ${!before && !after ? "both runs" : !before ? "the baseline" : "this run"}`);
  else if (before.id !== after.id) changes.push(`gateway image ${imageName(before)} → ${imageName(after)}`);
  const was = baseline.harness;
  const is = now.harness;
  if (!was || !is) changes.push(`harness commit unknown in ${!was && !is ? "both runs" : !was ? "the baseline" : "this run"}`);
  else if (was.sha !== is.sha || was.dirty !== is.dirty) changes.push(`harness ${shortSha(was)} → ${shortSha(is)}`);
  else if (is.dirty) changes.push(`harness ${shortSha(is)} in both runs: the uncommitted changes may differ`);
  return changes;
}

/**
 * Why a baseline comparison may not measure the code under test: a run whose stack may not have
 * run its checkout's code (its own provenance warning) puts an unknown build on that side.
 */
export function confounders(baseline: E2EProvenance | undefined, now: E2EProvenance | undefined): string[] {
  return [
    ...(now?.warnings ?? []).map((warning) => `this run: ${warning}`),
    ...(baseline?.warnings ?? []).map((warning) => `the baseline: ${warning}`),
  ];
}
