/**
 * get_site_credentials — retrieves stored username + password for a hostname.
 * Intended for use with Playwright MCP browser automation to log into sites.
 *
 * Requires per-call approval (Tier 2) so the user explicitly confirms before
 * a password is passed into the LLM's conversation context.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolveSiteCredential } from "../credentials/sites.js";

registerTool({
  name: "get_site_credentials",
  description: [
    "Retrieve stored login credentials (username + password) for a website.",
    "Use this before calling browser login tools to get the credentials to type.",
    "The hostname is matched against configured sites (e.g. 'github.com', 'jira.company.com').",
  ].join(" "),
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

    const lines = [
      `**Site:** ${cred.hostname}`,
      `**Username:** ${cred.username}`,
      `**Password:** ${cred.password}`,
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

    return {
      success: true,
      output: lines.join("\n"),
      metadata: {
        hostname: cred.hostname,
        username: cred.username,
        source: cred.source,
        hasLoginUrl: !!cred.loginUrl,
        namedUrls: Object.keys(cred.urls ?? {}),
        hasSelectors: !!(cred.usernameSelector || cred.passwordSelector),
      },
    };
  },
});
