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
import { lookupSiteCredential, siteCredentialMissMessage } from "../credentials/sites.js";
import { callPlaywrightTool } from "./multimodal.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("tool:credentials");

// ── Login-form auto-location ──────────────────────────────────────────────────
// LLM-supplied element refs go stale or are guessed wrong (especially by smaller
// models), which made site_fill_credentials fail with "fields failed to fill" on
// real login pages. We parse a fresh browser_snapshot to locate the username,
// password, and submit elements ourselves, and use the LLM-supplied refs only as
// a hint/fallback.

interface SnapshotElement { role: string; name: string; ref: string; isPassword: boolean; line: number; }

const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "textfield", "input"]);
const BUTTON_ROLES = new Set(["button", "link"]);
const USERNAME_NAME_RE = /e-?mail|user|benutzer|login|anmeldename|username|konto|account/i;
const PASSWORD_NAME_RE = /pass(word|wort)/i;
const SUBMIT_NAME_RE = /sign\s*in|log\s*in|login|anmelden|einloggen|weiter|continue|submit|absenden|next/i;

/** Parse a Playwright accessibility snapshot into {role, name, ref} elements. */
export function parseSnapshotElements(snapshot: string): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  snapshot.split("\n").forEach((raw, idx) => {
    const refMatch = raw.match(/\[ref=([A-Za-z0-9_]+)\]/);
    if (!refMatch) return;
    const role = (raw.match(/^\s*-\s*([A-Za-z]+)/)?.[1] ?? "").toLowerCase();
    const name = raw.match(/"([^"]*)"/)?.[1] ?? "";
    const isPassword = PASSWORD_NAME_RE.test(name) || /\btype\s*=\s*["']?password\b/i.test(raw);
    elements.push({ role, name, ref: refMatch[1]!, isPassword, line: idx });
  });
  return elements;
}

