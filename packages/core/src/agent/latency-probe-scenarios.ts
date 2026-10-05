/**
 * Live latency probe: the calls it sends, the math on what comes back, and the verdicts
 * (the pure half of scripts/latency-probe.ts).
 *
 * The question behind it is where a categorisation decision (Laya, a skipped call, a different
 * call order) can replace prompt processing and so shorten the response. The audit rows cannot
 * answer that. They carry no llama.cpp timings, a streamed call's clock starts only after the
 * response headers, and 25 image turns from one user show nothing about interference, concurrency
 * or cache reuse on the production path. Each experiment here answers one restructuring question
 * on that path (llama-swap and its "qwen" selector, not a station address):
 *
 *   E1  what one decision point's LLM call costs, i.e. what Laya would save per call;
 *   E2  whether the ~0.7 s floor of a warm call is fixed per-call cost or cache reuse that
 *       resumes at a checkpoint before the change;
 *   E3  whether the orchestrator head keeps its cache while small decision calls run between;
 *   E4  whether small calls get cheaper in parallel or each one gets slower;
 *   E5  whether decide()'s concurrent start of the incumbent is free when Laya is taken and the
 *       incumbent is aborted 20 ms after it was sent;
 *   E6  whether a max_tokens=1 prewarm saves a sub-agent's first prefill, finished or in flight;
 *   E7  what switching between the orchestrator's full tool block and the forced subset costs;
 *   E8  which rule decides whether a NEW conversation on a sub-agent head finds it cached: the
 *       server's idle-slot save plus its "skip an entry the new prompt shares < 25% of" load rule
 *       (warm after a run of 1.5x and 3x the head, cold after 6x), or checkpoint eviction (warm at
 *       every length); whether the head is still there after other agents' conversations ran in
 *       between (the arm the --no-cache-idle-slots decision rests on); whether a cache entry is
 *       used up by the conversation that loads it; and how many of three concurrent new
 *       conversations one prewarm serves;
 *   E9  whether warming the orchestrator's FORCED heads (the warm-keeper's
 *       promptCacheWarmForcedHeads) makes a forced turn's first two calls warm, against the
 *       full head alone, the plan's rejected literal variant, and six large prompts in between.
 *
 * On the deployed Qwen3.6 template the TOOL BLOCK renders before the system text, so a nonce in
 * the system text alone leaves two calls with the same tools sharing their whole tool-block
 * prefix. E8 and E9 compare arms whose tool blocks are identical, so their nonce also leads the
 * tool block (withNonceTool).
 *
 * Every prompt is built by the PRODUCTION builder of its call site from SYNTHETIC content only.
 * Three call sites build their prompt inline (goal-met oversight, finding distillation, QA
 * verdict); their copies here are held to the original by latency-probe-scenarios.test.ts. Result
 * rows carry step names and numbers, never prompt or response text.
 */
import { getConfig } from "../config/loader.js";
import {
  computeOutputTokenBudget,
  estimatePromptTokensForRequest,
  normalizeMessagesForModel,
  resolveThinkingControls,
  type LLMMessage,
  type LLMToolDef,
} from "../providers/lmstudio.js";
import { loadMainAssistantPersonality } from "../personality/service.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { getToolsAsLLMDefs } from "../tools/registry.js";
import { getMainAssistantToolNames } from "./default-tools.js";
import { buildProgressJudgePrompt } from "./progress-verifier.js";
import { qaRequiresEvidence } from "./qa-delivery-loop.js";
import { formatQaTurnRecord } from "./qa-turn-record.js";
import { buildReceptionistMessages } from "./receptionist.js";
import { getReceptionistPersonaLines } from "./receptionist-policy.js";
import { defaultReplyLanguage } from "./reply-language.js";
import { defaultSystemPrompt, splitOrchestrationModule } from "./session.js";
import { buildDisagreementCheckMessages } from "./sub-agent-disagreement.js";
import { buildStagedArtifactBuildGuidance } from "./sub-agent-prompt-guidance.js";
import { buildSourceSensitiveQuestionJudgeMessages, buildUngroundedClaimJudgeMessages } from "./ungrounded-claim-judge.js";

// ── Experiments ────────────────────────────────────────────────────────────────────────────────

export type ExperimentId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9";

export const EXPERIMENT_IDS: readonly ExperimentId[] = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"];

export const EXPERIMENT_QUESTIONS: Readonly<Record<ExperimentId, string>> = {
  E1: "What does each decision point's LLM call cost on the production path, i.e. what would Laya save per call?",
  E2: "Is the floor of a warm call fixed per-call cost, or does cache reuse resume at a checkpoint before the change?",
  E3: "Does the orchestrator head keep its cache while K small decision calls run between two of its calls?",
  E4: "Do small calls (receptionist, judge) get cheaper in parallel, or does each call get slower?",
  E5: "When the incumbent is aborted shortly after it was sent (Laya taken), does the abort still cost the next call?",
  E6: "Does a max_tokens=1 prewarm save a sub-agent head's first prefill, when finished and when still in flight?",
  E7: "What does switching the orchestrator between its full tool block and the forced subset cost?",
  E8: "Does a new conversation on a sub-agent head find it cached after a run of 1.5x, 3x and 6x the head, and after other agents' conversations in between, is the entry used up by one conversation, and how many of three concurrent ones does a prewarm serve?",
  E9: "Does warming the orchestrator's forced heads make a forced turn's first two calls warm, and what does keeping them warm cost?",
};

// ── Thresholds ─────────────────────────────────────────────────────────────────────────────────

/**
 * A difference below max(MATERIAL_MS, MATERIAL_SHARE x baseline) is reported but not called an
 * effect. With a handful of repetitions on a shared station, smaller differences sit inside the
 * run-to-run spread: the source judge alone took 1.0-2.2 s for the same 530-token prompt.
 */
export const MATERIAL_MS = 250;
export const MATERIAL_SHARE = 0.15;
/** A comparison needs at least this many repetitions where both sides were measured. */
export const MIN_PAIRS = 2;
/**
 * Appending text re-processes the new tokens plus the chat template's closing turn (about ten
 * tokens). An overhead above this means reuse stopped short of the common prefix.
 */
export const EXACT_REUSE_TOKENS = 32;
/** A head call that reused less than this share of its prompt lost its cache. */
export const EVICTED_SHARE = 0.5;
/** A call that reused at most this many tokens was cold. */
export const COLD_CACHE_TOKENS = 16;
/** A decision call whose prompt processing is under this share of its wall time is floor-dominated. */
export const FLOOR_DOMINATED_SHARE = 0.5;
/**
 * Output ceiling of the head probes. They measure prompt processing; decoding is a steady
 * ~56 tok/s on this station and adds nothing to the questions asked, so they stop after one token.
 */
export const HEAD_PROBE_MAX_TOKENS = 1;
/** E2: new tokens appended per step, each relative to the previous step's prompt. */
export const APPEND_STEPS = [1, 18, 100, 500, 2000] as const;
/** E3: how many small calls run between two head calls. */
export const INTERFERENCE_KS = [0, 1, 2, 4] as const;
/** The sub-agent-shaped head keeps at most this many tools (a specialist carries about ten). */
export const SUB_AGENT_HEAD_MAX_TOOLS = 12;
/** E2 filler: English prose tokenises at roughly four characters per token. */
export const FILLER_CHARS_PER_TOKEN = 4;

/**
 * E8: run lengths, as multiples of the head, after which a new conversation on the head is tried.
 * They straddle the server's load rule (llama.cpp 79bfc1d server_prompt_cache::load skips an entry
 * the new prompt shares less than 25% of, i.e. a run past ~4x its head): 1.5x and 3x predict warm,
 * 6x cold. Checkpoint eviction would predict warm at all three.
 */
export const E8_RUN_MULTIPLIERS = [1.5, 3, 6] as const;
/** E8: tokens a run grows by per call, about what one sub-agent iteration appends. */
export const E8_GROWTH_STEP_TOKENS = 1_200;
/** E8: a bound on one run's calls, whatever the head's size. */
export const E8_MAX_GROWTH_STEPS = 60;
/** E8: the task tail of every new conversation, about a production delegation's. */
export const E8_TAIL_TOKENS = 1_500;
/** E8: new conversations started together after one prewarm. */
export const E8_CONCURRENT = 3;
/**
 * E8 (d): other agents' conversations between a run and the new conversation on its head, each
 * on a distinct head of about this many tokens — as many as the station has slots (4), so under
 * --no-cache-idle-slots one of them has to take the run's slot unless the server keeps it. The
 * plan recommends that switch only if THIS arm stays warm under it.
 */
export const E8_INTERLEAVED_HEADS = 4;
export const E8_INTERLEAVED_HEAD_TOKENS = 6_000;
/** E8 "warm": the head reused to this share... */
export const E8_WARM_HEAD_SHARE = 0.95;
/** ...no more than the tail plus this many tokens processed... */
export const E8_WARM_EXTRA_TOKENS = 64;
/** ...and prompt processing within the tail at the cold rate plus this floor (a fixed 1.5 s cannot
 *  be met by a 1.5k tail even warm). */
export const E8_WARM_TAIL_TOKENS_PER_SEC = 900;
export const E8_WARM_FLOOR_MS = 1_000;

/** E9: a live forced call reused its warmed head when cache_n reaches the warm call's prompt minus this. */
export const E9_WARM_SLACK_TOKENS = 700;
/** E9: ...and processed its prompt within this. */
export const E9_WARM_PROMPT_MS = 3_000;
/** E9: a live call without a warmed head is cold: at most this much reused... */
export const E9_COLD_CACHE_TOKENS = COLD_CACHE_TOKENS;
/** ...and at least this long in prompt processing. */
export const E9_COLD_PROMPT_MS = 8_000;
/** E9: the full-head call after the forced heads were warmed must still find this share cached. */
export const E9_FULL_KEPT_SHARE = 0.9;
/** E9: TREATMENT is rejected when a live call reused under this share on 2 of 3 repetitions. */
export const E9_REJECT_SHARE = 0.5;
/** E9 EVICTION: large prompts between the warm-up and the live call, shaped like content_writer's loop calls. */
export const E9_EVICTION_PROMPTS = 6;
export const E9_EVICTION_TOKENS = 30_000;
/** E8/E9 need this many repetitions for a verdict: the pass criteria are stated "in 3 of 3". */
export const E8_E9_MIN_REPS = 3;

// ── Synthetic content ──────────────────────────────────────────────────────────────────────────

export type ProbeLanguage = "de" | "en";
export const PROBE_LANGUAGES: readonly ProbeLanguage[] = ["de", "en"];

interface Topic {
  /** A full request, as the source judge and the orchestrator see it. */
  message: string;
  /**
   * The same ask in few words: the receptionist's micro-call runs only for a short message with no
   * detected task intent (classifyFrontDesk), so this is the shape that reaches it.
   */
  short: string;
  /** Statements a draft, a slice, an evidence list or an answer is made of. */
  facts: string[];
}

/** Written for this probe; none of it comes from a conversation. */
const TOPICS: Readonly<Record<ProbeLanguage, readonly Topic[]>> = {
  de: [
    {
      message: "Kannst du mir erklären, wie eine Wärmepumpe im Winter Wärme aus kalter Außenluft gewinnt?",
      short: "Wie funktioniert eigentlich eine Wärmepumpe?",
      facts: [
        "Eine Luft-Wasser-Wärmepumpe entzieht der Außenluft auch bei Minusgraden Wärme, weil ihr Kältemittel schon bei sehr tiefen Temperaturen verdampft.",
        "Der Verdichter erhöht Druck und Temperatur des gasförmigen Kältemittels, sodass es seine Wärme im Verflüssiger an das Heizwasser abgeben kann.",
        "Die Jahresarbeitszahl gibt an, wie viele Kilowattstunden Wärme pro Kilowattstunde Strom über ein Jahr entstehen; in gut gedämmten Häusern liegt sie oft zwischen drei und vier.",
        "Bei sehr kalter Luft sinkt die Effizienz, deshalb springt in manchen Anlagen ein elektrischer Heizstab zu.",
        "Niedrige Vorlauftemperaturen, etwa mit einer Fußbodenheizung, verbessern den Wirkungsgrad deutlich.",
      ],
    },
    {
      message: "Erstelle bitte eine Einkaufsliste für ein vegetarisches Abendessen für vier Personen.",
      short: "Mach mir eine Einkaufsliste fürs Curry heute Abend",
      facts: [
        "Für ein Gemüsecurry werden zwei Zwiebeln, drei Knoblauchzehen, ein daumengroßes Stück Ingwer und zwei rote Paprika benötigt.",
        "Dazu kommen eine Dose Kichererbsen, eine Dose Kokosmilch und 400 Gramm passierte Tomaten aus dem Glas.",
        "Als Beilage reichen 300 Gramm Basmatireis, als Topping frischer Koriander und eine Limette zum Beträufeln.",
        "Für den Nachtisch eignen sich 500 Gramm Naturjoghurt, etwas Honig und eine Handvoll gehackte Walnüsse.",
        "Gewürze wie Kreuzkümmel, Kurkuma und Garam Masala sind in den meisten Küchen schon vorrätig und müssen nur geprüft werden.",
      ],
    },
    {
      message: "Welche Förderprogramme gibt es aktuell für Photovoltaik auf Mehrfamilienhäusern in Sachsen?",
      short: "Gibt es Zuschüsse für Solaranlagen in Sachsen?",
      facts: [
        "Die KfW fördert Photovoltaikanlagen über das Programm 270 mit zinsgünstigen Krediten für Anlagen und Speicher.",
        "Für Mieterstrommodelle gibt es einen Zuschlag nach dem Erneuerbare-Energien-Gesetz, der je nach Anlagengröße gestaffelt ist.",
        "Einige sächsische Kommunen bieten eigene Zuschüsse für Batteriespeicher an, deren Höhe sich jährlich ändern kann.",
        "Seit 2023 entfällt für kleine Anlagen die Umsatzsteuer beim Kauf, der sogenannte Nullsteuersatz.",
        "Vor dem Antrag lohnt sich ein Blick in die Förderdatenbank des Bundes, weil Programme kurzfristig auslaufen können.",
      ],
    },
    {
      message: "Schreib bitte eine kurze Nachricht an das Team, dass das Planungsmeeting auf Donnerstag verschoben wird.",
      short: "Schreib dem Team, dass wir am Donnerstag tagen",
      facts: [
        "Hallo zusammen, das Planungsmeeting findet diese Woche nicht am Dienstag statt, sondern am Donnerstag.",
        "Die Uhrzeit bleibt gleich, wir treffen uns um zehn Uhr im großen Besprechungsraum im zweiten Stock.",
        "Bitte bringt eure aktualisierten Aufgabenlisten und alle offenen Fragen zum Quartalsplan mit.",
        "Wer am Donnerstag verhindert ist, schickt seine Punkte bitte bis Mittwochabend per Nachricht an die Runde.",
        "Danke für eure Flexibilität, die Agenda kommt wie immer am Vortag, und bis Donnerstag.",
      ],
    },
    {
      message: "Vergleiche die neuesten Mittelklasse-Grafikkarten für lokale Sprachmodelle nach Speicher und Preis.",
      short: "Welche Grafikkarte reicht für lokale Sprachmodelle?",
      facts: [
        "Für lokale Sprachmodelle ist vor allem der Grafikspeicher entscheidend, weil das ganze Modell samt Kontext hineinpassen muss.",
        "Karten mit 16 Gigabyte erlauben quantisierte Modelle bis etwa 14 Milliarden Parameter mit längerem Kontext.",
        "Die Speicherbandbreite bestimmt die Geschwindigkeit der Tokenerzeugung stärker als die reine Rechenleistung.",
        "Gebrauchte Karten der Vorgängergeneration mit 24 Gigabyte sind oft günstiger pro Gigabyte als neue Mittelklassekarten.",
        "Der Stromverbrauch unter Last unterscheidet sich zwischen den Herstellern um bis zu hundert Watt.",
      ],
    },
    {
      message: "Wie lange muss ich als Selbstständiger in Deutschland Rechnungen und Belege aufbewahren?",
      short: "Wie lange muss ich Rechnungen aufheben?",
      facts: [
        "Rechnungen und Buchungsbelege müssen in Deutschland in der Regel acht Jahre lang aufbewahrt werden.",
        "Die Frist beginnt mit dem Ende des Kalenderjahres, in dem der Beleg entstanden ist, nicht mit dem Rechnungsdatum.",
        "Handelsbriefe und bestimmte andere Geschäftsunterlagen unterliegen einer kürzeren Frist von sechs Jahren.",
        "Elektronische Rechnungen müssen im Originalformat und unveränderbar gespeichert werden, ein Ausdruck genügt nicht.",
        "Wer die Fristen nicht einhält, riskiert bei einer Betriebsprüfung Schätzungen durch das Finanzamt.",
      ],
    },
  ],
  en: [
    {
      message: "How does a heat pump pull warmth out of cold winter air, and why does it still work below freezing?",
      short: "How does a heat pump actually work?",
      facts: [
        "An air-source heat pump extracts heat from outdoor air even below freezing because its refrigerant boils at very low temperatures.",
        "The compressor raises the pressure and temperature of the refrigerant vapour so it can release that heat into the heating water.",
        "The seasonal performance factor states how many kilowatt-hours of heat each kilowatt-hour of electricity yields over a year; in well-insulated homes it often lies between three and four.",
        "Efficiency drops in very cold air, which is why some systems add an electric backup heater.",
        "Low flow temperatures, for example with underfloor heating, improve efficiency noticeably.",
      ],
    },
    {
      message: "Put together a packing list for a three-day hiking trip in the mountains in autumn.",
      short: "Make me a packing list for a weekend hike",
      facts: [
        "Pack a waterproof shell jacket, a warm fleece layer and two pairs of merino socks for every day on the trail.",
        "Bring a 30-litre backpack with a rain cover, a headlamp with spare batteries and a small first-aid kit.",
        "For food, plan on oat breakfasts, wraps with cheese and nuts for lunch, and dehydrated meals for dinner.",
        "A paper map and a compass back up the phone, whose battery drains faster in the cold.",
        "Trekking poles help on wet descents, and gaiters keep mud and small stones out of the boots.",
      ],
    },
    {
      message: "What are the current rules for carrying power banks on flights within the EU?",
      short: "Can I take a power bank on a plane?",
      facts: [
        "Power banks must travel in hand luggage because spare lithium batteries are not allowed in checked baggage.",
        "Batteries up to 100 watt-hours are generally permitted without asking the airline first.",
        "Between 100 and 160 watt-hours most airlines require prior approval and limit passengers to two spare batteries.",
        "Some carriers have recently banned using power banks on board during the flight itself.",
        "Security staff may ask to see the capacity label, so devices without one can be refused at the checkpoint.",
      ],
    },
    {
      message: "Draft a short note to the team that this week's planning review moves to Thursday.",
      short: "Tell the team we meet on Thursday instead",
      facts: [
        "Hi all, this week's planning review moves from Tuesday to Thursday.",
        "The time stays the same: we meet at ten in the large meeting room on the second floor.",
        "Please bring your updated task lists and any open questions about the quarterly plan.",
        "If you cannot make Thursday, send your points to the group by Wednesday evening.",
        "Thanks for being flexible; the agenda goes out the day before as usual, and see you on Thursday.",
      ],
    },
    {
      message: "Compare the newest mid-range graphics cards for running language models locally by memory and price.",
      short: "Which graphics card is enough for local models?",
      facts: [
        "For local language models the graphics memory matters most, because the whole model and its context have to fit into it.",
        "Cards with 16 gigabytes run quantised models of up to about 14 billion parameters with a longer context.",
        "Memory bandwidth decides token generation speed more than raw compute does.",
        "Used previous-generation cards with 24 gigabytes are often cheaper per gigabyte than new mid-range cards.",
        "Power draw under load differs by up to a hundred watts between vendors.",
      ],
    },
    {
      message: "How long do freelancers in the UK have to keep their invoices and receipts?",
      short: "How long do I need to keep my invoices?",
      facts: [
        "Self-employed people in the UK must keep business records for at least five years after the 31 January deadline of the tax year they belong to.",
        "Records include sales invoices, receipts for expenses, bank statements and any grants received.",
        "The tax authority can charge a penalty of up to three thousand pounds for records that were not kept.",
        "Digital copies are acceptable as long as they are clear, complete and can be produced on request.",
        "Businesses registered for VAT also have to follow the digital record-keeping rules for VAT returns.",
      ],
    },
  ],
};

