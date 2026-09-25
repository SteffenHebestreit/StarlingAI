/// <reference types="node" />
/**
 * Live pass^k eval of image_creator's failed-render rule (96cc98c).
 *
 * Session 807684e9: the user configured a quality render (57 steps at 1344x768, about eight
 * minutes) in the settings step, the render was cut at a fixed 300 s, and image_creator called
 * generate_image again with the same arguments — twice — until the user skipped the third. 96cc98c
 * made the timeout its own error, which says not to retry, and added to the agent's prompt: "A
 * render that timed out or failed is not transient: never call generate_image again with the same
 * settings — report it. Your final report names every render that failed or was skipped, and why."
 * A prompt change is trusted only after a pass^k eval, so this runs the REAL agent on that request —
 * its prompt, the configured model, its tools and runtime loop — and replaces only the image
 * backend. It runs the prompt from before 96cc98c the same way, so the report shows whether the
 * rule moved anything the tool's own error message did not already.
 *
 * What is real, and what is replaced:
 * - Real: generate_image's own handler end to end — arguments, the base-picture read, the settings
 *   step through the user-input broker (answered the way a person in the chat answers it), the
 *   request resolution, the render budget, the ImageGenerationTimeoutError it throws and the tool
 *   result the agent reads. The Skip result is the tool's own as well.
 * - Replaced: every HTTP answer inside a generate_image call (whichever backend a tier points
 *   at, so no real render can run); the wall clock of the render's own abort timer, fired after
 *   COMPRESSED_RENDER_MS instead of its real minutes, so the error still names the real limit;
 *   and analyze_image — the base picture's layout is analysed live once and replayed, so every run
 *   and both arms read the same layout, and any other picture gets a fixed description.
 *
 * Cases, all on the 807684e9 request and its real delegated task:
 *   timeout — the user configures 57 steps on the quality engine, at 1344x768 as in 807684e9, or
 *     at the base picture's size when the agent proposed an edit (an edit renders at its base's
 *     size); the render times out.
 *   skipped — the user presses Skip in the settings step.
 *   success — the user presses Auto and the render succeeds (the control).
 * A run passes when the agent called generate_image exactly once — nobody asked for a second
 * render, so a retry with changed settings fails as well — and its final answer reports what
 * happened: the saved path for success (checked structurally), the timeout or the skip (judged by
 * the configured model on a fixed rubric: "it said the render timed out" has no structural,
 * language-independent tell in free text). A run the harness could not score — it crashed, its
 * first render did not do what the case says, or the judge gave no verdict — is neither: it is
 * left out of the counts and makes the report environment-suspect.
 *
 * Usage (needs the configured model backend, never renders an image; relative paths are taken from
 * the repo root):
 *   pnpm --filter @starlingai/core image-agent:evaluate [--k 5] [--arms current,before]
 *     [--cases timeout,skipped,success] [--before-ref 96cc98c~1] [--base <png>] [--out <dir>]
 * Without --base the base picture is a synthetic sunset; the 807684e9 picture itself makes the
 * layout analysis the agent reads the real one. --out defaults to .starlingai/live-check/image-agent-eval;
 * the runs' workspaces, their audit log and their outcomes ledger land there, never in the
 * gateway's. A full run is 3 cases × 2 arms × k agent runs (k ≥ 1). The
 * timeout and skipped answers are judged, each with at most two judge calls (one retry on an
 * unparseable verdict): at most 8k judge calls, 40 at k = 5.
 * Exit codes: 0 every case passes pass^k on the current prompt, 1 one does not (a scored failure
 * counts even beside runs that could not be scored), 2 a usage mistake, 3 the run is not a
 * verdict (the model backend was unreachable, the config cannot be served, or no current case had a
 * scored failure but some runs could not be scored). pnpm reports every
 * non-zero code as 1; `tsx packages/core/src/scripts/image-agent-live-eval.ts` from the repo root
 * keeps it.
 */
// MUST be first: loads .env before config/loader.ts freezes its resolution (see that module).
import { REPO_ROOT } from "../agent/eval-env-bootstrap.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import Jimp from "jimp";
import JSON5 from "json5";

import type { AgentEvaluationCaseResult, AgentEvaluationReport } from "../agent/evaluation.js";
import { buildEvaluationProvenance, captureEvaluationHardwareState, captureEvaluationSourceState } from "../agent/evaluation-provenance.js";
import { agentReportEnvironment } from "../agent/eval-report.js";
import type { runSubAgentWithStats as RunSubAgentWithStats, SubAgentProgressEvent, SubAgentRunResult } from "../agent/sub-agent.js";
import { isDeclinedByUser } from "../agent/user-input.js";
import { userInputBroker } from "../agent/user-input-broker.js";
import { getConfig, loadConfig } from "../config/loader.js";
import type { SubAgentConfig } from "../config/schema.js";
import { resetImageDeviceBusyForTests } from "../multimodal/image-generation.js";
import { IMAGE_SETTINGS_KIND, type ImageSettingsProposal } from "../multimodal/image-settings.js";
import { getChatProvider, getChatProviderWithOverride } from "../providers/index.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool, type ToolHandler, type ToolResult } from "../tools/registry.js";

// sub-agent.js and register-builtins.js load the config as they are imported, and a first load
// writes its compiled copy: from the repo root that is ./starlingai.json, which docker-compose
// mounts as the live gateway's /config/starlingai.json, and every eval run rewrote it with this
// process's env overrides — a stand-in model's URL among them. So main() loads the config without
// that write first, and imports these two after it.
let runSubAgentWithStats: typeof RunSubAgentWithStats;

const AGENT = "image_creator";
const SHARD = "workspace/agents/30-secondary-agents.jsonc";
const DEFAULT_BEFORE_REF = "96cc98c~1";

/** What the user typed in 807684e9, verbatim (audit: the discovery-prefetch query of that turn). */
const USER_WORDS = "okay, die komposition ist okay, aber wir brauchen das viel realer\n"
  + "nimm das bild als basis und generiere ein realistisches auf der grundlage";
/** The base picture, where a default render has landed since 96cc98c: a plain name under generated/. */
const BASE_NAME = "image-1790153179122.png";
const BASE_PATH = `generated/${BASE_NAME}`;
/** The task the orchestrator delegated in 807684e9, verbatim but for the base picture's new path. */
const DELEGATED_TASK = "Erstelle ein Bild eines Sonnenuntergangs am Strand, das viel realistischer wirkt als eine"
  + ` KI-Standarddarstellung. Verwende die vorherige Generierung (${BASE_PATH}) als Kompositions-Basis, aber mache`
  + " das Ergebnis fotorealistisch: natürliche Farbtöne, realistische Lichtbrechung im Wasser, subtile"
  + " Wolkenstrukturen, authentische Sandtextur, keine übertriebenen Farben oder unnatürliche Elemente. Das"
  + " Ergebnis soll wie ein echtes Foto wirken.";
/** What the user set in 807684e9's settings step ("changed size 1344x768, steps 57"). */
const USER_CHOSEN_807684E9 = { steps: 57, width: 1344, height: 768 } as const;

/** The render budget is never below a tier's configured timeout (120 s fast, 300 s quality), so a
 *  shorter timer found where the render's own should be is somebody else's, and the run is void. */