/** Heuristically pick the username, password, and submit refs from snapshot elements. */
export function pickLoginRefs(elements: SnapshotElement[]): { usernameRef?: string; passwordRef?: string; submitRef?: string } {
  const inputs = elements.filter((el) => INPUT_ROLES.has(el.role));
  const password = inputs.find((el) => el.isPassword) ?? inputs.find((el) => PASSWORD_NAME_RE.test(el.name));

  let username = inputs.find((el) => !el.isPassword && USERNAME_NAME_RE.test(el.name));
  if (!username && password) {
    // The visible input directly before the password field is almost always the username.
    const before = inputs.filter((el) => el.line < password.line && !el.isPassword);
    username = before[before.length - 1];
  }
  if (!username) username = inputs.find((el) => !el.isPassword);

  const submit = elements.find((el) => BUTTON_ROLES.has(el.role) && SUBMIT_NAME_RE.test(el.name));
  return { usernameRef: username?.ref, passwordRef: password?.ref, submitRef: submit?.ref };
}

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

    const lookup = lookupSiteCredential(hostname, ctx.sessionId, ctx.userId);
    if (lookup.status !== "resolved") {
      return {
        success: false,
        output: "",
        error: siteCredentialMissMessage(lookup, hostname),
        metadata: { credentialLookupStatus: lookup.status },
      };
    }
    const cred = lookup.credential;

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
        description: "Optional hint: element reference from browser_snapshot for the username / email input. If omitted or wrong, the tool auto-locates the field from a fresh snapshot.",
      },
      passwordRef: {
        type: "string",
        description: "Optional hint: element reference for the password input. If omitted or wrong, the tool auto-locates it from a fresh snapshot.",
      },
      submitRef: {
        type: "string",
        description: "Optional hint: element reference for the submit / login button. If omitted, the tool auto-locates and clicks it after filling.",
      },
    },
    required: ["hostname"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const hostname = String(args["hostname"] ?? "").trim();
    if (!hostname) {
      return { success: false, output: "", error: "hostname is required" };
    }

    const lookup = lookupSiteCredential(hostname, ctx.sessionId, ctx.userId);
    if (lookup.status !== "resolved") {
      return {
        success: false,
        output: "",
        error: siteCredentialMissMessage(lookup, hostname),
        metadata: { credentialLookupStatus: lookup.status },
      };
    }
    const cred = lookup.credential;

    const hintUsernameRef = args["usernameRef"] ? String(args["usernameRef"]).trim() : undefined;
    const hintPasswordRef = args["passwordRef"] ? String(args["passwordRef"]).trim() : undefined;
    const hintSubmitRef = args["submitRef"] ? String(args["submitRef"]).trim() : undefined;

    // Auto-locate the login fields from a FRESH snapshot so we don't depend on
    // (frequently stale or mis-guessed) LLM-supplied refs. The hints, when given,
    // are tried first and the located refs are the fallback.
    let located: { usernameRef?: string; passwordRef?: string; submitRef?: string } = {};
    try {
      const snapshot = await callPlaywrightTool("browser_snapshot", {});
      located = pickLoginRefs(parseSnapshotElements(snapshot));
    } catch (err) {
      log.debug({ err, hostname: cred.hostname }, "site_fill_credentials: snapshot for auto-location failed; relying on supplied refs");
    }

    const usernameRef = hintUsernameRef ?? located.usernameRef;
    const passwordRef = hintPasswordRef ?? located.passwordRef;
    const submitRef = hintSubmitRef ?? located.submitRef;

    if (!usernameRef || !passwordRef) {
      return {
        success: false,
        output: "",
        error: "Could not locate the username and/or password field. Take a browser_snapshot of the login form and pass usernameRef/passwordRef explicitly.",
      };
    }

    logAudit("credential_fill", { hostname: cred.hostname, source: cred.source, target: "browser" }, { sessionId: ctx.sessionId });

    const results: string[] = [];
    let allOk = true;

    // Fill a field by ref, retrying with the auto-located ref if the primary fails.
    const fillField = async (label: string, primaryRef: string, fallbackRef: string | undefined, text: string): Promise<void> => {
      try {
        await callPlaywrightTool("browser_type", { element: label, ref: primaryRef, text });
        results.push(`${label} (ref ${primaryRef}): filled ✓`);
      } catch (primaryErr) {
        if (fallbackRef && fallbackRef !== primaryRef) {
          try {
            await callPlaywrightTool("browser_type", { element: label, ref: fallbackRef, text });
            results.push(`${label} (ref ${fallbackRef}, auto-located after hint failed): filled ✓`);
            return;
          } catch (fallbackErr) {
            allOk = false;
            results.push(`${label}: FAILED — ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
            return;
          }
        }
        allOk = false;
        results.push(`${label} (ref ${primaryRef}): FAILED — ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`);
      }
    };

    // 1. Username, 2. Password (hint first, located ref as fallback)
    await fillField("Username / email field", usernameRef, located.usernameRef, cred.username);
    await fillField("Password field", passwordRef, located.passwordRef, cred.password);

    // 3. Click submit (hint first, located ref as fallback)
    if (submitRef) {
      try {
        await callPlaywrightTool("browser_click", { element: "submit / login button", ref: submitRef });
        results.push(`Submit button (ref ${submitRef}): clicked ✓`);
      } catch (primaryErr) {
        if (located.submitRef && located.submitRef !== submitRef) {
          try {
            await callPlaywrightTool("browser_click", { element: "submit / login button", ref: located.submitRef });
            results.push(`Submit button (ref ${located.submitRef}, auto-located): clicked ✓`);
          } catch (fallbackErr) {
            allOk = false;
            results.push(`Submit button: FAILED — ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
          }
        } else {
          allOk = false;
          results.push(`Submit button (ref ${submitRef}): FAILED — ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`);
        }
      }
    }

    log.info({ hostname: cred.hostname, allOk, autoLocated: !hintUsernameRef || !hintPasswordRef }, "site_fill_credentials completed");

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
      error: allOk ? undefined : "One or more fields failed to fill even after auto-locating from a fresh snapshot — the login form may be inside an iframe or behind a cookie/consent overlay. Take a browser_snapshot and inspect the form, dismiss any overlay, then retry.",
      metadata: { hostname: cred.hostname, source: cred.source },
    };
  },
});