/** Acceptance criteria as record_plan writes them: generic, in the language of the turn. */
const CRITERIA: Readonly<Record<ProbeLanguage, readonly string[]>> = {
  de: [
    "Die Antwort beantwortet jeden Teil der Anfrage.",
    "Konkrete Zahlen, Fristen und Beträge sind belegt oder als unbestätigt gekennzeichnet.",
    "Die Antwort ist auf Deutsch geschrieben.",
  ],
  en: [
    "The answer addresses every part of the request.",
    "Specific figures, deadlines and amounts are sourced or marked as unverified.",
    "The answer is written in English.",
  ],
};

/** Page chrome with nothing on any topic: the case the distillation's "irrelevant" answer covers. */
const PAGE_CHROME: Readonly<Record<ProbeLanguage, string>> = {
  de: "Zum Inhalt springen · Menü · Startseite · Über uns · Produkte · Karriere · Kontakt\n"
    + "Wir verwenden Cookies, um Ihnen das beste Nutzererlebnis zu bieten. Mit „Alle akzeptieren“ stimmen Sie der Verwendung aller Cookies zu. Einstellungen anpassen · Nur notwendige Cookies\n"
    + "Anmelden · Registrieren · Passwort vergessen?\n"
    + "Newsletter abonnieren: Erhalten Sie einmal im Monat Neuigkeiten aus unserem Haus.\n"
    + "Impressum · Datenschutz · AGB · Barrierefreiheit · Sitemap\n"
    + "© 2026 Beispiel GmbH. Alle Rechte vorbehalten.\n"
    + "Seite {page} von 40 · Zurück · Weiter",
  en: "Skip to content · Menu · Home · About us · Products · Careers · Contact\n"
    + "We use cookies to give you the best experience. By choosing “Accept all” you agree to the use of all cookies. Manage settings · Necessary only\n"
    + "Sign in · Register · Forgot your password?\n"
    + "Subscribe to our newsletter: news from our company once a month.\n"
    + "Imprint · Privacy · Terms · Accessibility · Sitemap\n"
    + "© 2026 Example Ltd. All rights reserved.\n"
    + "Page {page} of 40 · Back · Next",
};

/**
 * Stands in for the receptionist's memory capsule, which production builds from the user's own
 * memory records (buildMemoryCapsule): the same size (up to 400 chars), none of the content.
 */
export const SYNTHETIC_MEMORY_CAPSULE = [
  "- Prefers short answers that start with a one-line summary.",
  "- Works on a small home server with a local GPU.",
  "- Decided to keep the weekly planning review on Thursdays.",
  "- Prefers metric units and 24-hour times.",
  "- Asked for a reminder about invoice deadlines at the end of each quarter.",
].join("\n");

export interface SyntheticCase {
  language: ProbeLanguage;
  message: string;
  short: string;
  facts: string[];
  /** Page number of the synthetic page chrome, so every distillation input differs. */
  page: number;
}

/**
 * Case `index` of a language. Past the end of the topic list the topics repeat with a marker
 * appended, so every index still sends a prompt the server has not seen.
 */
export function syntheticCase(language: ProbeLanguage, index: number): SyntheticCase {
  const topics = TOPICS[language];
  const topic = topics[index % topics.length]!;
  const marker = index >= topics.length ? ` #${index}` : "";
  return {
    language,
    message: `${topic.message}${marker}`,
    short: `${topic.short}${marker}`,
    facts: topic.facts.map((fact, i) => (i === 0 ? `${fact}${marker}` : fact)),
    page: index + 1,
  };
}

/** Number of distinct topics per language before syntheticCase starts marking repeats. */
export const SYNTHETIC_TOPIC_COUNT = Math.min(TOPICS.de.length, TOPICS.en.length);

export function syntheticDraft(c: SyntheticCase): string {
  return c.facts.join(" ");
}

export function syntheticSlices(c: SyntheticCase): Array<{ label: string; text: string }> {
  return [
    { label: "researcher (slice 1)", text: c.facts.slice(0, 3).join(" ") },
    { label: "researcher (slice 2)", text: c.facts.slice(2).join(" ") },
  ];
}

export function syntheticEvidence(c: SyntheticCase): string {
  return c.facts.map((fact, i) => `- ${fact} (https://example.org/source/${c.page}-${i + 1})`).join("\n");
}

/** Longest stretch of the latest output the sub-agent loop hands the progress judge. */
export const PROGRESS_DIGEST_OUTPUT_CHARS = 1_200;

/**
 * A progress digest laid out as the sub-agent loop lays it out for the semantic judge
 * (agent/sub-agent.ts): the latest assistant output, clipped, then the recent tool calls by name.
 */
export function syntheticActivity(c: SyntheticCase): string {
  return [
    `Latest output:\n${syntheticDraft(c).slice(0, PROGRESS_DIGEST_OUTPUT_CHARS)}`,
    `Recent tool calls: ${["web_search", "web_fetch", "web_fetch", "share_finding"].join(", ")}`,
  ].join("\n\n");
}

/** About 2,000 characters of page chrome: navigation, cookie and login banners, a footer. */
export function syntheticPageChrome(c: SyntheticCase): string {
  const blocks: string[] = [];
  for (let i = 0; i < 4; i += 1) blocks.push(PAGE_CHROME[c.language].replace("{page}", String(c.page + i)));
  return blocks.join("\n\n");
}

/** A prior exchange for E2's "after history" steps, about 1.2k tokens. */
export function syntheticHistory(): LLMMessage[] {
  return TOPICS.de.flatMap((topic): LLMMessage[] => [
    { role: "user", content: topic.message },
    { role: "assistant", content: topic.facts.join(" ") },
  ]);
}

/** A distinct user message for head call number `n`. */
export function headUserMessage(n: number): string {
  const language: ProbeLanguage = n % 2 === 0 ? "de" : "en";
  const topics = TOPICS[language];
  return `${topics[Math.floor(n / 2) % topics.length]!.message} #h${n}`;
}

const FILLER_LINE = (i: number): string =>
  `Probe filler line ${i}: the station keeps serving while this appended context grows by a fixed amount.`;

/**
 * About `tokens` tokens of neutral text, cut at a word boundary. A shorter filler is always a prefix
 * of a longer one, so E2's appends extend the previous prompt instead of replacing its end.
 */
export function fillerText(tokens: number): string {
  if (tokens <= 0) return "";
  const target = Math.max(1, Math.round(tokens * FILLER_CHARS_PER_TOKEN));
  let source = "";
  for (let i = 1; source.length < target + 200; i += 1) source += (source ? " " : "") + FILLER_LINE(i);
  const cut = source.lastIndexOf(" ", target);
  return source.slice(0, cut > 0 ? cut : target);
}

const MID_CHANGE_SENTENCE = "Probe note: this sentence changes the middle of the system text.";

/** The system text with one sentence inserted at the first paragraph break past its middle. */
export function insertMidSystemChange(system: string): { system: string; atChar: number } {
  const middle = Math.floor(system.length / 2);
  const brk = system.indexOf("\n\n", middle);
  const at = brk >= 0 ? brk : middle;
  return { system: `${system.slice(0, at)}\n\n${MID_CHANGE_SENTENCE}${system.slice(at)}`, atChar: at };
}

// ── Decision prompts ───────────────────────────────────────────────────────────────────────────

export type DecisionShape =
  | "fast_lane"
  | "source_sensitive"
  | "ungrounded_draft"
  | "slices_disagree"
  | "goal_met"
  | "finding_relevant"
  | "run_drifting"
  | "qa_verdict";

/** The seven Laya decision points plus the QA verdict, the one other small verdict on the critical path. */
export const DECISION_SHAPES: readonly DecisionShape[] = [
  "fast_lane",
  "source_sensitive",
  "ungrounded_draft",
  "slices_disagree",
  "goal_met",
  "finding_relevant",
  "run_drifting",
  "qa_verdict",
];

/**
 * Where each call sits in a turn. Only a call the turn waits for turns a saving into a shorter
 * response: the distillation runs beside the tool loop (autoShareUsefulFinding in agent/sub-agent.ts)
 * and is joined only where its text is read, so skipping it mostly frees the model server. The QA
 * verdict is no Laya decision point; its row prices what a categorisation there would save.
 */
export const DECISION_PLACEMENT: Readonly<Record<DecisionShape, { awaited: boolean; layaPoint: boolean }>> = {
  fast_lane: { awaited: true, layaPoint: true },
  source_sensitive: { awaited: true, layaPoint: true },
  ungrounded_draft: { awaited: true, layaPoint: true },
  slices_disagree: { awaited: true, layaPoint: true },
  goal_met: { awaited: true, layaPoint: true },
  finding_relevant: { awaited: false, layaPoint: true },
  run_drifting: { awaited: true, layaPoint: true },
  qa_verdict: { awaited: true, layaPoint: false },
};

/** The production settings that change a decision prompt's text. */
export interface DecisionPromptSettings {
  receptionist: {
    confidenceAttempt: boolean;
    assistantName?: string;
    personaLines?: readonly string[];
    defaultLanguage?: string;
  };
  /** Whether the QA verdict asks for evidence with a PASS (qaRequiresEvidence). */
  qaRequireEvidence: boolean;
}

/** The settings as the loaded config sets them, read the way each call site reads them. */
export function collectDecisionSettings(): DecisionPromptSettings {
  const config = getConfig();
  let assistantName: string | undefined;
  try {
    assistantName = loadMainAssistantPersonality().identity?.name;
  } catch { /* the receptionist runs unnamed too */ }
  const orchestration = effectiveOrchestration();
  return {
    receptionist: {
      confidenceAttempt: config.receptionist?.confidenceAttempt === true,
      ...(assistantName ? { assistantName } : {}),
      personaLines: getReceptionistPersonaLines(),
      defaultLanguage: defaultReplyLanguage(),
    },
    qaRequireEvidence: qaRequiresEvidence({
      requireEvidence: orchestration.qaEvidenceRequired,
      qaToolJudge: orchestration.qaToolJudge,
      qaStrictVerdicts: orchestration.qaStrictVerdicts,
    }),
  };
}

