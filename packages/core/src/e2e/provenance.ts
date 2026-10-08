/**
 * What a run ran on, read without a new gateway route: the git state of the checkout the harness
 * runs from (its scenarios and assertions); from `pnpm e2e:env status --json`, the image the
 * stack's gateway container runs, with its build time and the commit `sai start` stamped into its
 * labels, and digests of the config files the gateway reads; and from GET /api/models/preset, the
 * models it answers with.
 *
 * Twice (2026-09-05, 2026-10-06) the stack ran an image older than the code under test, and only
 * grepping the baked dist showed it. A report now names the image that answered, and warns when
 * that image was built from another commit than the harness's HEAD (for an image without the
 * label: when it was built before HEAD was committed). A flag flipped in a gitignored *.local.jsonc
 * shard, or a preset switched on the dashboard, changes neither the image nor the checkout; the
 * config digests and the model ids are what a baseline comparison lists for it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeError, isRecord, type HttpResult } from "./gateway-client.js";
import type { EnvironmentStatusSource } from "./services.js";

export interface HarnessSource {
  /** HEAD of the checkout the harness ran from. */
  sha: string;
  /** Uncommitted changes, tracked or untracked: the scenarios or the harness may differ from `sha`. */
  dirty: boolean;
  /**
   * sha256 over what the checkout holds beyond HEAD: the status, the diff of tracked files and the
   * content of every untracked file git does not ignore. Two dirty runs with the same digest ran the
   * same harness. null when the tree is clean, or when git could not list the changes.
   */
  changes: string | null;
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

/**
 * The config files the gateway reads, as digested inside its container
 * (scripts/gateway-config-digest.mjs): each a sha256, "absent" when there is no such file, or null
 * when unknown.
 */
export interface GatewayConfig {
  /** The compiled starlingai.json: config/ and workspace/ shards, gitignored *.local.jsonc ones included. */
  compiled: string | null;
  /** The runtime overlay: the dashboard's model preset and every other change saved at runtime. */
  overlay: string | null;
}

/** The models the gateway answers with (GET /api/models/preset). */
export interface GatewayModel {
  /** The active model preset (the dashboard's Local ⇄ Claude switch); null: the configured default. */
  active: string | null;
  /** The active preset's primary model; null without a preset. */
  activePrimary: string | null;
  /** agents.defaults.model.primary. */
  defaultPrimary: string | null;
  /** The agents the preset applies to (agents.defaults.modelPresetScope). */
  scope: string | null;
}

export interface E2EProvenance {
  harness: HarnessSource | null;
  gatewayImage: GatewayImage | null;
  gatewayConfig: GatewayConfig | null;
  model: GatewayModel | null;
  /** Why a part above is null. */
  missing: string[];
  /** What a reader must know before taking the verdicts as verdicts on the code at HEAD. */
  warnings: string[];
}

/** Runs git in repoRoot: its trimmed output, or null when git failed or is missing. */
export type GitRunner = (repoRoot: string, args: string[]) => string | null;

const runGit: GitRunner = (repoRoot, args) => {
  try {
    // A diff can outgrow execFileSync's 1 MiB default, and a cut-off diff is no digest.
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).trim();
  } catch {
    return null;
  }
};

/** A full git object name: SHA-1, or SHA-256 in a repository that uses it. */
const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The digest of what the checkout holds beyond HEAD (HarnessSource.changes). Untracked files count
 * by their content: a new scenario file edited between two runs is a different harness.
 */
function uncommittedChanges(repoRoot: string, status: string, git: GitRunner): string | null {
  const diff = git(repoRoot, ["diff", "--no-ext-diff", "--binary", "HEAD"]);
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === null || untracked === null) return null;
  const digest = createHash("sha256").update(`status\0${status}\0diff\0${diff}\0`);
  for (const path of untracked.split("\0").filter(Boolean).sort()) {
    let content: Buffer;
    try {
      content = readFileSync(join(repoRoot, path));
    } catch {
      return null;
    }
    digest.update(`untracked\0${path}\0${createHash("sha256").update(content).digest("hex")}\0`);
  }
  return digest.digest("hex");
}

/** HEAD, dirty flag, uncommitted-changes digest and commit date of the checkout at repoRoot; null when git cannot tell. */
export function readHarnessSource(repoRoot: string, git: GitRunner = runGit): HarnessSource | null {
  const sha = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!sha || !COMMIT_SHA.test(sha)) return null;
  const status = git(repoRoot, ["status", "--porcelain=v1"]);
  // A status git could not produce is not a clean tree.
  const dirty = status === null || status.length > 0;
  return {
    sha,
    dirty,
    changes: status ? uncommittedChanges(repoRoot, status, git) : null,
    committedAt: git(repoRoot, ["log", "-1", "--format=%cI", "HEAD"]) || null,
  };
}