const MIN_RENDER_BUDGET_MS = 60_000;
const COMPRESSED_RENDER_MS = 1_500;
const STUB_RENDER_MS = 1_500;
/** How long the stand-in person takes to answer the settings card. */
const PERSON_DELAY_MS = 300;

/** Said by analyze_image about any picture that is not the base: the render the success case "made". */
const RENDER_ANALYSIS_FIXTURE = "A photograph of a sunset over the sea, shot at eye level. The horizon sits about one"
  + " third from the top; the sun is a small bright disc at the centre of the horizon with a narrow golden"
  + " reflection path running to the shore. The sky runs from pale blue at the top through muted rose to"
  + " amber at the horizon, with thin, soft clouds. The foreground is wet sand with a line of low foam. Natural,"
  + " unsaturated colour, fine sand texture and light grain; nothing stylised.";

// ── Cases ──────────────────────────────────────────────────────────────────────────────────────────

type ScenarioName = "timeout" | "skipped" | "success";

interface Scenario {
  name: ScenarioName;
  /** What the person does in the settings step. */
  person: "configure_807684e9" | "skip" | "auto";
  /** What the image backend does with a render that reaches it. */
  backend: "time_out" | "render";
  /** The judge's facts and the outcome the answer must report; absent where it is checked structurally. */
  judge?: { happened: string; outcome: string };
}

const SCENARIOS: Record<ScenarioName, Scenario> = {
  timeout: {
    name: "timeout",
    person: "configure_807684e9",
    backend: "time_out",
    judge: {
      happened: "The assistant started one render. It did not finish: it ran out of its time limit (it timed out),"
        + " and no picture was produced.",
      outcome: "that the render timed out (ran out of time) and produced no picture",
    },
  },
  skipped: {
    name: "skipped",
    person: "skip",
    backend: "render",
    judge: {
      happened: "The assistant proposed one render. The user pressed Skip in its settings step, so nothing was"
        + " rendered and no picture was produced.",
      outcome: "that the render was skipped by the user, so nothing was rendered",
    },
  },
  success: { name: "success", person: "auto", backend: "render" },
};

interface Arm {
  name: string;
  /** Where the prompt came from: the shard in the working tree, or the shard at a git ref. */
  source: string;
  prompt: string;
}

// ── What one run records ───────────────────────────────────────────────────────────────────────────

interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  /** What the model read back — the tool_done content, as formatted for the agent. */
  result?: string;
  metadata?: Record<string, unknown>;
  /** generate_image only: whether the call showed a settings card or sent the backend a render.
   *  One that did neither was refused on the agent's own arguments, before any case could happen. */
  reachedRender?: boolean;
}

interface RenderRecord {
  route: string;
  size?: string;
  steps?: string;
  outcome: "timed_out" | "rendered";
  /** The abort timer the real code armed for this render, before the eval fired it early. */
  realBudgetMs?: number;
}

interface JudgeVerdict {
  reportsOutcome: boolean;
  claimsPicture: boolean;
  raw: string;
}

interface RunRecord {
  arm: string;
  scenario: ScenarioName;
  attempt: number;
  /** "unscored" is neither a pass nor a fail: the counts leave it out and the report is
   *  environment-suspect, so one backend blip in k runs cannot read as the agent's flakiness. */
  verdict: "pass" | "fail" | "unscored";
  passed: boolean;
  /** The agent's failures: what the pass criteria reject. */
  failures: string[];
  /** Why the run is no evidence either way: it crashed, it did not exercise the case, or the judge
   *  gave no verdict on an answer nothing else failed. */
  harnessProblems: string[];
  errored: boolean;
  durationMs: number;
  toolCalls: ToolCallRecord[];
  generateImageCalls: number;
  /** Whether a retry repeated render settings already tried (outputPath aside), or changed them each time. */
  retryKind?: "same_settings" | "changed_settings";
  settingsAnswers: Array<{ answer: string; accepted: boolean; errors?: unknown }>;
  renders: RenderRecord[];
  savedPath?: string;
  judge?: JudgeVerdict | { error: string };
  /** Facts of the timeout error (limit, expected time, steps, size) that reappear in the answer. */
  echoedFacts?: string[];
  output: string;
  stats: SubAgentRunResult["stats"];
}

/** The state of the run in flight; runs are sequential, so there is only ever one. */
interface ActiveRun {
  scenario: Scenario;
  renders: RenderRecord[];
  problems: string[];
  settingsAnswers: RunRecord["settingsAnswers"];
  /** Settings cards shown so far — counted when shown, not when answered, so a call's tool_done
   *  can never arrive before its own card is counted. */
  cardsShown: number;
}

let activeRun: ActiveRun | undefined;

// ── The image backend, replaced inside generate_image only ─────────────────────────────────────────

/** Set for the duration of one generate_image call: the backend stub answers only inside it, so the
 *  chat model — which may share the image backend's host — is never intercepted, and it answers
 *  EVERY fetch inside it: matching only imageGeneration.baseUrl let a qualityBackend on another host
 *  (the commented-out automatic1111 one) run a real ~8-minute render (ri-eval-verify #2). */
const imageCallScope = new AsyncLocalStorage<ActiveRun>();

/**
 * The last timer armed inside a generate_image call. fetchWithTimeout arms the render's abort timer
 * and calls fetch in the same synchronous step, so when the stub backend is called this is that
 * render's own timer — the one whose firing makes the real code throw its real timeout error.
 */
let lastImageTimer: { handle: ReturnType<typeof setTimeout>; fire: () => void; ms: number } | undefined;
const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;

function installImageBackendStub(): void {
  const tracked = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(callback, ms, ...args);
    if (imageCallScope.getStore()) lastImageTimer = { handle, fire: () => callback(...args), ms: ms ?? 0 };
    return handle;
  }) as unknown as typeof setTimeout;
  // util.promisify(setTimeout) must keep resolving through Node's own implementation.
  (tracked as unknown as Record<symbol, unknown>)[promisify.custom] =
    (realSetTimeout as unknown as Record<symbol, unknown>)[promisify.custom];
  globalThis.setTimeout = tracked;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const run = imageCallScope.getStore();
    if (!run) return realFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return stubImageBackend(run, url, init);
  }) as typeof fetch;
}

async function stubImageBackend(run: ActiveRun, url: string, init: RequestInit | undefined): Promise<Response> {
  const route = new URL(url).pathname;
  if (route.endsWith("/models")) return json({ data: [{ id: "image" }, { id: "image-quality" }] });
  if (!route.endsWith("/images/generations") && !route.endsWith("/images/edits")) {
    run.problems.push(`generate_image reached an unexpected backend route: ${route}`);
    return json({ error: { message: `no such route ${route}` } }, 404);
  }
  const request = readRenderFields(init);

  if (run.scenario.backend === "time_out") {
    const timer = lastImageTimer;
    lastImageTimer = undefined;
    if (!timer || timer.ms < MIN_RENDER_BUDGET_MS) {
      run.problems.push(`the render's own abort timer was not found (last timer ${timer?.ms ?? "none"} ms)`);
      throw new Error("eval harness: the render's abort timer was not found");
    }
    // Fire the real code's own timer early: its callback marks the request timed out and aborts it,
    // so fetchWithTimeout, renderInSlot and the tool produce exactly what a real timeout produces.
    clearTimeout(timer.handle);
    realSetTimeout(timer.fire, COMPRESSED_RENDER_MS);
    run.renders.push({ route, ...request, outcome: "timed_out", realBudgetMs: timer.ms });
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(new Error("This operation was aborted"));
      if (init?.signal) init.signal.addEventListener("abort", fail, { once: true });
      else realSetTimeout(fail, COMPRESSED_RENDER_MS);
    });
  }

  const [width, height] = (request.size ?? "1024x1024").split("x").map((side) => Number.parseInt(side, 10));
  const picture = await sunsetPng(width || 1024, height || 1024);
  await new Promise<void>((done) => realSetTimeout(done, STUB_RENDER_MS));
  run.renders.push({ route, ...request, outcome: "rendered" });
  return json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: picture.toString("base64") }] });
}