/** The goal-met oversight prompt as assessOversightGoalMet (agent/sub-agent.ts) builds it inline. */
export function buildGoalMetMessages(acceptanceCriteria: readonly string[], evidence: string): LLMMessage[] {
  const system =
    "You are a swarm oversight checker. A worker agent is gathering evidence for a task. Given the task's "
    + "acceptance criteria and the evidence it has gathered SO FAR, decide whether the goal is ALREADY met well "
    + "enough to write the final answer now. Bias toward stopping: if the evidence already covers the criteria, the "
    + "worker should STOP gathering more. Reply with EXACTLY one word — DONE if the criteria are already satisfied, "
    + "or CONTINUE if a criterion is clearly not yet covered.";
  const user =
    "Acceptance criteria:\n"
    + acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
    + "\n\nEvidence gathered so far:\n"
    + (evidence || "(none)").slice(0, 3_000);
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** The finding-distillation prompt as distillFindingForSharedFacts (agent/sub-agent.ts) builds it inline. */
export function buildFindingDistillMessages(objective: string, toolName: string, rawEvidence: string): LLMMessage[] {
  const clippedObjective = objective.replace(/\s+/g, " ").trim().slice(0, 600);
  const raw = rawEvidence.slice(0, 6000);
  return [
    {
      role: "system",
      content:
        "You are an evidence-distillation step in a research pipeline. You are given a research OBJECTIVE "
        + "and RAW CONTENT that a tool returned. Extract ONLY the information in the raw content that is "
        + "relevant to the objective: concrete facts, figures, dates, names, prices, specs, and the source "
        + "URL(s) they came from. Output a compact Markdown bullet list (at most 8 bullets). Preserve exact "
        + "numbers, units, and URLs verbatim. DROP navigation menus, cookie/consent/login banners, site "
        + "chrome, and anything not relevant to the objective. Do NOT add facts that are not in the raw "
        + "content. "
        + "Copy each value exactly as the source states it. Do NOT add your own notes, caveats, "
        + "corrections, interpretations, or parenthetical commentary, and do NOT try to reconcile or "
        + "explain disagreements between sources — output only the facts themselves, each as a single "
        + "bullet with its value and (where present) its source URL. "
        + "If the raw content contains nothing relevant to the objective, reply with exactly: NONE",
    },
    { role: "user", content: `OBJECTIVE:\n${clippedObjective}\n\nRAW CONTENT (from ${toolName}):\n${raw}` },
  ];
}

/** The QA verdict prompt's fixed lines, as runQaDeliveryGate (agent/runtime.ts) writes them. */
export const QA_VERDICT_SYSTEM = "You are a concise QA reviewer. Output only a verdict (PASS or FAIL: …), never a rewritten answer.";
export const QA_VERDICT_LINES = {
  intro: "You are a strict QA reviewer. Judge ONLY whether the ANSWER below satisfies EVERY acceptance criterion for the user's task. Do not rewrite it.",
  criteriaHeader: "Acceptance criteria:",
  answerHeader: "ANSWER:",
  passWithEvidence: "Reply on a SINGLE line. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS — evidence: <one concrete verifiable fact from the answer's tool results / artifacts that proves the criteria are met>. A PASS with no such concrete evidence will NOT be trusted.",
  passPlain: "Reply on a SINGLE line. If every criterion is fully met and the answer is internally consistent, reply exactly: PASS",
  scope: "Also FAIL when the answer reveals work OUTSIDE the task's declared scope (unrequested changes, drive-by refactors, 'improvements' nobody asked for) or shows debug leftovers in the deliverable (debug prints, placeholder text, commented-out scraps) — name the out-of-scope item or leftover.",
  fail: "Otherwise reply: FAIL: <one concise sentence naming each unmet criterion / concrete flaw>.",
} as const;

/** The prose QA verdict prompt, without a disputed-evidence block (none exists on synthetic content). */
export function buildQaVerdictMessages(input: {
  criteria: readonly string[];
  answer: string;
  turnRecordBlock: string;
  requireEvidence: boolean;
}): LLMMessage[] {
  const instruction = [
    QA_VERDICT_LINES.intro,
    QA_VERDICT_LINES.criteriaHeader,
    ...input.criteria.map((c, i) => `${i + 1}. ${c}`),
    ...(input.turnRecordBlock ? [input.turnRecordBlock] : []),
    "",
    QA_VERDICT_LINES.answerHeader,
    input.answer,
    "",
    input.requireEvidence ? QA_VERDICT_LINES.passWithEvidence : QA_VERDICT_LINES.passPlain,
    QA_VERDICT_LINES.scope,
    QA_VERDICT_LINES.fail,
  ].join("\n");
  return [
    { role: "system", content: QA_VERDICT_SYSTEM },
    { role: "user", content: instruction },
  ];
}

/**
 * One decision call's messages, from its production builder. Each shape gets the case its Laya
 * point may answer alone where the point restricts that (decisions/decide.ts layaMayTake): a task
 * for the receptionist, page chrome for the distillation, an on-track run for the progress judge.
 * Those are the calls whose cost Laya can remove.
 */
export function buildDecisionMessages(shape: DecisionShape, c: SyntheticCase, settings: DecisionPromptSettings): LLMMessage[] {
  switch (shape) {
    case "fast_lane":
      return buildReceptionistMessages(c.short, {
        memoryCapsule: SYNTHETIC_MEMORY_CAPSULE,
        ...(settings.receptionist.assistantName ? { assistantName: settings.receptionist.assistantName } : {}),
        ...(settings.receptionist.personaLines ? { personaLines: settings.receptionist.personaLines } : {}),
        confidenceAttempt: settings.receptionist.confidenceAttempt,
        ...(settings.receptionist.defaultLanguage ? { defaultLanguage: settings.receptionist.defaultLanguage } : {}),
      });
    case "source_sensitive":
      return buildSourceSensitiveQuestionJudgeMessages(c.message);
    case "ungrounded_draft":
      return buildUngroundedClaimJudgeMessages(c.message, syntheticDraft(c));
    case "slices_disagree":
      return buildDisagreementCheckMessages(syntheticSlices(c));
    case "goal_met":
      return buildGoalMetMessages(CRITERIA[c.language], syntheticEvidence(c));
    case "finding_relevant":
      return buildFindingDistillMessages(c.message, "web_fetch", syntheticPageChrome(c));
    case "run_drifting":
      return buildProgressJudgePrompt({ objective: c.message, recentActivity: syntheticActivity(c) });
    case "qa_verdict":
      return buildQaVerdictMessages({
        criteria: CRITERIA[c.language],
        answer: syntheticDraft(c),
        turnRecordBlock: formatQaTurnRecord([{ role: "user" }], { opening: c.message, midTurn: [] }),
        requireEvidence: settings.qaRequireEvidence,
      });
  }
}

// ── Heads ──────────────────────────────────────────────────────────────────────────────────────

export interface HeadShape {
  label: string;
  system: string;
  tools: LLMToolDef[];
}

/**
 * The orchestrator head exactly as the prompt-cache warm-keeper builds it (agent/cache-warmer.ts):
 * the base prompt, reduced to its lean base when the orchestration module is split off, and the
 * main assistant's full tool block.
 */
export function collectOrchestratorHead(): HeadShape {
  const config = getConfig();
  let system = defaultSystemPrompt();
  if (config.agents?.performance?.splitOrchestrationPrompt === true) system = splitOrchestrationModule(system).leanBase;
  return { label: "orchestrator", system, tools: getToolsAsLLMDefs(getMainAssistantToolNames()) };
}

/** The date line of a sub-agent head, formatted as agent/sub-agent.ts formats it. */
export function subAgentHeadDate(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/**
 * A head shaped like a specialist's: its own prompt, the name/workspace/date lines and its tools.
 * Shaped, not byte-exact: production adds per-agent guidance blocks and ranks the tools by the
 * agent's description with an embedding call, which a timing probe does not need.
 */
export function collectSubAgentShapedHead(agentName: string, today: string = subAgentHeadDate()): HeadShape {
  const config = getConfig();
  const agent = config.subAgents?.[agentName];
  if (!agent) throw new Error(`the loaded config has no sub-agent "${agentName}"`);
  const role = agent.systemPrompt ?? `You are a specialized AI sub-agent named "${agentName}". Complete the given task and return your result.`;
  const system = `${role}\n\nAgent name: ${agentName}\nCurrent workspace: ${config.workspacePath}\nToday's date: ${today}`;
  return { label: `sub_agent:${agentName}`, system, tools: getToolsAsLLMDefs(agent.tools).slice(0, SUB_AGENT_HEAD_MAX_TOOLS) };
}

export function headMessages(head: HeadShape, user: string, history: readonly LLMMessage[] = []): LLMMessage[] {
  return [{ role: "system", content: head.system }, ...history, { role: "user", content: user }];
}

/** FNV-1a of a nonce as eight hex digits: a start that two nonces of one run do not share. */
export function nonceTag(nonce: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < nonce.length; i += 1) {
    hash ^= nonce.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Make a prompt unlike anything cached from its first token: a leading system line the provider's
 * fold merges into the system message, as it merges the turn's own system blocks. The line opens
 * with the nonce's hash, not the nonce: the nonces of one run all start with the run id and "-E",
 * and Qwen's tokenizer spells every digit of that as a token of its own, so a cold call could find
 * about twenty tokens of the previous nonce cached, more than COLD_CACHE_TOKENS lets a cold call reuse.
 */
export function withNonce(messages: readonly LLMMessage[], nonce: string): LLMMessage[] {
  return [{ role: "system", content: `[${nonceTag(nonce)} latency probe ${nonce}]` }, ...messages];
}

/**
 * The same, for the tool block: a marker tool named after the nonce's hash, first in the array.
 * On a template that renders the tools BEFORE the system text (the deployed Qwen3.6 one), two
 * calls that differ only in withNonce still share their whole tool-block prefix, and a checkpoint
 * inside it lets the "cold" call reuse it. The marker makes the first rendered tool differ too.
 */
export function withNonceTool(tools: readonly LLMToolDef[], nonce: string): LLMToolDef[] {
  return [
    { name: `probe_marker_${nonceTag(nonce)}`, description: "Latency probe marker. Never call it.", parameters: { type: "object", properties: {} } },
    ...tools,
  ];
}

/**
 * E8's head: a staged builder's as the runner assembles it — the FRESH staged-build directive
 * first (a constant string), then the agent's own prompt and the name/workspace/date lines, with
 * ALL of the agent's tools (no cap: content_writer carries 16, about 7.6k tokens with the prompt).
 * Still shaped, not byte-exact: the rerank order and the per-agent guidance blocks are left out.
 */
export function collectStagedBuilderHead(agentName: string, today: string = subAgentHeadDate()): HeadShape {
  const config = getConfig();
  const agent = config.subAgents?.[agentName];
  if (!agent) throw new Error(`the loaded config has no sub-agent "${agentName}"`);
  const role = agent.systemPrompt ?? `You are a specialized AI sub-agent named "${agentName}". Complete the given task and return your result.`;
  const system = `${buildStagedArtifactBuildGuidance()}\n\n${role}\n\nAgent name: ${agentName}\nCurrent workspace: ${config.workspacePath}\nToday's date: ${today}`;
  return { label: `staged_builder:${agentName}`, system, tools: getToolsAsLLMDefs(agent.tools) };
}

/**
 * A head whose leading system run is several messages (lean base, then the orchestration module),
 * as the warm-keeper sends it (agent/cache-warmer.ts collectWarmHeads). The provider folds them
 * into one system message, exactly as it folds the turn's own.
 */
export interface MultiSystemHead {
  label: string;
  system: string[];
  tools: LLMToolDef[];
}

/** E9's heads: the three the warm-keeper sends with promptCacheWarmForcedHeads on, and the date line a turn adds after them. */
export interface ForcedHeadSet {
  /** Lean base + the full tool block: what every non-forced turn sends. */
  full: MultiSystemHead;
  /** Lean base + module, record_plan subset: a forced turn's first call, before a plan exists. */
  plan: MultiSystemHead;
  /** Lean base + module, execute_plan subset: a forced call once the plan exists. */
  dispatch: MultiSystemHead;
  /** filterForcedOrchestrationTools(full) with NO plan argument: the plan's rejected literal subset. */
  literalSubsetTools: LLMToolDef[];
  /** The turn's date line (buildTemporalContextPrompt), which follows the head in a real turn. */
  temporal: string;
}

// ── Requests and the wire ──────────────────────────────────────────────────────────────────────

export interface ProbeRequest {
  /** Which step of its experiment this call is, e.g. "cold", "append_18", "head_after_k2". */
  step: string;
  /** What the call stands for in production: a decision shape, "orchestrator_head", "sub_agent_head", "forced_subset_head". */
  shape: string;
  language?: ProbeLanguage;
  messages: LLMMessage[];
  tools: LLMToolDef[];
  /** A probe-chosen output ceiling; absent, the call sends the production call site's own budget. */
  maxTokens?: number;
  /** Abort the request this long after it was sent (E5). */
  abortAfterMs?: number;
  /** Facts the verdicts need, e.g. { k: 2 } or { appendedTokens: 18 }. */
  tags?: Record<string, number | string>;
}

export interface WireOptions {
  model: string;
  /** agents.defaults.model.contextWindow: the production budget is derived from it. */
  contextWindow: number;
  /** agents.defaults.model.maxTokens, the declared ceiling on that budget. */
  declaredMaxTokens?: number;
}

/** Thinking off, as every routing-tier verdict and the QA verdict send it. */
const THINKING_OFF = { enableThinking: false, reasoningEffort: "none" } as const;

/** The output ceiling a production call without a per-call ceiling sends (LMStudioProvider.resolveMaxTokens). */
export function resolveProbeMaxTokens(request: ProbeRequest, options: WireOptions): number {
  if (request.maxTokens !== undefined) return request.maxTokens;
  return computeOutputTokenBudget({
    contextWindow: options.contextWindow,
    estimatedPromptTokens: estimatePromptTokensForRequest(request.messages, request.tools),
    ...(options.declaredMaxTokens !== undefined ? { declaredMaxTokens: options.declaredMaxTokens } : {}),
  });
}

/**
 * The request body, in the shape LMStudioProvider.complete() puts on the wire: folded system
 * messages, the same tool mapping, the family's thinking-off controls and cache_prompt. Sampling is
 * pinned to temperature 0 so repetitions decode alike.
 */
export function buildWireBody(request: ProbeRequest, options: WireOptions): Record<string, unknown> {
  const controls = resolveThinkingControls(options.model, THINKING_OFF);
  const tools = request.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages: normalizeMessagesForModel(request.messages, options.model),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    temperature: 0,
    max_tokens: resolveProbeMaxTokens(request, options),
    stream: false,
    cache_prompt: true,
    ...(controls.chatTemplateKwargs ? { chat_template_kwargs: controls.chatTemplateKwargs } : {}),
    ...(controls.reasoningEffort ? { reasoning_effort: controls.reasoningEffort } : {}),
  };
}

// ── Plans ──────────────────────────────────────────────────────────────────────────────────────

export interface PlannedCall {
  request: ProbeRequest;
  /** Start this long after the phase starts; calls of one phase run concurrently. */
  startAfterMs: number;
}

export interface ProbePhase {
  rep: number;
  calls: PlannedCall[];
}

export interface ExperimentPlan {
  id: ExperimentId;
  question: string;
  phases: ProbePhase[];
}

/** The experiment name of the two production-head calls that bracket a run. */
export const SETUP_EXPERIMENT = "setup";
export const PRODUCTION_HEAD_BEFORE = "production_head_before";
export const PRODUCTION_HEAD_AFTER = "production_head_after";

/**
 * The warm-keeper's own request, without a nonce: [lean base, "."] and the full tool block. Sent
 * before the run it shows whether the live head was cached; sent after, it puts the head back into
 * the cache the probe's own heads have been crowding, so the next real turn does not pay for them.
 */
export function productionHeadRequest(head: HeadShape, step: typeof PRODUCTION_HEAD_BEFORE | typeof PRODUCTION_HEAD_AFTER): ProbeRequest {
  return { step, shape: "orchestrator_head", messages: headMessages(head, "."), tools: head.tools, maxTokens: HEAD_PROBE_MAX_TOKENS };
}

export interface PlanContext {
  /** Short id of this run: part of every nonce, so no two runs share a cold prefix. */
  runId: string;
  reps: number;
  settings: DecisionPromptSettings;
  orchestratorHead: HeadShape;
  subAgentHead: HeadShape;
  /** The orchestrator's tools as a forced iteration sends them (filterForcedOrchestrationTools). */
  forcedSubsetTools: LLMToolDef[];
  abortAfterMs: number;
  prewarmStaggerMs: number;
  /** E8: a staged builder's head (collectStagedBuilderHead); required when E8 is planned. */
  stagedBuilderHead?: HeadShape;
  /** E9: the warm-keeper's heads with the forced ones; required when E9 is planned. */
  forcedHeads?: ForcedHeadSet;
}

/** Case and head-message numbers per experiment, so no two experiments send the same user text. */
const CASE_OFFSETS: Readonly<Record<ExperimentId, number>> = { E1: 0, E2: 1_000, E3: 2_000, E4: 3_000, E5: 4_000, E6: 5_000, E7: 6_000, E8: 7_000, E9: 8_000 };

const E3_SMALL_SHAPES: readonly DecisionShape[] = ["fast_lane", "source_sensitive", "ungrounded_draft", "qa_verdict"];
const E4_PAIR: readonly DecisionShape[] = ["fast_lane", "source_sensitive"];
const E4_QUAD: readonly DecisionShape[] = ["fast_lane", "source_sensitive", "ungrounded_draft", "run_drifting"];

function sequential(rep: number, request: ProbeRequest): ProbePhase {
  return { rep, calls: [{ request, startAfterMs: 0 }] };
}

function nonce(ctx: PlanContext, experiment: ExperimentId, rep: number, variant: string): string {
  return `${ctx.runId}-${experiment}-r${rep}-${variant}`;
}

function decisionRequest(
  shape: DecisionShape,
  c: SyntheticCase,
  ctx: PlanContext,
  step: string,
  extra: { nonce?: string; tags?: Record<string, number | string>; abortAfterMs?: number } = {},
): ProbeRequest {
  const messages = buildDecisionMessages(shape, c, ctx.settings);
  return {
    step,
    shape,
    language: c.language,
    messages: extra.nonce ? withNonce(messages, extra.nonce) : messages,
    tools: [],
    ...(extra.abortAfterMs !== undefined ? { abortAfterMs: extra.abortAfterMs } : {}),
    ...(extra.tags ? { tags: extra.tags } : {}),
  };
}

function headRequest(
  head: HeadShape,
  shape: string,
  step: string,
  user: string,
  opts: { nonce?: string; history?: readonly LLMMessage[]; tools?: LLMToolDef[]; system?: string; tags?: Record<string, number | string> } = {},
): ProbeRequest {
  const shaped: HeadShape = { ...head, ...(opts.system !== undefined ? { system: opts.system } : {}) };
  const messages = headMessages(shaped, user, opts.history ?? []);
  return {
    step,
    shape,
    messages: opts.nonce ? withNonce(messages, opts.nonce) : messages,
    tools: opts.tools ?? head.tools,
    maxTokens: HEAD_PROBE_MAX_TOKENS,
    ...(opts.tags ? { tags: opts.tags } : {}),
  };
}

function counter(start: number): () => number {
  let next = start;
  return () => next++;
}

function planE1(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  for (const shape of DECISION_SHAPES) {
    // Cold: a nonce makes the whole prompt new, so this is the first call a prompt ever pays.
    phases.push(sequential(0, decisionRequest(shape, syntheticCase("de", 0), ctx, "cold", { nonce: nonce(ctx, "E1", 0, shape) })));
    // Prime, not scored: the cold call's nonce kept the static system part out of the cache, so
    // without this the first warm call would pay for that part and count as warm.
    phases.push(sequential(0, decisionRequest(shape, syntheticCase("en", 0), ctx, "prime")));
    // Warm: the static system part cached by the call before, the case new — how production meets it.
    let last: ProbeRequest | undefined;
    for (let rep = 0; rep < ctx.reps; rep += 1) {
      for (const language of PROBE_LANGUAGES) {
        last = decisionRequest(shape, syntheticCase(language, rep + 1), ctx, "warm");
        phases.push(sequential(rep, last));
      }
    }
    // Repeat: the identical prompt again, so only the per-call floor is left.
    if (last) phases.push(sequential(ctx.reps - 1, { ...last, step: "repeat" }));
  }
  return phases;
}

function planE2(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  const head = ctx.orchestratorHead;
  const nextUser = counter(CASE_OFFSETS.E2);
  const history = syntheticHistory();
  const mid = insertMidSystemChange(head.system);
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    const n = nonce(ctx, "E2", rep, "head");
    const base = headUserMessage(nextUser());
    phases.push(sequential(rep, headRequest(head, "orchestrator_head", "cold", base, { nonce: n })));
    let cumulative = 0;
    for (const tokens of APPEND_STEPS) {
      cumulative += tokens;
      phases.push(sequential(rep, headRequest(head, "orchestrator_head", `append_${tokens}`, `${base} ${fillerText(cumulative)}`, {
        nonce: n,
        tags: { appendedTokens: tokens, cumulativeTokens: cumulative },
      })));
    }
    phases.push(sequential(rep, headRequest(head, "orchestrator_head", "history_first", headUserMessage(nextUser()), { nonce: n, history })));
    phases.push(sequential(rep, headRequest(head, "orchestrator_head", "history_next_user", headUserMessage(nextUser()), { nonce: n, history })));
    phases.push(sequential(rep, headRequest(head, "orchestrator_head", "mid_system_change", base, {
      nonce: n,
      system: mid.system,
      tags: { changeAtChar: mid.atChar, systemChars: head.system.length },
    })));
  }
  return phases;
}

function planE3(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  const head = ctx.orchestratorHead;
  const nextUser = counter(CASE_OFFSETS.E3);
  const nextCase = counter(CASE_OFFSETS.E3);
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    const n = nonce(ctx, "E3", rep, "head");
    phases.push(sequential(rep, headRequest(head, "orchestrator_head", "head_warmup", headUserMessage(nextUser()), { nonce: n })));
    for (const k of INTERFERENCE_KS) {
      for (let i = 0; i < k; i += 1) {
        const index = nextCase();
        const shape = E3_SMALL_SHAPES[i % E3_SMALL_SHAPES.length]!;
        const language = PROBE_LANGUAGES[index % 2]!;
        phases.push(sequential(rep, decisionRequest(shape, syntheticCase(language, index), ctx, `small_k${k}`, { tags: { k, i } })));
      }
      phases.push(sequential(rep, headRequest(head, "orchestrator_head", `head_after_k${k}`, headUserMessage(nextUser()), { nonce: n, tags: { k } })));
    }
  }
  return phases;
}

