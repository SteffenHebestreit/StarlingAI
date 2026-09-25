/**
 * laya-browser beside the browser agent (decisions/browser-step.ts): what it may take on its own in
 * mode "drive", what it must leave to the model, how often it reads the page, and what it records
 * when the model chose. The Playwright server and the sidecar are fakes; the page is what jev's
 * snapshot script would have returned.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logAuditMock = vi.hoisted(() => vi.fn());
vi.mock("../audit/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/logger.js")>()),
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

const tempDir = mkdtempSync(join(tmpdir(), "sai-decisions-browser-"));
const configPath = join(tempDir, "starlingai.json");
const ledgerPath = join(tempDir, "decisions", "ledger.jsonl");
const browserLedgerPath = join(tempDir, "decisions", "browser-ledger.jsonl");

async function writeConfig(browser: Record<string, unknown>, baseUrl = "http://laya:8080", decisions: Record<string, unknown> = {}): Promise<void> {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    gateway: { jwtSecret: "t".repeat(32) },
    decisions: { baseUrl, ledger: { path: ledgerPath }, browser, ...decisions },
  }), "utf8");
  (await import("../config/loader.js")).resetConfigForTests();
}

beforeAll(async () => {
  process.env["SAI_CONFIG_PATH"] = configPath;
  await (await import("../agent/text-language.js")).warmTextLanguageDetector();
});

beforeEach(async () => {
  (await import("../decisions/decide.js")).resetDecisionsForTests();
  (await import("../decisions/browser-step.js")).resetBrowserGateSeedingForTests();
  logAuditMock.mockClear();
  // Rows of the test before are written asynchronously: let them land before the ledger goes.
  await (await import("../decisions/ledger.js")).flushLedgerForTests();
  rmSync(join(tempDir, "decisions"), { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

// ── The page ────────────────────────────────────────────────────────────────────────────────────

interface Page {
  observation: Record<string, unknown>;
  targets?: Record<string, { path: string | null; refused?: string; href?: string }>;
}

function page(url: string, actions: Array<Record<string, unknown>>, targets?: Page["targets"], text = "Welcome to the shop"): Page {
  return {
    observation: {
      url, title: "Shop", w: 1280, h: 720, text, scroll: { y: 0, height: 3000 }, omitted_actions: 0,
      actions: actions.map((action, i) => ({ id: `e${i + 1}`, value: "", rect: { x: 1, y: 2, w: 3, h: 4 }, ...action })),
    },
    ...(targets ? { targets } : {}),
  };
}

const HOME = page("https://shop.example/", [
  { node: 1, role: "link", label: "Home", kind: "click" },
  { node: 2, role: "link", label: "Products", kind: "click" },
  { node: 3, role: "button", label: "Search", kind: "click" },
  { node: 4, role: "textbox", label: "Query", kind: "fill" },
  { node: 4, role: "textbox", label: "Open Query", kind: "click" },
  { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
], {
  1: { path: "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(1)", href: "https://shop.example/" },
  2: { path: "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(2)", href: "https://shop.example/products" },
  3: { path: "html > body:nth-child(2) > form:nth-child(2) > button:nth-child(2)", refused: "it submits a form" },
  4: { path: "html > body:nth-child(2) > form:nth-child(2) > input:nth-child(1)" },
});
const HOME_AGAIN: Page = { ...HOME, observation: { ...HOME.observation, url: "https://shop.example/?page=2", text: "More of the shop" } };
const PRODUCTS = page("https://shop.example/products", [
  { node: 1, role: "link", label: "Home", kind: "click" },
  { node: 5, role: "link", label: "Chair", kind: "click" },
], {
  1: { path: "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(1)" },
  5: { path: "html > body:nth-child(2) > main:nth-child(2) > a:nth-child(1)" },
});

/** Playwright MCP 1.61's answer to browser_evaluate: the result, then the code it ran. */
function evaluateAnswer(value: unknown): string {
  return `### Result\n${JSON.stringify(value, null, 2)}\n### Ran Playwright code\n\`\`\`js\nawait page.evaluate('() => …');\n\`\`\``;
}

interface FakeBrowser {
  current: Page;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  mapIds?: { self: number | null; ancestors: number[]; inner: number[] };
  /** The page a scroll or wait leads to. */
  afterLook?: Page;
}

