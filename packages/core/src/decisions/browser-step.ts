/**
 * laya-browser beside the browser agent (config `decisions.browser`, docker/laya).
 *
 * laya-browser picks a browser step — which element to click, type into or select, whether to
 * scroll, or that the goal is met — from the page as jev-ultrafast's snapshot script reads it, in
 * about 20 ms on a GPU where the agent's model takes seconds per step. It was trained on that
 * script's observations only, so the page is read with the same script (jev-snapshot.ts), run
 * through Playwright MCP's browser_evaluate on the agent's own page.
 *
 * Shadow: before the model's click, typing or select runs, laya-browser is asked what it would do
 * on the same page, and the model's element is found among the observed ones — by role and name
 * from the model's last page snapshot, or, when that is ambiguous, in the page itself. Both
 * choices go to the audit (`browser_step`) and the browser ledger, which is what a laya-browser
 * fine-tune on the swarm's own sites would learn from.
 *
 * Acting: before each model call laya-browser acts on its own when it may — in `adaptive` where the
 * comparisons show it agrees with the model at its confidence (the decision layer's gate, point
 * `browser_step`), in `drive` above a fixed probability — for a click or a select. Its step becomes
 * an ordinary browser_click / browser_select_option call of the run, so approvals, guards, the
 * audit and the progress stream apply as to the model's own; the model then reads the call, marked
 * as laya-browser's, and the page it led to. Never taken: typing (the text is the model's to
 * write), Enter and anything that submits a form, a download, a link into another tab or to an
 * internal host, finishing. Scrolling and waiting are laya-browser's way of looking at the page
 * (the model's snapshot covers the whole page already) and are done in place.
 *
 * Every page read costs a Playwright MCP round trip, which on 1.61 includes a fixed settle wait of
 * about a second, so the page is read once per page state and reused until a page action runs —
 * and, in `adaptive`, not before the model's turn at all while nothing has qualified.
 */
import { createHash, randomUUID } from "node:crypto";
import { logAudit } from "../audit/logger.js";
import { detectTextLanguage } from "../agent/text-language.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { getMcpConnections } from "../mcp/registry.js";
import { getChatProviderForTier } from "../providers/index.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { languageBucket, layaMayDecide, modelsWithSamples, qualifiedLevel, recordAgreementSample, type LanguageBucket } from "./gate.js";
import { JEV_SNAPSHOT_SCRIPT } from "./jev-snapshot.js";
import { askLayaBrowser, layaConfigured, type LayaBrowserStep } from "./laya-client.js";
import { appendBrowserLedgerRow, readLedgerRows, resolveBrowserLedgerPath } from "./ledger.js";

const log = childLogger("decisions:browser");

/** The gate's point for browser steps; its samples are kept per laya-browser operation. */
export const BROWSER_POINT = "browser_step";

let seeding: Promise<void> | undefined;

/**
 * The laya-browser version that answered last. An adaptive decider asks the gate before it reads the
 * page — the read is what costs — and has no answer yet to take the version from, so it asks about
 * this one: seeded from the ledger, then kept current by every answer.
 */
let lastBrowserModel = "";

/**
 * Rebuild the browser gate from the browser ledger, once per process. Started by the first
 * decider without being waited for: until it finishes, the gate knows less and so hands
 * laya-browser less, never more.
 */
export function seedBrowserGate(): Promise<void> {
  seeding ??= readLedgerRows(resolveBrowserLedgerPath())
    .then((rows) => {
      let seeded = 0;
      let lastSeededModel = "";
      for (const row of rows as unknown as Array<{ point?: string; language?: LanguageBucket; gate?: { answer?: unknown; top?: unknown; agree?: unknown; model?: unknown } }>) {
        const gate = row.gate;
        if (row.point !== BROWSER_POINT || !gate || typeof gate.answer !== "string" || typeof gate.top !== "number" || typeof gate.agree !== "boolean") continue;
        const model = typeof gate.model === "string" ? gate.model : "";
        recordAgreementSample(BROWSER_POINT, row.language ?? "other", gate.answer, gate.top, gate.agree, model);
        if (model) lastSeededModel = model;
        seeded += 1;
      }
      if (!lastBrowserModel && lastSeededModel) lastBrowserModel = lastSeededModel;
      if (seeded > 0) log.info({ seeded }, "Browser gate rebuilt from the browser ledger");
    })
    .catch((err: unknown) => {
      log.warn({ err }, "Could not rebuild the browser gate from the browser ledger");
    });
  return seeding;
}

/** Test-only: seed again on the next decider, and forget the last version seen. */
export function resetBrowserGateSeedingForTests(): void {
  seeding = undefined;
  lastBrowserModel = "";
}

/** The model's page actions laya-browser also chooses among, as its operation names. */
const MODEL_OPERATIONS: Readonly<Record<string, "CLICK" | "TYPE_TEXT" | "SELECT">> = {
  browser_click: "CLICK",
  browser_type: "TYPE_TEXT",
  browser_select_option: "SELECT",
};