function planE4(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  const nextCase = counter(CASE_OFFSETS.E4);
  // The pair runs on a short message, the kind on which both the receptionist and the judge run.
  const pairCase = (index: number): SyntheticCase => {
    const c = syntheticCase(PROBE_LANGUAGES[index % 2]!, index);
    return { ...c, message: c.short };
  };
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    for (const shape of E4_QUAD) {
      phases.push(sequential(rep, decisionRequest(shape, pairCase(nextCase()), ctx, "c1", { tags: { inFlight: 1 } })));
    }
    phases.push({
      rep,
      calls: E4_PAIR.map((shape) => ({ request: decisionRequest(shape, pairCase(nextCase()), ctx, "c2", { tags: { inFlight: 2 } }), startAfterMs: 0 })),
    });
    phases.push({
      rep,
      calls: E4_QUAD.map((shape) => ({ request: decisionRequest(shape, pairCase(nextCase()), ctx, "c4", { tags: { inFlight: 4 } }), startAfterMs: 0 })),
    });
  }
  return phases;
}

function planE5(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  const head = ctx.orchestratorHead;
  const nextUser = counter(CASE_OFFSETS.E5);
  const nextCase = counter(CASE_OFFSETS.E5);
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    const n = nonce(ctx, "E5", rep, "head");
    const head_ = (step: string) => headRequest(head, "orchestrator_head", step, headUserMessage(nextUser()), { nonce: n });
    phases.push(sequential(rep, head_("head_warmup")));
    phases.push(sequential(rep, head_("head_after_nothing")));
    // The aborted incumbent: the judge, as decide() starts it beside Laya. Its own nonce means only
    // this request could have cached its prompt, so the resend below shows whether it was processed.
    const aborted = decisionRequest("source_sensitive", syntheticCase("de", nextCase()), ctx, "aborted_decision", {
      nonce: nonce(ctx, "E5", rep, "aborted"),
      abortAfterMs: ctx.abortAfterMs,
    });
    phases.push(sequential(rep, aborted));
    phases.push(sequential(rep, head_("head_after_abort")));
    const { abortAfterMs: _abortAfterMs, ...resend } = aborted;
    phases.push(sequential(rep, { ...resend, step: "aborted_resend" }));
    phases.push(sequential(rep, decisionRequest("source_sensitive", syntheticCase("en", nextCase()), ctx, "completed_decision", {
      nonce: nonce(ctx, "E5", rep, "completed"),
    })));
    phases.push(sequential(rep, head_("head_after_completed")));
  }
  return phases;
}

function planE6(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  const head = ctx.subAgentHead;
  const nextCase = counter(CASE_OFFSETS.E6);
  const task = (): string => {
    const index = nextCase();
    return syntheticCase(PROBE_LANGUAGES[index % 2]!, index).message;
  };
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    phases.push(sequential(rep, headRequest(head, "sub_agent_head", "cold_first_call", task(), { nonce: nonce(ctx, "E6", rep, "cold") })));
    const warmed = nonce(ctx, "E6", rep, "prewarmed");
    // The prewarm knows the agent, not the task: its user turn is a placeholder, as the warm-keeper's is.
    phases.push(sequential(rep, headRequest(head, "sub_agent_head", "prewarm", ".", { nonce: warmed })));
    phases.push(sequential(rep, headRequest(head, "sub_agent_head", "first_call_after_prewarm", task(), { nonce: warmed })));
    const inFlight = nonce(ctx, "E6", rep, "in_flight");
    phases.push({
      rep,
      calls: [
        { request: headRequest(head, "sub_agent_head", "prewarm_concurrent", ".", { nonce: inFlight }), startAfterMs: 0 },
        {
          request: headRequest(head, "sub_agent_head", "first_call_concurrent", task(), { nonce: inFlight, tags: { staggerMs: ctx.prewarmStaggerMs } }),
          startAfterMs: ctx.prewarmStaggerMs,
        },
      ],
    });
  }
  return phases;
}

function planE7(ctx: PlanContext): ProbePhase[] {
  const phases: ProbePhase[] = [];
  const head = ctx.orchestratorHead;
  const subset = ctx.forcedSubsetTools;
  const nextUser = counter(CASE_OFFSETS.E7);
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    const n = nonce(ctx, "E7", rep, "head");
    const full = (step: string) => headRequest(head, "orchestrator_head", step, headUserMessage(nextUser()), { nonce: n });
    const forced = (step: string, nonceValue = n) =>
      headRequest(head, "forced_subset_head", step, headUserMessage(nextUser()), { nonce: nonceValue, tools: subset, tags: { toolCount: subset.length } });
    phases.push(sequential(rep, full("full_cold")));
    phases.push(sequential(rep, full("full_warm")));
    phases.push(sequential(rep, forced("subset_after_full")));
    phases.push(sequential(rep, forced("subset_warm")));
    phases.push(sequential(rep, full("full_after_subset")));
    phases.push(sequential(rep, forced("subset_after_full_again")));
    phases.push(sequential(rep, forced("subset_cold", nonce(ctx, "E7", rep, "subset"))));
  }
  return phases;
}

/** A head with the nonce leading BOTH its system text and its tool block (see withNonceTool). */
function nonceHeadRequest(
  system: readonly string[],
  tools: readonly LLMToolDef[],
  shape: string,
  step: string,
  n: string,
  rest: readonly LLMMessage[],
  tags?: Record<string, number | string>,
): ProbeRequest {
  const messages: LLMMessage[] = [...system.map((content) => ({ role: "system" as const, content })), ...rest];
  return {
    step,
    shape,
    messages: withNonce(messages, n),
    tools: withNonceTool(tools, n),
    maxTokens: HEAD_PROBE_MAX_TOKENS,
    ...(tags ? { tags } : {}),
  };
}

/** A new conversation's task: a distinct synthetic task, padded to about E8_TAIL_TOKENS. */
function e8Tail(index: number): string {
  const c = syntheticCase(PROBE_LANGUAGES[index % 2]!, index);
  return `${c.message}\n\n${fillerText(E8_TAIL_TOKENS - 60)}`;
}

/** E8's run arms: the three run lengths, then 6x again with a head-only request before the new
 *  conversations, then 1.5x again with other agents' conversations in between (d). */
export const E8_ARMS = ["L1.5", "L3", "L6", "L6_head_only", "L1.5_interleaved"] as const;

function planE8(ctx: PlanContext): ProbePhase[] {
  const head = ctx.stagedBuilderHead;
  if (!head) throw new Error("E8 needs the staged builder head (PlanContext.stagedBuilderHead)");
  const phases: ProbePhase[] = [];
  const nextTail = counter(CASE_OFFSETS.E8);
  const nextCase = counter(CASE_OFFSETS.E8 + 500);
  // The runs are sized in ONE unit, the provider's estimator, for the head and the run alike: a
  // head of tool schemas tokenises denser than the prose a run appends, so sizing the run in real
  // tokens against an estimated head overshot (3x read as 4x on a prose head). In one unit a run
  // lands at or under its multiple in real tokens, never over. The verdict measures both sizes off
  // the answers (head_size, grow_*) and flags a run that ended on the wrong side of 4x.
  const headEstimate = estimatePromptTokensForRequest(headMessages(head, "."), head.tools);
  const sizeOf = (messages: readonly LLMMessage[]) => estimatePromptTokensForRequest([{ role: "system", content: head.system }, ...messages], head.tools);
  const unrelated = (rep: number, label: string, tags: Record<string, number | string>): ProbePhase => {
    const index = nextCase();
    return sequential(rep, decisionRequest("source_sensitive", syntheticCase(PROBE_LANGUAGES[index % 2]!, index), ctx, "unrelated", {
      nonce: nonce(ctx, "E8", rep, `unrelated-${label}-${index}`),
      tags,
    }));
  };
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    // The head's own size, on a nonce of its own so it warms nothing the arms use.
    phases.push(sequential(rep, nonceHeadRequest([head.system], head.tools, "staged_builder_head", "head_size", nonce(ctx, "E8", rep, "size"), [{ role: "user", content: "." }])));
    for (const arm of E8_ARMS) {
      const multiplier = arm === "L1.5" || arm === "L1.5_interleaved" ? 1.5 : arm === "L3" ? 3 : 6;
      const n = nonce(ctx, "E8", rep, arm);
      const call = (step: string, rest: readonly LLMMessage[], tags: Record<string, number | string> = {}) =>
        nonceHeadRequest([head.system], head.tools, "staged_builder_head", step, n, rest, { arm, multiplier, ...tags });
      // The run: its task, then one sub-agent-sized step per call (an assistant turn and the tool
      // result that answers it), so the server checkpoints at every user message as in a real run.
      const firstTask: LLMMessage = { role: "user", content: e8Tail(nextTail()) };
      phases.push(sequential(rep, call("grow_cold", [firstTask])));
      const history: LLMMessage[] = [firstTask];
      for (let step = 1; step <= E8_MAX_GROWTH_STEPS && sizeOf(history) < multiplier * headEstimate; step += 1) {
        history.push(
          { role: "assistant", content: `Pass ${step}. ${fillerText(E8_GROWTH_STEP_TOKENS / 2)}` },
          { role: "user", content: `Result of pass ${step}. ${fillerText(E8_GROWTH_STEP_TOKENS / 2)}` },
        );
        phases.push(sequential(rep, call("grow", [...history], { step })));
      }
      if (arm === "L6_head_only") {
        // (e) A finished head-only request, then two new conversations: the first should load the
        // head-only entry; whether the second finds it again says whether loading used it up.
        phases.push(sequential(rep, call("head_only", [{ role: "user", content: "." }])));
        phases.push(unrelated(rep, arm, { arm, multiplier }));
        phases.push(sequential(rep, call("consume_first", [{ role: "user", content: e8Tail(nextTail()) }])));
        phases.push(sequential(rep, call("consume_second", [{ role: "user", content: e8Tail(nextTail()) }])));
      } else if (arm === "L1.5_interleaved") {
        // (d) A run of a length both rules call warm, then other agents' conversations, each on a
        // head of its own (a nonce leads it, no tools), then the new conversation. Under the
        // idle-slot save the run's slot went to the host cache when the first of them started, and
        // this asks whether it outlived them; under --no-cache-idle-slots whether the slot did.
        for (let i = 0; i < E8_INTERLEAVED_HEADS; i += 1) {
          phases.push(sequential(rep, {
            step: "interleaved",
            shape: "other_agent_head",
            messages: withNonce([
              { role: "system", content: `Another agent's instructions. ${fillerText(E8_INTERLEAVED_HEAD_TOKENS)}` },
              { role: "user", content: "." },
            ], nonce(ctx, "E8", rep, `interleaved-${i}`)),
            tools: [],
            maxTokens: HEAD_PROBE_MAX_TOKENS,
            tags: { arm, multiplier, i },
          }));
        }
        phases.push(sequential(rep, call("new_conversation_interleaved", [{ role: "user", content: e8Tail(nextTail()) }])));
      } else {
        // (c) One unrelated call — its start is when the server saves and clears the idle slots —
        // then a NEW conversation on the same head with a different task.
        phases.push(unrelated(rep, arm, { arm, multiplier }));
        phases.push(sequential(rep, call("new_conversation", [{ role: "user", content: e8Tail(nextTail()) }])));
      }
    }
    // (f) One finished prewarm, then E8_CONCURRENT new conversations at once.
    const f = nonce(ctx, "E8", rep, "concurrent");
    phases.push(sequential(rep, nonceHeadRequest([head.system], head.tools, "staged_builder_head", "prewarm", f, [{ role: "user", content: "." }], { arm: "concurrent" })));
    phases.push({
      rep,
      calls: Array.from({ length: E8_CONCURRENT }, (_, i) => ({
        request: nonceHeadRequest([head.system], head.tools, "staged_builder_head", "concurrent_new", f, [{ role: "user", content: e8Tail(nextTail()) }], { arm: "concurrent", slot: i }),
        startAfterMs: 0,
      })),
    });
  }
  return phases;
}

/** E9's arms, interleaved within every repetition. */
export const E9_ARMS = ["control", "treatment", "literal", "eviction"] as const;

function planE9(ctx: PlanContext): ProbePhase[] {
  const heads = ctx.forcedHeads;
  if (!heads) throw new Error("E9 needs the warm-keeper's forced heads (PlanContext.forcedHeads)");
  const phases: ProbePhase[] = [];
  const nextUser = counter(CASE_OFFSETS.E9);
  const history = syntheticHistory();
  for (let rep = 0; rep < ctx.reps; rep += 1) {
    for (const arm of E9_ARMS) {
      const n = nonce(ctx, "E9", rep, arm);
      const warm = (head: { system: readonly string[]; tools: readonly LLMToolDef[] }, shape: string, step: string) =>
        sequential(rep, nonceHeadRequest(head.system, head.tools, shape, `${arm}_${step}`, n, [{ role: "user", content: "." }], { arm }));
      // A live forced call as the turn sends it: the head, the date line after it, a history, the user.
      const live = (head: MultiSystemHead, shape: string, step: string) =>
        sequential(rep, nonceHeadRequest([...head.system, heads.temporal], head.tools, shape, `${arm}_${step}`, n, [
          ...history,
          { role: "user", content: headUserMessage(nextUser()) },
        ], { arm, toolCount: head.tools.length }));
      phases.push(warm(heads.full, "orchestrator_head", "warm_full"));
      if (arm === "treatment" || arm === "eviction") {
        phases.push(warm(heads.plan, "forced_plan_head", "warm_plan"));
        phases.push(warm(heads.dispatch, "forced_dispatch_head", "warm_dispatch"));
      } else if (arm === "literal") {
        // The two heads the plan's corrections ruled out: the no-plan-argument subset on the lean
        // base, and the full block on lean base + module.
        phases.push(warm({ system: heads.full.system, tools: heads.literalSubsetTools }, "forced_dispatch_head", "warm_literal_subset"));
        phases.push(warm({ system: heads.plan.system, tools: heads.full.tools }, "orchestrator_head", "warm_full_module"));
      }
      if (arm === "eviction") {
        for (let i = 0; i < E9_EVICTION_PROMPTS; i += 1) {
          const e = nonce(ctx, "E9", rep, `evict-${i}`);
          phases.push(sequential(rep, {
            step: `${arm}_evict`,
            shape: "eviction_prompt",
            messages: withNonce([{ role: "system", content: "Eviction probe: a prompt the size of a long content_writer loop call." }, { role: "user", content: fillerText(E9_EVICTION_TOKENS) }], e),
            tools: [],
            maxTokens: HEAD_PROBE_MAX_TOKENS,
            tags: { arm, i },
          }));
        }
      }
      phases.push(live(heads.plan, "forced_plan_head", "live_a"));
      if (arm !== "eviction") phases.push(live(heads.dispatch, "forced_dispatch_head", "live_b"));
      if (arm === "treatment") {
        // The full head still cached next to the forced ones, then what keeping them warm costs
        // after a turn: the warm-keeper's re-warm of each forced head.
        phases.push(live(heads.full, "orchestrator_head", "full_after"));
        phases.push(warm(heads.plan, "forced_plan_head", "rewarm_plan"));
        phases.push(warm(heads.dispatch, "forced_dispatch_head", "rewarm_dispatch"));
      }
    }
  }
  return phases;
}

export function buildExperimentPlan(id: ExperimentId, ctx: PlanContext): ExperimentPlan {
  const builders: Record<ExperimentId, (c: PlanContext) => ProbePhase[]> = {
    E1: planE1, E2: planE2, E3: planE3, E4: planE4, E5: planE5, E6: planE6, E7: planE7, E8: planE8, E9: planE9,
  };
  return { id, question: EXPERIMENT_QUESTIONS[id], phases: builders[id](ctx) };
}