function deps(browser: FakeBrowser, overrides: Record<string, unknown> = {}) {
  const schemas: Record<string, Record<string, unknown>> = {
    browser_evaluate: { properties: { function: {}, element: {}, target: {} } },
    browser_click: { properties: { element: {}, target: {} } },
    browser_select_option: { properties: { element: {}, target: {}, values: {} } },
    browser_run_code_unsafe: { properties: { code: {} } },
  };
  return {
    agentName: "browser_agent",
    sessionId: "s-browser",
    task: "Open the shop and find the price of the Chair.\n\n[LANGUAGE] Reason and work internally in English.",
    toolNames: ["browser_navigate", "browser_click", "browser_type", "browser_select_option", "browser_snapshot"],
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      browser.calls.push({ name, args });
      if (name === "browser_evaluate") {
        const fn = String(args["function"]);
        if (fn.startsWith("(el)")) return evaluateAnswer(browser.mapIds ?? null);
        const withTargets = fn.includes("targets:");
        return evaluateAnswer({ observation: browser.current.observation, ...(withTargets ? { targets: browser.current.targets ?? {} } : {}) });
      }
      if (name === "browser_run_code_unsafe") {
        if (browser.afterLook) browser.current = browser.afterLook;
        return "### Result\nundefined";
      }
      throw new Error(`unexpected tool ${name}`);
    }),
    toolSchema: (name: string) => schemas[name],
    ...overrides,
  };
}

type Step = Record<string, unknown>;

function sidecar(steps: Step[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = steps.length > 1 ? steps.shift()! : steps[0]!;
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies };
}

function click(node: number, label: string, p: number, targetP = p, actionId = `e${node}`): Step {
  return {
    operation: "CLICK", operationProbability: p, operationProbabilities: { CLICK: p, DONE: 1 - p },
    target: { index: String(node), actionId, node, kind: "click", label, role: "link", probability: targetP, alternatives: [] },
    control: null, passes: 1, tokens: 300, ms: 18, model: "laya-browser-test",
  };
}

function operation(name: string, p: number, extra: Partial<Step> = {}): Step {
  return { operation: name, operationProbability: p, operationProbabilities: { [name]: p, CLICK: 1 - p }, target: null, control: null, ms: 15, model: "laya-browser-test", ...extra };
}

async function decider(browserSettings: Record<string, unknown>, browser: FakeBrowser, overrides: Record<string, unknown> = {}, decisions: Record<string, unknown> = {}) {
  await writeConfig(browserSettings, "http://laya:8080", decisions);
  const { createBrowserDecider } = await import("../decisions/browser-step.js");
  const made = createBrowserDecider(deps(browser, overrides) as never);
  if (!made) throw new Error("no decider");
  return made;
}

const navigate = { id: "n1", name: "browser_navigate", arguments: { url: "https://shop.example/" } };
const observeCalls = (browser: FakeBrowser) => browser.calls.filter((c) => c.name === "browser_evaluate" && !String(c.args["function"]).startsWith("(el)"));

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

describe("who laya-browser is asked for", () => {
  it("is not created while off, without a sidecar, or for an agent that cannot click", async () => {
    const { createBrowserDecider } = await import("../decisions/browser-step.js");
    const browser: FakeBrowser = { current: HOME, calls: [] };
    await writeConfig({ mode: "off" });
    expect(createBrowserDecider(deps(browser) as never)).toBeNull();
    await writeConfig({ mode: "drive" }, "");
    expect(createBrowserDecider(deps(browser) as never)).toBeNull();
    await writeConfig({ mode: "drive" });
    expect(createBrowserDecider(deps(browser, { toolNames: ["browser_snapshot"] }) as never)).toBeNull();
    expect(createBrowserDecider(deps(browser, { toolSchema: () => undefined }) as never), "no server that can read the page").toBeNull();
    expect(createBrowserDecider(deps(browser) as never)).not.toBeNull();
  });
});

