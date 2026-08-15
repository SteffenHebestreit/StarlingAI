import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";

export interface EvaluationSourceState {
  revision?: string;
  diff?: string;
  status?: string;
}

export interface EvaluationHardwareState {
  nodeVersion: string;
  platform: string;
  arch: string;
  release: string;
  totalMemoryBytes: number;
  cpus: Array<{ model: string }>;
}

export interface EvaluationProvenanceResult {
  agentName: string;
  stats?: { model?: string | null };
}

export interface EvaluationProvenanceInput {
  plan: { cases?: Array<{ agentName?: string; arm?: "pinned" | "composed" }> };
  config: unknown;
  results: readonly EvaluationProvenanceResult[];
  source: EvaluationSourceState;
  hardware: EvaluationHardwareState;
  /** How cases were executed. Defaults to "in_process"; gateway-routed runs MUST say so —
   *  their source/hardware fingerprint the CLI process, not the environment that ran the agents. */
  transport?: "in_process" | "gateway";
}

export interface EvaluationProvenance {
  version: 1;
  transport: "in_process" | "gateway";
  source: {
    available: boolean;
    revision: string | null;
    dirty: boolean;
    digest: string;
  };
  planDigest: string;
  configDigest: string;
  modelDigest: string;
  promptDigest: string;
  hardware: {
    digest: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic JSON without persisting the input itself, which may contain secrets. */
function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "undefined") return '"__undefined__"';
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function configuredPrompt(config: unknown, agentName: string): string | null {
  if (!isRecord(config) || !isRecord(config["subAgents"])) return null;
  const agent = config["subAgents"][agentName];
  if (!isRecord(agent) || typeof agent["systemPrompt"] !== "string") return null;
  return agent["systemPrompt"];
}

function evaluatedAgentNames(
  plan: EvaluationProvenanceInput["plan"],
  results: EvaluationProvenanceInput["results"],
): string[] {
  const names = new Set<string>();
  for (const testCase of plan.cases ?? []) {
    if (typeof testCase.agentName === "string" && testCase.agentName.trim()) names.add(testCase.agentName.trim());
    // A composed-arm case does NOT pin its agent — routing picks at runtime, so the
    // set of prompts that actually ran is not knowable from the plan. Mark it so the
    // promptDigest cannot claim to fingerprint a composed run as if one agent ran it;
    // otherwise a pinned and a composed report over the same cases would share a
    // digest and read as comparable when they are not.
    if (testCase.arm === "composed") names.add("__composed__");
  }
  for (const result of results) {
    if (result.agentName.trim()) names.add(result.agentName.trim());
  }
  return [...names].sort();
}

/** Build deterministic, secret-free provenance for an evaluation report. */
export function buildEvaluationProvenance(input: EvaluationProvenanceInput): EvaluationProvenance {
  const revision = input.source.revision?.trim() || null;
  const transport = input.transport ?? "in_process";
  const sourceState = {
    revision,
    diff: input.source.diff ?? null,
    status: input.source.status ?? null,
    // Folded into the digest so a gateway-routed report can't pose as an in-process one.
    transport,
  };
  const agentNames = evaluatedAgentNames(input.plan, input.results);
  const prompts = agentNames.map((agentName) => ({
    agentName,
    systemPrompt: configuredPrompt(input.config, agentName),
  }));
  const models = input.results
    .map((result) => ({ agentName: result.agentName, model: result.stats?.model ?? null }))
    .sort((left, right) => {
      // Code-unit comparison — localeCompare would make the digest locale-dependent.
      const a = `${left.agentName}:${left.model ?? ""}`;
      const b = `${right.agentName}:${right.model ?? ""}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });

  return {
    version: 1,
    transport,
    source: {
      available: revision !== null || input.source.diff !== undefined || input.source.status !== undefined,
      revision,
      dirty: Boolean(input.source.diff?.trim() || input.source.status?.trim()),
      digest: digest(sourceState),
    },
    planDigest: digest(input.plan),
    configDigest: digest(input.config),
    modelDigest: digest(models),
    promptDigest: digest(prompts),
    hardware: {
      digest: digest(input.hardware),
      nodeVersion: input.hardware.nodeVersion,
      platform: input.hardware.platform,
      arch: input.hardware.arch,
    },
  };
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.trim();
  } catch {
    return undefined;
  }
}

export function captureEvaluationSourceState(cwd = process.cwd()): EvaluationSourceState {
  return {
    revision: gitOutput(cwd, ["rev-parse", "HEAD"]),
    diff: gitOutput(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD"]),
    status: gitOutput(cwd, ["status", "--porcelain=v1"]),
  };
}

export function captureEvaluationHardwareState(): EvaluationHardwareState {
  return {
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    release: release(),
    totalMemoryBytes: totalmem(),
    // speed is intentionally omitted — it fluctuates with CPU frequency scaling.
    cpus: cpus().map((cpu) => ({ model: cpu.model })),
  };
}

export function captureEvaluationProvenance(
  input: Omit<EvaluationProvenanceInput, "source" | "hardware"> & { cwd?: string },
): EvaluationProvenance {
  return buildEvaluationProvenance({
    ...input,
    source: captureEvaluationSourceState(input.cwd),
    hardware: captureEvaluationHardwareState(),
  });
}

/** Stable, opt-in destination for raw live-evaluation reports. */
export function buildVersionedEvaluationReportPath(
  kind: "agent" | "scene",
  generatedAt: string,
  provenance: Pick<EvaluationProvenance, "source"> | undefined,
  root = process.cwd(),
): string {
  const timestamp = generatedAt.replace(/[:.]/g, "-").replace(/[^0-9TZ-]/g, "_");
  const revision = (provenance?.source.revision ?? "unknown").slice(0, 12).replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(root, "artifacts", "evaluations", `${kind}-${timestamp}-${revision}.json`);
}