// ── Running ────────────────────────────────────────────────────────────────────────────────────

/** llama-server's own account of one request, from its `timings` object. */
export interface LlamaTimings {
  /** Prompt tokens processed by this request. */
  promptN: number;
  /** Prompt tokens reused from the cache; absent when neither timings nor usage tell. */
  cacheN?: number;
  /** True when cacheN was derived as usage.prompt_tokens - prompt_n (an older build without cache_n). */
  cacheNDerived: boolean;
  promptMs: number;
  predictedN: number;
  predictedMs: number;
}

export interface CallOutcome {
  status: "ok" | "aborted" | "error";
  /** From before the request was sent to the last byte of the answer (or to the abort). */
  wallMs: number;
  httpStatus?: number;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  timings?: LlamaTimings;
  /** Whatever the answer says about the server that produced it: model, build fingerprint, x-* headers. */
  station?: string;
}

export interface CallResult extends Omit<CallOutcome, "status"> {
  /** An experiment id, or "setup" for the production-head calls around the run. */
  experiment: string;
  rep: number;
  phase: number;
  step: string;
  shape: string;
  language?: ProbeLanguage;
  /** How many calls its phase started together. */
  inFlight: number;
  /** When the call was sent, relative to the start of the run. */
  startedAtMs: number;
  /** wall - prompt processing - generation: transport, llama-swap, waiting for a slot, templating. */
  queueMs?: number;
  tags?: Record<string, number | string>;
  status: CallOutcome["status"] | "skipped";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseLlamaTimings(body: unknown): LlamaTimings | undefined {
  if (!body || typeof body !== "object") return undefined;
  const timings = (body as { timings?: Record<string, unknown> }).timings;
  if (!timings || typeof timings !== "object") return undefined;
  const promptN = finiteNumber(timings["prompt_n"]);
  const promptMs = finiteNumber(timings["prompt_ms"]);
  const predictedN = finiteNumber(timings["predicted_n"]);
  const predictedMs = finiteNumber(timings["predicted_ms"]);
  if (promptN === undefined || promptMs === undefined || predictedN === undefined || predictedMs === undefined) return undefined;
  const reported = finiteNumber(timings["cache_n"]);
  const usageTotal = finiteNumber((body as { usage?: Record<string, unknown> }).usage?.["prompt_tokens"]);
  const derived = reported === undefined && usageTotal !== undefined && usageTotal >= promptN ? usageTotal - promptN : undefined;
  const cacheN = reported ?? derived;
  return {
    promptN,
    ...(cacheN !== undefined ? { cacheN } : {}),
    cacheNDerived: reported === undefined && derived !== undefined,
    promptMs,
    predictedN,
    predictedMs,
  };
}

/** Header names whose values never go into a report, whatever their prefix. */
const SECRET_HEADER_RE = /key|token|auth|cookie|secret/i;
/**
 * Header names whose values change with every request (ids, timings, dates). They say nothing about
 * which server answered, and in the station string they would make every call a server of its own,
 * so every cache comparison would be reported as crossing servers.
 */
const PER_REQUEST_HEADER_RE = /request|trace|span|correlation|date|time|duration|elapsed|latency|(^|-)id$/i;

/** What the answer reveals about the server behind llama-swap: model path or alias, build, x-* headers. */
export function stationOf(body: unknown, headers?: { forEach(callback: (value: string, key: string) => void): void }): string | undefined {
  const parts: string[] = [];
  if (body && typeof body === "object") {
    const model = (body as { model?: unknown }).model;
    const fingerprint = (body as { system_fingerprint?: unknown }).system_fingerprint;
    if (typeof model === "string" && model) parts.push(`model=${model}`);
    if (typeof fingerprint === "string" && fingerprint) parts.push(`build=${fingerprint}`);
  }
  headers?.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name.startsWith("x-") && !SECRET_HEADER_RE.test(name) && !PER_REQUEST_HEADER_RE.test(name)) parts.push(`${name}=${value.slice(0, 80)}`);
  });
  return parts.length > 0 ? parts.sort().join(" ") : undefined;
}

export interface ProbeTransport {
  chatUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  now: () => number;
  callTimeoutMs: number;
}

/**
 * Send one request and time it. The clock starts before the request is sent and stops after the
 * whole answer arrived, so queueing and the llama-swap hop are inside it; the provider's stream
 * clock, which starts after the response headers, leaves them out.
 */
export async function runProbeCall(body: Record<string, unknown>, request: ProbeRequest, transport: ProbeTransport): Promise<CallOutcome> {
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  let abortedByPlan = false;
  const timeout = setTimeout(() => controller.abort(new Error(`no answer within ${transport.callTimeoutMs} ms`)), transport.callTimeoutMs);
  const planned = request.abortAfterMs !== undefined
    ? setTimeout(() => { abortedByPlan = true; controller.abort(); }, request.abortAfterMs)
    : undefined;
  const started = transport.now();
  try {
    const response = await transport.fetchImpl(transport.chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...transport.headers },
      body: payload,
      signal: controller.signal,
    });
    const text = await response.text();
    const wallMs = transport.now() - started;
    if (!response.ok) return { status: "error", wallMs, httpStatus: response.status, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "error", wallMs, httpStatus: response.status, error: "the answer is not JSON" };
    }
    const usage = (json as { usage?: Record<string, unknown> }).usage;
    const promptTokens = finiteNumber(usage?.["prompt_tokens"]);
    const completionTokens = finiteNumber(usage?.["completion_tokens"]);
    const timings = parseLlamaTimings(json);
    const station = stationOf(json, response.headers);
    return {
      status: "ok",
      wallMs,
      httpStatus: response.status,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(timings ? { timings } : {}),
      ...(station ? { station } : {}),
    };
  } catch (err) {
    const wallMs = transport.now() - started;
    if (abortedByPlan) return { status: "aborted", wallMs };
    return { status: "error", wallMs, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
    if (planned) clearTimeout(planned);
  }
}

export function queueMsOf(outcome: Pick<CallOutcome, "wallMs" | "timings">): number | undefined {
  return outcome.timings ? outcome.wallMs - outcome.timings.promptMs - outcome.timings.predictedMs : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the plans in order, one phase at a time; the calls of a phase start together (after their
 * own offsets). A phase that would start past the deadline is recorded as skipped, not sent.
 */
export async function runPlans(
  plans: readonly ExperimentPlan[],
  execute: (request: ProbeRequest) => Promise<CallOutcome>,
  options: { now: () => number; runStartedAt: number; deadlineAt?: number; onPhase?: (results: CallResult[]) => void | Promise<void> },
): Promise<CallResult[]> {
  const all: CallResult[] = [];
  for (const plan of plans) {
    for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex += 1) {
      const phase = plan.phases[phaseIndex]!;
      const base = (call: PlannedCall) => ({
        experiment: plan.id,
        rep: phase.rep,
        phase: phaseIndex,
        step: call.request.step,
        shape: call.request.shape,
        ...(call.request.language ? { language: call.request.language } : {}),
        inFlight: phase.calls.length,
        ...(call.request.tags ? { tags: call.request.tags } : {}),
      });
      let results: CallResult[];
      if (options.deadlineAt !== undefined && options.now() >= options.deadlineAt) {
        results = phase.calls.map((call) => ({ ...base(call), status: "skipped", wallMs: 0, startedAtMs: options.now() - options.runStartedAt, error: "time budget spent" }));
      } else {
        results = await Promise.all(phase.calls.map(async (call): Promise<CallResult> => {
          if (call.startAfterMs > 0) await sleep(call.startAfterMs);
          const startedAtMs = options.now() - options.runStartedAt;
          const outcome = await execute(call.request);
          const queueMs = queueMsOf(outcome);
          return { ...base(call), ...outcome, startedAtMs, ...(queueMs !== undefined ? { queueMs } : {}) };
        }));
      }
      all.push(...results);
      await options.onPhase?.(results);
    }
  }
  return all;
}

// ── Math ───────────────────────────────────────────────────────────────────────────────────────

export interface Summary {
  n: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

/** Median (mean of the middle two for an even count) and nearest-rank p90; null for no values. */
export function summarize(values: readonly number[]): Summary | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return { n, median, p90: sorted[Math.max(0, Math.ceil(0.9 * n) - 1)]!, min: sorted[0]!, max: sorted[n - 1]! };
}

export function median(values: readonly number[]): number | null {
  return summarize(values)?.median ?? null;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

/** Least squares y = intercept + slope * x; null for fewer than two points or no spread in x. */
export function fitLinear(points: ReadonlyArray<readonly [number, number]>): LinearFit | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((s, [x]) => s + x, 0) / n;
  const meanY = points.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
    syy += (y - meanY) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

export function isScored(r: CallResult): boolean {
  return r.status === "ok" && r.timings !== undefined;
}

/** The whole prompt: what usage reports, else processed plus reused. */
export function totalPromptTokens(r: Pick<CallOutcome, "promptTokens" | "timings">): number | undefined {
  if (r.promptTokens !== undefined) return r.promptTokens;
  const t = r.timings;
  return t && t.cacheN !== undefined ? t.promptN + t.cacheN : undefined;
}

/** Share of the prompt the call reused from the cache. */
export function cacheShare(r: Pick<CallOutcome, "promptTokens" | "timings">): number | undefined {
  const total = totalPromptTokens(r);
  const cacheN = r.timings?.cacheN;
  return total && cacheN !== undefined ? cacheN / total : undefined;
}

export interface ColdPrefillFit {
  msPerToken: number;
  tokensPerSecond: number;
  interceptMs: number;
  r2: number;
  n: number;
}

/**
 * Cold prompt processing as a line: prompt_ms against prompt_n over calls that reused nothing. The
 * slope is the per-token cost; the intercept is what prompt_ms charges regardless of length.
 */
export function fitColdPrefill(results: readonly CallResult[], minPromptN = 256): ColdPrefillFit | null {
  const points = results
    .filter((r) => isScored(r) && r.timings!.cacheN !== undefined && r.timings!.cacheN <= COLD_CACHE_TOKENS && r.timings!.promptN >= minPromptN)
    .map((r) => [r.timings!.promptN, r.timings!.promptMs] as const);
  const fit = fitLinear(points);
  if (!fit || fit.slope <= 0) return null;
  return { msPerToken: fit.slope, tokensPerSecond: 1000 / fit.slope, interceptMs: fit.intercept, r2: fit.r2, n: fit.n };
}

/** Is `delta` larger than noise, measured against `baseline`? */
export function isMaterial(delta: number, baseline: number): boolean {
  return Math.abs(delta) >= Math.max(MATERIAL_MS, MATERIAL_SHARE * Math.abs(baseline));
}

// ── Verdicts ───────────────────────────────────────────────────────────────────────────────────

export interface StepSummary {
  key: string;
  calls: number;
  scored: number;
  wallMs: Summary | null;
  promptN: Summary | null;
  cacheN: Summary | null;
  promptMs: Summary | null;
  predictedMs: Summary | null;
  queueMs: Summary | null;
}

export interface ExperimentVerdict {
  experiment: ExperimentId;
  question: string;
  /** A short machine-readable answer, e.g. "checkpoint_spacing" or "head_evicted_at_k4". */
  code: string;
  conclusive: boolean;
  /** The answer in one or two plain sentences. */
  answer: string;
  numbers: Record<string, number | null>;
  notes: string[];
  /** Per-row detail where one experiment answers per shape (E1). */
  rows?: Array<Record<string, string | number | null>>;
}

export interface VerdictContext {
  /** What one Laya decision takes, to net out of E1's saving. */
  layaMs: number;
  /** A whole turn's wall time, to state E1's saving as a share of it; optional. */
  turnMs?: number;
}

const round = (value: number | null | undefined, digits = 0): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function ofExperiment(results: readonly CallResult[], experiment: ExperimentId): CallResult[] {
  return results.filter((r) => r.experiment === experiment);
}

function scoredStep(results: readonly CallResult[], step: string, shape?: string): CallResult[] {
  return results.filter((r) => r.step === step && (shape === undefined || r.shape === shape) && isScored(r));
}

/** The first scored result of a step per repetition. */
function perRep(results: readonly CallResult[], step: string): Map<number, CallResult> {
  const map = new Map<number, CallResult>();
  for (const r of results) if (r.step === step && isScored(r) && !map.has(r.rep)) map.set(r.rep, r);
  return map;
}

/** a - b per repetition where both were measured. */
function pairedDeltas(results: readonly CallResult[], stepA: string, stepB: string, pick: (r: CallResult) => number | undefined = (r) => r.wallMs): number[] {
  const a = perRep(results, stepA);
  const b = perRep(results, stepB);
  const out: number[] = [];
  for (const [rep, ra] of a) {
    const rb = b.get(rep);
    const va = pick(ra);
    const vb = rb ? pick(rb) : undefined;
    if (va !== undefined && vb !== undefined) out.push(va - vb);
  }
  return out;
}

function medianOf(results: readonly CallResult[], pick: (r: CallResult) => number | undefined): number | null {
  return median(results.map(pick).filter((v): v is number => v !== undefined));
}

/** Per-step summaries of one experiment, keyed by step (and by shape where one step spans several). */
export function summarizeSteps(results: readonly CallResult[]): StepSummary[] {
  const shapesPerStep = new Map<string, Set<string>>();
  for (const r of results) {
    const set = shapesPerStep.get(r.step) ?? new Set<string>();
    set.add(r.shape);
    shapesPerStep.set(r.step, set);
  }
  const groups = new Map<string, CallResult[]>();
  for (const r of results) {
    const key = (shapesPerStep.get(r.step)?.size ?? 0) > 1 ? `${r.step} · ${r.shape}` : r.step;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const scored = list.filter(isScored);
    const values = (pick: (r: CallResult) => number | undefined) => summarize(scored.map(pick).filter((v): v is number => v !== undefined));
    return {
      key,
      calls: list.length,
      scored: scored.length,
      wallMs: values((r) => r.wallMs),
      promptN: values((r) => r.timings?.promptN),
      cacheN: values((r) => r.timings?.cacheN),
      promptMs: values((r) => r.timings?.promptMs),
      predictedMs: values((r) => r.timings?.predictedMs),
      queueMs: values((r) => r.queueMs),
    };
  });
}

/** Distinct stations among the scored calls. Cache comparisons across two stations mean nothing. */
function stationsOf(results: readonly CallResult[]): string[] {
  return [...new Set(results.filter(isScored).map((r) => r.station ?? "unknown"))].sort();
}

function stationNote(results: readonly CallResult[]): string | null {
  const stations = stationsOf(results);
  return stations.length > 1
    ? `Calls were answered by ${stations.length} different servers (${stations.join(" | ")}); a cache comparison across servers is not valid.`
    : null;
}

function inconclusive(experiment: ExperimentId, answer: string, notes: string[] = [], numbers: Record<string, number | null> = {}): ExperimentVerdict {
  return { experiment, question: EXPERIMENT_QUESTIONS[experiment], code: "inconclusive", conclusive: false, answer, numbers, notes };
}