/** The jev action kind each operation acts through. */
const OPERATION_KIND: Readonly<Record<string, string>> = { CLICK: "click", TYPE_TEXT: "fill", SELECT: "select" };

/** Browser tools that only read the page: after them the observed page is still current. */
const READ_ONLY_BROWSER_TOOLS = new Set(["browser_snapshot", "browser_screenshot", "browser_take_screenshot"]);
/** Tools outside the browser_ family that act on the page. */
const OTHER_PAGE_TOOLS = new Set(["site_fill_credentials", "request_human_assist"]);

/** Does this tool change the page? After it, the page must be read again. */
function isPageAction(name: string): boolean {
  return (name.startsWith("browser_") && !READ_ONLY_BROWSER_TOOLS.has(name)) || OTHER_PAGE_TOOLS.has(name);
}

/** How much of the task laya-browser reads as its goal. Its goals in training were a sentence or two. */
const GOAL_CHARS = 400;
/** laya-browser reads the last ten actions (docker/laya/app/browser.py MAX_HISTORY). */
const HISTORY_SENT = 10;
/** Scrolls and waits before one decision to act or hand back, and in a whole run. */
const MAX_LOOKS_PER_STEP = 2;
const MAX_LOOKS_PER_RUN = 8;
/** A page read that takes longer than this is abandoned (1.61 alone waits ~1 s per call; a read takes ~1.05 s). */
const OBSERVE_TIMEOUT_MS = 4_000;

// ── In the page ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where laya-browser's element can be clicked from, and why it must not be. Run with the observed
 * actions, it returns one entry per clickable or selectable node: a CSS path that selects exactly
 * that element (verified), and, when driving it is refused, the reason.
 */
const DESCRIBE_TARGETS = `(actions) => {
  const c = window.__jevFast, out = {};
  const pathOf = (e) => {
    const parts = [];
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) i++;
      parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + i + ')');
    }
    const selector = 'html > ' + parts.join(' > ');
    try { return document.querySelector(selector) === e ? selector : null; } catch { return null; }
  };
  for (const a of actions) {
    if ((a.kind !== 'click' && a.kind !== 'select') || a.node in out) continue;
    const e = c && c.nodes.get(a.node);
    if (!e) continue;
    const t = { path: pathOf(e) };
    if (e.tagName === 'INPUT' ? ['submit', 'image', 'reset'].includes(e.type)
        : e.tagName === 'BUTTON' && !!e.form && (e.type === 'submit' || e.type === 'reset')) t.refused = 'it submits a form';
    const link = t.refused ? null : e.closest('a[href]');
    if (link) {
      const raw = link.getAttribute('href') || '';
      const target = (link.getAttribute('target') || '').toLowerCase();
      if (link.hasAttribute('download')) t.refused = 'it downloads a file';
      else if (target && !['_self', '_top', '_parent'].includes(target)) t.refused = 'it opens another tab';
      else if (!raw.startsWith('#') && !/^(https?|javascript):$/.test(link.protocol)) t.refused = 'it leaves the web (' + link.protocol + ')';
      else if (/^https?:$/.test(link.protocol)) t.href = link.href;
    }
    out[a.node] = t;
  }
  return out;
}`;

/** The page as laya-browser reads it; with `withTargets`, also where its elements can be clicked from. */
export function observeFunction(withTargets: boolean): string {
  return `() => {
  const o = ${JEV_SNAPSHOT_SCRIPT};
  if (!o) return null;
  const { marker, page_key, guards, ...observation } = o;
  return ${withTargets ? `{ observation, targets: (${DESCRIBE_TARGETS})(observation.actions) }` : "{ observation }"};
}`;
}

/** Run on the model's element: the observed node ids of it, its ancestors and its descendants. */
const MAP_ELEMENT = `(el) => {
  const c = window.__jevFast;
  if (!c || !el) return null;
  const self = c.ids.has(el) ? c.ids.get(el) : null;
  const ancestors = [];
  for (let e = el.parentElement; e && ancestors.length < 12; e = e.parentElement) if (c.ids.has(e)) ancestors.push(c.ids.get(e));
  const inner = [];
  for (const d of el.querySelectorAll('*')) { if (c.ids.has(d)) { inner.push(c.ids.get(d)); if (inner.length >= 8) break; } }
  return { self, ancestors, inner };
}`;

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────

export interface JevAction {
  id: string;
  kind: string;
  node?: number;
  role?: string;
  label: string;
  value?: string;
  current_value?: string;
  delta?: number;
  key?: string;
  [key: string]: unknown;
}

export interface JevObservation {
  url: string;
  title: string;
  text: string;
  scroll?: { y: number; height: number };
  actions: JevAction[];
  [key: string]: unknown;
}

