/**
 * Accessibility / web-audit tools — Wave F.
 *
 * browser_axe_audit    — inject axe-core into the shared Playwright session
 *                        and return WCAG violations grouped by severity.
 * lighthouse_audit     — call Google PageSpeed Insights (Lighthouse-as-a-service)
 *                        for performance / accessibility / best-practices /
 *                        SEO scores and the top issues per category.
 *
 * Both target live external URLs. No local Chrome / Lighthouse runtime is
 * ever launched — browser_axe_audit reuses the existing Playwright MCP
 * bridge, and lighthouse_audit is a pure HTTP call.
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { registerTool, type ToolResult } from "./registry.js";
import { callPlaywrightTool } from "./multimodal.js";
import { fetchWithTimeout, resolveSecretRef } from "./infrastructure-shared.js";

const log = childLogger("tool:accessibility");

function fail(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

// ─────────────────────────────────────────────────────────────────────────────
// browser_axe_audit
// ─────────────────────────────────────────────────────────────────────────────

registerTool({
  name: "browser_axe_audit",
  description:
    "Run an axe-core WCAG accessibility audit against the current Playwright browser page (or navigate to a fresh URL first). Axe is fetched from the jsdelivr CDN and executed in the page context, so this requires outbound network from the browser. Returns violations grouped by severity (critical / serious / moderate / minor), each with WCAG tags, impacted nodes, and a remediation hint.",
  embeddingDescription:
    "axe-core accessibility audit wcag violations browser check a11y aria landmarks contrast labels roles keyboard focus",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Optional URL to navigate to before running the audit. When omitted, audits the current browser page.",
      },
      waitForSelector: {
        type: "string",
        description: "Optional CSS selector that must be visible before running the audit (e.g. 'main' or '#root > *').",
      },
      waitSeconds: {
        type: "number",
        description: "Optional settle delay in seconds after navigation before running the audit (default 0).",
      },
      runOnly: {
        type: "array",
        description: "Optional axe tag / rule filter (e.g. ['wcag2a', 'wcag2aa', 'wcag22aa']). Defaults to WCAG 2.1 AA + WCAG 2.2 AA.",
        items: { type: "string" },
      },
      disableRules: {
        type: "array",
        description: "Optional list of axe rule ids to skip (e.g. ['color-contrast']).",
        items: { type: "string" },
      },
      maxNodesPerViolation: {
        type: "number",
        description: "Cap on impacted nodes reported per violation (defaults to 5 to keep output readable).",
      },
    },
    required: [],
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const url = typeof args["url"] === "string" && String(args["url"]).trim() ? String(args["url"]).trim() : "";
    const waitForSelector = typeof args["waitForSelector"] === "string" ? String(args["waitForSelector"]).trim() : "";
    const waitSeconds = typeof args["waitSeconds"] === "number" && Number.isFinite(args["waitSeconds"])
      ? Math.max(0, Math.min(60, args["waitSeconds"]))
      : 0;
    const runOnly = Array.isArray(args["runOnly"])
      ? args["runOnly"].map((v) => String(v)).filter(Boolean)
      : ["wcag2a", "wcag2aa", "wcag22aa"];
    const disableRules = Array.isArray(args["disableRules"])
      ? args["disableRules"].map((v) => String(v)).filter(Boolean)
      : [];
    const maxNodes = typeof args["maxNodesPerViolation"] === "number" && Number.isFinite(args["maxNodesPerViolation"])
      ? Math.max(1, Math.min(50, Math.trunc(args["maxNodesPerViolation"])))
      : 5;

    try {
      if (url) {
        await callPlaywrightTool("browser_navigate", { url });
      }
      if (waitForSelector) {
        // Browser MCP offers either text or time waits; emulate selector waits
        // by polling via browser_evaluate until the element exists or we time
        // out after ~10 s.
        const probeScript = `() => Boolean(document.querySelector(${JSON.stringify(waitForSelector)}))`;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const probe = await callPlaywrightTool("browser_evaluate", { function: probeScript });
          if (probe && probe.includes("true")) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (waitSeconds > 0) {
        await callPlaywrightTool("browser_wait_for", { time: waitSeconds });
      }

      const injectionScript = `async () => {
  if (!window.axe) {
    await new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js';
      tag.crossOrigin = 'anonymous';
      tag.onload = () => resolve();
      tag.onerror = () => reject(new Error('Failed to load axe-core from jsdelivr'));
      document.head.appendChild(tag);
    });
  }
  const options = {
    runOnly: { type: 'tag', values: ${JSON.stringify(runOnly)} },
    rules: Object.fromEntries(${JSON.stringify(disableRules)}.map((id) => [id, { enabled: false }])),
    resultTypes: ['violations', 'incomplete'],
  };
  const result = await window.axe.run(document, options);
  return {
    url: result.url,
    testEngine: result.testEngine,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.slice(0, ${maxNodes}).map((n) => ({
        target: n.target,
        html: n.html ? n.html.slice(0, 400) : '',
        failureSummary: n.failureSummary,
      })),
      nodeCount: v.nodes.length,
    })),
    incomplete: result.incomplete.map((v) => ({ id: v.id, description: v.description, nodeCount: v.nodes.length })),
  };
}`;

      const raw = await callPlaywrightTool("browser_evaluate", { function: injectionScript });
      const parsed = parsePlaywrightJson(raw);
      if (!parsed) {
        return { success: false, output: raw || "", error: "axe audit returned non-JSON output" };
      }

      const violations = Array.isArray(parsed["violations"]) ? parsed["violations"] as Array<Record<string, unknown>> : [];
      const severityBuckets = groupBySeverity(violations);

      const lines: string[] = [];
      lines.push(`URL: ${String(parsed["url"] ?? url ?? "(current page)")}`);
      const engine = parsed["testEngine"] as { name?: string; version?: string } | undefined;
      if (engine) lines.push(`Engine: ${engine.name ?? "axe-core"} ${engine.version ?? ""}`.trim());
      lines.push(`Violations: ${violations.length} (critical ${severityBuckets.critical.length} · serious ${severityBuckets.serious.length} · moderate ${severityBuckets.moderate.length} · minor ${severityBuckets.minor.length})`);
      for (const severity of ["critical", "serious", "moderate", "minor"] as const) {
        if (severityBuckets[severity].length === 0) continue;
        lines.push("");
        lines.push(`=== ${severity.toUpperCase()} (${severityBuckets[severity].length}) ===`);
        for (const v of severityBuckets[severity]) {
          const tags = Array.isArray(v["tags"]) ? (v["tags"] as string[]).filter((t) => /wcag|best-practice|section508/.test(t)).join(", ") : "";
          lines.push(`• [${v["id"]}] ${v["help"]} ${tags ? `(${tags})` : ""}`);
          const nodes = Array.isArray(v["nodes"]) ? v["nodes"] as Array<Record<string, unknown>> : [];
          const nodeCount = typeof v["nodeCount"] === "number" ? v["nodeCount"] as number : nodes.length;
          if (nodeCount > 0) {
            lines.push(`  ${nodeCount} affected node${nodeCount === 1 ? "" : "s"} (showing first ${nodes.length}):`);
            for (const node of nodes) {
              const target = Array.isArray(node["target"]) ? (node["target"] as string[]).join(" ") : String(node["target"] ?? "");
              lines.push(`    - ${target}`);
            }
          }
          if (v["helpUrl"]) lines.push(`  docs: ${v["helpUrl"]}`);
        }
      }

      return {
        success: true,
        output: lines.join("\n"),
        metadata: {
          url: parsed["url"] ?? url ?? null,
          totalViolations: violations.length,
          critical: severityBuckets.critical.length,
          serious: severityBuckets.serious.length,
          moderate: severityBuckets.moderate.length,
          minor: severityBuckets.minor.length,
          incompleteCount: Array.isArray(parsed["incomplete"]) ? (parsed["incomplete"] as unknown[]).length : 0,
        },
      };
    } catch (error) {
      log.error({ error, url }, "browser_axe_audit failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

function tryJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Extract the first balanced JSON object/array from arbitrary text, honoring
 * string literals and escapes so braces inside strings don't miscount. Returns
 * the substring (unparsed) or null.
 */
function extractBalancedJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the JSON return value out of a Playwright MCP browser_evaluate response.
 * Modern @playwright/mcp echoes the executed code in a ```js fence and then
 * prints the return value after a "Result" marker (older builds returned bare
 * JSON or a ```json fence or a quoted string). Try, in order: the whole thing,
 * an explicit ```json fence, the value after a Result marker, the text with all
 * code fences stripped, and finally a balanced-JSON extraction from each — so
 * the echoed function body's own braces never get parsed as the result.
 */
function parsePlaywrightJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];

  const jsonFence = trimmed.match(/```json\s*([\s\S]+?)\s*```/i);
  if (jsonFence?.[1]) candidates.push(jsonFence[1]);

  // Content after a "Result" / "### Result" / "- Result:" marker.
  const resultMatch = trimmed.match(/(?:^|\n)[#\-\s]*result\s*:?\s*\n?([\s\S]+)$/i);
  if (resultMatch?.[1]) {
    candidates.push(resultMatch[1]);
    const innerFence = resultMatch[1].match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (innerFence?.[1]) candidates.push(innerFence[1]);
  }

  // Text with all fenced code blocks removed (drops the echoed js function).
  candidates.push(trimmed.replace(/```[\s\S]*?```/g, " "));

  for (const c of candidates) {
    const s = c.trim();
    if (!s) continue;
    const direct = tryJsonObject(s);
    if (direct) return direct;
    const extracted = extractBalancedJson(s);
    if (extracted) {
      const parsed = tryJsonObject(extracted);
      if (parsed) return parsed;
    }
  }

  // Legacy: whole response is a quoted JSON string.
  const quoted = trimmed.match(/^\s*"(.+)"\s*$/s);
  if (quoted?.[1]) {
    const unescaped = tryJsonObject(quoted[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
    if (unescaped) return unescaped;
  }
  return null;
}

function groupBySeverity(violations: Array<Record<string, unknown>>): {
  critical: Array<Record<string, unknown>>;
  serious: Array<Record<string, unknown>>;
  moderate: Array<Record<string, unknown>>;
  minor: Array<Record<string, unknown>>;
} {
  const buckets = { critical: [] as Array<Record<string, unknown>>, serious: [] as Array<Record<string, unknown>>, moderate: [] as Array<Record<string, unknown>>, minor: [] as Array<Record<string, unknown>> };
  for (const v of violations) {
    const impact = String(v["impact"] ?? "minor").toLowerCase();
    if (impact === "critical") buckets.critical.push(v);
    else if (impact === "serious") buckets.serious.push(v);
    else if (impact === "moderate") buckets.moderate.push(v);
    else buckets.minor.push(v);
  }
  return buckets;
}

// ─────────────────────────────────────────────────────────────────────────────
// lighthouse_audit — Google PageSpeed Insights API
// ─────────────────────────────────────────────────────────────────────────────

const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

registerTool({
  name: "lighthouse_audit",
  description:
    "Run a Lighthouse audit on a public URL via the Google PageSpeed Insights API and return scores for performance / accessibility / best-practices / SEO, plus top opportunities and diagnostics. Strategy 'mobile' uses the mobile Lighthouse profile (default); 'desktop' uses the desktop profile. Optional API key from sourceForge.pageSpeedInsightsApiKey avoids the strict anonymous quota.",
  embeddingDescription:
    "lighthouse pagespeed audit performance accessibility best-practices seo web vitals lcp cls fid inp score google",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public URL to audit." },
      strategy: {
        type: "string",
        enum: ["mobile", "desktop"],
        description: "Lighthouse profile. Defaults to mobile (matches what Google ranks against).",
      },
      categories: {
        type: "array",
        description: "Optional subset of Lighthouse categories. Defaults to all four (performance, accessibility, best-practices, seo).",
        items: { type: "string", enum: ["performance", "accessibility", "best-practices", "seo", "pwa"] },
      },
      locale: {
        type: "string",
        description: "Optional BCP-47 locale for the Lighthouse report (e.g. 'en', 'de').",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms (PageSpeed can take 30-90s). Defaults to 120000.",
      },
    },
    required: ["url"],
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const url = String(args["url"] ?? "").trim();
    if (!url) return fail("url is required");
    if (!/^https?:\/\//i.test(url)) return fail("url must start with http:// or https://");

    const strategy = args["strategy"] === "desktop" ? "desktop" : "mobile";
    const categories = Array.isArray(args["categories"]) && args["categories"].length > 0
      ? (args["categories"] as string[])
      : ["performance", "accessibility", "best-practices", "seo"];
    const locale = typeof args["locale"] === "string" && String(args["locale"]).trim() ? String(args["locale"]).trim() : "";
    const timeoutMs = typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])
      ? Math.max(5_000, Math.min(300_000, Math.trunc(args["timeoutMs"])))
      : 120_000;

    const config = getConfig();
    const apiKeyRaw = (config.sourceForge as unknown as { pageSpeedInsightsApiKey?: string })?.pageSpeedInsightsApiKey;
    const apiKey = apiKeyRaw ? (resolveSecretRef(apiKeyRaw) ?? apiKeyRaw) : "";

    const params = new URLSearchParams({ url, strategy });
    for (const cat of categories) params.append("category", cat.toUpperCase().replace(/-/g, "_"));
    if (locale) params.set("locale", locale);
    if (apiKey) params.set("key", apiKey);

    try {
      const response = await fetchWithTimeout(`${PSI_BASE}?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }, timeoutMs);
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: text.slice(0, 4000), error: `PageSpeed Insights returned HTTP ${response.status}` };
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { success: false, output: text.slice(0, 4000), error: "PageSpeed Insights returned non-JSON body" };
      }

      const lighthouse = (parsed["lighthouseResult"] ?? {}) as Record<string, unknown>;
      const categoriesOut = (lighthouse["categories"] ?? {}) as Record<string, { title?: string; score?: number; auditRefs?: Array<{ id: string }> }>;
      const audits = (lighthouse["audits"] ?? {}) as Record<string, { title?: string; score?: number | null; description?: string; displayValue?: string }>;

      const scoreTable = Object.entries(categoriesOut).map(([key, cat]) => ({
        id: key,
        title: cat.title ?? key,
        score: typeof cat.score === "number" ? Math.round(cat.score * 100) : null,
      }));

      const pickTopIssues = (catKey: string): Array<{ id: string; title: string; displayValue: string }> => {
        const cat = categoriesOut[catKey];
        if (!cat?.auditRefs) return [];
        return cat.auditRefs
          .map(({ id }) => ({ id, audit: audits[id] }))
          .filter(({ audit }) => audit && typeof audit.score === "number" && audit.score !== null && audit.score < 0.9)
          .slice(0, 8)
          .map(({ id, audit }) => ({
            id,
            title: audit?.title ?? id,
            displayValue: audit?.displayValue ?? "",
          }));
      };

      const lines: string[] = [];
      lines.push(`URL: ${url} · strategy: ${strategy}`);
      lines.push("");
      lines.push("Scores:");
      for (const row of scoreTable) {
        const score = row.score === null ? "n/a" : `${row.score}/100`;
        lines.push(`  ${row.title.padEnd(18)} ${score}`);
      }
      for (const catKey of ["performance", "accessibility", "best-practices", "seo"]) {
        const top = pickTopIssues(catKey);
        if (top.length === 0) continue;
        lines.push("");
        lines.push(`Top ${catKey} issues:`);
        for (const issue of top) {
          lines.push(`  • ${issue.title}${issue.displayValue ? ` — ${issue.displayValue}` : ""}`);
        }
      }

      return {
        success: true,
        output: lines.join("\n"),
        metadata: {
          url,
          strategy,
          scores: Object.fromEntries(scoreTable.map((row) => [row.id, row.score])),
          lighthouseVersion: (lighthouse["lighthouseVersion"] as string) ?? undefined,
          fetchTime: (lighthouse["fetchTime"] as string) ?? undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `lighthouse_audit failed: ${message}` };
    }
  },
});