function verdictE1(all: readonly CallResult[], ctx: VerdictContext): ExperimentVerdict {
  const results = ofExperiment(all, "E1");
  const rows: Array<Record<string, string | number | null>> = [];
  const missing: string[] = [];
  for (const shape of DECISION_SHAPES) {
    const warm = scoredStep(results, "warm", shape);
    if (warm.length < MIN_PAIRS) {
      missing.push(shape);
      continue;
    }
    const wall = medianOf(warm, (r) => r.wallMs)!;
    const promptMs = medianOf(warm, (r) => r.timings?.promptMs);
    const byLanguage = (language: ProbeLanguage) => medianOf(warm.filter((r) => r.language === language), (r) => r.wallMs);
    const cold = medianOf(scoredStep(results, "cold", shape), (r) => r.wallMs);
    const repeat = medianOf(scoredStep(results, "repeat", shape), (r) => r.wallMs);
    const prefillShare = promptMs !== null && wall > 0 ? promptMs / wall : null;
    const saving = wall - ctx.layaMs;
    const placement = DECISION_PLACEMENT[shape];
    rows.push({
      shape,
      awaited: placement.awaited ? "yes" : "no",
      layaPoint: placement.layaPoint ? "yes" : "no",
      warmWallMs: round(wall),
      warmWallDeMs: round(byLanguage("de")),
      warmWallEnMs: round(byLanguage("en")),
      promptTokens: round(medianOf(warm, (r) => totalPromptTokens(r))),
      promptN: round(medianOf(warm, (r) => r.timings?.promptN)),
      promptMs: round(promptMs),
      predictedN: round(medianOf(warm, (r) => r.timings?.predictedN)),
      predictedMs: round(medianOf(warm, (r) => r.timings?.predictedMs)),
      queueMs: round(medianOf(warm, (r) => r.queueMs)),
      coldWallMs: round(cold),
      repeatWallMs: round(repeat),
      prefillShare: round(prefillShare, 3),
      kind: prefillShare === null ? null : prefillShare < FLOOR_DOMINATED_SHARE ? "floor_dominated" : "prefill_dominated",
      savingPerCallMs: round(saving),
      // A share of the turn only where the turn waits for the call; elsewhere it would count
      // model-server time as the user's.
      ...(ctx.turnMs ? { savingShareOfTurn: placement.awaited ? round(saving / ctx.turnMs, 4) : null } : {}),
    });
  }
  if (rows.length === 0) return inconclusive("E1", "No decision call was measured twice warm.", missing.length ? [`Not measured: ${missing.join(", ")}.`] : []);
  // The headline is what Laya takes off the user's wait: its own points, and only those the turn waits for.
  const counted = rows.filter((row) => row["awaited"] === "yes" && row["layaPoint"] === "yes");
  const left = rows.filter((row) => !counted.includes(row));
  const floorDominated = rows.filter((row) => row["kind"] === "floor_dominated").length;
  const notes = [
    ...(missing.length ? [`Too few warm measurements for: ${missing.join(", ")}.`] : []),
    ...left.map((row) => row["layaPoint"] === "no"
      ? `${String(row["shape"])} is no Laya decision point: its row prices a categorisation there and is left out of the summary.`
      : `${String(row["shape"])} runs beside the work, not in the turn's wait: skipping it frees the model server, and it is left out of the summary.`),
    ...[stationNote(results)].filter((n): n is string => n !== null),
  ];
  const s = summarize(counted.map((row) => row["savingPerCallMs"] as number));
  if (!s) return { ...inconclusive("E1", "No Laya decision the turn waits for was measured twice warm.", notes), rows };
  const turnPart = ctx.turnMs ? ` (${round((s.median / ctx.turnMs) * 100, 1)}% of a ${round(ctx.turnMs)} ms turn)` : "";
  return {
    experiment: "E1",
    question: EXPERIMENT_QUESTIONS.E1,
    code: "measured",
    conclusive: missing.length === 0,
    answer: `Answering a decision the turn waits for without its LLM call saves ${round(s.min)}-${round(s.max)} ms per call (median ${round(s.median)} ms${turnPart}, net of ${ctx.layaMs} ms for Laya; ${counted.length} decision points). `
      + `${floorDominated} of ${rows.length} calls are floor-dominated: prompt processing is under half their time, so a shorter prompt would not make them much faster; skipping them would.`,
    numbers: {
      savingMedianMs: round(s.median),
      savingMinMs: round(s.min),
      savingMaxMs: round(s.max),
      floorDominatedShapes: floorDominated,
      shapesMeasured: rows.length,
      shapesCounted: counted.length,
    },
    notes,
    rows,
  };
}

function verdictE2(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E2");
  const chain = ["cold", ...APPEND_STEPS.map((n) => `append_${n}`)];
  const overheads: number[] = [];
  for (let i = 1; i < chain.length; i += 1) {
    const prev = perRep(results, chain[i - 1]!);
    for (const [rep, cur] of perRep(results, chain[i]!)) {
      const before = prev.get(rep);
      const totalBefore = before ? totalPromptTokens(before) : undefined;
      const totalNow = totalPromptTokens(cur);
      if (totalBefore === undefined || totalNow === undefined) continue;
      overheads.push(cur.timings!.promptN - (totalNow - totalBefore));
    }
  }
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const floorCalls = scoredStep(results, "append_1");
  if (overheads.length < MIN_PAIRS || floorCalls.length < MIN_PAIRS) {
    return inconclusive("E2", "Too few consecutive appends were measured to tell how far reuse reaches.", notes);
  }
  const overhead = median(overheads)!;
  const floorWall = medianOf(floorCalls, (r) => r.wallMs)!;
  const floorPromptMs = medianOf(floorCalls, (r) => r.timings?.promptMs);
  const floorQueueMs = medianOf(floorCalls, (r) => r.queueMs);
  const floorPromptN = medianOf(floorCalls, (r) => r.timings?.promptN);
  const exact = overhead <= EXACT_REUSE_TOKENS;

  const cold = perRep(results, "cold");
  const historyTokens: number[] = [];
  const historyNext: number[] = [];
  for (const [rep, first] of perRep(results, "history_first")) {
    const base = cold.get(rep);
    const next = perRep(results, "history_next_user").get(rep);
    const firstTotal = totalPromptTokens(first);
    const baseTotal = base ? totalPromptTokens(base) : undefined;
    if (!next || firstTotal === undefined || baseTotal === undefined) continue;
    historyTokens.push(firstTotal - baseTotal);
    historyNext.push(next.timings!.promptN);
  }
  const historyReused = historyTokens.length >= MIN_PAIRS ? median(historyNext)! < 0.5 * median(historyTokens)! : null;

  const midShares = scoredStep(results, "mid_system_change").map((r) => cacheShare(r)).filter((v): v is number => v !== undefined);
  const midShare = median(midShares);

  const reach = exact
    ? `Appending reuses everything before the new text (median overhead ${round(overhead)} tokens beyond the new ones), so the ${round(floorWall)} ms of a one-token append is fixed per-call cost: queue ${round(floorQueueMs)} ms, prompt ${round(floorPromptMs)} ms.`
    : `Appending re-processes a median ${round(overhead)} tokens beyond the new ones: reuse resumes at a checkpoint that far back, so every warm call pays about that many tokens (${round(floorPromptMs)} ms of its ${round(floorWall)} ms) whatever changed.`;
  const historyPart = historyReused === null
    ? " Whether a byte-identical history is reused could not be measured."
    : historyReused
      ? " A byte-identical history is reused when only the last user message changes."
      : " A history is re-processed even when only the last user message after it changes.";
  const midPart = midShare === null ? "" : ` A change in the middle of the system text kept ${round(midShare * 100)}% of the prompt cached.`;
  return {
    experiment: "E2",
    question: EXPERIMENT_QUESTIONS.E2,
    code: exact ? "fixed_overhead" : "checkpoint_spacing",
    conclusive: notes.length === 0,
    answer: reach + historyPart + midPart,
    numbers: {
      overheadTokensMedian: round(overhead),
      floorWallMs: round(floorWall),
      floorPromptMs: round(floorPromptMs),
      floorQueueMs: round(floorQueueMs),
      floorPromptN: round(floorPromptN),
      historyTokensMedian: round(median(historyTokens)),
      historyNextPromptNMedian: round(median(historyNext)),
      historyReused: historyReused === null ? null : historyReused ? 1 : 0,
      midSystemChangeCacheShare: round(midShare, 3),
    },
    notes,
  };
}

function verdictE3(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E3");
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const numbers: Record<string, number | null> = {};
  let firstEvicted: number | null = null;
  let slower: number | null = null;
  let measuredKs = 0;
  let lostWithoutCalls = false;
  const baseline = medianOf(scoredStep(results, "head_after_k0"), (r) => r.wallMs);
  for (const k of INTERFERENCE_KS) {
    const calls = scoredStep(results, `head_after_k${k}`);
    const shares = calls.map((r) => cacheShare(r)).filter((v): v is number => v !== undefined);
    if (shares.length < MIN_PAIRS) continue;
    measuredKs += 1;
    const evicted = shares.filter((share) => share < EVICTED_SHARE).length;
    numbers[`k${k}CacheShareMedian`] = round(median(shares), 3);
    numbers[`k${k}WallMedianMs`] = round(medianOf(calls, (r) => r.wallMs));
    numbers[`k${k}EvictedReps`] = evicted;
    if (k === 0 && evicted * 2 > shares.length) lostWithoutCalls = true;
    if (k > 0 && firstEvicted === null && evicted * 2 > shares.length) firstEvicted = k;
    if (k > 0) {
      const deltas = pairedDeltas(results, `head_after_k${k}`, "head_after_k0");
      const d = median(deltas);
      numbers[`k${k}ExtraWallMs`] = round(d);
      if (slower === null && d !== null && baseline !== null && deltas.length >= MIN_PAIRS && d > 0 && isMaterial(d, baseline)) slower = k;
    }
  }
  if (measuredKs < INTERFERENCE_KS.length) {
    return inconclusive("E3", "Not every K was measured often enough to compare the head against K = 0.", notes, numbers);
  }
  // A head that is re-processed with nothing between its calls says nothing about small calls:
  // any K would look like an eviction.
  if (lostWithoutCalls) {
    return {
      experiment: "E3", question: EXPERIMENT_QUESTIONS.E3, code: "head_not_reused", conclusive: false,
      answer: "The orchestrator head was re-processed even with no call between two of its calls, so what the small calls do to it cannot be told apart (see E2 for how far reuse reaches).",
      numbers, notes,
    };
  }
  if (firstEvicted !== null) {
    return {
      experiment: "E3", question: EXPERIMENT_QUESTIONS.E3, code: `head_evicted_at_k${firstEvicted}`, conclusive: notes.length === 0,
      answer: `The orchestrator head lost its cache once ${firstEvicted} small call(s) ran between two of its calls: each small call before a turn can cost the full head prefill.`,
      numbers, notes,
    };
  }
  if (slower !== null) {
    return {
      experiment: "E3", question: EXPERIMENT_QUESTIONS.E3, code: "head_kept_but_slower", conclusive: notes.length === 0,
      answer: `The head stayed cached, but its next call was slower once ${slower} small call(s) ran between (restored from host memory or a busier slot).`,
      numbers, notes,
    };
  }
  return {
    experiment: "E3", question: EXPERIMENT_QUESTIONS.E3, code: "head_survives", conclusive: notes.length === 0,
    answer: `The head kept its cache and its speed with up to ${INTERFERENCE_KS[INTERFERENCE_KS.length - 1]} small calls between: the small calls cost only their own time.`,
    numbers, notes,
  };
}

function verdictE4(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E4");
  const notes: string[] = [];
  const stations = stationsOf(results.filter((r) => r.step === "c4"));
  if (stations.length > 1) notes.push(`With 4 in flight the calls were answered by ${stations.length} servers (${stations.join(" | ")}).`);
  // Per repetition: the shapes one after the other (the sum of their single calls) against the same
  // shapes started together (the slowest of them, which is when the last answer is in).
  const savings = (shapes: readonly DecisionShape[], step: string) => {
    const out: Array<{ serial: number; batch: number }> = [];
    for (const rep of new Set(results.map((r) => r.rep))) {
      const serial = shapes.map((shape) => results.find((r) => r.rep === rep && r.step === "c1" && r.shape === shape && isScored(r))?.wallMs);
      const together = results.filter((r) => r.rep === rep && r.step === step && isScored(r));
      if (together.length !== shapes.length || serial.some((v) => v === undefined)) continue;
      out.push({ serial: serial.reduce<number>((sum, v) => sum + (v ?? 0), 0), batch: Math.max(...together.map((r) => r.wallMs)) });
    }
    return out;
  };
  const pair = savings(E4_PAIR, "c2");
  const quad = savings(E4_QUAD, "c4");
  if (pair.length < MIN_PAIRS) return inconclusive("E4", "Too few repetitions measured both the serial pair and the pair in parallel.", notes);
  const serialPair = median(pair.map((p) => p.serial))!;
  const savingPair = median(pair.map((p) => p.serial - p.batch))!;
  const savingQuad = quad.length >= MIN_PAIRS ? median(quad.map((p) => p.serial - p.batch)) : null;
  const serialQuad = quad.length >= MIN_PAIRS ? median(quad.map((p) => p.serial)) : null;
  const single = medianOf(results.filter((r) => r.step === "c1" && (E4_PAIR as readonly string[]).includes(r.shape) && isScored(r)), (r) => r.wallMs);
  const inPair = medianOf(results.filter((r) => r.step === "c2" && isScored(r)), (r) => r.wallMs);
  const inQuad = medianOf(results.filter((r) => r.step === "c4" && isScored(r)), (r) => r.wallMs);
  const queue1 = medianOf(results.filter((r) => r.step === "c1" && isScored(r)), (r) => r.queueMs);
  const queue2 = medianOf(results.filter((r) => r.step === "c2" && isScored(r)), (r) => r.queueMs);
  const code = !isMaterial(savingPair, serialPair) ? "parallel_no_gain" : savingPair > 0 ? "parallel_saves" : "parallel_hurts";
  const answer = code === "parallel_saves"
    ? `Running the receptionist and the judge together saves ${round(savingPair)} ms of their ${round(serialPair)} ms serial time; each call slows from ${round(single)} to ${round(inPair)} ms.`
    : code === "parallel_hurts"
      ? `Running the two together costs ${round(-savingPair)} ms more than one after the other (${round(serialPair)} ms serial).`
      : `Running the two together saves nothing material (${round(savingPair)} ms of ${round(serialPair)} ms): each call slows from ${round(single)} to ${round(inPair)} ms, so the server serialises them.`;
  return {
    experiment: "E4",
    question: EXPERIMENT_QUESTIONS.E4,
    code,
    conclusive: true,
    answer: answer + (savingQuad !== null ? ` Four at once save ${round(savingQuad)} ms of ${round(serialQuad)} ms.` : ""),
    numbers: {
      serialPairMs: round(serialPair),
      savingPairMs: round(savingPair),
      serialQuadMs: round(serialQuad),
      savingQuadMs: round(savingQuad),
      perCallWallC1Ms: round(single),
      perCallWallC2Ms: round(inPair),
      perCallWallC4Ms: round(inQuad),
      queueC1Ms: round(queue1),
      queueC2Ms: round(queue2),
      inflationC2: single && inPair ? round(inPair / single, 2) : null,
    },
    notes,
  };
}

function verdictE5(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E5");
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const stationsMixed = notes.length > 0;
  // Only a repetition whose incumbent really was aborted says anything about aborts.
  const abortedReps = new Set(results.filter((r) => r.step === "aborted_decision" && r.status === "aborted").map((r) => r.rep));
  const unaborted = results.filter((r) => r.step === "aborted_decision" && r.status === "ok").length;
  if (unaborted > 0) notes.push(`${unaborted} incumbent(s) answered before the abort fired; their repetitions are left out of the abort comparison.`);
  const aborted = results.filter((r) => abortedReps.has(r.rep));
  const abortCost = pairedDeltas(aborted, "head_after_abort", "head_after_nothing");
  const completedCost = pairedDeltas(results, "head_after_completed", "head_after_nothing");
  const processed = scoredStep(aborted, "aborted_resend").map((r) => cacheShare(r)).filter((v): v is number => v !== undefined);
  if (abortCost.length < MIN_PAIRS) return inconclusive("E5", "Too few repetitions measured the head both after nothing and after an aborted incumbent.", notes);
  const baseline = medianOf(scoredStep(results, "head_after_nothing"), (r) => r.wallMs) ?? 0;
  const cost = median(abortCost)!;
  const share = median(processed);
  const processing = share === null ? "unknown" : share >= 0.5 ? "processed" : share <= 0.1 ? "not_processed" : "partially_processed";
  const costly = cost > 0 && isMaterial(cost, baseline);
  const processingPart = processing === "unknown"
    ? "Whether the server still processed the aborted prompt could not be measured."
    : processing === "processed"
      ? `The server still processed the aborted prompt (a resend reused ${round(share! * 100)}% of it), so the abort saves waiting, not GPU time.`
      : processing === "not_processed"
        ? `The server dropped the aborted prompt (a resend reused ${round(share! * 100)}% of it).`
        : `The server processed part of the aborted prompt (a resend reused ${round(share! * 100)}% of it).`;
  return {
    experiment: "E5",
    question: EXPERIMENT_QUESTIONS.E5,
    code: `${costly ? "abort_costs" : "abort_free"}:${processing}`,
    conclusive: !stationsMixed,
    answer: `${costly ? `An aborted incumbent makes the next head call ${round(cost)} ms slower` : `An aborted incumbent costs the next head call nothing material (${round(cost)} ms)`}; a completed one costs it ${round(median(completedCost))} ms. ${processingPart}`,
    numbers: {
      abortCostMedianMs: round(cost),
      completedCostMedianMs: round(median(completedCost)),
      headAfterNothingMs: round(baseline),
      abortedResendCacheShare: round(share, 3),
    },
    notes,
  };
}

function verdictE6(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E6");
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const coldShares = scoredStep(results, "cold_first_call").map((r) => cacheShare(r)).filter((v): v is number => v !== undefined);
  const coldNotCold = coldShares.length > 0 && median(coldShares)! > EVICTED_SHARE;
  if (coldNotCold) notes.push("The cold first calls reused most of their prompt: the nonce did not make them cold, so the saving below is understated.");
  const sequentialSaving = pairedDeltas(results, "cold_first_call", "first_call_after_prewarm");
  const inFlightDelta = pairedDeltas(results, "first_call_concurrent", "cold_first_call");
  if (sequentialSaving.length < MIN_PAIRS || inFlightDelta.length < MIN_PAIRS) {
    return inconclusive("E6", "Too few repetitions measured the cold call, the call after a prewarm and the call beside one.", notes);
  }
  const cold = medianOf(scoredStep(results, "cold_first_call"), (r) => r.wallMs)!;
  const saving = median(sequentialSaving)!;
  const delta = median(inFlightDelta)!;
  const prewarm = medianOf(scoredStep(results, "prewarm"), (r) => r.wallMs);
  const inFlightShare = median(scoredStep(results, "first_call_concurrent").map((r) => cacheShare(r)).filter((v): v is number => v !== undefined));
  const helps = saving > 0 && isMaterial(saving, cold);
  const inFlight = !isMaterial(delta, cold) ? "neutral" : delta < 0 ? "helps" : "hurts";
  const code = !helps ? "no_gain" : inFlight === "helps" ? "helps_even_in_flight" : inFlight === "hurts" ? "in_flight_hurts" : "helps_only_when_finished";
  const inFlightPart = inFlight === "helps"
    ? `Still in flight it helps too: the real call took ${round(-delta)} ms less than cold.`
    : inFlight === "hurts"
      ? `Still in flight it hurts: the real call took ${round(delta)} ms longer than cold, both prefilling at once.`
      : `Still in flight it changes nothing material (${round(delta)} ms against cold): the two requests do not share the prefill.`;
  return {
    experiment: "E6",
    question: EXPERIMENT_QUESTIONS.E6,
    code,
    conclusive: !coldNotCold && notes.length === 0,
    answer: `${helps ? `A finished prewarm (${round(prewarm)} ms) saves the first call ${round(saving)} ms of its ${round(cold)} ms cold time.` : `A finished prewarm saves nothing material (${round(saving)} ms of ${round(cold)} ms).`} ${inFlightPart}`,
    numbers: {
      coldFirstCallMs: round(cold),
      prewarmMs: round(prewarm),
      sequentialSavingMs: round(saving),
      inFlightDeltaMs: round(delta),
      inFlightCacheShare: round(inFlightShare, 3),
    },
    notes,
  };
}

