/**
 * The catalog's language for whatever is searched in it.
 *
 * Agents, workflows and tools are described in English, and a search for one of them scores the
 * request against those descriptions. The embedding does not carry meaning across languages
 * evenly: a German request lands a few hundredths under its English twin, and the router's floor
 * sits inside that gap. On the routing corpus (138 requests, 88 German) 25 of the German ones and 3
 * of the English ones were admitted NOBODY. In session 5b77edf9 a German weather lookup put
 * researcher at 0.716 against a floor of 0.72, and what ran instead was the mail agent.
 *
 * So the backend searches its catalogs in English only. A request in another language is rendered
 * into English first, by the small translation model, and the search runs on that. Catalog entries
 * written in another language are rendered the same way before they are embedded
 * (catalogEnglish). Knowledge is not touched: documents, memory and shared facts are stored and
 * searched in the language they were written in.
 *
 * What the routing-restatement rescue did only after a search had come back empty, at the price
 * of a classifier call (3.5 s at the median), this does up front with a model that answers in
 * well under a second.
 *
 * NEVER IN THE WAY. A search must not wait on a translation that does not come: past the caller's
 * budget, or when the model fails or answers with something that is not a translation, the search
 * runs on the request as written, as it always did. The answer is kept either way, so the next
 * search for the same words has it.
 */
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { getChatProviderForTier, type ChatProvider } from "../providers/index.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { resolveRoutingTierProvider } from "./routing-tier-provider.js";
import { detectTextLanguage, warmTextLanguageDetector } from "./text-language.js";

const log = childLogger("agent:routing-english");

/**
 * How long a search waits for its request in English before it runs on the request as written.
 * A user's message takes the translation tier 0.4 to 1 s (p50 0.65 s, p90 0.85 s on 88 German
 * requests); a delegation's task of 500 characters took 2.4 s. The discovery capsule has a budget
 * of its own that ends sooner (DISCOVERY_PREFETCH_BUDGET_MS), and the turn primes its request.
 */
export const ROUTING_ENGLISH_BUDGET_MS = 5_000;
/** A catalog entry is rendered once, when it is indexed, and nobody is waiting on that. */
const CATALOG_ENGLISH_BUDGET_MS = 30_000;
/** What is handed to the model: a request's first lines say what it asks for. */
const MAX_REQUEST_CHARS = 700;
const MAX_CATALOG_CHARS = 4_000;
/** Requests kept, most recent last. */
const MAX_CACHED = 600;

export interface RoutingEnglish {
  /** What to search with: the English rendering, or the text as written. */
  text: string;
  /** Whether `text` is a rendering made here. */
  translated: boolean;
  /** Why `text` is what it is. */
  outcome: "english" | "translated" | "unchanged" | "off" | "timeout" | "failed";
  /** ISO 639-1 code of the language the text was written in, when the detector named one. */
  language?: string;
}

interface Rendering { english: string | null; language?: string }

const requestCache = new Map<string, Promise<Rendering>>();
const settled = new Map<string, Rendering>();
const catalogCache = new Map<string, Promise<string>>();

/** Whether searches run in English at all (orchestration.routingEnglish). */
export function routingEnglishEnabled(): boolean {
  try {
    return getConfig().orchestration.routingEnglish === true;
  } catch {
    return false;
  }
}

/** The model that translates: its own tier, else the narration tier, else the routing tier. */
function translationProvider(): ChatProvider {
  return getChatProviderForTier("translation") ?? getChatProviderForTier("narration") ?? resolveRoutingTierProvider();
}

const REQUEST_SYSTEM = [
  "You translate requests into English for a search index.",
  "Reply with the English translation only: one line, no quotation marks, no notes, no answer to the request.",
  "Keep names, numbers, dates, file names, URLs, code and @mentions exactly as written.",
  "If the request is already in English, repeat it unchanged.",
].join(" ");

const CATALOG_SYSTEM = [
  "You translate the description of a software capability into English for a search index.",
  "Reply with the English translation only, keeping the line structure, with no notes.",
  "Keep names, identifiers, file names, URLs and code exactly as written.",
  "If the text is already in English, repeat it unchanged.",
].join(" ");