describe("drive: the steps laya-browser takes on its own", () => {
  it("takes a click it is sure of as the agent's own browser_click, addressed by a path that selects exactly that element", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    const { bodies } = sidecar([click(2, "Products", 0.97, 0.95)]);
    const d = await decider({ mode: "drive" }, browser);
    expect(await d.proposeStep(), "nothing to act on before a page is open").toBeNull();
    d.afterToolCall(navigate, { success: true });
    const step = await d.proposeStep();
    expect(step?.toolCall.name).toBe("browser_click");
    expect(step?.toolCall.arguments).toEqual({
      element: "Products (link) — picked by the fast browser model, 95% sure",
      ref: "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(2)",
    });
    // What laya-browser read: the goal without the appended blocks, the page without geometry, no history yet.
    expect(bodies[0]!["goal"]).toBe("Open the shop and find the price of the Chair.");
    const actions = (bodies[0]!["observation"] as { actions: Array<Record<string, unknown>> }).actions;
    expect(actions[1]).toEqual({ id: "e2", node: 2, role: "link", label: "Products", kind: "click", value: "" });
    expect(bodies[0]!["history"]).toEqual([]);
  });

  it("selects an option it is sure of through browser_select_option, with the option's value", async () => {
    const browser: FakeBrowser = {
      current: page("https://shop.example/", [{ node: 7, role: "combobox", label: "Sort → Cheapest", kind: "select", value: "cheap", current_value: "Newest" }], {
        7: { path: "html > body:nth-child(2) > select:nth-child(1)" },
      }),
      calls: [],
    };
    sidecar([{
      ...operation("SELECT", 0.96),
      target: { index: "1:1", actionId: "e1", node: 7, kind: "select", label: "Sort → Cheapest", role: "combobox", value: "cheap", probability: 0.93, alternatives: [] },
    }]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    const step = await d.proposeStep();
    expect(step?.toolCall).toMatchObject({ name: "browser_select_option", arguments: { ref: "html > body:nth-child(2) > select:nth-child(1)", values: ["cheap"] } });
  });

  it("leaves the step to the model below the threshold, for typing and finishing, and for a form submit", async () => {
    const cases: Array<[string, Step]> = [
      ["operation below the threshold", click(2, "Products", 0.85, 0.99)],
      ["element below the threshold", click(2, "Products", 0.99, 0.6)],
      ["typing", { ...operation("TYPE_TEXT", 0.99), target: { index: "4", actionId: "e4", node: 4, kind: "fill", label: "Query", role: "textbox", probability: 0.99, alternatives: [] } }],
      ["finishing", operation("DONE", 0.99)],
      ["a form submit", click(3, "Search", 0.99, 0.99)],
    ];
    for (const [name, answer] of cases) {
      const browser: FakeBrowser = { current: HOME, calls: [] };
      sidecar([answer]);
      const d = await decider({ mode: "drive" }, browser);
      d.afterToolCall(navigate, { success: true });
      expect(await d.proposeStep(), name).toBeNull();
    }
    const refusal = logAuditMock.mock.calls.find(([type, data]) => type === "browser_step" && (data as { refused?: string }).refused);
    expect(refusal?.[1]).toMatchObject({ decidedBy: "model", refused: "it submits a form" });
  });

  it("does not follow a link to a host the SSRF guard refuses", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.99, 0.99)]);
    const checkUrl = vi.fn(async (url: string) => (url.includes("/products") ? "requesting private/internal network addresses is not allowed" : null));
    const d = await decider({ mode: "drive" }, browser, { checkUrl });
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).toBeNull();
    expect(checkUrl).toHaveBeenCalledWith("https://shop.example/products");
  });

  it("reads a page once per page state, and again after a page action", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    const { fetchMock } = sidecar([click(2, "Products", 0.5)]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).toBeNull();
    d.afterToolCall({ id: "f1", name: "share_finding", arguments: {} }, { success: true });
    expect(await d.proposeStep()).toBeNull();
    expect(observeCalls(browser)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    d.afterToolCall({ id: "c1", name: "browser_wait_for", arguments: { time: 1 } }, { success: true });
    await d.proposeStep();
    expect(observeCalls(browser)).toHaveLength(2);
  });

  it("scrolls in place when it is sure the element is further down, then clicks it", async () => {
    // The scroll brings the chair into view.
    const browser: FakeBrowser = { current: HOME, calls: [], afterLook: PRODUCTS };
    const { bodies } = sidecar([
      operation("SCROLL_DOWN", 0.95, { control: { actionId: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 } }),
      click(5, "Chair", 0.97, 0.96),
    ]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    const step = await d.proposeStep();
    const wheel = browser.calls.find((c) => c.name === "browser_run_code_unsafe");
    expect(String(wheel?.args["code"])).toContain("page.mouse.wheel(0, 560)");
    expect(step?.toolCall.arguments["ref"]).toBe("html > body:nth-child(2) > main:nth-child(2) > a:nth-child(1)");
    // The second question knows about the scroll, and that it changed the page.
    expect(bodies[1]!["history"]).toEqual([{ action: "Scroll down", kind: "scroll", text: null, page_changed: true }]);
  });

  it("hands back to the model after maxConsecutiveDriven steps in a row, and gives it back the count once it did", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.99)]);
    const d = await decider({ mode: "drive", maxConsecutiveDriven: 2 }, browser);
    d.afterToolCall(navigate, { success: true });
    for (let i = 0; i < 2; i += 1) {
      const step = await d.proposeStep();
      expect(step, `driven step ${i + 1}`).not.toBeNull();
      d.afterToolCall(step!.toolCall, { success: true });
      // Each click leads to another page with the same menu.
      browser.current = i % 2 === 0 ? HOME_AGAIN : HOME;
    }
    expect(await d.proposeStep(), "the model is asked after two in a row").toBeNull();
    const again = await d.proposeStep();
    expect(again, "after the model's turn it may drive again").not.toBeNull();
  });

  it("does not offer an action again that changed nothing, and stops driving after two of its own changed nothing", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    const { bodies } = sidecar([click(2, "Products", 0.99), click(1, "Home", 0.99, 0.99, "e1"), click(2, "Products", 0.99), click(5, "Chair", 0.99)]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    const first = await d.proposeStep();
    d.afterToolCall(first!.toolCall, { success: true });
    // The page did not change.
    const second = await d.proposeStep();
    expect(bodies[1]!["excluded"]).toEqual(["e2"]);
    expect(bodies[1]!["history"]).toEqual([{ action: "Products", kind: "click", text: null, page_changed: false }]);
    d.afterToolCall(second!.toolCall, { success: true });
    expect(await d.proposeStep(), "two of its own steps changed nothing").toBeNull();
    // The model's own page action ends the stall.
    d.afterToolCall({ id: "m1", name: "browser_click", arguments: { element: "Chair", ref: "e9" } }, { success: true });
    browser.current = PRODUCTS;
    expect(await d.proposeStep()).not.toBeNull();
  });

  it("does not credit its own step with what the model's next page action did", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    const { bodies } = sidecar([click(2, "Products", 0.99), operation("DONE", 0.5)]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    const step = await d.proposeStep();
    d.afterToolCall(step!.toolCall, { success: true });
    // Before the page is read again, the model navigates elsewhere.
    d.afterToolCall({ id: "n2", name: "browser_navigate", arguments: { url: "https://shop.example/products" } }, { success: true });
    browser.current = PRODUCTS;
    await d.proposeStep();
    expect(bodies[1]!["history"], "whether the click changed the page is unknown").toEqual([{ action: "Products", kind: "click", text: null, page_changed: null }]);
  });

  it("takes an answer that breaks the sidecar's contract as no answer", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([{ ...click(2, "Products", 0.99), operationProbability: 1.7 }]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).toBeNull();
  });

  it("hands the page back when the run stopped its call before it ran, instead of proposing it again", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.99)]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).not.toBeNull();
    // No afterToolCall: a cap of the run refused the call.
    expect(await d.proposeStep()).toBeNull();
    expect(await d.proposeStep(), "and stays quiet until the model acts on the page").toBeNull();
  });

  it("hands the page back when its own call failed", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.99)]);
    const d = await decider({ mode: "drive" }, browser);
    d.afterToolCall(navigate, { success: true });
    const step = await d.proposeStep();
    d.afterToolCall(step!.toolCall, { success: false });
    expect(await d.proposeStep()).toBeNull();
  });

  it("drives only on an English goal: a German task is translated first, and without a translation it only watches", async () => {
    const task = "Öffne den Shop und finde heraus, was der Stuhl kostet.";
    const browser: FakeBrowser = { current: HOME, calls: [] };
    const { bodies } = sidecar([click(2, "Products", 0.99)]);
    const translate = vi.fn(async () => "Open the shop and find out what the chair costs.");
    const d = await decider({ mode: "drive" }, browser, { task, translate });
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).not.toBeNull();
    expect(translate).toHaveBeenCalledWith(task);
    expect(bodies[0]!["goal"]).toBe("Open the shop and find out what the chair costs.");

    const untranslated = await decider({ mode: "drive" }, { current: HOME, calls: [] }, { task, translate: async () => null });
    untranslated.afterToolCall(navigate, { success: true });
    expect(await untranslated.proposeStep()).toBeNull();
  });
});