function gatewayBlock(json: unknown): Record<string, unknown> | null {
  return isRecord(json) && isRecord(json["gateway"]) ? json["gateway"] : null;
}

/** The gateway image block of the e2e environment status; null when the status names none. */
export function gatewayImageFromStatus(json: unknown): GatewayImage | null {
  const gateway = gatewayBlock(json);
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

/** The gateway config block of the e2e environment status; null when it names neither digest. */
export function gatewayConfigFromStatus(json: unknown): GatewayConfig | null {
  const gateway = gatewayBlock(json);
  const config = gateway && isRecord(gateway["config"]) ? gateway["config"] : null;
  if (!config) return null;
  const digest = (value: unknown): string | null => (typeof value === "string" && (SHA256.test(value) || value === "absent") ? value : null);
  const parsed = { compiled: digest(config["compiled"]), overlay: digest(config["overlay"]) };
  return parsed.compiled === null && parsed.overlay === null ? null : parsed;
}

/** The models the gateway answers with, or why they could not be read. */
export type ModelSource = () => Promise<{ model: GatewayModel } | { missing: string }>;

/** GET /api/models/preset (any session token may read it), reduced to the model ids. */
export async function readGatewayModel(get: (path: string) => Promise<HttpResult>): Promise<{ model: GatewayModel } | { missing: string }> {
  let result: HttpResult;
  try {
    result = await get("/api/models/preset");
  } catch (err) {
    return { missing: `model: ${describeError(err)}` };
  }
  const body = result.json;
  if (!result.ok || !isRecord(body)) return { missing: `model: GET /api/models/preset answered HTTP ${result.status}` };
  const text = (key: string): string | null => {
    const value = body[key];
    return typeof value === "string" && value ? value : null;
  };
  const model = { active: text("active"), activePrimary: text("activePrimary"), defaultPrimary: text("defaultPrimary"), scope: text("scope") };
  if (model.activePrimary === null && model.defaultPrimary === null) return { missing: "model: GET /api/models/preset named no model" };
  return { model };
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

/** A config file's digest, short: "a7b7e82ffd2e", "none" for no file, "unknown". */
function configFile(digest: string | null): string {
  return digest === null ? "unknown" : digest === "absent" ? "none" : digest.slice(0, 12);
}

/** "a7b7e82ffd2e, no overlay" or "a7b7e82ffd2e + overlay 5e6f7a8b9c0d". */
function describeConfig(config: GatewayConfig): string {
  return `${configFile(config.compiled)}${config.overlay === "absent" ? ", no overlay" : ` + overlay ${configFile(config.overlay)}`}`;
}

/**
 * "local/qwen3.6-35b", or with a preset "anthropic/claude-opus-4-1 (preset claude)"; a preset for
 * some agents only names the model the others keep. Two models that read the same answer the same.
 */
function describeModel(model: GatewayModel): string {
  if (!model.active) return model.defaultPrimary ?? "unknown";
  const others = model.scope && model.scope !== "all" ? ` for ${model.scope}, else ${model.defaultPrimary ?? "unknown"}` : "";
  return `${model.activePrimary ?? "unknown"}${others} (preset ${model.active})`;
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

export interface ProvenanceSources {
  /** Default: git in repoRoot. */
  git?: GitRunner;
  /** The models the gateway answers with; absent: not read. */
  model?: ModelSource;
}

export async function captureProvenance(repoRoot: string, environment: EnvironmentStatusSource | null, sources: ProvenanceSources = {}): Promise<E2EProvenance> {
  const missing: string[] = [];
  const harness = readHarnessSource(repoRoot, sources.git ?? runGit);
  if (!harness) missing.push(`harness: git could not read the checkout at ${repoRoot}`);
  let gatewayImage: GatewayImage | null = null;
  let gatewayConfig: GatewayConfig | null = null;
  if (!environment) {
    missing.push("gateway image and config: scripts/e2e-env.mjs not found");
  } else {
    const status = await environment();
    if ("error" in status) missing.push(`gateway image and config: ${status.error}`);
    else {
      const none = "the e2e environment status names none (no running gateway container of this checkout)";
      const running = gatewayBlock(status.json)?.["running"] === true;
      gatewayImage = gatewayImageFromStatus(status.json);
      if (!gatewayImage) missing.push(`gateway image: ${running ? "docker could not read the running gateway container's image" : none}`);
      gatewayConfig = gatewayConfigFromStatus(status.json);
      if (!gatewayConfig) missing.push(`gateway config: ${running ? "the running gateway container did not report the digests of its config" : none}`);
    }
  }
  let model: GatewayModel | null = null;
  if (!sources.model) missing.push("model: not read");
  else {
    const read = await sources.model();
    if ("missing" in read) missing.push(read.missing);
    else model = read.model;
  }
  return { harness, gatewayImage, gatewayConfig, model, missing, warnings: provenanceWarnings(harness, gatewayImage) };
}

/**
 * "harness 92ade50 (dirty) · gateway image 3bb86782e028 from 92ade50 (dirty) built 2026-10-07T21:09:32Z ·
 * config a7b7e82ffd2e, no overlay · model local/qwen3.6-35b"
 */
export function describeProvenance(provenance: E2EProvenance): string {
  const harness = provenance.harness ? `harness ${shortSha(provenance.harness)}` : "harness unknown";
  const image = provenance.gatewayImage;
  const config = provenance.gatewayConfig ? `config ${describeConfig(provenance.gatewayConfig)}` : "config unknown";
  const model = provenance.model ? `model ${describeModel(provenance.model)}` : "model unknown";
  return `${harness} · ${image ? `gateway image ${imageName(image)}${image.createdAt ? ` built ${image.createdAt}` : ""}` : "gateway image unknown"} · ${config} · ${model}`;
}

/** "both runs", "the baseline" or "this run": where a part of the provenance is unknown. */
function unknownIn(before: unknown, after: unknown): string {
  return before == null && after == null ? "both runs" : before == null ? "the baseline" : "this run";
}

/**
 * What differs between two runs' builds, for reading a baseline comparison: a verdict across a new
 * gateway image, config, model or harness may be the change's, or the build's. A model or config
 * change is what an A/B run is for, so it is listed here and not as a confounder. A part unknown on
 * either side is listed as such, never taken for the same. null when either run recorded no
 * provenance (reports before 2026-10-08).
 */
export function buildChanges(baseline: E2EProvenance | undefined, now: E2EProvenance | undefined): string[] | null {
  if (!baseline || !now) return null;
  const changes: string[] = [];
  const before = baseline.gatewayImage;
  const after = now.gatewayImage;
  if (!before || !after) changes.push(`gateway image unknown in ${unknownIn(before, after)}`);
  else if (before.id !== after.id) changes.push(`gateway image ${imageName(before)} → ${imageName(after)}`);

  const configBefore = baseline.gatewayConfig ?? null;
  const configAfter = now.gatewayConfig ?? null;
  if (!configBefore || !configAfter) changes.push(`gateway config unknown in ${unknownIn(configBefore, configAfter)}`);
  else {
    for (const [file, name] of [["compiled", "compiled config"], ["overlay", "runtime overlay"]] as const) {
      const prior = configBefore[file];
      const current = configAfter[file];
      if (prior === null || current === null) changes.push(`${name} unknown in ${unknownIn(prior, current)}`);
      else if (prior !== current) changes.push(`${name} ${configFile(prior)} → ${configFile(current)}`);
    }
  }

  const modelBefore = baseline.model ?? null;
  const modelAfter = now.model ?? null;
  if (!modelBefore || !modelAfter) changes.push(`model unknown in ${unknownIn(modelBefore, modelAfter)}`);
  else if (describeModel(modelBefore) !== describeModel(modelAfter)) changes.push(`model ${describeModel(modelBefore)} → ${describeModel(modelAfter)}`);

  const was = baseline.harness;
  const is = now.harness;
  if (!was || !is) changes.push(`harness commit unknown in ${unknownIn(was, is)}`);
  else if (was.sha !== is.sha || was.dirty !== is.dirty) changes.push(`harness ${shortSha(was)} → ${shortSha(is)}`);
  else if (is.dirty) {
    const wasChanges = was.changes ?? null;
    const isChanges = is.changes ?? null;
    if (wasChanges === null || isChanges === null) changes.push(`harness ${shortSha(is)} in both runs: the uncommitted changes may differ`);
    else if (wasChanges !== isChanges) changes.push(`harness ${shortSha(is)} in both runs: the uncommitted changes differ`);
  }
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
