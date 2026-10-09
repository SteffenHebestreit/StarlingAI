/**
 * Training data for the two decision points whose case is the user's message alone — fast_lane (the receptionist)
 * and source_sensitive (the up-front source judge), which run on nearly every turn — before the ledger has grown
 * from real turns:
 *
 *   pnpm --filter @starlingai/core decisions:bootstrap [--per-kind 25] [--corpus <messages.jsonl>] [--out <path>]
 *
 * 1. The messages: a corpus file (one {"message": "..."} per line), or written by the routing tier — German and
 *    English, in the kinds the two points tell apart, near-misses included.
 * 2. The labels: each message is put to the incumbent exactly as a turn would put it — the receptionist through its
 *    own front-desk gate, prompt and escalation rule (runReceptionist), and the source judge's prompt and parser.
 *    Laya is not asked.
 * 3. Rows in the decision ledger's format, mode "bootstrap", in decisions/bootstrap-ledger.jsonl beside the ledger.
 *    decisions:export reads them as training data; the gate never does — it only counts a comparison on a real turn.
 *
 * It calls the routing tier about (2 + per-kind x 10 / 20) + messages x 2 times: run it where that model is reachable.
 * It runs from the repository root (the package script changes there first): anywhere else the config loader reads a
 * different config, and under packages/core that is a stub with no receptionist and no routing tier. Its own provider
 * calls are audited to bootstrap-audit.jsonl beside its output, never to the gateway's audit log.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReceptionistMessages, classifyFrontDesk, receptionistEscalated } from "../agent/receptionist.js";
import { getReceptionistPersonaLines } from "../agent/receptionist-policy.js";
import { defaultReplyLanguage } from "../agent/reply-language.js";
import { resolveRoutingTierProvider } from "../agent/routing-tier-provider.js";
import { detectTextLanguage, warmTextLanguageDetector } from "../agent/text-language.js";
import { buildSourceSensitiveQuestionJudgeMessages, JUDGE_ANSWER_TOKEN_RE, parseUngroundedClaimVerdict } from "../agent/ungrounded-claim-judge.js";
import { getConfig, loadConfig } from "../config/loader.js";
import { getChatProviderForTier } from "../providers/index.js";
import { languageBucket } from "../decisions/gate.js";
import { resolveLedgerPath, type LedgerRow } from "../decisions/ledger.js";
import type { ChatProvider, LLMMessage } from "../providers/lmstudio.js";
import { defaultLedgerPath } from "./decisions-export.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The kinds of message the two points tell apart, each written in both languages. */
export const MESSAGE_KINDS: ReadonlyArray<{ kind: string; describe: string }> = [
  { kind: "small_talk", describe: "small talk to an assistant: greetings, thanks, goodbyes, how are you, what is your name, what can you do" },
  { kind: "short_task", describe: "short requests to do something: write, translate, summarise, calculate, convert, draft, fix, plan" },
  { kind: "fact_lookup", describe: "questions that need current, checkable real-world facts: prices, fees, opening hours, laws, statistics, dates, news, named companies or products, how a particular real service works" },
  { kind: "general_knowledge", describe: "questions answerable from general knowledge or reasoning: concepts, definitions, how something works in principle, advice, opinions, maths, code" },
  { kind: "near_miss", describe: "tricky cases: small talk that also asks for something, general questions that mention a brand or place in passing, fact questions phrased casually, requests about the user's own text, 'do not look anything up' requests" },
];

export function generationMessages(kind: { kind: string; describe: string }, language: string, count: number, seed: number): LLMMessage[] {
  return [
    {
      role: "system",
      content: "You write realistic test messages that users send to a personal AI assistant in a chat. Vary length, tone, "
        + "topic and phrasing; some are one or two words, some are several sentences, some have typos. Reply with a JSON "
        + "array of strings and nothing else.",
    },
    {
      role: "user",
      content: `Write ${count} different messages in ${language}. Kind: ${kind.describe}. Batch ${seed}: avoid the most `
        + "obvious examples; do not number them.",
    },
  ];
}

/** The messages in a generated reply: a JSON array of strings, trimmed, deduplicated, of a sensible length. */
export function parseGenerated(raw: string | null | undefined): string[] {
  const match = /\[[\s\S]*\]/.exec(raw ?? "");
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const message = item.trim();
      if (message.length >= 2 && message.length <= 1_500) out.add(message);
    }
    return [...out];
  } catch {
    return [];
  }
}

/** The source judge's verdict on a message, as the turn asks it; undefined when the reply holds none. */
export async function labelSourceSensitive(provider: ChatProvider, message: string): Promise<"yes" | "no" | undefined> {
  const response = await provider.complete(buildSourceSensitiveQuestionJudgeMessages(message), [], AbortSignal.timeout(30_000));
  const raw = response.content ?? "";
  if (!JUDGE_ANSWER_TOKEN_RE.test(raw)) return undefined;
  return parseUngroundedClaimVerdict(raw) ? "yes" : "no";
}

/**
 * The receptionist's verdict on a message, through its own front-desk gate, prompt and escalation rule; undefined
 * when the gate does not let the message reach the model at all — then the turn never asks, and neither is Laya.
 *
 * Its parts, not runReceptionist: that asks the decision layer too, and a synthetic message must never reach the
 * ledger as evidence — only a comparison on a real turn may.
 */
