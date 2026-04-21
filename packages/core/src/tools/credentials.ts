/**
 * Credential tools — site lookup and secure form-filling.
 *
 * get_site_credentials  — returns metadata (login URL, selectors, notes) but
 *                         NEVER exposes the actual username or password to the
 *                         LLM.  Tells the LLM to use site_fill_credentials.
 *
 * site_fill_credentials — securely fills browser login forms via Playwright
 *                         MCP.  The LLM provides element refs from a
 *                         browser_snapshot; this tool fills username + password
 *                         from the credential store without the LLM ever seeing
 *                         the values.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolveSiteCredential } from "../credentials/sites.js";
import { callPlaywrightTool } from "./multimodal.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("tool:credentials");

// ── get_site_credentials (redacted — never leaks secrets) ─────────────────────

registerTool({
  name: "get_site_credentials",
  description: [
    "Check whether stored login credentials exist for a website and retrieve non-secret metadata (login URL, CSS selectors, notes).",
    "Actual username and password are NEVER returned — use site_fill_credentials to fill login forms securely.",
    "When saved loginUrl or named URLs are present, use those saved URLs before guessing a path or opening the homepage.",
    "The hostname is matched against configured sites (e.g. 'github.com', 'jira.company.com').",
  ].join(" "),
  embeddingDescription: "Look up, retrieve stored site credentials, login URL, saved bookmarks for a website. Zugangsdaten suchen, gespeicherte Logins prüfen, hinterlegte URLs abrufen.",
  parameters: {
    type: "object",
    properties: {
      hostname: {
        type: "string",
        description: "The site hostname, e.g. 'github.com' or a full URL — the hostname is extracted automatically",
      },
    },
    required: ["hostname"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const hostname = String(args["hostname"] ?? "").trim();
    if (!hostname) {
      return { success: false, output: "", error: "hostname is required" };
    }

    const cred = resolveSiteCredential(hostname, ctx.sessionId);
    if (!cred) {
      return {
        success: false,
        output: "",
        error: `No credentials found for '${hostname}'. Add them via the dashboard (Settings → Site Credentials) or in the config file.`,
      };
    }

    // SECURITY: Never expose username or password to the LLM
    const lines = [
      `**Site:** ${cred.hostname}`,
      `**Credentials:** ✓ configured (use **site_fill_credentials** to fill login forms)`,
    ];
    if (cred.loginUrl)          lines.push(`**Login URL:** ${cred.loginUrl}`);
    if (cred.urls && Object.keys(cred.urls).length) {
      lines.push(`**Named URLs:**`);
      for (const [label, url] of Object.entries(cred.urls)) {
        lines.push(`  - ${label}: ${url}`);
      }
    }
    if (cred.usernameSelector)  lines.push(`**Username selector:** \`${cred.usernameSelector}\``);
    if (cred.passwordSelector)  lines.push(`**Password selector:** \`${cred.passwordSelector}\``);
    if (cred.submitSelector)    lines.push(`**Submit selector:** \`${cred.submitSelector}\``);
    if (cred.notes)             lines.push(`**Notes:** ${cred.notes}`);
    lines.push("");
    lines.push("If the saved login URL or a named URL matches the task, navigate to that saved URL immediately instead of the homepage or a guessed path.");
    lines.push("To log in: navigate to the login URL, take a browser_snapshot, then call site_fill_credentials with the element refs for the username, password, and submit fields.");

    return {
      success: true,
      output: lines.join("\n"),
      metadata: {
        hostname: cred.hostname,
        source: cred.source,
        hasLoginUrl: !!cred.loginUrl,
        namedUrls: Object.keys(cred.urls ?? {}),
        hasSelectors: !!(cred.usernameSelector || cred.passwordSelector),
      },
    };
  },
});

// ── site_fill_credentials (secure form fill via Playwright) ───────────────────

registerTool({
  name: "site_fill_credentials",
  description: [
    "Securely fill login form fields in the browser with stored site credentials.",
    "The actual username and password are NEVER exposed to the LLM.",
    "First navigate to the login page and take a browser_snapshot to identify form field refs,",
    "then call this tool with the element refs for the username and password fields.",
    "Credentials are resolved from the site config (matched by hostname).",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      hostname: {
        type: "string",
        description: "The site hostname to resolve credentials for, e.g. 'github.com'",
      },
      usernameRef: {
        type: "string",
        description: "Element reference from browser_snapshot for the username / email input field",
      },
      passwordRef: {
        type: "string",
        description: "Element reference from browser_snapshot for the password input field",
      },
      submitRef: {
        type: "string",
        description: "Optional: element reference for the submit / login button — will be clicked after filling",
      },
    },
    required: ["hostname", "usernameRef", "passwordRef"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const hostname = String(args["hostname"] ?? "").trim();
    if (!hostname) {
      return { success: false, output: "", error: "hostname is required" };
    }

    const cred = resolveSiteCredential(hostname, ctx.sessionId);
    if (!cred) {
      return {
        success: false,
        output: "",
        error: `No credentials found for '${hostname}'. Configure them in Settings → Site Credentials first.`,
      };
    }

    const usernameRef = String(args["usernameRef"] ?? "").trim();
    const passwordRef = String(args["passwordRef"] ?? "").trim();
    const submitRef = args["submitRef"] ? String(args["submitRef"]).trim() : undefined;

    if (!usernameRef || !passwordRef) {
      return { success: false, output: "", error: "usernameRef and passwordRef are required (get them from a browser_snapshot)" };
    }

    // Get Playwright MCP connection
    // Use callPlaywrightTool which properly checks isError from MCP results
    // (raw callTool returns isError without throwing, masking fill failures)

    logAudit("credential_fill", { hostname: cred.hostname, source: cred.source, target: "browser" }, { sessionId: ctx.sessionId });

    const results: string[] = [];
    let allOk = true;

    // 1. Fill username
    try {
      await callPlaywrightTool("browser_type", { element: "username / email field", ref: usernameRef, text: cred.username });
      results.push(`Username field (ref ${usernameRef}): filled ✓`);
    } catch (err) {
      allOk = false;
      results.push(`Username field (ref ${usernameRef}): FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Fill password
    try {
      await callPlaywrightTool("browser_type", { element: "password field", ref: passwordRef, text: cred.password });
      results.push(`Password field (ref ${passwordRef}): filled ✓`);
    } catch (err) {
      allOk = false;
      results.push(`Password field (ref ${passwordRef}): FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Click submit (optional)
    if (submitRef) {
      try {
        await callPlaywrightTool("browser_click", { element: "submit / login button", ref: submitRef });
        results.push(`Submit button (ref ${submitRef}): clicked ✓`);
      } catch (err) {
        allOk = false;
        results.push(`Submit button (ref ${submitRef}): FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log.info({ hostname: cred.hostname, allOk }, "site_fill_credentials completed");

    return {
      success: allOk,
      output: [
        `Credentials for ${cred.hostname} filled into form fields (values not shown).`,
        ...results.map(r => `• ${r}`),
        "",
        "If the workflow already has a known post-login destination, navigate there directly now instead of re-checking the login form.",
        "Otherwise take a fresh browser_snapshot to verify the new page state before any further clicks.",
        "Do not re-click the submit button or wait for login-form text such as Sign in, Email, or Password unless a fresh snapshot shows the form is still awaiting submission.",
      ].join("\n"),
      error: allOk ? undefined : "One or more fields failed to fill — check the refs from browser_snapshot",
      metadata: { hostname: cred.hostname, source: cred.source },
    };
  },
});