function verdictE7(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E7");
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const switchCost = pairedDeltas(results, "subset_after_full", "subset_warm");
  const switchBack = pairedDeltas(results, "full_after_subset", "full_warm");
  const switchAgain = pairedDeltas(results, "subset_after_full_again", "subset_warm");
  if (switchCost.length < MIN_PAIRS || switchBack.length < MIN_PAIRS) {
    return inconclusive("E7", "Too few repetitions measured both tool blocks warm and after a switch.", notes);
  }
  const subsetWarm = medianOf(scoredStep(results, "subset_warm"), (r) => r.wallMs)!;
  const fullWarm = medianOf(scoredStep(results, "full_warm"), (r) => r.wallMs)!;
  const cost = median(switchCost)!;
  const back = median(switchBack)!;
  const again = median(switchAgain);
  const reuse = median(scoredStep(results, "subset_after_full").map((r) => cacheShare(r)).filter((v): v is number => v !== undefined));
  const costly = (cost > 0 && isMaterial(cost, subsetWarm)) || (back > 0 && isMaterial(back, fullWarm));
  const againPart = again === null ? "" : isMaterial(again, subsetWarm)
    ? ` Every switch pays again (${round(again)} ms on the second one).`
    : ` After one round both blocks stay cached (${round(again)} ms on the second switch).`;
  return {
    experiment: "E7",
    question: EXPERIMENT_QUESTIONS.E7,
    code: costly ? "subset_switch_costly" : "subset_switch_cheap",
    conclusive: notes.length === 0,
    answer: `${costly
      ? `Switching to the forced subset costs ${round(cost)} ms and switching back ${round(back)} ms over the warm calls`
      : `Switching between the tool blocks costs nothing material (${round(cost)} ms to the subset, ${round(back)} ms back)`}; the first subset call reused ${reuse === null ? "an unknown share" : `${round(reuse * 100)}%`} of its prompt.${againPart}`,
    numbers: {
      switchToSubsetMs: round(cost),
      switchBackMs: round(back),
      secondSwitchMs: round(again),
      subsetWarmMs: round(subsetWarm),
      fullWarmMs: round(fullWarm),
      fullColdMs: round(medianOf(scoredStep(results, "full_cold"), (r) => r.wallMs)),
      subsetColdMs: round(medianOf(scoredStep(results, "subset_cold"), (r) => r.wallMs)),
      switchReuseShare: round(reuse, 3),
    },
    notes,
  };
}

/** E8's "warm": the head reused, only the tail processed, and processed in about the tail's time. */
export function isE8Warm(r: CallResult, headTokens: number, tailTokens: number): boolean {
  const t = r.timings;
  if (!t || t.cacheN === undefined) return false;
  return t.cacheN >= E8_WARM_HEAD_SHARE * headTokens
    && t.promptN <= tailTokens + E8_WARM_EXTRA_TOKENS
    && t.promptMs <= (tailTokens / E8_WARM_TAIL_TOKENS_PER_SEC) * 1_000 + E8_WARM_FLOOR_MS;
}

function tagOf(r: CallResult, key: string): number | string | undefined {
  return r.tags?.[key];
}

function verdictE8(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E8");
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const headTokens = median(scoredStep(results, "head_size").map((r) => totalPromptTokens(r)).filter((v): v is number => v !== undefined));
  if (headTokens === null) return inconclusive("E8", "The head's size was not measured (no head_size call answered with a token count).", notes);
  const tails = scoredStep(results, "grow_cold").map((r) => totalPromptTokens(r)).filter((v): v is number => v !== undefined).map((v) => v - headTokens);
  const tailTokens = median(tails);
  if (tailTokens === null || tailTokens <= 0) return inconclusive("E8", "The task tail's size could not be derived (no grow_cold call answered).", notes, { headTokens: round(headTokens) });

  const numbers: Record<string, number | null> = { headTokens: round(headTokens), tailTokens: round(tailTokens) };
  const warmAt = new Map<number, boolean>();
  let measuredLengths = 0;
  for (const multiplier of E8_RUN_MULTIPLIERS) {
    const calls = scoredStep(results, "new_conversation").filter((r) => tagOf(r, "multiplier") === multiplier);
    const warm = calls.filter((r) => isE8Warm(r, headTokens, tailTokens)).length;
    // The length the run actually reached: its last grow call (results are in time order) against
    // the measured head. The plan sized the runs with an estimate; this is what the rule saw.
    const lastGrow = new Map<number, CallResult>();
    for (const r of results) {
      if (isScored(r) && (r.step === "grow" || r.step === "grow_cold") && tagOf(r, "arm") === `L${multiplier}`) lastGrow.set(r.rep, r);
    }
    const reached = median([...lastGrow.values()].map((r) => (totalPromptTokens(r) ?? 0) / headTokens));
    const key = String(multiplier).replace(".", "_");
    // The runs were sized with an estimate; a run that ended on the wrong side of the rule's ~4x
    // boundary cannot test it, whatever its new conversation did.
    if (reached !== null && (multiplier < 4) !== (reached < 4)) {
      notes.push(`The ${multiplier}x run reached ${round(reached, 2)}x the measured head, on the other side of the 4x boundary it was meant to test.`);
    }
    numbers[`L${key}Calls`] = calls.length;
    numbers[`L${key}Warm`] = warm;
    numbers[`L${key}ReachedMultiple`] = round(reached, 2);
    numbers[`L${key}CacheNMedian`] = round(medianOf(calls, (r) => r.timings?.cacheN));
    numbers[`L${key}PromptMsMedian`] = round(medianOf(calls, (r) => r.timings?.promptMs));
    if (calls.length >= MIN_PAIRS) {
      measuredLengths += 1;
      warmAt.set(multiplier, warm * 2 > calls.length);
    }
  }
  if (measuredLengths < E8_RUN_MULTIPLIERS.length) {
    return inconclusive("E8", "Not every run length had its new conversation measured at least twice.", notes, numbers);
  }
  const [short, mid, long] = E8_RUN_MULTIPLIERS.map((m) => warmAt.get(m) === true);
  const code = short && mid && !long ? "load_rule_quarter_share"
    : short && mid && long ? "entries_survive"
      : !short && !mid && !long ? "no_reuse_across_conversations"
        : "mixed";

  // (e) the head-only rescue and whether one conversation used the entry up.
  const first = scoredStep(results, "consume_first");
  const second = scoredStep(results, "consume_second");
  const firstWarm = first.filter((r) => isE8Warm(r, headTokens, tailTokens)).length;
  const secondWarm = second.filter((r) => isE8Warm(r, headTokens, tailTokens)).length;
  numbers["consumeFirstWarm"] = firstWarm;
  numbers["consumeFirstCalls"] = first.length;
  numbers["consumeSecondWarm"] = secondWarm;
  numbers["consumeSecondCalls"] = second.length;

  // (d) the head after other agents' conversations in between: what the idle-slot switch is decided on.
  const interleaved = scoredStep(results, "new_conversation_interleaved");
  const interleavedWarm = interleaved.filter((r) => isE8Warm(r, headTokens, tailTokens)).length;
  numbers["interleavedWarm"] = interleavedWarm;
  numbers["interleavedCalls"] = interleaved.length;

  // (f) how many of the concurrent new conversations one prewarm served, per repetition.
  const perRep = new Map<number, number>();
  for (const r of scoredStep(results, "concurrent_new")) perRep.set(r.rep, (perRep.get(r.rep) ?? 0) + (isE8Warm(r, headTokens, tailTokens) ? 1 : 0));
  numbers["concurrentReps"] = perRep.size;
  numbers["concurrentWarmMedian"] = round(median([...perRep.values()]), 1);
  numbers["concurrentExactlyOneReps"] = [...perRep.values()].filter((w) => w === 1).length;

  const lengths = E8_RUN_MULTIPLIERS.map((m) => `${m}x ${warmAt.get(m) ? "warm" : "cold"}`).join(", ");
  const mechanism = code === "load_rule_quarter_share"
    ? "as the server's load rule predicts (an entry the new prompt shares under a quarter of is skipped), not checkpoint eviction"
    : code === "entries_survive"
      ? "every length warm: entries survive long runs (checkpoint eviction and the quarter rule both refuted; the idle-slot save may be off)"
      : code === "no_reuse_across_conversations"
        ? "no length warm: a new conversation did not find the head at all"
        : "a pattern neither rule predicts";
  const consumed = first.length === 0 ? ""
    : ` After a 6x run, a finished head-only request made the next new conversation warm in ${firstWarm} of ${first.length}, and the one after it in ${secondWarm} of ${second.length}${secondWarm === 0 && firstWarm > 0 ? " (the entry was used up)" : ""}.`;
  const concurrent = perRep.size === 0 ? "" : ` One prewarm served a median ${round(median([...perRep.values()]), 1)} of ${E8_CONCURRENT} concurrent new conversations (exactly one in ${numbers["concurrentExactlyOneReps"]} of ${perRep.size} repetitions).`;
  const between = interleaved.length === 0 ? ""
    : ` With ${E8_INTERLEAVED_HEADS} other agents' conversations in between, a 1.5x run's head was still warm in ${interleavedWarm} of ${interleaved.length}${interleavedWarm * 2 > interleaved.length ? "" : " (the other traffic pushed it out)"}.`;
  const reps = new Set(results.filter((r) => r.step === "new_conversation").map((r) => r.rep)).size;
  if (reps < E8_E9_MIN_REPS) notes.push(`${reps} repetition(s); the plan's criteria are stated over ${E8_E9_MIN_REPS}.`);
  return {
    experiment: "E8",
    question: EXPERIMENT_QUESTIONS.E8,
    code,
    conclusive: notes.length === 0,
    answer: `A new conversation on a ${round(headTokens)}-token head (tail ${round(tailTokens)}) was ${lengths} after a run of that length: ${mechanism}.${between}${consumed}${concurrent}`,
    numbers,
    notes,
  };
}

function verdictE9(all: readonly CallResult[]): ExperimentVerdict {
  const results = ofExperiment(all, "E9");
  const notes = [stationNote(results)].filter((n): n is string => n !== null);
  const at = (rep: number, step: string): CallResult | undefined => results.find((r) => r.rep === rep && r.step === step && isScored(r));
  const reps = [...new Set(results.map((r) => r.rep))].sort((a, b) => a - b);
  const numbers: Record<string, number | null> = {};

  let treatmentPass = 0;
  let controlCold = 0;
  let separated = 0;
  let rejectedReps = 0;
  let fullKept = 0;
  let measured = 0;
  for (const rep of reps) {
    const tA = at(rep, "treatment_live_a");
    const tB = at(rep, "treatment_live_b");
    const wA = at(rep, "treatment_warm_plan");
    const wB = at(rep, "treatment_warm_dispatch");
    const cA = at(rep, "control_live_a");
    const cB = at(rep, "control_live_b");
    if (!tA || !tB || !wA || !wB || !cA || !cB) continue;
    measured += 1;
    const warmHit = (live: CallResult, warmCall: CallResult): boolean => {
      const warmN = totalPromptTokens(warmCall);
      return warmN !== undefined && (live.timings!.cacheN ?? 0) >= warmN - E9_WARM_SLACK_TOKENS && live.timings!.promptMs <= E9_WARM_PROMPT_MS;
    };
    const cold = (live: CallResult): boolean => (live.timings!.cacheN ?? 0) <= E9_COLD_CACHE_TOKENS && live.timings!.promptMs >= E9_COLD_PROMPT_MS;
    if (warmHit(tA, wA) && warmHit(tB, wB)) treatmentPass += 1;
    if (cold(cA) && cold(cB)) controlCold += 1;
    if (Math.max(tA.timings!.promptMs, tB.timings!.promptMs) < Math.min(cA.timings!.promptMs, cB.timings!.promptMs)) separated += 1;
    if (Math.min(cacheShare(tA) ?? 0, cacheShare(tB) ?? 0) < E9_REJECT_SHARE) rejectedReps += 1;
    // Kept means the warmed full HEAD is still cached: its reused tokens against the head's own length, as the live
    // calls are judged against their warm call. Against the whole prompt the call's own new tail (its message and
    // nonce, ~1.6k tokens) counted as lost head: run 2026-09-26T11-06 kept 12,555 of a 13,071-token head (96%) in
    // every rep and read 88%.
    const fullAfter = at(rep, "treatment_full_after");
    const warmFullN = totalPromptTokens(at(rep, "treatment_warm_full") ?? {});
    if (fullAfter && warmFullN && (fullAfter.timings?.cacheN ?? 0) >= E9_FULL_KEPT_SHARE * warmFullN) fullKept += 1;
  }
  const med = (step: string, pick: (r: CallResult) => number | undefined) => round(medianOf(scoredStep(results, step), pick));
  const share = (step: string) => round(median(scoredStep(results, step).map((r) => cacheShare(r)).filter((v): v is number => v !== undefined)), 3);
  Object.assign(numbers, {
    repsMeasured: measured,
    treatmentPassReps: treatmentPass,
    controlColdReps: controlCold,
    separatedReps: separated,
    treatmentRejectedReps: rejectedReps,
    fullKeptReps: fullKept,
    treatmentLiveAPromptMs: med("treatment_live_a", (r) => r.timings?.promptMs),
    treatmentLiveBPromptMs: med("treatment_live_b", (r) => r.timings?.promptMs),
    treatmentLiveAShare: share("treatment_live_a"),
    treatmentLiveBShare: share("treatment_live_b"),
    controlLiveAPromptMs: med("control_live_a", (r) => r.timings?.promptMs),
    controlLiveBPromptMs: med("control_live_b", (r) => r.timings?.promptMs),
    literalLiveAShare: share("literal_live_a"),
    literalLiveBShare: share("literal_live_b"),
    literalLiveAPromptMs: med("literal_live_a", (r) => r.timings?.promptMs),
    literalLiveBPromptMs: med("literal_live_b", (r) => r.timings?.promptMs),
    evictionLiveAShare: share("eviction_live_a"),
    evictionLiveAPromptMs: med("eviction_live_a", (r) => r.timings?.promptMs),
    fullAfterShare: share("treatment_full_after"),
    // What keeping the forced heads warm costs: cold (a new nonce each repetition) and re-warm.
    warmPlanColdMs: med("treatment_warm_plan", (r) => r.timings?.promptMs),
    warmDispatchColdMs: med("treatment_warm_dispatch", (r) => r.timings?.promptMs),
    rewarmPlanMs: med("treatment_rewarm_plan", (r) => r.timings?.promptMs),
    rewarmDispatchMs: med("treatment_rewarm_dispatch", (r) => r.timings?.promptMs),
  });
  if (measured < E8_E9_MIN_REPS) {
    return inconclusive("E9", `${measured} repetition(s) measured both arms' live calls; the pass criteria need ${E8_E9_MIN_REPS} of ${E8_E9_MIN_REPS}.`, notes, numbers);
  }
  const rejected = rejectedReps >= 2;
  const passed = !rejected && treatmentPass === measured && controlCold === measured && separated === measured && fullKept === measured;
  const code = rejected ? "treatment_rejected" : passed ? "forced_heads_warm" : "criteria_not_met";
  const failed = [
    treatmentPass < measured ? `TREATMENT live calls warm in ${treatmentPass} of ${measured}` : null,
    controlCold < measured ? `CONTROL live calls cold in ${controlCold} of ${measured}` : null,
    separated < measured ? `the arms' prompt times separated in ${separated} of ${measured}` : null,
    fullKept < measured ? `the full head kept ≥${E9_FULL_KEPT_SHARE * 100}% cached in ${fullKept} of ${measured}` : null,
  ].filter((s): s is string => s !== null);
  return {
    experiment: "E9",
    question: EXPERIMENT_QUESTIONS.E9,
    code,
    conclusive: notes.length === 0,
    answer: rejected
      ? `REJECTED: with the forced heads warmed, a live forced call still reused under ${E9_REJECT_SHARE * 100}% of its prompt in ${rejectedReps} of ${measured} repetitions.`
      : passed
        ? `Warming the forced heads works: both live forced calls reused their head (${numbers["treatmentLiveAPromptMs"]} / ${numbers["treatmentLiveBPromptMs"]} ms of prompt) where the full head alone left them cold (${numbers["controlLiveAPromptMs"]} / ${numbers["controlLiveBPromptMs"]} ms), and the full head stayed cached. Keeping them warm costs ${numbers["warmPlanColdMs"]} + ${numbers["warmDispatchColdMs"]} ms cold and ${numbers["rewarmPlanMs"]} + ${numbers["rewarmDispatchMs"]} ms per re-warm.`
        : `The pass criteria were not all met: ${failed.join("; ")}.`,
    numbers,
    notes,
  };
}

