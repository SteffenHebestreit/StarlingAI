/**
 * Optional rubric judge for `expect.judge`: one OpenAI-compatible chat completion at temperature
 * 0 that must answer with exactly one line "SCORE: <0-10>".
 *
 *   E2E_JUDGE_URL      base URL (".../v1") or the full ".../chat/completions" endpoint
 *   E2E_JUDGE_MODEL    model id
 *   E2E_JUDGE_API_KEY  optional bearer key
 *
 * Unconfigured, the runner reports the judge as skipped and the attempt is not failed by it. A
 * configured judge that answers anything but one score line, or cannot be reached, fails the
 * attempt: an unverifiable rubric is never a pass.
 */
import { describeError, isRecord } from "./gateway-client.js";

export interface JudgeConfig {
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface JudgeInput {
  rubric: string;
  userMessage: string;
  reply: string;
}

export interface JudgeVerdict {
  score: number;
}

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeError";
  }
}

const MAX_REPLY_CHARS = 24_000;

export function judgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JudgeConfig | null {
  const url = env["E2E_JUDGE_URL"]?.trim();
  const model = env["E2E_JUDGE_MODEL"]?.trim();
  if (!url || !model) return null;
  const apiKey = env["E2E_JUDGE_API_KEY"]?.trim();
  return { url, model, ...(apiKey ? { apiKey } : {}) };
}

export function judgeEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * The score of a judge answer, or null when the answer is not exactly one "SCORE: n" line with
 * 0 ≤ n ≤ 10. A <think>…</think> block before it is tolerated (reasoning models emit one).
 */
export function parseJudgeScore(content: string): number | null {
  const visible = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const lines = visible.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const match = /^SCORE:\s*(\d{1,2}(?:\.\d+)?)$/i.exec(lines[0]!);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
}

export function buildJudgeMessages(input: JudgeInput): Array<{ role: "system" | "user"; content: string }> {
  const reply = input.reply.length > MAX_REPLY_CHARS ? `${input.reply.slice(0, MAX_REPLY_CHARS)}\n[…truncated]` : input.reply;
  return [
    {
      role: "system",
      content: "You grade an AI assistant's reply against a rubric. Score 0-10: 10 = the reply fully satisfies the rubric, "
        + "0 = it does not satisfy it at all. Judge only what the rubric asks. Answer with exactly one line and nothing else: "
        + "SCORE: <integer 0-10>",
    },
    {
      role: "user",
      content: `RUBRIC:\n${input.rubric}\n\nUSER MESSAGE:\n${input.userMessage}\n\nASSISTANT REPLY:\n${reply}\n\nAnswer with one line: SCORE: <0-10>`,
    },
  ];
}

export async function judgeReply(config: JudgeConfig, input: JudgeInput, signal?: AbortSignal): Promise<JudgeVerdict> {
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await fetch(judgeEndpoint(config.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, temperature: 0, messages: buildJudgeMessages(input) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    throw new JudgeError(`request failed: ${describeError(err)}`);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new JudgeError(`HTTP ${response.status} from the judge endpoint`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new JudgeError("the judge endpoint answered with non-JSON");
  }
  const choices = isRecord(body) ? body["choices"] : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first["message"] : undefined;
  const content = isRecord(message) && typeof message["content"] === "string" ? message["content"] : "";
  const score = parseJudgeScore(content);
  if (score === null) {
    const shown = content.trim().replace(/\s+/g, " ");
    throw new JudgeError(`malformed answer ${JSON.stringify(shown.length > 160 ? `${shown.slice(0, 160)}…` : shown)} (expected one line "SCORE: <0-10>")`);
  }
  return { score };
}