interface DriveTarget {
  path: string | null;
  refused?: string;
  href?: string;
}

/** One entry of laya-browser's action history, as jev-ultrafast records it (agent.py). */
interface HistoryEntry {
  action: string;
  kind: string;
  text: string | null;
  page_changed: boolean | null;
  /** Not sent: the observed action it was, for the stall guard. */
  actionId?: string;
  drivenByLaya?: boolean;
}

interface View {
  observation: JevObservation;
  targets?: Record<string, DriveTarget>;
  fingerprint: string;
  answer: Promise<LayaBrowserStep | null>;
  /** What laya-browser was asked with, for the ledger. */
  asked: { goal: string; language: LanguageBucket; history: HistoryEntry[]; excluded: string[] } | null;
}

interface Goal {
  text: string;
  /** English as laya-browser was trained on: as written, or translated. */
  english: boolean;
  translated: boolean;
  /** Whose statistics apply: the language of the goal laya-browser reads. */
  language: LanguageBucket;
}

interface MappedElement {
  node: number;
  how: "name" | "exact" | "ancestor" | "descendant";
}

/** What MAP_ELEMENT returns: the observed node ids of the model's element and around it. */
interface ElementIds {
  self: number | null;
  ancestors: number[];
  inner: number[];
}

export interface DrivenStep {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  operation: string;
  label: string;
}