export async function labelFastLane(provider: ChatProvider, message: string): Promise<"small_talk" | "task" | undefined> {
  const settings = getConfig().receptionist;
  const confidenceAttempt = settings?.confidenceAttempt === true;
  const gate = classifyFrontDesk(message, {
    alwaysEscalateTerms: settings?.alwaysEscalateTerms,
    confidenceAttempt,
    ...(settings?.confidenceAttemptMaxChars !== undefined ? { confidenceMaxChars: settings.confidenceAttemptMaxChars } : {}),
  });
  if (!gate.fastLane) return undefined;
  const messages = buildReceptionistMessages(message, {
    personaLines: getReceptionistPersonaLines(),
    confidenceAttempt,
    defaultLanguage: defaultReplyLanguage(),
  });
  const reply = (await provider.complete(messages, [], AbortSignal.timeout(30_000))).content ?? "";
  return receptionistEscalated(reply, confidenceAttempt) ? "task" : "small_talk";
}

/**
 * Where the labels go: beside a ledger configured elsewhere (decisions.ledger.path, SAI_DECISIONS_LEDGER), otherwise
 * beside the ledger decisions:export reads by default — not wherever the working directory's audit log happens to
 * put the ledger, which under packages/core was a directory the export never looks in.
 */
export function bootstrapLedgerPath(): string {
  const configured = Boolean(getConfig().decisions?.ledger?.path?.trim() || process.env["SAI_DECISIONS_LEDGER"]?.trim());
  return join(dirname(configured ? resolveLedgerPath() : defaultLedgerPath()), "bootstrap-ledger.jsonl");
}

export function bootstrapRow(point: "fast_lane" | "source_sensitive", message: string, choice: string, ms: number): LedgerRow {
  return {
    ts: new Date().toISOString(),
    point,
    language: languageBucket(detectTextLanguage(message)?.code),
    // The state each point is asked about on a turn (agent/receptionist.ts, agent/runtime.ts).
    state: { message: point === "source_sensitive" ? message.slice(0, 2_000) : message },
    mode: "bootstrap",
    incumbent: { choice, ms },
    decidedBy: "incumbent",
    sessionId: "bootstrap",
  };
}

async function readCorpus(path: string): Promise<string[]> {
  const out: string[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = (JSON.parse(line) as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) out.push(message.trim());
    } catch {
      // not a corpus line
    }
  }
  return out;
}

async function main(): Promise<void> {
  // .env first, before the config is loaded: it holds the address of the model backend the host can reach. Loaded
  // here rather than by a static import, so a test that imports this module's helpers does not take in the repo's
  // .env with it.
  const { REPO_ROOT } = await import("../agent/eval-env-bootstrap.js");
  // Windows paths compare without case: a shell may report the drive as f: where Node reports F:.
  const here = resolve(process.cwd());
  const root = resolve(REPO_ROOT);
  if (!process.env["SAI_CONFIG_PATH"]?.trim() && (process.platform === "win32" ? here.toLowerCase() !== root.toLowerCase() : here !== root)) {
    console.error(`usage: run from the repository root (${REPO_ROOT}); the package script does \`cd ../..\` first. Here the config loader would read ${process.cwd()}.`);
    process.exit(2);
  }
  // Without writing its compiled copy: from the repo root that is ./starlingai.json, the live gateway's config.
  loadConfig({ skipCompiledWrite: true });
  const perKind = Number(arg("per-kind") ?? 25);
  const corpus = arg("corpus");
  const outArg = arg("out");
  const out = outArg ? resolve(REPO_ROOT, outArg) : bootstrapLedgerPath();
  // Set after the output path is resolved: the ledger's default location follows the audit log's.
  process.env["SAI_AUDIT_LOG"] = join(dirname(out), "bootstrap-audit.jsonl");
  await warmTextLanguageDetector();
  const provider = resolveRoutingTierProvider();
  // The receptionist's lane runs its tier with reasoning off (agent/receptionist.ts).
  const receptionistProvider = getChatProviderForTier("routing", { reasoningEffort: "none" }) ?? provider;
  let messages: string[];
  if (corpus) {
    messages = await readCorpus(corpus);
  } else {
    const all = new Set<string>();
    for (const language of ["German", "English"]) {
      for (const kind of MESSAGE_KINDS) {
        for (let batch = 0; batch * 20 < perKind; batch += 1) {
          const count = Math.min(20, perKind - batch * 20);
          const reply = await provider.complete(generationMessages(kind, language, count, batch + 1), [], AbortSignal.timeout(120_000)).catch(() => null);
          for (const message of parseGenerated(reply?.content)) all.add(message);
        }
        console.log(`${language} ${kind.kind}: ${all.size} messages so far`);
      }
    }
    messages = [...all];
  }
  await mkdir(dirname(out), { recursive: true });
  const counts: Record<string, number> = {};
  let done = 0;
  for (const message of messages) {
    for (const point of ["source_sensitive", "fast_lane"] as const) {
      const started = Date.now();
      const choice = await (point === "source_sensitive" ? labelSourceSensitive(provider, message) : labelFastLane(receptionistProvider, message)).catch(() => undefined);
      if (!choice) continue;
      await appendFile(out, `${JSON.stringify(bootstrapRow(point, message, choice, Date.now() - started))}\n`, "utf8");
      counts[`${point}=${choice}`] = (counts[`${point}=${choice}`] ?? 0) + 1;
    }
    done += 1;
    if (done % 25 === 0) console.log(`${done}/${messages.length} messages labelled`, counts);
  }
  console.log(`Wrote the labels of ${messages.length} messages to ${out}:`, counts);
  const exportLedger = join(dirname(out), "ledger.jsonl");
  console.log(`Next: pnpm --filter @starlingai/core decisions:export${exportLedger === defaultLedgerPath() ? "" : ` --ledger ${exportLedger}`}, then train (see config/gateway/45-decisions.jsonc).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