describe("adaptive: laya-browser acts where the comparisons show it agrees", () => {
  const snapshot = "- link \"Home\" [ref=e5]\n- link \"Products\" [ref=e7]";
  const noAudits = { adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 0 } };

  /** 40 steps where laya-browser's click at 0.65 agreed with the model, and 10 at 0.55 where it did not. */
  async function evidence() {
    const { recordAgreementSample } = await import("../decisions/gate.js");
    for (let i = 0; i < 40; i += 1) recordAgreementSample("browser_step", "en", "CLICK", 0.65, true, "laya-browser-test");
    for (let i = 0; i < 10; i += 1) recordAgreementSample("browser_step", "en", "CLICK", 0.55, false, "laya-browser-test");
  }

  it("reads no page before the model's turn while nothing has qualified, and learns from every comparison", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.62, 0.62)]);
    const d = await decider({ mode: "adaptive" }, browser, {}, noAudits);
    d.afterToolCall(navigate, { success: true, output: snapshot });
    expect(await d.proposeStep()).toBeNull();
    expect(observeCalls(browser), "the page is not read for a step it may not take").toHaveLength(0);
    await d.beforeModelActions([{ id: "m1", name: "browser_click", arguments: { element: "Products", ref: "e7" } }]);
    const { gateSnapshot } = await import("../decisions/gate.js");
    await vi.waitFor(() => expect(gateSnapshot({ targetAgreement: 0.9, minSamples: 30 })).toEqual([
      { point: "browser_step", language: "en", answer: "CLICK", model: "laya-browser-test", samples: 1, agreement: 1, qualifiedLevel: null },
    ]));
    await (await import("../decisions/ledger.js")).flushLedgerForTests();
    const row = JSON.parse(readFileSync(browserLedgerPath, "utf8").trim()) as Record<string, unknown>;
    expect(row).toMatchObject({ point: "browser_step", language: "en", gate: { answer: "CLICK", top: 0.62, agree: true } });
  });

  it("counts a different operation as a disagreement, and an unfound element as no sample", async () => {
    const { gateSnapshot } = await import("../decisions/gate.js");
    const browser: FakeBrowser = { current: HOME, calls: [], mapIds: { self: null, ancestors: [], inner: [] } };
    sidecar([operation("DONE", 0.8)]);
    const d = await decider({ mode: "adaptive" }, browser, {}, noAudits);
    d.afterToolCall(navigate, { success: true, output: snapshot });
    await d.beforeModelActions([{ id: "m1", name: "browser_click", arguments: { element: "Products", ref: "e7" } }]);
    await vi.waitFor(() => expect(gateSnapshot({ targetAgreement: 0.9, minSamples: 30 })).toMatchObject([{ answer: "DONE", samples: 1, agreement: 0 }]));

    const unfound = await decider({ mode: "adaptive" }, { current: HOME, calls: [], mapIds: { self: null, ancestors: [], inner: [] } }, {}, noAudits);
    sidecar([click(2, "Products", 0.7)]);
    unfound.afterToolCall(navigate, { success: true });
    await unfound.beforeModelActions([{ id: "m2", name: "browser_click", arguments: { element: "somewhere", ref: "e99" } }]);
    await vi.waitFor(() => expect(logAuditMock.mock.calls.filter(([type]) => type === "browser_step")).toHaveLength(2));
    expect(gateSnapshot({ targetAgreement: 0.9, minSamples: 30 }).find((row) => row.answer === "CLICK"), "the element could not be compared").toBeUndefined();
  });

  it("takes a click once its confidence has qualified, and not one below that", async () => {
    await evidence();
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.64)]);
    const d = await decider({ mode: "adaptive" }, browser, {}, noAudits);
    d.afterToolCall(navigate, { success: true });
    const step = await d.proposeStep();
    expect(step?.toolCall).toMatchObject({ name: "browser_click", arguments: { ref: "html > body:nth-child(2) > nav:nth-child(1) > a:nth-child(2)" } });

    const below = await decider({ mode: "adaptive" }, { current: HOME, calls: [] }, {}, noAudits);
    sidecar([click(2, "Products", 0.95, 0.58)]);
    below.afterToolCall(navigate, { success: true });
    expect(await below.proposeStep(), "0.58 is below the qualified 0.6").toBeNull();
  });

  it("counts evidence for the version that earned it: a new checkpoint compares first, without reading ahead", async () => {
    await evidence();
    // The first answer of this process names a version the evidence was not earned by.
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([{ ...click(2, "Products", 0.64), model: "laya-browser-v2" }]);
    const d = await decider({ mode: "adaptive" }, browser, {}, noAudits);
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep(), "the old version's evidence does not hand the new one the click").toBeNull();
    expect(observeCalls(browser), "one read, to learn which version answers").toHaveLength(1);
    // Now that the new version is known and has no evidence, the page is not read ahead of the model any more.
    d.afterToolCall({ id: "w1", name: "browser_wait_for", arguments: {} }, { success: true });
    expect(await d.proposeStep()).toBeNull();
    expect(observeCalls(browser)).toHaveLength(1);
  });

  it("still hands a share of what it may take to the model, to keep measuring", async () => {
    await evidence();
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.64)]);
    const d = await decider({ mode: "adaptive" }, browser, {}, { adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 1 } });
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).toBeNull();
  });

  it("rebuilds what it learnt from the browser ledger after a restart", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempDir, "decisions"), { recursive: true });
    const rows = Array.from({ length: 40 }, () => JSON.stringify({ point: "browser_step", language: "en", gate: { answer: "CLICK", top: 0.8, agree: true, model: "laya-browser-test" }, decidedBy: "model" }));
    writeFileSync(browserLedgerPath, `${rows.join("\n")}\n`, "utf8");
    await writeConfig({ mode: "adaptive" });
    const { seedBrowserGate } = await import("../decisions/browser-step.js");
    const { qualifiedLevel } = await import("../decisions/gate.js");
    await seedBrowserGate();
    expect(qualifiedLevel("browser_step", "en", "CLICK", { targetAgreement: 0.9, minSamples: 30 }, "laya-browser-test")).toBe(0.5);
  });
});