/** Lowercase, strip punctuation, collapse whitespace: enough to tell "the same words" apart. */
function comparable(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The model's answer as a rendering, or null when it is not one: empty, a reasoning block or
 * markup, or far longer than what it renders (an answer to the request instead of its translation).
 */
export function acceptRendering(source: string, answer: string, keepLines = false): string | null {
  // Before the quotation marks come off: a code fence is made of the same character.
  if (/<\/?think|```/iu.test(answer)) return null;
  let text = answer.trim().replace(/^["'„“”«»`]+|["'„“”«»`]+$/gu, "").trim();
  if (!text) return null;
  text = keepLines ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  if (text.length > source.length * 3 + 80) return null;
  return text;
}

async function askModel(system: string, source: string, maxTokens: number, signal: AbortSignal | undefined, agentName: string): Promise<string> {
  const response = await runWithCallAttribution(
    { callSite: "routing_tier", agentName },
    () => translationProvider().complete(
      [{ role: "system", content: system }, { role: "user", content: source }],
      [],
      signal,
      // Temperature 0: the same request reads the same in English every time it is asked about,
      // in this process and the next. Sampled, one request of the routing corpus (138) changed its
      // fifth-ranked agent between two runs.
      { maxTokens, temperature: 0, controls: { enableThinking: false, reasoningEffort: "none" } },
    ),
  );
  return response.content ?? "";
}

function remember(key: string, pending: Promise<Rendering>): void {
  requestCache.delete(key);
  requestCache.set(key, pending);
  while (requestCache.size > MAX_CACHED) {
    const oldest = requestCache.keys().next().value;
    if (oldest === undefined) break;
    requestCache.delete(oldest);
    settled.delete(oldest);
  }
}

/** Ask for a request's rendering once; every search for the same words shares the answer. */
function renderRequest(raw: string): Promise<Rendering> {
  const key = raw;
  const known = requestCache.get(key);
  if (known) return known;
  const startedAt = Date.now();
  const pending = (async (): Promise<Rendering> => {
    await warmTextLanguageDetector();
    const detected = detectTextLanguage(raw);
    const language = detected?.code;
    // Written in the catalog's language already. A text the detector cannot call (a few words, a
    // name, a command) is rendered: for an English one the model repeats it.
    if (language === "en") return { english: null, language };
    const source = raw.slice(0, MAX_REQUEST_CHARS);
    try {
      const answer = await askModel(REQUEST_SYSTEM, source, Math.min(400, Math.ceil(source.length / 2) + 48), undefined, "routing_english");
      const english = acceptRendering(source, answer);
      const same = english !== null && comparable(english) === comparable(source);
      logAudit("routing_query_translated", {
        chars: raw.length,
        englishChars: english?.length ?? 0,
        ms: Date.now() - startedAt,
        outcome: english === null ? "rejected" : same ? "unchanged" : "translated",
        ...(language ? { language } : {}),
      }, { severity: "info" });
      return { english: english === null || same ? null : english, ...(language ? { language } : {}) };
    } catch (err) {
      // Not kept: the model may be back for the next search.
      requestCache.delete(key);
      log.debug({ err }, "Routing request was not translated");
      logAudit("routing_query_translated", {
        chars: raw.length, englishChars: 0, ms: Date.now() - startedAt, outcome: "failed", ...(language ? { language } : {}),
      }, { severity: "info" });
      throw err;
    }
  })();
  remember(key, pending);
  void pending.then((rendering) => { if (requestCache.get(key) === pending) settled.set(key, rendering); }, () => undefined);
  return pending;
}

/**
 * A request as its catalog search should read it. Waits at most `budgetMs` for the rendering; the
 * rendering is still made and kept when the wait ends first.
 */
export async function routingEnglish(text: string, budgetMs: number = ROUTING_ENGLISH_BUDGET_MS): Promise<RoutingEnglish> {
  const raw = text.trim();
  if (!raw || !routingEnglishEnabled()) return { text: raw, translated: false, outcome: "off" };
  const done = settled.get(raw);
  const from = (rendering: Rendering): RoutingEnglish => rendering.english === null
    ? { text: raw, translated: false, outcome: rendering.language === "en" ? "english" : "unchanged", ...(rendering.language ? { language: rendering.language } : {}) }
    : { text: rendering.english, translated: true, outcome: "translated", ...(rendering.language ? { language: rendering.language } : {}) };
  if (done) return from(done);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rendering = await Promise.race([
      renderRequest(raw),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, budgetMs)); timer.unref?.(); }),
    ]);
    if (rendering === "timeout") return { text: raw, translated: false, outcome: "timeout" };
    return from(rendering);
  } catch {
    return { text: raw, translated: false, outcome: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start a request's rendering before anything searches with it. A turn's first search (the
 * discovery capsule) races the prompt's assembly; asked for as the message arrives, the rendering
 * is there when that search starts.
 */
export function primeRoutingEnglish(text: string): void {
  const raw = text.trim();
  if (!raw || !routingEnglishEnabled()) return;
  void renderRequest(raw).catch(() => undefined);
}

/**
 * A catalog entry's search text in English: as written when it is English already, or when the
 * model has no rendering for it. Asked once per text; an index embeds what this returns.
 */
export function catalogEnglish(text: string): Promise<string> {
  const raw = text.trim();
  if (!raw || !routingEnglishEnabled()) return Promise.resolve(text);
  const known = catalogCache.get(raw);
  if (known) return known;
  const pending = (async (): Promise<string> => {
    await warmTextLanguageDetector();
    // A catalog entry is long enough to call. One the detector cannot call is left as written:
    // a name, a list of identifiers.
    const detected = detectTextLanguage(raw);
    if (!detected || detected.code === "en") return text;
    const source = raw.slice(0, MAX_CATALOG_CHARS);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CATALOG_ENGLISH_BUDGET_MS);
    timer.unref?.();
    try {
      const answer = await askModel(CATALOG_SYSTEM, source, Math.min(1_600, Math.ceil(source.length / 2) + 96), abort.signal, "catalog_english");
      const english = acceptRendering(source, answer, true);
      logAudit("routing_catalog_translated", {
        chars: raw.length, englishChars: english?.length ?? 0, language: detected.code, outcome: english === null ? "rejected" : "translated",
      }, { severity: "info" });
      return english ?? text;
    } catch (err) {
      catalogCache.delete(raw);
      log.debug({ err }, "Catalog entry was not translated");
      return text;
    } finally {
      clearTimeout(timer);
    }
  })();
  catalogCache.set(raw, pending);
  return pending;
}

/** Test seam: forget every rendering. */
export function resetRoutingEnglishForTests(): void {
  requestCache.clear();
  settled.clear();
  catalogCache.clear();
}