export function computeVerdict(id: ExperimentId, results: readonly CallResult[], ctx: VerdictContext): ExperimentVerdict {
  switch (id) {
    case "E1": return verdictE1(results, ctx);
    case "E2": return verdictE2(results);
    case "E3": return verdictE3(results);
    case "E4": return verdictE4(results);
    case "E5": return verdictE5(results);
    case "E6": return verdictE6(results);
    case "E7": return verdictE7(results);
    case "E8": return verdictE8(results);
    case "E9": return verdictE9(results);
  }
}

// ── Server facts ───────────────────────────────────────────────────────────────────────────────

/** The llama-swap root for a base URL that ends in /v1. */
export function endpointOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const SERVER_FLAGS: Readonly<Record<string, string>> = {
  "-np": "parallel", "--parallel": "parallel",
  "-c": "ctxSize", "--ctx-size": "ctxSize",
  "-cram": "cacheRamMiB", "--cache-ram": "cacheRamMiB",
  "--ctx-checkpoints": "ctxCheckpoints", "--swa-checkpoints": "ctxCheckpoints",
  "-b": "batchSize", "--batch-size": "batchSize",
  "-ub": "ubatchSize", "--ubatch-size": "ubatchSize",
  "--cache-reuse": "cacheReuse",
  "-sps": "slotPromptSimilarity", "--slot-prompt-similarity": "slotPromptSimilarity",
  "-fa": "flashAttn", "--flash-attn": "flashAttn",
  "-m": "model", "--model": "model",
};
const SERVER_SWITCHES: Readonly<Record<string, string>> = {
  "--swa-full": "swaFull",
  "--no-cache-prompt": "noCachePrompt",
  "-kvu": "kvUnified", "--kv-unified": "kvUnified",
  "--cont-batching": "contBatching", "-cb": "contBatching",
  "--no-cont-batching": "noContBatching", "-nocb": "noContBatching",
  // E8 is run with and without it: the switch that decides whether idle slots are saved to the
  // host cache and cleared whenever a task starts (on by default with a unified KV cache).
  "--cache-idle-slots": "cacheIdleSlots",
  "--no-cache-idle-slots": "noCacheIdleSlots",
};

/**
 * The cache-relevant flags of a llama-server command line, from an allowlist, so an API key or a
 * path argument of any other flag never reaches the report. A model path keeps only its file name.
 */
export function extractServerFlags(cmd: string): Record<string, string | boolean> {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const valued = SERVER_FLAGS[flag];
    if (valued) {
      const value = eq > 0 ? token.slice(eq + 1) : tokens[i + 1];
      if (value !== undefined && !(eq < 0 && value.startsWith("-") && Number.isNaN(Number(value)))) {
        out[valued] = valued === "model" ? value.split(/[\\/]/).pop() ?? value : value;
        if (eq < 0) i += 1;
      }
      continue;
    }
    const switched = SERVER_SWITCHES[flag];
    if (switched) out[switched] = true;
  }
  return out;
}

export interface RunningModel {
  model: string;
  state?: string;
  flags?: Record<string, string | boolean>;
}

/** llama-swap's /running, reduced to model, state and the allowlisted flags of its command line. */
export function summarizeRunning(body: unknown): RunningModel[] {
  const list = (body as { running?: unknown })?.running;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): RunningModel[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    if (typeof e["model"] !== "string") return [];
    return [{
      model: e["model"],
      ...(typeof e["state"] === "string" ? { state: e["state"] } : {}),
      ...(typeof e["cmd"] === "string" ? { flags: extractServerFlags(e["cmd"]) } : {}),
    }];
  });
}

export interface PropsSummary {
  totalSlots?: number;
  nCtx?: number;
  modelFile?: string;
  buildInfo?: string;
}

export function summarizeProps(body: unknown): PropsSummary {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const settings = b["default_generation_settings"] as Record<string, unknown> | undefined;
  const totalSlots = finiteNumber(b["total_slots"]);
  const nCtx = finiteNumber(settings?.["n_ctx"]);
  return {
    ...(totalSlots !== undefined ? { totalSlots } : {}),
    ...(nCtx !== undefined ? { nCtx } : {}),
    ...(typeof b["model_path"] === "string" ? { modelFile: b["model_path"].split(/[\\/]/).pop() ?? b["model_path"] } : {}),
    ...(typeof b["build_info"] === "string" ? { buildInfo: b["build_info"] } : {}),
  };
}

/** /slots reduced to counts: a slot's prompt text may belong to a live user and is never kept. */
export function summarizeSlots(body: unknown): { count: number; processing: number; nCtx: number[] } | undefined {
  if (!Array.isArray(body)) return undefined;
  const slots = body.filter((s): s is Record<string, unknown> => !!s && typeof s === "object");
  return {
    count: slots.length,
    processing: slots.filter((s) => s["is_processing"] === true).length,
    nCtx: [...new Set(slots.map((s) => finiteNumber(s["n_ctx"])).filter((v): v is number => v !== undefined))],
  };
}

const RENDER_SYSTEM_MARKER = "RENDERPROBESYSTEMMARKER";
const RENDER_TOOL_MARKER = "renderprobe_tool_marker";

/** An /apply-template request whose rendered prompt shows where the tool block sits. */
export function renderOrderProbeBody(): Record<string, unknown> {
  return {
    messages: [{ role: "system", content: RENDER_SYSTEM_MARKER }, { role: "user", content: "." }],
    tools: [{ type: "function", function: { name: RENDER_TOOL_MARKER, description: "marker", parameters: { type: "object", properties: {} } } }],
  };
}

export type RenderOrder = "system_first" | "tools_first" | "tools_not_rendered" | "unknown";

/**
 * Where the chat template puts the tool block relative to the system text. It decides what a
 * change costs: with the system text first, a change there re-prefills the whole tool block too.
 */
export function detectRenderOrder(prompt: unknown): RenderOrder {
  if (typeof prompt !== "string") return "unknown";
  const system = prompt.indexOf(RENDER_SYSTEM_MARKER);
  const tool = prompt.indexOf(RENDER_TOOL_MARKER);
  if (system < 0) return "unknown";
  if (tool < 0) return "tools_not_rendered";
  return system < tool ? "system_first" : "tools_first";
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────

export interface ServerFacts {
  models?: string[];
  running?: RunningModel[];
  props?: PropsSummary;
  slots?: { count: number; processing: number; nCtx: number[] };
  renderOrder?: RenderOrder;
  /** Was the probed model loaded before the probe sent anything (false: the first call loads it). */
  modelLoaded?: boolean;
  errors: string[];
}

export interface HeadFacts {
  label: string;
  systemChars: number;
  toolCount: number;
  toolChars: number;
  /** Prompt tokens of the head's cold call, as the server counted them. */
  measuredPromptTokens?: number | null;
}

export interface ProductionHeadFacts {
  wallMs: number;
  cacheShare: number | null;
  promptTokens: number | null;
}

export interface ProbeReport {
  kind: "latency-probe";
  version: 1;
  generatedAt: string;
  runId: string;
  endpoint: { baseUrl: string; model: string };
  source: { revision: string | null; dirty: boolean; diffSha256: string | null };
  settings: Record<string, string | number | boolean | string[] | null>;
  server: ServerFacts;
  heads: HeadFacts[];
  /** The production head before and after the run: was it cached, and is it again. */
  productionHead: { before?: ProductionHeadFacts; after?: ProductionHeadFacts };
  global: {
    calls: number;
    scored: number;
    skipped: number;
    errors: number;
    timingsCoverage: number | null;
    coldPrefill: ColdPrefillFit | null;
    /** wall - prompt - generation of single calls: what every call pays before and after the model. */
    perCallQueueMs: Summary | null;
    stations: string[];
  };
  experiments: ExperimentVerdict[];
  steps: Record<string, StepSummary[]>;
  calls: CallResult[];
  environment: { suspect: boolean; reasons: string[] };
  verdict: "conclusive" | "inconclusive" | "environment_suspect";
}

export interface ReportInput {
  generatedAt: string;
  runId: string;
  endpoint: { baseUrl: string; model: string };
  source: ProbeReport["source"];
  settings: ProbeReport["settings"];
  server: ServerFacts;
  heads: HeadShape[];
  experiments: readonly ExperimentId[];
  results: readonly CallResult[];
  verdictContext: VerdictContext;
  environmentReasons: readonly string[];
}

function headFacts(head: HeadShape, measured: readonly CallResult[]): HeadFacts {
  return {
    label: head.label,
    systemChars: head.system.length,
    toolCount: head.tools.length,
    toolChars: JSON.stringify(head.tools).length,
    measuredPromptTokens: round(median(measured.filter(isScored).map((r) => totalPromptTokens(r)).filter((v): v is number => v !== undefined))),
  };
}

function productionHeadFacts(results: readonly CallResult[], step: string): ProductionHeadFacts | undefined {
  const r = results.find((x) => x.experiment === SETUP_EXPERIMENT && x.step === step);
  if (!r || r.status !== "ok") return undefined;
  return { wallMs: round(r.wallMs)!, cacheShare: round(cacheShare(r), 3), promptTokens: totalPromptTokens(r) ?? null };
}

export function buildProbeReport(input: ReportInput): ProbeReport {
  const results = input.results;
  const inExperiments = results.filter((r) => r.experiment !== "setup");
  const ok = results.filter((r) => r.status === "ok");
  const scored = results.filter(isScored);
  const coldCallsOf = (experiment: string, step: string) => results.filter((r) => r.experiment === experiment && r.step === step);
  const heads = input.heads.map((head) => {
    const cold = head.label === "orchestrator"
      ? coldCallsOf("E2", "cold")
      : head.label === "forced_subset"
        ? coldCallsOf("E7", "subset_cold")
        : head.label.startsWith("staged_builder:")
          ? coldCallsOf("E8", "head_size")
          : head.label === "forced_plan"
            ? coldCallsOf("E9", "treatment_warm_plan")
            : head.label === "forced_dispatch"
              ? coldCallsOf("E9", "treatment_warm_dispatch")
              : coldCallsOf("E6", "cold_first_call");
    return headFacts(head, cold);
  });
  const experiments = input.experiments.map((id) => computeVerdict(id, results, input.verdictContext));
  const steps: Record<string, StepSummary[]> = {};
  for (const id of input.experiments) steps[id] = summarizeSteps(results.filter((r) => r.experiment === id));

  const reasons = [...input.environmentReasons];
  if (inExperiments.length > 0 && inExperiments.every((r) => r.status === "skipped")) reasons.push("every planned call was skipped: the time budget was spent before the first experiment");
  else if (ok.length === 0 && results.length > 0) reasons.push("no call succeeded");
  else if (ok.length > 0 && scored.length === 0) reasons.push("no answer carried llama.cpp timings: the endpoint is not a llama-server, or something in between strips them");
  const suspect = reasons.length > 0;
  const verdict = suspect ? "environment_suspect" : experiments.length > 0 && experiments.every((e) => e.conclusive) ? "conclusive" : "inconclusive";
  const before = productionHeadFacts(results, PRODUCTION_HEAD_BEFORE);
  const after = productionHeadFacts(results, PRODUCTION_HEAD_AFTER);
  return {
    kind: "latency-probe",
    version: 1,
    generatedAt: input.generatedAt,
    runId: input.runId,
    endpoint: input.endpoint,
    source: input.source,
    settings: input.settings,
    server: input.server,
    heads,
    productionHead: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
    global: {
      calls: results.length,
      scored: scored.length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      timingsCoverage: ok.length > 0 ? round(scored.length / ok.length, 3) : null,
      coldPrefill: fitColdPrefill(results),
      perCallQueueMs: summarize(scored.filter((r) => r.inFlight === 1 && r.queueMs !== undefined).map((r) => r.queueMs!)),
      stations: stationsOf(results),
    },
    experiments,
    steps,
    calls: [...results],
    environment: { suspect, reasons },
    verdict,
  };
}

/** 0 every experiment answered, 2 some could not be, 3 the environment makes the run no verdict. */
export function probeExitCode(report: Pick<ProbeReport, "verdict">): 0 | 2 | 3 {
  return report.verdict === "conclusive" ? 0 : report.verdict === "environment_suspect" ? 3 : 2;
}

const cell = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : String(Math.round(value)));

export function formatProbeMarkdown(report: ProbeReport): string {
  const lines: string[] = [
    `# Latency probe ${report.runId}`,
    "",
    `- Generated: ${report.generatedAt}`,
    `- Endpoint: ${report.endpoint.baseUrl} · model \`${report.endpoint.model}\``,
    `- Source: ${report.source.revision ?? "unknown"}${report.source.dirty ? " (dirty tree)" : ""}`,
    `- Verdict: **${report.verdict}**${report.environment.reasons.length ? ` — ${report.environment.reasons.join("; ")}` : ""}`,
    `- Calls: ${report.global.calls} (${report.global.scored} with timings, ${report.global.skipped} skipped, ${report.global.errors} errors); servers: ${report.global.stations.join(" | ") || "unknown"}`,
    "",
    "## Server",
    "",
    `- Slots: ${report.server.props?.totalSlots ?? report.server.slots?.count ?? "unknown"} · context per slot: ${report.server.props?.nCtx ?? "unknown"} · build: ${report.server.props?.buildInfo ?? "unknown"}`,
    `- Tool block renders: ${report.server.renderOrder ?? "unknown"} · model loaded before the probe: ${report.server.modelLoaded === undefined ? "unknown" : report.server.modelLoaded ? "yes" : "no"}`,
    ...(report.server.running ?? []).map((r) => `- Running: \`${r.model}\` ${r.state ?? ""} ${r.flags ? JSON.stringify(r.flags) : ""}`.trimEnd()),
    ...(report.server.errors.length ? [`- Not readable: ${report.server.errors.join("; ")}`] : []),
    `- Cold prefill: ${report.global.coldPrefill ? `${Math.round(report.global.coldPrefill.tokensPerSecond)} tok/s (${report.global.coldPrefill.msPerToken.toFixed(3)} ms/token, intercept ${Math.round(report.global.coldPrefill.interceptMs)} ms, r² ${report.global.coldPrefill.r2.toFixed(3)}, n ${report.global.coldPrefill.n})` : "not measured"}`,
    `- Per-call queue (wall − prompt − generation, single calls): ${report.global.perCallQueueMs ? `median ${cell(report.global.perCallQueueMs.median)} ms, p90 ${cell(report.global.perCallQueueMs.p90)} ms` : "not measured"}`,
    ...(report.productionHead.before ? [`- Production head before the run: ${report.productionHead.before.promptTokens ?? "?"} tokens, ${report.productionHead.before.cacheShare === null ? "?" : Math.round(report.productionHead.before.cacheShare * 100)}% cached, ${report.productionHead.before.wallMs} ms`] : []),
    ...(report.productionHead.after ? [`- Production head after the run (re-warmed): ${report.productionHead.after.cacheShare === null ? "?" : Math.round(report.productionHead.after.cacheShare * 100)}% cached, ${report.productionHead.after.wallMs} ms`] : []),
    "",
    "## Heads",
    "",
    "| head | system chars | tools | tool chars | prompt tokens (cold) |",
    "|---|---|---|---|---|",
    ...report.heads.map((h) => `| ${h.label} | ${h.systemChars} | ${h.toolCount} | ${h.toolChars} | ${cell(h.measuredPromptTokens)} |`),
  ];
  for (const e of report.experiments) {
    lines.push("", `## ${e.experiment}: ${e.question}`, "", `**${e.code}**${e.conclusive || e.code === "inconclusive" ? "" : " (inconclusive)"} — ${e.answer}`);
    for (const note of e.notes) lines.push(`- ${note}`);
    if (e.rows?.length) {
      const keys = Object.keys(e.rows[0]!);
      lines.push("", `| ${keys.join(" | ")} |`, `|${keys.map(() => "---").join("|")}|`);
      for (const row of e.rows) lines.push(`| ${keys.map((k) => String(row[k] ?? "–")).join(" | ")} |`);
    }
    const steps = report.steps[e.experiment] ?? [];
    if (steps.length) {
      lines.push("", "| step | calls | scored | wall p50 | wall p90 | prompt_n p50 | cache_n p50 | prompt ms p50 | gen ms p50 | queue ms p50 |", "|---|---|---|---|---|---|---|---|---|---|");
      for (const s of steps) {
        lines.push(`| ${s.key} | ${s.calls} | ${s.scored} | ${cell(s.wallMs?.median)} | ${cell(s.wallMs?.p90)} | ${cell(s.promptN?.median)} | ${cell(s.cacheN?.median)} | ${cell(s.promptMs?.median)} | ${cell(s.predictedMs?.median)} | ${cell(s.queueMs?.median)} |`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