describe("shadow: the model's step against laya-browser's", () => {
  it("finds the model's element by its role and name in the model's last snapshot, and records both choices", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([click(2, "Products", 0.8)]);
    const d = await decider({ mode: "shadow" }, browser);
    d.afterToolCall(navigate, { success: true, output: "### Snapshot\n```yaml\n- navigation [ref=e3]:\n  - link \"Home\" [ref=e5]\n  - link \"Products\" [ref=e7] [cursor=pointer]\n```" });
    const modelClick = { id: "m1", name: "browser_click", arguments: { element: "Products link", ref: "e7" } };
    await d.beforeModelActions([modelClick]);
    await vi.waitFor(() => expect(logAuditMock.mock.calls.some(([type]) => type === "browser_step")).toBe(true));
    const row = logAuditMock.mock.calls.find(([type]) => type === "browser_step")![1];
    expect(row).toMatchObject({ decidedBy: "model", agree: true, targetAgree: true, model: { tool: "browser_click", operation: "CLICK", target: "Products", found: "name" } });
    expect(browser.calls.filter((c) => String(c.args["function"] ?? "").startsWith("(el)")), "no page call needed to find it").toHaveLength(0);
    await (await import("../decisions/ledger.js")).flushLedgerForTests();
    const ledger = readFileSync(browserLedgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ decidedBy: "model", model: { node: 2, found: "name" }, laya: { operation: "CLICK", target: { node: 2 } }, agree: { operation: true, target: true } });
    expect((ledger[0]!["observation"] as { actions: Array<Record<string, unknown>> }).actions[0]).not.toHaveProperty("rect");
    // The model's click, once it ran, is laya-browser's history for the next page.
    d.afterToolCall(modelClick, { success: true });
    browser.current = PRODUCTS;
    d.afterToolCall({ id: "w1", name: "browser_wait_for", arguments: {} }, { success: true });
  });

  it("asks the page which element the model meant when its name is ambiguous", async () => {
    const browser: FakeBrowser = {
      current: page("https://news.example/", [
        { node: 8, role: "link", label: "Read more", kind: "click" },
        { node: 9, role: "link", label: "Read more", kind: "click" },
      ]),
      calls: [],
      mapIds: { self: null, ancestors: [9], inner: [] },
    };
    sidecar([click(8, "Read more", 0.7, 0.7, "e1")]);
    const d = await decider({ mode: "shadow" }, browser);
    d.afterToolCall(navigate, { success: true, output: "- link \"Read more\" [ref=e10]\n- link \"Read more\" [ref=e11]" });
    await d.beforeModelActions([{ id: "m2", name: "browser_click", arguments: { element: "second Read more", ref: "e11" } }]);
    const mapCall = browser.calls.find((c) => String(c.args["function"] ?? "").startsWith("(el)"));
    expect(mapCall?.args).toMatchObject({ ref: "e11", element: "second Read more" });
    await vi.waitFor(() => expect(logAuditMock.mock.calls.some(([type]) => type === "browser_step")).toBe(true));
    const row = logAuditMock.mock.calls.find(([type]) => type === "browser_step")![1];
    expect(row).toMatchObject({ agree: true, targetAgree: false, model: { found: "ancestor" } });
  });

  it("compares a final answer with laya-browser's DONE, and never takes a step itself", async () => {
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([operation("DONE", 0.9)]);
    const d = await decider({ mode: "shadow" }, browser);
    d.afterToolCall(navigate, { success: true });
    expect(await d.proposeStep()).toBeNull();
    d.noteFinalAnswer();
    await vi.waitFor(() => expect(logAuditMock.mock.calls.some(([type]) => type === "browser_step")).toBe(true));
    expect(logAuditMock.mock.calls.find(([type]) => type === "browser_step")![1]).toMatchObject({ agree: true, model: { operation: "DONE" } });
  });

  it("writes no ledger while the ledger is off", async () => {
    await writeConfig({ mode: "shadow" });
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      gateway: { jwtSecret: "t".repeat(32) },
      decisions: { baseUrl: "http://laya:8080", ledger: { path: ledgerPath, enabled: false }, browser: { mode: "shadow" } },
    }), "utf8");
    (await import("../config/loader.js")).resetConfigForTests();
    const browser: FakeBrowser = { current: HOME, calls: [] };
    sidecar([operation("DONE", 0.9)]);
    const { createBrowserDecider } = await import("../decisions/browser-step.js");
    const d = createBrowserDecider(deps(browser) as never)!;
    d.afterToolCall(navigate, { success: true });
    d.noteFinalAnswer();
    await vi.waitFor(() => expect(logAuditMock.mock.calls.some(([type]) => type === "browser_step")).toBe(true));
    await (await import("../decisions/ledger.js")).flushLedgerForTests();
    expect(existsSync(browserLedgerPath)).toBe(false);
  });
});