export interface BrowserDeciderDeps {
  agentName: string;
  sessionId: string;
  /** The run's task, which laya-browser reads as its goal. */
  task: string;
  /** The tools the agent holds: laya-browser only ever takes a step the model could have taken. */
  toolNames: readonly string[];
  /** Call a tool on the connected Playwright MCP server; throws on a tool error. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The input schema the server lists a tool with; undefined when it lists no such tool. */
  toolSchema: (name: string) => Record<string, unknown> | undefined;
  /** Why a URL must not be opened (an internal or private host); null when it may. */
  checkUrl?: (url: string) => Promise<string | null>;
  /** The goal in English, when it is not; null when that cannot be had. Default: the routing tier. */
  translate?: (text: string, signal?: AbortSignal) => Promise<string | null>;
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────

/** The JSON value of a browser_evaluate / browser_run_code_unsafe answer (`### Result` section). */
export function readEvaluateResult(output: string): unknown {
  const start = output.indexOf("### Result\n");
  if (start < 0) return undefined;
  const body = output.slice(start + "### Result\n".length);
  // The next section header ends it; JSON never puts one at the start of a line.
  const end = body.search(/\n#{1,4} /);
  try {
    return JSON.parse((end >= 0 ? body.slice(0, end) : body).trim());
  } catch {
    return undefined;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** jev-ultrafast's page fingerprint (browser.py): what changed when an action "changed the page". */
export function fingerprintOf(observation: JevObservation): string {
  const content = { url: observation.url, text: observation.text, actions: observation.actions, scroll: observation.scroll ?? null };
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

/** The observation as the sidecar and the ledger get it: what laya-browser reads, without geometry. */
function strippedObservation(observation: JevObservation): Record<string, unknown> {
  return {
    url: observation.url,
    title: observation.title,
    text: observation.text,
    actions: observation.actions.map(({ rect: _rect, ...action }) => action),
  };
}

/** The task as laya-browser's goal: the instruction itself, without the blocks appended to it, cut short. */
export function browserGoalText(task: string): string {
  const head = task.split(/\n\s*\n\s*\[[A-Z][A-Z0-9 _-]{2,}\]/)[0] ?? task;
  const flat = head.replace(/\s+/g, " ").trim();
  if (flat.length <= GOAL_CHARS) return flat;
  const cut = flat.slice(0, GOAL_CHARS);
  const sentence = cut.lastIndexOf(". ");
  return sentence > GOAL_CHARS / 2 ? cut.slice(0, sentence + 1) : cut;
}

const ARIA_REF_LINE = /^[ \t]*-[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[^\n]*?\[ref=([a-z0-9]+)\]/gim;

/** role and name of each element the model can address, from a Playwright page snapshot. */
export function parseAriaRefs(output: string): Map<string, { role: string; name: string }> {
  const refs = new Map<string, { role: string; name: string }>();
  for (const match of output.matchAll(ARIA_REF_LINE)) {
    let name = match[2] ?? "";
    try {
      name = JSON.parse(`"${name}"`) as string;
    } catch {
      // Kept as written.
    }
    refs.set(match[3]!, { role: match[1]!.toLowerCase(), name });
  }
  return refs;
}

function normalizedLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The element's own name in a jev label: without the "Open " of a field's click and an option after " → ". */
function elementLabel(action: JevAction): string {
  const base = action.label.split(" → ")[0] ?? action.label;
  return action.kind === "click" && action.label.startsWith("Open ") && action.role && ["textbox", "searchbox", "spinbutton", "combobox"].includes(action.role)
    ? base.slice(5)
    : base;
}

/** The observed node whose role and name are the snapshot's for `ref` — only when exactly one is. */
export function nodeByName(ref: { role: string; name: string } | undefined, observation: JevObservation): number | null {
  if (!ref || !ref.name.trim()) return null;
  const wanted = normalizedLabel(ref.name);
  const nodes = new Set<number>();
  for (const action of observation.actions) {
    if (typeof action.node !== "number" || action.role !== ref.role) continue;
    if (normalizedLabel(elementLabel(action)) === wanted) nodes.add(action.node);
  }
  return nodes.size === 1 ? [...nodes][0]! : null;
}

/** The observed node the model's element is: itself, else the nearest observed ancestor, else its one observed descendant. */
export function nodeFromIds(ids: ElementIds | null, observation: JevObservation): MappedElement | null {
  if (!ids || !Array.isArray(ids.ancestors) || !Array.isArray(ids.inner)) return null;
  const observed = new Set(observation.actions.map((action) => action.node).filter((node): node is number => typeof node === "number"));
  if (ids.self !== null && observed.has(ids.self)) return { node: ids.self, how: "exact" };
  const ancestor = ids.ancestors.find((id) => observed.has(id));
  if (ancestor !== undefined) return { node: ancestor, how: "ancestor" };
  const inner = [...new Set(ids.inner.filter((id) => observed.has(id)))];
  return inner.length === 1 ? { node: inner[0]!, how: "descendant" } : null;
}

function probability(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** How sure laya-browser is of a step: of its operation and, for a targeted one, of its element — the lower. */
function jointProbability(laya: LayaBrowserStep): number {
  return Math.min(laya.operationProbability, laya.target?.probability ?? 1);
}

/** Operations that act on an element: agreeing on them means agreeing on the element too. */
const TARGETED_OPERATIONS = new Set(["CLICK", "TYPE_TEXT", "SELECT"]);

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The goal in English through the routing tier: one short instruction, identifiers kept. */
async function translateWithRoutingTier(text: string, signal?: AbortSignal): Promise<string | null> {
  const provider = getChatProviderForTier("routing");
  if (!provider) return null;
  const callSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await runWithCallAttribution({ callSite: "routing_tier", agentName: "laya_browser_goal" }, () =>
    provider.complete([
      {
        role: "system",
        content: "Rewrite the web-browsing task below as ONE short, plain English instruction (at most two sentences) "
          + "for a browser agent. Keep names, URLs, numbers and quoted text exactly as written. Reply with the instruction only.",
      },
      { role: "user", content: text },
    ], [], callSignal));
  const out = (response.content ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return out && out.length <= 1_000 ? out : null;
}

function declares(schema: Record<string, unknown> | undefined, key: string): boolean {
  const properties = schema?.["properties"];
  return Boolean(properties && typeof properties === "object" && Object.prototype.hasOwnProperty.call(properties, key));
}

// ── The decider ─────────────────────────────────────────────────────────────────────────────────

export type BrowserDecider = LayaBrowserDecider;

/**
 * laya-browser for one run of an agent holding browser_click, or null when it is not to be asked:
 * mode off, no sidecar, or no Playwright server that can read the page.
 */
export function createBrowserDecider(deps: BrowserDeciderDeps): BrowserDecider | null {
  const settings = getConfig().decisions?.browser;
  if (!settings || settings.mode === "off" || !layaConfigured()) return null;
  if (!deps.toolNames.includes("browser_click")) return null;
  if (!deps.toolSchema("browser_evaluate")) return null;
  return new LayaBrowserDecider(deps);
}

/** The decider on the gateway's own Playwright connection, with its SSRF guard for the links it would follow. */
export function createBrowserDeciderForRun(run: Pick<BrowserDeciderDeps, "agentName" | "sessionId" | "task" | "toolNames">): BrowserDecider | null {
  return createBrowserDecider({
    ...run,
    callTool: async (name, args) => (await import("../tools/multimodal.js")).callPlaywrightTool(name, args),
    toolSchema: (name) => getMcpConnections().get("playwright")?.tools?.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown> | undefined,
    checkUrl: async (url) => (await import("../tools/web.js")).checkUrlSsrf(url),
  });
}

export class LayaBrowserDecider {
  readonly mode: "shadow" | "adaptive" | "drive";
  private readonly settings = getConfig().decisions.browser;
  private readonly goal: Promise<Goal | null>;
  /** Which of laya-browser's steps this server and this agent let it take. */
  private readonly may: { click: boolean; select: boolean; look: string | null };
  private pageOpen = false;
  private dirty = true;
  private view: View | undefined;
  private refs = new Map<string, { role: string; name: string }>();
  private readonly history: HistoryEntry[] = [];
  /** The last action, until the next page read tells whether it changed the page. */
  private pendingChange: { entry: HistoryEntry; fingerprint: string } | undefined;
  /** Actions that were taken and changed nothing, not offered again until the page changes. */
  private readonly excluded = new Set<string>();
  private excludedOn: string | undefined;
  private readonly drivenCalls = new Map<string, { label: string; kind: string; actionId: string; fingerprint: string }>();
  private modelAction: { callId: string; label: string; kind: string; actionId?: string; fingerprint: string; text: string | null } | undefined;
  private consecutiveDriven = 0;
  private stalled = false;
  private readonly counts = { asked: 0, answered: 0, compared: 0, agreed: 0, targetCompared: 0, targetAgreed: 0, driven: 0, looked: 0, refused: 0, failedDrives: 0 };

  constructor(private readonly deps: BrowserDeciderDeps) {
    this.mode = this.settings.mode === "drive" || this.settings.mode === "adaptive" ? this.settings.mode : "shadow";
    const acting = this.mode !== "shadow";
    const lookTool = ["browser_run_code_unsafe", "browser_run_code"].find((name) => deps.toolSchema(name)) ?? null;
    this.may = {
      click: acting && declares(deps.toolSchema("browser_click"), "target"),
      select: acting && deps.toolNames.includes("browser_select_option") && declares(deps.toolSchema("browser_select_option"), "target"),
      look: acting ? lookTool : null,
    };
    void seedBrowserGate();
    this.goal = this.prepareGoal().catch((err: unknown) => {
      log.debug({ err }, "Could not prepare laya-browser's goal");
      return null;
    });
  }

  private async prepareGoal(): Promise<Goal | null> {
    const text = browserGoalText(this.deps.task);
    if (!text) return null;
    const language = detectTextLanguage(text)?.code;
    if (!language || language === "en") return { text, english: true, translated: false, language: "en" };
    if (this.settings.translateGoal) {
      const english = await (this.deps.translate ?? translateWithRoutingTier)(text);
      if (english) return { text: browserGoalText(english), english: true, translated: true, language: "en" };
    }
    return { text, english: false, translated: false, language: languageBucket(language) };
  }

  /** The page as laya-browser reads it, read once per page state; laya-browser is asked about it right away. */
  private async observe(signal?: AbortSignal): Promise<View | null> {
    const withTargets = this.mode !== "shadow";
    if (!this.dirty && this.view && (!withTargets || this.view.targets)) return this.view;
    const output = await withTimeout(this.deps.callTool("browser_evaluate", { function: observeFunction(withTargets) }), OBSERVE_TIMEOUT_MS);
    const value = output === undefined ? undefined : readEvaluateResult(output) as { observation?: JevObservation; targets?: Record<string, DriveTarget> } | null | undefined;
    const observation = value?.observation;
    if (!observation || !Array.isArray(observation.actions)) return null;
    const fingerprint = fingerprintOf(observation);
    if (this.pendingChange) {
      const { entry, fingerprint: before } = this.pendingChange;
      entry.page_changed = before !== fingerprint;
      this.pendingChange = undefined;
      // jev's stall guard: an action that changed nothing is not offered again on this page, and
      // laya-browser does not drive on after two of its own in a row changed nothing.
      if (entry.page_changed === false && entry.actionId) {
        if (this.excludedOn !== fingerprint) this.excluded.clear();
        this.excluded.add(entry.actionId);
        this.excludedOn = fingerprint;
        const previous = this.history.at(-2);
        if (entry.drivenByLaya && previous?.drivenByLaya && previous.page_changed === false) this.stalled = true;
      }
    }
    if (this.excludedOn !== fingerprint) {
      this.excluded.clear();
      this.excludedOn = fingerprint;
    }
    const goal = await this.goal;
    const asked = goal
      ? { goal: goal.text, language: goal.language, history: this.history.slice(-HISTORY_SENT).map((entry) => ({ ...entry })), excluded: [...this.excluded] }
      : null;
    let answer: Promise<LayaBrowserStep | null> = Promise.resolve(null);
    if (asked) {
      this.counts.asked += 1;
      answer = askLayaBrowser({
        goal: asked.goal,
        observation: strippedObservation(observation),
        history: asked.history.map(({ action, kind, text, page_changed }) => ({ action, kind, text, page_changed })),
        ...(asked.excluded.length ? { excluded: asked.excluded } : {}),
      }, signal).then((step) => {
        if (step) {
          this.counts.answered += 1;
          lastBrowserModel = step.model;
        }
        return step;
      });
    }
    this.view = { observation, ...(value?.targets ? { targets: value.targets } : {}), fingerprint, answer, asked };
    this.dirty = false;
    return this.view;
  }

  /**
   * Before the model is asked: laya-browser's own step, when it is sure and may take it — as the
   * tool call the run executes in place of the model's. Null hands the step to the model.
   */
  async proposeStep(signal?: AbortSignal): Promise<DrivenStep | null> {
    const step = await this.driveStep(signal).catch((err: unknown) => {
      log.debug({ err, agentName: this.deps.agentName }, "laya-browser could not propose a step");
      return null;
    });
    if (!step) this.consecutiveDriven = 0;
    return step;
  }

  private async driveStep(signal?: AbortSignal): Promise<DrivenStep | null> {
    // Its last call never ran — a cap or guard of the run stopped it before it reached the page.
    // Proposing again would propose the same call on the same page: hand the page back instead.
    if (this.drivenCalls.size > 0) {
      this.drivenCalls.clear();
      this.counts.failedDrives += 1;
      this.stalled = true;
      return null;
    }
    if (this.mode === "shadow" || !this.pageOpen || this.stalled || !(this.may.click || this.may.select)) return null;
    if (this.counts.driven >= this.settings.maxDrivenSteps || this.consecutiveDriven >= this.settings.maxConsecutiveDriven) return null;
    const goal = await this.goal;
    // Trained on English goals: on any other it would be guessing, which shadow may measure and drive must not act on.
    if (!goal?.english) return null;
    // Nothing it may take before a confidence has qualified — and so no reason to read the page before the model's turn.
    if (this.mode === "adaptive" && !this.gateOpen(goal.language)) return null;
    for (let looks = 0; ; looks += 1) {
      const view = await this.observe(signal);
      // Reading the page is what shows that its own last steps changed nothing.
      if (!view || this.stalled) return null;
      const laya = await view.answer;
      if (!laya) return null;
      if (laya.operation === "CLICK" || laya.operation === "SELECT") return this.driveTarget(view, laya, goal.language);
      // Looking changes nothing but the view, so a fixed confidence is enough for it in either mode.
      const lookable = laya.operation === "SCROLL_DOWN" || laya.operation === "SCROLL_UP" || laya.operation === "WAIT";
      if (!lookable || !this.may.look || !laya.control || laya.operationProbability < this.settings.driveMinProbability) return null;
      if (looks >= MAX_LOOKS_PER_STEP || this.counts.looked >= MAX_LOOKS_PER_RUN) return null;
      if (!(await this.look(view, laya))) return null;
    }
  }

  /**
   * Has a confidence qualified for any step laya-browser may take here — for the version answering
   * now? Before any answer has named that version, any version's qualification is reason enough to
   * read the page once: the answer to that read names it.
   */
  private gateOpen(language: LanguageBucket): boolean {
    const adaptive = getConfig().decisions.adaptive;
    const answers = [...(this.may.click ? ["CLICK"] : []), ...(this.may.select ? ["SELECT"] : [])];
    return answers.some((answer) => (lastBrowserModel ? [lastBrowserModel] : modelsWithSamples(BROWSER_POINT, language, answer))
      .some((model) => qualifiedLevel(BROWSER_POINT, language, answer, adaptive, model) !== null));
  }

  /** A scroll or a wait: laya-browser looking at the page, done in place. */
  private async look(view: View, laya: LayaBrowserStep): Promise<boolean> {
    const control = laya.control!;
    const delta = control.delta;
    if (control.kind === "scroll" && !(Number.isInteger(delta) && Math.abs(delta!) <= 5_000)) return false;
    const code = control.kind === "scroll"
      ? `async (page) => { await page.mouse.move(550, 650); await page.mouse.wheel(0, ${delta}); await page.waitForTimeout(150); }`
      : "async (page) => { await page.waitForTimeout(250); }";
    try {
      await this.deps.callTool(this.may.look!, { code });
    } catch (err) {
      log.debug({ err }, "laya-browser could not scroll or wait");
      return false;
    }
    this.counts.looked += 1;
    const entry: HistoryEntry = { action: control.label, kind: control.kind, text: null, page_changed: null, actionId: control.actionId, drivenByLaya: true };
    this.history.push(entry);
    this.pendingChange = { entry, fingerprint: view.fingerprint };
    this.dirty = true;
    this.record(view, laya, null, "laya");
    return true;
  }

  private async driveTarget(view: View, laya: LayaBrowserStep, language: LanguageBucket): Promise<DrivenStep | null> {
    const target = laya.target;
    if (!target || target.node === null) return null;
    if (laya.operation === "CLICK" ? !this.may.click : !this.may.select) return null;
    if (this.mode === "drive") {
      const threshold = this.settings.driveMinProbability;
      if (laya.operationProbability < threshold || target.probability < threshold) return null;
    } else {
      const adaptive = getConfig().decisions.adaptive;
      if (!layaMayDecide(BROWSER_POINT, language, laya.operation, jointProbability(laya), adaptive, laya.model)) return null;
      // Some of what it may take still goes to the model: without those, the agreement could not be measured once it acts.
      if (Math.random() < adaptive.auditRate) return null;
    }
    const where = view.targets?.[String(target.node)];
    let refused = !where?.path ? "it cannot be addressed on the page" : where.refused;
    if (!refused && where?.href && this.deps.checkUrl) refused = (await this.deps.checkUrl(where.href)) ?? undefined;
    if (refused) {
      this.counts.refused += 1;
      logAudit("browser_step", {
        agentName: this.deps.agentName,
        mode: this.mode,
        decidedBy: "model",
        refused,
        laya: { operation: laya.operation, p: probability(laya.operationProbability), target: target.label.slice(0, 80), targetP: probability(target.probability), ms: laya.ms },
      }, { sessionId: this.deps.sessionId, severity: "info" });
      return null;
    }
    const role = target.role ? ` (${target.role})` : "";
    const sure = Math.round(jointProbability(laya) * 100);
    const element = `${target.label.slice(0, 120)}${role} — picked by the fast browser model, ${sure}% sure`;
    const id = `call_laya_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const toolCall = laya.operation === "CLICK"
      ? { id, name: "browser_click", arguments: { element, ref: where!.path! } }
      : { id, name: "browser_select_option", arguments: { element, ref: where!.path!, values: [String(target.value ?? "")] } };
    this.drivenCalls.set(id, { label: target.label, kind: OPERATION_KIND[laya.operation]!, actionId: target.actionId, fingerprint: view.fingerprint });
    this.consecutiveDriven += 1;
    this.record(view, laya, null, "laya");
    return { toolCall, operation: laya.operation, label: target.label };
  }

  /**
   * The model chose these calls on the page as it stands: before they run, find its element among
   * the observed ones and compare with laya-browser. Only the first page action is compared — the
   * page the later ones act on is the one the first leaves behind.
   */
  async beforeModelActions(toolCalls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>, signal?: AbortSignal): Promise<void> {
    this.modelAction = undefined;
    const first = toolCalls.find((call) => isPageAction(call.name));
    const operation = first ? MODEL_OPERATIONS[first.name] : undefined;
    if (!first || !operation || !this.pageOpen || this.drivenCalls.has(first.id)) return;
    try {
      const view = await this.observe(signal);
      if (!view) return;
      const ref = String(first.arguments["ref"] ?? first.arguments["target"] ?? "");
      let mapped: MappedElement | null = null;
      const byName = nodeByName(this.refs.get(ref), view.observation);
      if (byName !== null) mapped = { node: byName, how: "name" };
      else if (ref) {
        const output = await withTimeout(this.deps.callTool("browser_evaluate", {
          function: MAP_ELEMENT,
          element: String(first.arguments["element"] ?? "element"),
          ref,
        }), OBSERVE_TIMEOUT_MS);
        mapped = nodeFromIds(output === undefined ? null : readEvaluateResult(output) as ElementIds | null, view.observation);
      }
      const action = mapped ? view.observation.actions.find((a) => a.node === mapped!.node && a.kind === OPERATION_KIND[operation]) : undefined;
      this.modelAction = {
        callId: first.id,
        label: action?.label ?? String(first.arguments["element"] ?? ""),
        kind: OPERATION_KIND[operation]!,
        ...(action ? { actionId: action.id } : {}),
        fingerprint: view.fingerprint,
        text: first.name === "browser_type" ? String(first.arguments["text"] ?? "") : null,
      };
      const values = Array.isArray(first.arguments["values"]) ? (first.arguments["values"] as unknown[]).map(String) : [];
      void view.answer.then((laya) => this.record(view, laya, { tool: first.name, operation, mapped, values }, "model"));
    } catch (err) {
      log.debug({ err, agentName: this.deps.agentName }, "laya-browser could not compare the model's step");
    }
  }

  /** The model answered without a tool call: would laya-browser have said the goal is met? */
  noteFinalAnswer(): void {
    if (!this.pageOpen) return;
    void this.observe()
      .then(async (view) => {
        if (view) this.record(view, await view.answer, { tool: "final_answer", operation: "DONE", mapped: null, values: [] }, "model");
      })
      .catch(() => { /* measurement only */ });
  }

  /** A call of the run finished — the model's or one laya-browser drove. */
  afterToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }, result: { success: boolean; output?: string }): void {
    if (typeof result.output === "string" && result.output.includes("[ref=")) {
      const refs = parseAriaRefs(result.output);
      if (refs.size > 0) this.refs = refs;
    }
    if (!isPageAction(call.name)) return;
    this.dirty = true;
    if (result.success) this.pageOpen = true;
    const driven = this.drivenCalls.get(call.id);
    if (driven) {
      this.drivenCalls.delete(call.id);
      if (!result.success) {
        // Hand the page back: the model sees the failed call and chooses; laya-browser waits for its next page action.
        this.counts.failedDrives += 1;
        this.stalled = true;
        return;
      }
      this.counts.driven += 1;
      const entry: HistoryEntry = { action: driven.label, kind: driven.kind, text: null, page_changed: null, actionId: driven.actionId, drivenByLaya: true };
      this.history.push(entry);
      this.pendingChange = { entry, fingerprint: driven.fingerprint };
      return;
    }
    this.stalled = false;
    const acted = this.modelAction?.callId === call.id ? this.modelAction : undefined;
    this.modelAction = undefined;
    // Whatever the page does next is this action's doing, not the one before it.
    this.pendingChange = undefined;
    if (acted && result.success) {
      const entry: HistoryEntry = { action: acted.label, kind: acted.kind, text: acted.text, page_changed: null, ...(acted.actionId ? { actionId: acted.actionId } : {}) };
      this.history.push(entry);
      this.pendingChange = { entry, fingerprint: acted.fingerprint };
    }
  }

  /** What laya-browser did this run, for the run's audit. */
  finish(): void {
    if (this.counts.asked === 0) return;
    logAudit("browser_step", {
      agentName: this.deps.agentName,
      mode: this.mode,
      summary: { ...this.counts },
    }, { sessionId: this.deps.sessionId, severity: "info" });
  }

  /** One step to the audit and the ledger: laya-browser's choice, and the model's when it chose. */
  private record(
    view: View,
    laya: LayaBrowserStep | null,
    model: { tool: string; operation: string; mapped: MappedElement | null; values: string[] } | null,
    decidedBy: "laya" | "model",
  ): void {
    try {
      let agree: { operation: boolean; target?: boolean } | null = null;
      let sample: { answer: string; top: number; agree: boolean; model: string } | null = null;
      if (laya && model) {
        const operation = laya.operation === model.operation;
        let target: boolean | undefined;
        if (operation && model.operation !== "DONE" && laya.target && model.mapped) {
          target = laya.target.node === model.mapped.node;
          if (target && model.operation === "SELECT") {
            const option = laya.target.label.split(" → ").at(-1) ?? "";
            target = model.values.some((value) => value === laya.target!.value || normalizedLabel(value) === normalizedLabel(option));
          }
        }
        agree = { operation, ...(target !== undefined ? { target } : {}) };
        this.counts.compared += 1;
        if (operation) this.counts.agreed += 1;
        if (target !== undefined) {
          this.counts.targetCompared += 1;
          if (target) this.counts.targetAgreed += 1;
        }
        // One sample for the gate: a different operation is a disagreement; the same one on an element
        // agrees only on the same element, and counts only when the model's element was found.
        const judged = !operation ? false : TARGETED_OPERATIONS.has(laya.operation) ? target : true;
        if (judged !== undefined && view.asked) {
          sample = { answer: laya.operation, top: jointProbability(laya), agree: judged, model: laya.model };
          recordAgreementSample(BROWSER_POINT, view.asked.language, sample.answer, sample.top, sample.agree, sample.model);
        }
      }
      const modelTarget = model?.mapped ? view.observation.actions.find((a) => a.node === model.mapped!.node) : undefined;
      logAudit("browser_step", {
        agentName: this.deps.agentName,
        mode: this.mode,
        decidedBy,
        laya: laya
          ? {
            operation: laya.operation,
            p: probability(laya.operationProbability),
            ...(laya.target ? { target: laya.target.label.slice(0, 80), targetP: probability(laya.target.probability) } : {}),
            ms: laya.ms,
          }
          : null,
        ...(model
          ? { model: { tool: model.tool, operation: model.operation, ...(modelTarget ? { target: modelTarget.label.slice(0, 80) } : {}), ...(model.mapped ? { found: model.mapped.how } : {}) } }
          : {}),
        ...(agree ? { agree: agree.operation, ...(agree.target !== undefined ? { targetAgree: agree.target } : {}) } : {}),
      }, { sessionId: this.deps.sessionId, severity: "info" });
      if (!view.asked) return;
      void appendBrowserLedgerRow({
        ts: new Date().toISOString(),
        point: BROWSER_POINT,
        language: view.asked.language,
        sessionId: this.deps.sessionId,
        agentName: this.deps.agentName,
        mode: this.mode,
        goal: view.asked.goal,
        observation: strippedObservation(view.observation),
        history: view.asked.history.map(({ action, kind, text, page_changed }) => ({ action, kind, text, page_changed })),
        excluded: view.asked.excluded,
        laya: laya
          ? {
            operation: laya.operation,
            operationProbability: laya.operationProbability,
            target: laya.target ? { actionId: laya.target.actionId, node: laya.target.node, label: laya.target.label, probability: laya.target.probability } : null,
            control: laya.control,
            ms: laya.ms,
            ...(laya.model ? { model: laya.model } : {}),
          }
          : null,
        model: model
          ? { tool: model.tool, operation: model.operation, node: model.mapped?.node ?? null, found: model.mapped?.how ?? null, ...(model.values.length ? { values: model.values } : {}) }
          : null,
        agree,
        ...(sample ? { gate: sample } : {}),
        decidedBy,
      });
    } catch (err) {
      log.debug({ err }, "Could not record a browser step");
    }
  }
}