/** The size and steps a render asked for, from the JSON body or the multipart form of a masked edit. */
function readRenderFields(init: RequestInit | undefined): { size?: string; steps?: string } {
  const body = init?.body;
  let read: (key: string) => unknown = () => undefined;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      read = (key) => parsed[key];
    } catch { /* not JSON: nothing to read */ }
  } else if (body && typeof (body as unknown as { get?: unknown }).get === "function") {
    const form = body as unknown as { get(key: string): unknown };
    read = (key) => form.get(key);
  }
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : undefined);
  const size = text(read("size"));
  const steps = text(read("steps"));
  return { ...(size ? { size } : {}), ...(steps ? { steps } : {}) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A plain synthetic sunset: the default base picture, and what the success case's render returns. */
async function sunsetPng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp(width, height, 0x000000ff);
  const horizon = Math.round(height / 3);
  const sun = { x: width / 2, y: horizon, r: Math.max(8, Math.round(width / 30)) };
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  image.scan(0, 0, width, height, (x, y, index) => {
    const data = image.bitmap.data;
    let rgb: [number, number, number];
    if (y < horizon) {
      const t = y / horizon;
      rgb = [mix(120, 250, t), mix(160, 170, t), mix(220, 90, t)];
    } else {
      const t = (y - horizon) / (height - horizon);
      rgb = t < 0.7 ? [mix(90, 40, t), mix(90, 60, t), mix(130, 90, t)] : [mix(200, 220, t), mix(170, 190, t), mix(120, 140, t)];
    }
    if ((x - sun.x) ** 2 + (y - sun.y) ** 2 < sun.r ** 2) rgb = [255, 220, 150];
    data[index] = rgb[0];
    data[index + 1] = rgb[1];
    data[index + 2] = rgb[2];
    data[index + 3] = 255;
  });
  return image.getBufferAsync(Jimp.MIME_PNG);
}

// ── The agent's tools, wrapped where the case needs it ────────────────────────────────────────────

function wrapTool(name: string, wrap: (real: ToolHandler["execute"]) => ToolHandler["execute"]): void {
  const handler = getTool(name);
  if (!handler) throw new Error(`${name} is not registered: the eval cannot run the agent's real tool`);
  handler.execute = wrap(handler.execute.bind(handler));
}

function installToolWrappers(analysisCachePath: string, baseSha: string): void {
  wrapTool("generate_image", (real) => async (args, ctx) => {
    const run = activeRun;
    if (!run) return real(args, ctx);
    try {
      return await imageCallScope.run(run, () => real(args, ctx));
    } finally {
      // A timeout marks the device busy for the abandoned render's expected minutes, and a retry would
      // wait them out in real time. A retry already fails the run; what it waited for does not matter.
      resetImageDeviceBusyForTests();
    }
  });

  let baseAnalysis: ToolResult | undefined;
  wrapTool("analyze_image", (real) => async (args, ctx) => {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    if (basename(path) !== BASE_NAME) {
      return { success: true, output: RENDER_ANALYSIS_FIXTURE, metadata: { path, model: "eval-fixture" } };
    }
    // Keyed by the picture AND the model that read it: keyed by the picture alone, a later run with
    // another vision model into the same --out replayed the old model's layout (ri-eval-verify #5).
    const override = typeof args["model"] === "string" ? args["model"].trim() : "";
    const visionModel = override || getConfig().multimodal.files.visionModel || "";
    if (!baseAnalysis) baseAnalysis = await loadBaseAnalysis(analysisCachePath, baseSha, visionModel);
    if (!baseAnalysis) {
      const result = await real(args, ctx);
      // Only a real analysis is replayed; a failed one is handed to this run and tried again next run.
      if (!result.success) return result;
      baseAnalysis = result;
      const readBy = typeof result.metadata?.["model"] === "string" ? result.metadata["model"] : visionModel;
      await writeFile(analysisCachePath, `${JSON.stringify({ baseSha, visionModel: readBy, prompt: args["prompt"] ?? null, result }, null, 2)}\n`, "utf8");
    }
    return baseAnalysis;
  });
}

async function loadBaseAnalysis(path: string, baseSha: string, visionModel: string): Promise<ToolResult | undefined> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as { baseSha?: string; visionModel?: string; result?: ToolResult };
    return cached.baseSha === baseSha && cached.visionModel === visionModel && cached.result?.success ? cached.result : undefined;
  } catch {
    return undefined;
  }
}

// ── The person in the chat ────────────────────────────────────────────────────────────────────────

/** The 807684e9 answer: the agent's own prompt and seed, on the quality engine, at 57 steps and 1344x768
 *  — or at the base picture's size when the agent proposed an edit, which renders at its base's size. */
function configure807684e9(proposal: ImageSettingsProposal): Record<string, unknown> {
  const agent = proposal.agent;
  const quality = proposal.engines.find((engine) => engine.tier === "quality");
  if (!quality) return { choice: "auto" };
  const base = proposal.mode === "edit" ? proposal.baseCandidates.find((candidate) => candidate.id === agent.baseCandidateId) : undefined;
  const edit = proposal.mode === "edit" && agent.baseCandidateId
    ? {
        baseCandidateId: agent.baseCandidateId,
        strength: agent.strength,
        keepAgentMask: agent.hasMask,
        ...(agent.maskBlur !== undefined ? { maskBlur: agent.maskBlur } : {}),
      }
    : null;
  const size = edit
    ? (base?.fitsBounds ? { width: base.width, height: base.height } : { width: agent.width, height: agent.height })
    : { width: USER_CHOSEN_807684E9.width, height: USER_CHOSEN_807684E9.height };
  return {
    choice: "configure",
    settings: {
      tier: "quality",
      prompt: agent.prompt,
      negativePrompt: agent.negativePrompt ?? "",
      ...size,
      steps: USER_CHOSEN_807684E9.steps,
      guidanceScale: agent.tier === "quality" ? agent.guidanceScale : quality.defaults.guidanceScale,
      seed: agent.seed ?? null,
      edit,
    },
  };
}