describe("the report", () => {
  it("shows laya-browser as the point browser_step, qualified where the gate would qualify it", async () => {
    const { browserRowsForReport, buildDecisionReport } = await import("../scripts/decisions-report.js");
    const rows = [
      ...Array.from({ length: 40 }, () => ({ point: "browser_step", language: "en", mode: "adaptive", decidedBy: "model", laya: { operation: "CLICK", ms: 20 }, gate: { answer: "CLICK", top: 0.7, agree: true } })),
      ...Array.from({ length: 5 }, () => ({ point: "browser_step", language: "en", mode: "adaptive", decidedBy: "model", laya: { operation: "CLICK", ms: 20 }, gate: { answer: "CLICK", top: 0.55, agree: false } })),
      { point: "browser_step", language: "en", mode: "adaptive", decidedBy: "laya", laya: { operation: "CLICK", operationProbability: 0.9, target: { probability: 0.72 }, ms: 18 } },
      { point: "fast_lane", language: "en", decidedBy: "model" },
    ];
    const [report] = buildDecisionReport(browserRowsForReport(rows), 0.9, 30);
    expect(report).toMatchObject({ point: "browser_step", language: "en", rows: 46, decidedByLaya: 1, bothAnswered: 45, incumbentMedianMs: null });
    expect(report!.answers).toEqual([expect.objectContaining({ answer: "CLICK", qualifiedLevel: 0.6 })]);
  });

  it("keeps each checkpoint version's statistics apart, as the gate does", async () => {
    const { browserRowsForReport, buildDecisionReport } = await import("../scripts/decisions-report.js");
    const row = (model: string, agree: boolean) => ({ point: "browser_step", language: "en", decidedBy: "model", laya: { operation: "CLICK", ms: 20 }, gate: { answer: "CLICK", top: 0.7, agree, model } });
    const report = buildDecisionReport(browserRowsForReport([row("v14s", false), row("v14s", false), row("run-2", true)]), 0.9, 30);
    expect(report.map((r) => [r.model, r.bothAnswered, r.agreement])).toEqual([["run-2", 1, 1], ["v14s", 2, 0]]);
  });
});

