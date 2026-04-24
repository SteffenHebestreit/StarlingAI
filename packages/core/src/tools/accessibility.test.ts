import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials/store.js", () => ({
  getCredential: vi.fn((name: string) => name === "psi_key" ? "stored-psi-key" : undefined),
}));

const callPlaywrightMock = vi.fn();
vi.mock("./multimodal.js", () => ({
  callPlaywrightTool: callPlaywrightMock,
}));

async function setupConfig(extra: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-a11y-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    sourceForge: {
      pageSpeedInsightsApiKey: "secret:psi_key",
      github: {},
      ...extra,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  return tempDir;
}

describe("accessibility tools", () => {
  const cleanup: string[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callPlaywrightMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
  });

  async function getTool(name: string) {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./accessibility.js"),
    ]);
    return getTool(name)!;
  }

  function ctx() {
    return { sessionId: "s1", workspacePath: "/tmp" };
  }

  it("registers both accessibility tools at Tier 0", async () => {
    const [{ getAllTools }, { getToolTier }] = await Promise.all([
      import("./registry.js"),
      import("../guardrails/tool-tiers.js"),
      import("./accessibility.js"),
    ]);
    const names = getAllTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["browser_axe_audit", "lighthouse_audit"]));
    expect(getToolTier("browser_axe_audit").tier).toBe(0);
    expect(getToolTier("lighthouse_audit").tier).toBe(0);
  });

  it("browser_axe_audit navigates, evaluates, and groups violations by severity", async () => {
    callPlaywrightMock.mockImplementation(async (toolName: string) => {
      if (toolName === "browser_navigate") return "navigated";
      if (toolName === "browser_evaluate") {
        return JSON.stringify({
          url: "https://example.com",
          testEngine: { name: "axe-core", version: "4.9.0" },
          violations: [
            {
              id: "color-contrast",
              impact: "serious",
              help: "Elements must have sufficient color contrast",
              helpUrl: "https://dequeuniversity.com/rules/axe/4/color-contrast",
              tags: ["cat.color", "wcag2aa", "wcag143"],
              nodes: [
                { target: ["button.primary"], html: "<button class=\"primary\">Go</button>", failureSummary: "contrast ratio 2.5:1" },
                { target: ["a.subtle"], html: "<a class=\"subtle\">More</a>", failureSummary: "contrast ratio 2.1:1" },
              ],
            },
            {
              id: "image-alt",
              impact: "critical",
              help: "Images must have alternate text",
              helpUrl: "https://dequeuniversity.com/rules/axe/4/image-alt",
              tags: ["wcag2a", "wcag111"],
              nodes: [{ target: ["img.hero"], html: "<img class=\"hero\" src=\"/hero.jpg\">", failureSummary: "missing alt" }],
            },
          ],
          incomplete: [],
        });
      }
      return "";
    });

    const result = await (await getTool("browser_axe_audit")).execute({
      url: "https://example.com",
      waitSeconds: 0,
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["totalViolations"]).toBe(2);
    expect(result.metadata?.["critical"]).toBe(1);
    expect(result.metadata?.["serious"]).toBe(1);
    expect(result.output).toContain("color-contrast");
    expect(result.output).toContain("image-alt");
    expect(result.output).toContain("CRITICAL (1)");
    expect(result.output).toContain("SERIOUS (1)");
    expect(callPlaywrightMock).toHaveBeenCalledWith("browser_navigate", { url: "https://example.com" });
  });

  it("browser_axe_audit passes runOnly tags + disabled rules to the injected script", async () => {
    callPlaywrightMock.mockImplementation(async (toolName: string) => {
      if (toolName === "browser_evaluate") {
        return JSON.stringify({ url: "https://current", violations: [], incomplete: [] });
      }
      return "";
    });

    await (await getTool("browser_axe_audit")).execute({
      runOnly: ["wcag2a", "wcag22aa"],
      disableRules: ["color-contrast"],
    }, ctx());

    const lastEvaluateCall = callPlaywrightMock.mock.calls.find((call) => call[0] === "browser_evaluate");
    expect(lastEvaluateCall).toBeDefined();
    const injectedScript = (lastEvaluateCall![1] as { function: string }).function;
    expect(injectedScript).toContain('["wcag2a","wcag22aa"]');
    expect(injectedScript).toContain('"color-contrast"');
  });

  it("browser_axe_audit surfaces non-JSON evaluate output as an error", async () => {
    callPlaywrightMock.mockImplementation(async (toolName: string) => {
      if (toolName === "browser_evaluate") return "not-json at all";
      return "";
    });

    const result = await (await getTool("browser_axe_audit")).execute({
      url: "https://example.com",
    }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain("non-JSON");
  });

  it("lighthouse_audit rejects missing URL + wrong scheme", async () => {
    cleanup.push(await setupConfig());
    const tool = await getTool("lighthouse_audit");

    const missing = await tool.execute({}, ctx());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("url is required");

    const bad = await tool.execute({ url: "ftp://example.com" }, ctx());
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("http://");
  });

  it("lighthouse_audit calls PageSpeed Insights with api key, categories, and strategy", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      lighthouseResult: {
        lighthouseVersion: "11.5.0",
        fetchTime: "2026-04-24T10:00:00Z",
        categories: {
          performance: { title: "Performance", score: 0.78, auditRefs: [{ id: "largest-contentful-paint" }] },
          accessibility: { title: "Accessibility", score: 0.92, auditRefs: [{ id: "color-contrast" }] },
          "best-practices": { title: "Best Practices", score: 0.83, auditRefs: [] },
          seo: { title: "SEO", score: 1.0, auditRefs: [] },
        },
        audits: {
          "largest-contentful-paint": { title: "Largest Contentful Paint", score: 0.4, displayValue: "4.1 s" },
          "color-contrast": { title: "Background and foreground colors do not have a sufficient contrast ratio", score: 0, displayValue: "6 elements failed" },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await (await getTool("lighthouse_audit")).execute({
      url: "https://example.com",
      strategy: "desktop",
      categories: ["performance", "accessibility"],
      locale: "en",
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["scores"]).toMatchObject({ performance: 78, accessibility: 92, "best-practices": 83, seo: 100 });
    expect(result.output).toContain("78/100");
    expect(result.output).toContain("92/100");
    expect(result.output).toContain("Top performance issues");
    expect(result.output).toContain("4.1 s");

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("url")).toBe("https://example.com");
    expect(url.searchParams.get("strategy")).toBe("desktop");
    expect(url.searchParams.getAll("category")).toEqual(["PERFORMANCE", "ACCESSIBILITY"]);
    expect(url.searchParams.get("locale")).toBe("en");
    expect(url.searchParams.get("key")).toBe("stored-psi-key");
  });

  it("lighthouse_audit surfaces API errors with truncated body", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response("quota exceeded", { status: 429 }));

    const result = await (await getTool("lighthouse_audit")).execute({
      url: "https://example.com",
    }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 429");
    expect(result.output).toContain("quota exceeded");
  });
});