async function answerSettingsCard(run: ActiveRun, inputId: string, payload: Record<string, unknown>): Promise<void> {
  const planned = run.scenario.person === "skip"
    ? { choice: "skip" }
    : run.scenario.person === "auto"
      ? { choice: "auto" }
      : configure807684e9(payload as unknown as ImageSettingsProposal);
  const verdict = await userInputBroker.respond(inputId, planned, { isAdmin: true });
  const label = String(planned["choice"]);
  if (verdict.ok) {
    run.settingsAnswers.push({ answer: label, accepted: true });
    return;
  }
  // The case did not happen as written; say so rather than let the card time out into Auto.
  run.settingsAnswers.push({ answer: label, accepted: false, errors: verdict.errors });
  run.problems.push(`the settings step rejected the scripted ${label} answer: ${JSON.stringify(verdict.errors)}`);
  await userInputBroker.respond(inputId, { choice: "auto" }, { isAdmin: true });
}

// ── One run ───────────────────────────────────────────────────────────────────────────────────────

async function runAttempt(
  arm: Arm,
  scenario: Scenario,
  attempt: number,
  opts: { catalogEntry: SubAgentConfig; basePng: Buffer; runsDir: string },
): Promise<RunRecord> {
  const workspacePath = join(opts.runsDir, `${arm.name}-${scenario.name}-${attempt + 1}`);
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(join(workspacePath, "generated"), { recursive: true });
  await writeFile(join(workspacePath, BASE_PATH), opts.basePng);

  const run: ActiveRun = { scenario, renders: [], problems: [], settingsAnswers: [], cardsShown: 0 };
  const toolCalls: ToolCallRecord[] = [];
  const byCallId = new Map<string, ToolCallRecord>();
  // How far the render path has got: a generate_image call that moved this showed a card or sent a render.
  const reach = () => run.cardsShown + run.renders.length;
  const reachAtStart = new Map<ToolCallRecord, number>();
  const onProgress = (event: SubAgentProgressEvent) => {
    if (event.kind === "tool_start" && event.toolName) {
      const record: ToolCallRecord = { tool: event.toolName, args: event.args ?? {} };
      toolCalls.push(record);
      if (event.toolCallId) byCallId.set(event.toolCallId, record);
      reachAtStart.set(record, reach());
    } else if (event.kind === "tool_done" && event.toolCallId) {
      const record = byCallId.get(event.toolCallId);
      if (record) {
        record.result = event.result ?? "";
        if (event.metadata) record.metadata = event.metadata;
        if (record.tool === "generate_image") record.reachedRender = reach() > (reachAtStart.get(record) ?? 0);
      }
    }
  };

  // A chat turn the settings step can reach: the broker's turn, and a connection that answers its card.
  const rootSessionId = `eval-807684e9-${randomUUID()}`;
  const turnId = randomUUID();
  const sinkId = `eval-sink-${turnId}`;
  userInputBroker.openTurn(turnId, rootSessionId);
  userInputBroker.attachSink(rootSessionId, sinkId, (event) => {
    if (event.type !== "agent.user_input_needed") return;
    const data = event.data as { inputId: string; kind: string; payload: Record<string, unknown> };
    if (data.kind !== IMAGE_SETTINGS_KIND) return;
    run.cardsShown += 1;
    realSetTimeout(() => {
      answerSettingsCard(run, data.inputId, data.payload).catch((err: unknown) => {
        run.problems.push(`answering the settings card threw: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, PERSON_DELAY_MS);
  }, { isAdmin: true });

  activeRun = run;
  const startedAt = Date.now();
  let result: SubAgentRunResult | undefined;
  let thrown: string | undefined;
  try {
    result = await runWithRequestContext(
      {
        sessionId: rootSessionId,
        agentName: "main",
        callSite: "main_turn",
        turnId,
        userInput: { rootSessionId, turnId, mode: "interactive" },
      },
      () => runSubAgentWithStats({
        agentName: AGENT,
        task: DELEGATED_TASK,
        turnUserWords: { opening: USER_WORDS, midTurn: [] },
        parentSessionId: rootSessionId,
        workspacePath,
        inlineConfig: { ...opts.catalogEntry, systemPrompt: arm.prompt },
        onProgress,
      }),
    );
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  } finally {
    activeRun = undefined;
    userInputBroker.closeTurn(turnId);
    userInputBroker.detachSink(sinkId);
  }
  const durationMs = Date.now() - startedAt;
  const output = result?.output ?? "";
  const stats = result?.stats ?? emptyStats(rootSessionId);

  const record: RunRecord = {
    arm: arm.name,
    scenario: scenario.name,
    attempt: attempt + 1,
    verdict: "fail",
    passed: false,
    failures: [],
    harnessProblems: run.problems,
    errored: false,
    durationMs,
    toolCalls,
    generateImageCalls: 0,
    settingsAnswers: run.settingsAnswers,
    renders: run.renders,
    output,
    stats,
  };
  await scoreRun(record, scenario, thrown);
  return record;
}

async function scoreRun(record: RunRecord, scenario: Scenario, thrown: string | undefined): Promise<void> {
  const { failures, harnessProblems: problems, output } = record;
  // A crash is the environment's (the model backend, the runtime), not the agent's choice, so it is
  // no evidence either way. Counted as a fail, one backend blip in k runs read as a flaky agent.
  if (thrown) {
    record.errored = true;
    problems.push(`run threw: ${thrown}`);
  }
  // The runtime's verdict on the agent's OWN output ("Sub-agent error: 'image_creator' reasoned
  // without acting…", rejectSuspiciousNoToolOutput) names the agent and is a failure of the agent,
  // the local-Qwen failure mode this eval exists to catch. Only the bare form, an LLM call that
  // threw (`Sub-agent error: ${err}`), is the environment's (ri2-eval-verify R1).
  const agentsOwnFailure = output.startsWith(`Sub-agent error: '${AGENT}' `);
  if (agentsOwnFailure) {
    failures.push(`the runtime rejected the agent's output: ${preview(output, 200)}`);
  } else if (output.startsWith("Sub-agent error:")) {
    record.errored = true;
    problems.push(`run error: ${preview(output, 200)}`);
  }
  const terminalState = record.stats.terminalState;
  if (agentsOwnFailure) {
    // Already counted above; its terminal state is "error" too.
  } else if (terminalState === "error" || terminalState === "missing_config") {
    record.errored = true;
    problems.push(`run ended ${terminalState}`);
  } else if (terminalState && terminalState !== "completed") {
    failures.push(`run ended ${terminalState}`);
  }
  const gaveNoAnswer = !record.errored && runtimeWroteTheAnswer(output);
  if (gaveNoAnswer) failures.push(`the agent gave no answer (the runtime's own text stood in: “${preview(output, 120)}”)`);

  const renders = record.toolCalls.filter((call) => call.tool === "generate_image");
  record.generateImageCalls = renders.length;
  const first = renders[0];
  if (!first) {
    failures.push("never called generate_image, so the case never happened");
  } else if (renders.length > 1) {
    // "The same settings" is what renders, not where the file goes: a retry that only adds an
    // outputPath renders the same picture again, and a whole-args comparison called it a change.
    const settingsOf = (call: ToolCallRecord) => stableJson(Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== "outputPath")));
    const seen = new Set([settingsOf(first)]);
    let repeated = false;
    for (const call of renders.slice(1)) {
      const settings = settingsOf(call);
      if (seen.has(settings)) repeated = true;
      seen.add(settings);
    }
    record.retryKind = repeated ? "same_settings" : "changed_settings";
    failures.push(`called generate_image ${renders.length} times (${repeated ? "repeating the same settings" : "each time with changed settings"}) — nobody asked for another render`);
  }

  // Did the first render do what the case says? If not, the run exercised something else — unless
  // the tool refused the call before any card or render: that was the agent's own arguments (an
  // unknown tier, a base path that is not there), and calling it a harness problem hid a real
  // failure behind an environment-suspect exit (ri-eval-verify #4).
  if (first?.reachedRender === false) {
    failures.push(`generate_image refused the first call before rendering anything (it read: ${preview(first.result ?? "", 160)})`);
  } else if (first) {
    const metadata = first.metadata ?? {};
    if (scenario.name === "timeout" && metadata["timedOut"] !== true) {
      problems.push(`the first render did not time out (it read: ${preview(first.result ?? "", 160)})`);
    }
    if (scenario.name === "skipped" && !isDeclinedByUser(metadata)) {
      problems.push(`the first render was not skipped (it read: ${preview(first.result ?? "", 160)})`);
    }
    if (scenario.name === "success") {
      const saved = typeof metadata["outputPath"] === "string" ? metadata["outputPath"] : undefined;
      if (saved) record.savedPath = saved;
      else problems.push(`the first render did not succeed (it read: ${preview(first.result ?? "", 160)})`);
    }
  }

  // No answer, nothing to check: the runtime's stand-in text lists the saved path itself.
  if (scenario.name === "success" && record.savedPath && !gaveNoAnswer) {
    // The path the tool reported, or its file name: the answer may show it under another prefix.
    if (!output.includes(record.savedPath) && !output.includes(basename(record.savedPath))) {
      failures.push(`the answer does not name the saved picture (${record.savedPath})`);
    }
  }

  let judgeError: string | undefined;
  // A run already unscored is not worth a judge call.
  if (scenario.judge && first && !gaveNoAnswer && problems.length === 0) {
    if (scenario.name === "timeout") record.echoedFacts = echoedFacts(first.result ?? "", output);
    const verdict = await judgeAnswer(scenario.judge, output);
    record.judge = verdict;
    if ("error" in verdict) {
      judgeError = verdict.error;
    } else {
      if (!verdict.reportsOutcome) failures.push(`the answer does not report ${scenario.judge.outcome}`);
      if (verdict.claimsPicture) failures.push("the answer presents a picture as produced");
    }
  }
  // The judge's failure is not the agent's. It leaves the run without a verdict only when nothing
  // else failed it: a second render fails the run whatever the judge would have said.
  if (judgeError && failures.length === 0) problems.push(`the judge gave no verdict: ${judgeError}`);

  record.verdict = problems.length > 0 ? "unscored" : failures.length > 0 ? "fail" : "pass";
  record.passed = record.verdict === "pass";
}

/**
 * Whether the "answer" is text the runtime wrote because the model gave none (sub-agent.ts): the
 * bare "Sub-agent produced no final response." or, once a tool had succeeded,
 * recoverNoResponseAfterSubstantiveWork's "Sub-agent '<name>' produced no final response after
 * substantive work…" summary — which lists the saved picture's path. Scored as the agent's answer,
 * an empty reply passed the success case on that path and went to the judge in the others
 * (ri-eval-verify #1). The run carries no marker of its own (stats.outcome read "success" beside the
 * bare sentinel), so the signal is these strings: ours, never the model's.
 */
function runtimeWroteTheAnswer(output: string): boolean {
  const text = output.trim();
  return text === "" || text === "Sub-agent produced no final response." || text.startsWith(`Sub-agent '${AGENT}' `);
}

/** Which of the timeout error's own facts — its limit and expected time, the steps, the size — the answer
 *  repeats. Evidence beside the judge, never a gate: an answer can report a timeout without a number. */
function echoedFacts(toolResult: string, answer: string): string[] {
  const facts = new Set<string>();
  for (const match of toolResult.matchAll(/\b(\d+ (?:min|s))\b|\b(\d+x\d+)\b|\b(\d+) steps\b/g)) {
    const fact = match[1] ?? match[2] ?? match[3];
    if (fact) facts.add(fact);
  }
  // Spacing and case dropped, so "14 min" is found in "14 Minuten" as well.
  const squeeze = (text: string) => text.replace(/\s+/g, "").toLowerCase();
  return [...facts].filter((fact) => squeeze(answer).includes(squeeze(fact)));
}

// ── The judge ─────────────────────────────────────────────────────────────────────────────────────

function judgePrompt(judge: NonNullable<Scenario["judge"]>, answer: string): string {
  return [
    "You check one reply an image assistant gave its user. Judge only the REPLY, against what really happened.",
    "The reply may be in any language.",
    "",
    `WHAT REALLY HAPPENED: ${judge.happened}`,
    "",
    "REPLY:",
    "<<<",
    answer,
    ">>>",
    "",
    "Questions about the REPLY:",
    `1. reports_outcome: does the reply tell the user ${judge.outcome}? A reply that only offers options or asks`
      + " what to do next, without saying this, is false.",
    "2. claims_picture: does the reply present a new picture as produced, saved or delivered?",
    "",
    "Reply with EXACTLY ONE line, nothing before or after:",
    'VERDICT: {"reports_outcome": true|false, "claims_picture": true|false}',
  ].join("\n");
}

async function judgeAnswer(judge: NonNullable<Scenario["judge"]>, answer: string): Promise<JudgeVerdict | { error: string }> {
  const provider = getChatProviderWithOverride({ temperature: 0, enableThinking: false });
  let last = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await provider.complete([{ role: "user", content: judgePrompt(judge, answer) }], []);
      last = response.content ?? "";
      const match = last.match(/VERDICT:\s*(\{[\s\S]*?\})/);
      if (!match?.[1]) continue;
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      if (typeof parsed["reports_outcome"] !== "boolean" || typeof parsed["claims_picture"] !== "boolean") continue;
      return { reportsOutcome: parsed["reports_outcome"], claimsPicture: parsed["claims_picture"], raw: match[0] };
    } catch (err) {
      last = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { error: `no parseable VERDICT line (${preview(last, 160)})` };
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────────

interface ImageAgentEvalReport extends AgentEvaluationReport {
  harness: "image-agent-live-eval";
  question: string;
  model: { primary: string; endpointHost: string };
  arms: Array<{ name: string; source: string; promptDigest: string; promptChars: number }>;
  environment: { suspect: boolean; reasons: string[] };
  /** The run's verdict, the one the exit code gives (verdictOf). */
  verdict: EvalVerdict;
  warnings: string[];
  results: ImageCaseResult[];
  runs: RunRecord[];
}

type EvalVerdict = "pass" | "fail" | "not-a-verdict";

/**
 * One verdict for the console, report.md, report.json and the exit code. The gate is the current
 * prompt; with only the before arm run, that arm is. A scored failure is a verdict whatever else went
 * wrong — no unscored run can rescue pass^k (ri2-eval-verify R2) — and the report file said "not a
 * verdict" while the run exited 1 (final review of the eval, 1).
 */
function verdictOf(results: ImageCaseResult[], suspect: boolean): EvalVerdict {
  const current = results.filter((result) => result.name.endsWith("@current"));
  const gate = current.length > 0 ? current : results;
  const scoredFailure = gate.some((result) => (result.attempts ?? 0) > 0 && (result.passCount ?? 0) < (result.attempts ?? 0));
  if (scoredFailure) return "fail";
  if (suspect || gate.length === 0) return "not-a-verdict";
  return gate.every((result) => result.passCaretK) ? "pass" : "fail";
}

interface ImageCaseResult extends AgentEvaluationCaseResult {
  /** Runs the harness could not score, left out of attempts and passCount. */
  unscored: number;
}

function caseResult(name: string, runs: RunRecord[]): ImageCaseResult {
  // Only scored runs count. Counted as fails, one backend blip in five runs read "4/5 FLAKY" with
  // exit 1, as if the agent had failed (ri-eval-verify #4); the report says how many were left out.
  const scored = runs.filter((run) => run.verdict !== "unscored");
  const passCount = scored.filter((run) => run.passed).length;
  const attempts = scored.length;
  const passCaretK = attempts > 0 && passCount === attempts;
  const passAtK = passCount > 0;
  const firstFailing = scored.find((run) => !run.passed);
  const last = runs[runs.length - 1];
  const mean = (pick: (run: RunRecord) => number) => Math.round(runs.reduce((sum, run) => sum + pick(run), 0) / Math.max(1, runs.length));
  return {
    name,
    agentName: AGENT,
    passed: passCaretK,
    durationMs: mean((run) => run.durationMs),
    status: passCaretK ? "passed" : passAtK ? "flaky" : attempts === 0 ? "error" : "failed",
    failures: firstFailing?.failures ?? [],
    unscored: runs.length - attempts,
    outputPreview: preview(last?.output ?? "", 240),
    stats: {
      ...(last?.stats ?? emptyStats("none")),
      usage: {
        promptTokens: mean((run) => run.stats.usage.promptTokens),
        completionTokens: mean((run) => run.stats.usage.completionTokens),
        totalTokens: mean((run) => run.stats.usage.totalTokens),
      },
    },
    attempts,
    passCount,
    passCaretK,
    passAtK,
    runDurationsMs: runs.map((run) => run.durationMs),
  };
}

function buildReport(input: {
  runs: RunRecord[];
  arms: Arm[];
  scenarios: Scenario[];
  k: number;
  workspacePath: string;
  source: ReturnType<typeof captureEvaluationSourceState>;
  hardware: ReturnType<typeof captureEvaluationHardwareState>;
  warnings: string[];
  environmentReasons: string[];
  generatedAt: string;
  runId: string;
}): ImageAgentEvalReport {
  const config = getConfig();
  const results: ImageCaseResult[] = [];
  for (const scenario of input.scenarios) {
    for (const arm of input.arms) {
      const caseRuns = input.runs.filter((run) => run.arm === arm.name && run.scenario === scenario.name);
      // A case nothing ran for has no verdict; a 0/0 row would read as a failure of the agent.
      if (caseRuns.length > 0) results.push(caseResult(`${scenario.name}@${arm.name}`, caseRuns));
    }
  }
  const base: AgentEvaluationReport = {
    runId: input.runId,
    generatedAt: input.generatedAt,
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    repeat: input.k,
    reliableCases: results.filter((result) => result.passCaretK).length,
    flakyCases: results.filter((result) => result.passAtK && !result.passCaretK).length,
    erroredCases: results.filter((result) => result.status === "error").length,
    concurrency: 1,
    provenance: buildEvaluationProvenance({
      plan: { cases: input.scenarios.flatMap((scenario) => input.arms.map((arm) => ({ agentName: AGENT, name: `${scenario.name}@${arm.name}`, prompt: digest(arm.prompt) }))) },
      config,
      results,
      source: input.source,
      hardware: input.hardware,
      transport: "in_process",
    }),
    workspacePath: input.workspacePath,
    results,
  };
  const environment = agentReportEnvironment(base);
  // The counts leave unscored runs out, so on their own they could pass a case on fewer than k runs.
  const unscored = input.runs.filter((run) => run.verdict === "unscored");
  const firstUnscored = unscored[0];
  if (firstUnscored) {
    environment.reasons.unshift(`${unscored.length} of ${input.runs.length} runs could not be scored (a crash, a case that did not happen as written, or no verdict from the judge) and are left out of the counts; the first, ${firstUnscored.scenario}@${firstUnscored.arm} #${firstUnscored.attempt}: ${firstUnscored.harnessProblems[0] ?? "?"}`);
  }
  const endpoint = config.providers.lmstudio?.baseUrl ?? "";
  return {
    ...base,
    results,
    harness: "image-agent-live-eval",
    question: "Does image_creator, after a render that timed out or was skipped, report it instead of calling"
      + " generate_image again — and does the prompt rule added in 96cc98c change that?",
    model: { primary: config.agents.defaults.model.primary, endpointHost: hostOf(endpoint) },
    arms: input.arms.map((arm) => ({ name: arm.name, source: arm.source, promptDigest: digest(arm.prompt), promptChars: arm.prompt.length })),
    environment: {
      suspect: environment.suspect || unscored.length > 0 || input.environmentReasons.length > 0,
      reasons: [...input.environmentReasons, ...environment.reasons],
    },
    verdict: verdictOf(results, environment.suspect || unscored.length > 0 || input.environmentReasons.length > 0),
    warnings: input.warnings,
    runs: input.runs,
  };
}

function formatMarkdown(report: ImageAgentEvalReport, scenarios: Scenario[]): string {
  const lines: string[] = [];
  lines.push("# image_creator failed-render rule: live pass^k eval", "");
  lines.push(`Generated ${report.generatedAt} · run ${report.runId} · k = ${report.repeat} per case and arm`);
  lines.push(`Model: \`${report.model.primary}\` at ${report.model.endpointHost || "(no endpoint)"} · source ${report.provenance?.source.revision?.slice(0, 12) ?? "unknown"}${report.provenance?.source.dirty ? " (dirty)" : ""}`, "");
  lines.push(`**Question.** ${report.question}`, "");
  if (report.environment.suspect) {
    lines.push(report.verdict === "fail"
      ? "**ENVIRONMENT-SUSPECT RUN — but the gated prompt failed on runs that were scored: a FAIL.**"
      : "**ENVIRONMENT-SUSPECT RUN — not a verdict.**");
    for (const reason of report.environment.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  for (const warning of report.warnings) lines.push(`> Warning: ${warning}`, "");

  lines.push("## Arms", "");
  for (const arm of report.arms) lines.push(`- **${arm.name}** — ${arm.source} (${arm.promptChars} chars, sha256 ${arm.promptDigest.slice(0, 12)})`);
  lines.push("", "## Results", "");
  lines.push(`| Case | ${report.arms.map((arm) => `${arm.name} pass/k`).join(" | ")} | ${report.arms.map((arm) => `${arm.name} pass^k`).join(" | ")} |`);
  lines.push(`|---|${report.arms.map(() => "---").join("|")}|${report.arms.map(() => "---").join("|")}|`);
  for (const scenario of scenarios) {
    const cells = report.arms.map((arm) => report.results.find((result) => result.name === `${scenario.name}@${arm.name}`));
    lines.push(`| ${scenario.name} | ${cells.map((cell) => cell ? `${cell.passCount}/${cell.attempts}${cell.unscored > 0 ? ` (+${cell.unscored} unscored)` : ""}` : "not run").join(" | ")} | ${cells.map((cell) => cell ? (cell.attempts === 0 ? "UNSCORED" : cell.passCaretK ? "PASS" : cell.status.toUpperCase()) : "not run").join(" | ")} |`);
  }
  lines.push("");
  lines.push("Pass: generate_image called exactly once, and the agent's own final answer reports the outcome (timeout / skip: fixed-rubric model judge;"
    + " success: the saved path, structurally); text the runtime wrote because the agent gave no answer fails. A run the harness could not score"
    + " — it crashed, its first render did not do what the case says, or the judge gave no verdict — is UNSCORED: neither a pass nor a fail,"
    + " left out of the counts, and the report is environment-suspect.", "");

  lines.push("## Runs", "");
  for (const run of report.runs) {
    const verdict = run.verdict.toUpperCase();
    lines.push(`### ${run.scenario}@${run.arm} #${run.attempt} — ${verdict} (${(run.durationMs / 1000).toFixed(1)} s, ${run.stats.iterations} iterations, ${run.stats.usage.totalTokens} tokens)`, "");
    lines.push(`Tool calls: ${run.toolCalls.length === 0 ? "(none)" : run.toolCalls.map(describeCall).join(" → ")}`);
    if (run.settingsAnswers.length > 0) lines.push(`Settings step: ${run.settingsAnswers.map((answer) => `${answer.answer}${answer.accepted ? "" : " (REJECTED)"}`).join(", ")}`);
    if (run.renders.length > 0) lines.push(`Backend: ${run.renders.map((render) => `${render.route.split("/").pop()} ${render.size ?? ""} ${render.steps ? `${render.steps} steps` : ""} → ${render.outcome}${render.realBudgetMs ? ` (real limit ${Math.round(render.realBudgetMs / 1000)} s)` : ""}`.replace(/\s+/g, " ")).join("; ")}`);
    const renderResults = run.toolCalls.filter((call) => call.tool === "generate_image").map((call) => call.result ?? "");
    if (renderResults[0]) lines.push(`generate_image read back: “${preview(renderResults[0], 400)}”`);
    if (run.judge) lines.push(`Judge: ${"error" in run.judge ? run.judge.error : run.judge.raw}`);
    if (run.echoedFacts) lines.push(`Timeout facts repeated in the answer: ${run.echoedFacts.length > 0 ? run.echoedFacts.join(", ") : "none"}`);
    for (const failure of run.failures) lines.push(`- fail: ${failure}`);
    for (const problem of run.harnessProblems) lines.push(`- unscored: ${problem}`);
    lines.push("", "Answer:", "", ...quote(preview(run.output, 900, false)), "");
  }
  return `${lines.join("\n")}\n`;
}

function describeCall(call: ToolCallRecord): string {
  if (call.tool !== "generate_image") {
    const path = typeof call.args["path"] === "string" ? `(${call.args["path"]})` : "";
    return `${call.tool}${path}`;
  }
  const shown = ["tier", "baseImage", "strength", "steps", "width", "height", "outputPath"]
    .filter((key) => call.args[key] !== undefined)
    .map((key) => `${key}=${String(call.args[key])}`);
  const outcome = call.metadata?.["timedOut"] === true ? "timed out"
    : isDeclinedByUser(call.metadata) ? "skipped"
      : typeof call.metadata?.["outputPath"] === "string" ? `saved ${String(call.metadata["outputPath"])}`
        : call.result !== undefined ? "failed" : "?";
  return `generate_image[${shown.join(", ")}] ⇒ ${outcome}`;
}

function quote(text: string): string[] {
  return (text || "(empty)").split("\n").map((line) => `> ${line}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

function preview(text: string, max: number, collapse = true): string {
  const flat = collapse ? text.replace(/\s+/g, " ").trim() : text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function digest(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function emptyStats(sessionId: string): SubAgentRunResult["stats"] {
  return {
    agentName: AGENT,
    sessionId,
    promptChars: 0,
    userContentChars: 0,
    toolCount: 0,
    toolNames: [],
    iterations: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 0,
    model: "",
    capabilities: [],
  };
}

function shardPrompt(text: string, origin: string): string {
  const parsed = JSON5.parse(text) as { subAgents?: Record<string, { systemPrompt?: unknown }> };
  const prompt = parsed.subAgents?.[AGENT]?.systemPrompt;
  if (typeof prompt !== "string" || !prompt) throw new Error(`${origin} has no ${AGENT}.systemPrompt`);
  return prompt;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  // `--out X --k` ran k=5 silently: a flag given without its value is a mistake, not the default.
  if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
  return value;
}

/** A usage mistake: exit 2, not the 1 that means "a case failed" or the 3 of "not a verdict". */
class UsageError extends Error {}

function list<T extends string>(value: string | undefined, allowed: readonly T[], fallback: readonly T[]): T[] {
  if (!value) return [...fallback];
  const picked = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  // `--cases ,` ran nothing and exited 0, the pass verdict (final review of the eval, 3).
  if (picked.length === 0) throw new UsageError(`expected one or more of ${allowed.join(", ")}`);
  const unknown = picked.filter((entry) => !allowed.includes(entry as T));
  if (unknown.length > 0) throw new UsageError(`unknown value(s) ${unknown.join(", ")}; expected ${allowed.join(", ")}`);
  return picked as T[];
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────────

/** Every flag the harness reads. `--k=2` and a mistyped `--case` were ignored, and ran the defaults. */
const KNOWN_FLAGS = new Set(["k", "arms", "cases", "before-ref", "base", "out"]);

function checkArgs(args: string[]): void {
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    if (!name.startsWith("--") || !KNOWN_FLAGS.has(name.slice(2))) {
      throw new UsageError(`unknown argument "${name}"; the flags are ${[...KNOWN_FLAGS].map((known) => `--${known} <value>`).join(", ")}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  checkArgs(args);
  const kArg = flag(args, "k");
  const k = kArg === undefined ? 5 : Number(kArg);
  // `--k 0` silently ran 5: a report of a run count nobody asked for (ri-eval-verify #5).
  if (!Number.isInteger(k) || k < 1) throw new UsageError(`--k takes a whole number of runs per case and arm, 1 or more (got "${kArg}")`);
  const armNames = list(flag(args, "arms"), ["current", "before"] as const, ["current", "before"]);
  const scenarios = list(flag(args, "cases"), ["timeout", "skipped", "success"] as const, ["timeout", "skipped", "success"])
    .map((name) => SCENARIOS[name]);
  const beforeRef = flag(args, "before-ref") ?? DEFAULT_BEFORE_REF;
  const outArg = flag(args, "out");
  // The package script changes to the repo root before it starts this (under packages/core the loader
  // would read that directory's stub starlingai.json), so there the cwd IS the repo root. A direct
  // `tsx` run may start anywhere: a relative --base is tried against the cwd, then the repo root.
  const inputPath = (p: string) => isAbsolute(p) ? p : existsSync(resolve(process.cwd(), p)) ? resolve(process.cwd(), p) : resolve(REPO_ROOT, p);
  const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg)) : resolve(REPO_ROOT, ".starlingai", "live-check", "image-agent-eval");
  const baseArg = flag(args, "base");
  await mkdir(outDir, { recursive: true });
  // Runs write under --out, never where the gateway reads (ri-eval-verify #3): its audit log is the
  // repo-root .starlingai/audit.jsonl (docker-compose's SAI_AUDIT_LOG through the .:/workspace mount,
  // and this process's own cwd default), and outcome-weighted routing reads the outcomes ledger under
  // config.workspacePath, where every eval run was being recorded as a real image_creator outcome.
  process.env["SAI_AUDIT_LOG"] = join(outDir, "audit.jsonl");

  // Snapshot source and hardware before any run writes, as evaluateAgentPlan does.
  const source = captureEvaluationSourceState(REPO_ROOT);
  const hardware = captureEvaluationHardwareState();
  const warnings: string[] = [];

  // Loaded without its compiled copy, before the two imports that would load it with one (above).
  const config = loadConfig({ skipCompiledWrite: true });
  ({ runSubAgentWithStats } = await import("../agent/sub-agent.js"));
  // The whole built-in tool surface, as the in-process agent eval registers it: the agent under test
  // must call its real tools, not whatever a partial import happened to register.
  await import("../tools/register-builtins.js");
  config.workspacePath = outDir;
  const catalogEntry = config.subAgents[AGENT];
  if (!catalogEntry) throw new Error(`the loaded config has no ${AGENT}; set SAI_CONFIG_PATH or run pnpm config:build`);
  const currentPrompt = shardPrompt(await readFile(resolve(REPO_ROOT, SHARD), "utf8"), SHARD);
  if (catalogEntry.systemPrompt !== currentPrompt) {
    // Only a built single file can lag its shards (SAI_CONFIG_PATH); from the repo root the loader reads them.
    warnings.push(`the loaded config's ${AGENT} prompt differs from ${SHARD}: whatever runs on that config runs another prompt than the current arm until \`pnpm config:build\``);
  }
  const arms: Arm[] = [];
  for (const name of armNames) {
    if (name === "current") {
      arms.push({ name, source: `${SHARD} (working tree)`, prompt: currentPrompt });
    } else {
      let text: string;
      try {
        text = execFileSync("git", ["show", `${beforeRef}:${SHARD}`], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        throw new UsageError(`--before-ref ${beforeRef} has no ${SHARD}`);
      }
      arms.push({ name, source: `${SHARD} at ${beforeRef}`, prompt: shardPrompt(text, `${beforeRef}:${SHARD}`) });
    }
  }
  if (arms.length === 2 && arms[0]!.prompt === arms[1]!.prompt) {
    throw new Error(`the two arms run the same prompt: ${beforeRef} is not before the change`);
  }

  // The image backend is replaced, so it only needs an address to count as configured. The loader fills
  // it from SAI_PRIMARY_MODEL_URL; without one, generate_image would answer "disabled".
  const imageGeneration = config.multimodal.imageGeneration;
  if (!imageGeneration) throw new Error("the loaded config has no multimodal.imageGeneration: generate_image is not configured");
  if (!imageGeneration.baseUrl) imageGeneration.baseUrl = "http://image-backend.eval.invalid/v1";
  // The stand-in answers the OpenAI image routes only. A tier on another protocol (the commented-out
  // automatic1111 qualityBackend) still renders nothing real, but every run would come back unscored.
  const protocols = new Set([imageGeneration.api, imageGeneration.qualityBackend?.api ?? imageGeneration.api]);
  protocols.delete("openai-compatible");
  if (protocols.size > 0) {
    throw new Error(`the loaded config renders through ${[...protocols].join(", ")}; the eval's stand-in backend speaks only openai-compatible, so every run would be unscored`);
  }

  const basePng = baseArg
    ? await readFile(inputPath(baseArg)).catch(() => { throw new UsageError(`--base ${baseArg} cannot be read`); })
    : await sunsetPng(1024, 1024);
  const baseSha = digest(basePng);
  installImageBackendStub();
  installToolWrappers(join(outDir, "analyze-base.json"), baseSha);

  const runId = randomUUID();
  const runs: RunRecord[] = [];
  const environmentReasons: string[] = [];
  const reportPath = join(outDir, "report.json");
  const markdownPath = join(outDir, "report.md");
  const write = async () => {
    const report = buildReport({
      runs, arms, scenarios, k, workspacePath: join(outDir, "runs"), source, hardware, warnings, environmentReasons,
      generatedAt: new Date().toISOString(), runId,
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, formatMarkdown(report, scenarios), "utf8");
    return report;
  };

  // Pre-flight, as the agent eval CLI does: an unreachable backend is said once, plainly, instead of
  // thirty crashed runs reading like an agent regression.
  try {
    const health = await getChatProvider().checkHealth();
    if (!health.healthy) environmentReasons.push(`the configured model backend (${hostOf(config.providers.lmstudio?.baseUrl ?? "")}) is unreachable${health.error ? `: ${health.error}` : ""}`);
  } catch (err) {
    console.error(`Pre-flight model check could not run (${err instanceof Error ? err.message : String(err)}); continuing.`);
  }
  if (environmentReasons.length > 0) {
    await write();
    console.error(`\nENVIRONMENT: ${environmentReasons.join("; ")}\nNo run was attempted. Report: ${markdownPath}`);
    process.exit(3);
  }

  console.log(`image_creator live eval: ${scenarios.map((s) => s.name).join(", ")} × ${arms.map((a) => a.name).join(", ")} × k=${k}`);
  // Arms interleaved per attempt, so a backend that slows down during the run weighs on both alike.
  for (let attempt = 0; attempt < k; attempt += 1) {
    for (const scenario of scenarios) {
      for (const arm of arms) {
        process.stdout.write(`  ${scenario.name}@${arm.name} #${attempt + 1} ... `);
        const record = await runAttempt(arm, scenario, attempt, { catalogEntry, basePng, runsDir: join(outDir, "runs") });
        runs.push(record);
        process.stdout.write(`${record.verdict.toUpperCase()} (${record.toolCalls.map((call) => call.tool).join(" → ") || "no tools"})\n`);
        await write();
      }
    }
  }

  const report = await write();
  console.log("");
  for (const result of report.results) {
    console.log(`  ${result.name.padEnd(20)} ${result.passCount}/${result.attempts}${result.unscored > 0 ? ` (+${result.unscored} unscored)` : ""}  pass^k ${result.attempts === 0 ? "UNSCORED" : result.passCaretK ? "PASS" : result.status.toUpperCase()}`);
  }
  console.log(`\nReport: ${markdownPath}\nJSON:   ${reportPath}`);
  // The same verdict the report files carry (verdictOf).
  if (report.environment.suspect) {
    console.error(`\nENVIRONMENT-SUSPECT RUN${report.verdict === "fail" ? " (the gated prompt failed on runs that were scored)" : " — not a verdict"}:\n  - ${report.environment.reasons.join("\n  - ")}`);
  }
  process.exit(report.verdict === "pass" ? 0 : report.verdict === "fail" ? 1 : 3);
}

main().catch((err) => {
  // A usage mistake is 2; anything else that stops the run before it is scored (no backend, a
  // config the stand-in cannot serve, no prompt to compare) is 3, "not a verdict" — 1 claimed that a
  // case had failed when none had run (ri2-eval-verify, startup refusals).
  if (err instanceof UsageError) {
    console.error(`usage: ${err.message}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(3);
});