describe("the training export", () => {
  it("keeps the steps the agent's model took, with what laya-browser read, and leaves laya-browser's own out", async () => {
    const { buildBrowserTrainingRows } = await import("../scripts/decisions-export.js");
    const read = { goal: "Open the shop", observation: { url: "https://shop.example/", actions: [] }, history: [], sessionId: "s1", ts: "t" };
    const rows = buildBrowserTrainingRows([
      { point: "browser_step", decidedBy: "model", model: { tool: "browser_click", operation: "CLICK", node: 2 }, laya: { operation: "CLICK" }, gate: {}, ...read },
      // laya-browser's own step — left out by who decided it, whatever the row says of a model step.
      { point: "browser_step", decidedBy: "laya", model: { tool: "browser_click", operation: "CLICK", node: 2 }, laya: { operation: "CLICK" }, ...read },
      { point: "browser_step", decidedBy: "model", model: { tool: "final_answer", operation: "DONE", node: null }, ...read },
      { point: "fast_lane", decidedBy: "incumbent" },
    ]);
    expect(rows).toEqual([
      { ts: "t", sessionId: "s1", goal: "Open the shop", observation: read.observation, history: [], excluded: [], model: { tool: "browser_click", operation: "CLICK", node: 2 }, decidedBy: "model" },
      { ts: "t", sessionId: "s1", goal: "Open the shop", observation: read.observation, history: [], excluded: [], model: { tool: "final_answer", operation: "DONE", node: null }, decidedBy: "model" },
    ]);
  });
});

describe("reading Playwright's answers", () => {
  it("takes the JSON of a result section, however it is laid out, and nothing after it", async () => {
    const { readEvaluateResult } = await import("../decisions/browser-step.js");
    expect(readEvaluateResult(evaluateAnswer({ a: [1, { b: "x\n### y" }] }))).toEqual({ a: [1, { b: "x\n### y" }] });
    expect(readEvaluateResult("### Result\n42")).toBe(42);
    expect(readEvaluateResult("### Error\nboom")).toBeUndefined();
  });

  it("reads role and name of every addressable element from a snapshot", async () => {
    const { parseAriaRefs } = await import("../decisions/browser-step.js");
    const refs = parseAriaRefs("- generic [ref=e2]:\n  - link \"Say \\\"hi\\\"\" [ref=e3] [cursor=pointer]:\n    - /url: /hi\n  - textbox \"Query\" [active] [ref=e4]");
    expect(refs.get("e2")).toEqual({ role: "generic", name: "" });
    expect(refs.get("e3")).toEqual({ role: "link", name: "Say \"hi\"" });
    expect(refs.get("e4")).toEqual({ role: "textbox", name: "Query" });
  });

  it("finds the model's element by name only when exactly one observed element has it", async () => {
    const { nodeByName } = await import("../decisions/browser-step.js");
    const observation = HOME.observation as never;
    expect(nodeByName({ role: "link", name: " products " }, observation)).toBe(2);
    expect(nodeByName({ role: "textbox", name: "Query" }, observation), "a field's own name, not its 'Open …' click").toBe(4);
    expect(nodeByName({ role: "button", name: "Products" }, observation), "same name, other role").toBeNull();
    expect(nodeByName({ role: "link", name: "" }, observation)).toBeNull();
  });

  it("maps the model's element to itself, else its nearest observed ancestor, else its one observed descendant", async () => {
    const { nodeFromIds } = await import("../decisions/browser-step.js");
    const observation = HOME.observation as never;
    expect(nodeFromIds({ self: 2, ancestors: [1], inner: [] }, observation)).toEqual({ node: 2, how: "exact" });
    expect(nodeFromIds({ self: 99, ancestors: [98, 1], inner: [] }, observation)).toEqual({ node: 1, how: "ancestor" });
    expect(nodeFromIds({ self: null, ancestors: [], inner: [3] }, observation)).toEqual({ node: 3, how: "descendant" });
    expect(nodeFromIds({ self: null, ancestors: [], inner: [3, 4] }, observation), "two candidates inside: unknown").toBeNull();
  });

  it("reads the instruction as the goal, without the blocks appended to it", async () => {
    const { browserGoalText } = await import("../decisions/browser-step.js");
    expect(browserGoalText("Find the  opening hours.\n\n[LANGUAGE] Reason in English.")).toBe("Find the opening hours.");
    expect(browserGoalText(`${"Open the page. ".repeat(40)}`).length).toBeLessThanOrEqual(400);
  });
});
