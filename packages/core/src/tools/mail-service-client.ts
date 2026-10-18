/**
 * Shared HTTP client for the headless mail-service backend.
 *
 * Used by the mail, calendar, and contacts tools. Centralises:
 *  - serviceUrl / timeout / auth-token resolution from config + env overrides
 *  - JSON request/response handling with timeout abort
 *  - error formatting that surfaces the upstream `error`/`message` field
 */
import { getConfig } from "../config/loader.js";
import { currentIdentity } from "../runtime/request-context.js";
import type { Identity } from "../runtime/accounts.js";
import { ACL_PRINCIPAL_PREFIX } from "../guardrails/resource-access.js";
import type { ToolResult } from "./registry.js";

export interface MailServiceResponse<T = unknown> {
  status: number;
  body: T;
}

function resolveMailConfig() {
  const config = getConfig().mail;
  return {
    serviceUrl: process.env["SAI_MAIL_SERVICE_URL"] ?? config.serviceUrl,
    timeoutMs: Number(process.env["SAI_MAIL_SERVICE_TIMEOUT_MS"] ?? config.timeoutMs),
    authToken: process.env["SAI_MAIL_SERVICE_TOKEN"] ?? config.authToken,
  };
}

/**
 * Issue a JSON request against the configured mail service.
 * Always returns the raw status + parsed body (or `{}` if the body wasn't JSON);
 * callers decide how to react to non-2xx statuses.
 */
export async function callMailService<T>(
  path: string,
  init?: RequestInit,
): Promise<MailServiceResponse<T>> {
  const config = resolveMailConfig();
  // Forward the owning user so the mail-service can enforce per-account access
  // (allowedUsers). Undefined in single-user / auth-disabled mode → no header,
  // mail-service treats the request as unscoped.
  const identityHeaders = mailIdentityHeaders(currentIdentity());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.serviceUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
        ...identityHeaders,
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // A failure answered in plain text still says why; dropping it left "HTTP 404" alone.
        if (!response.ok) body = { error: text.trim().slice(0, 500) };
      }
    }
    return { status: response.status, body: body as T };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The headers that tell the mail-service who is asking, in the forms its `allowedUsers` and
 * `isolatedUsers` entries take (packages/mail-service/src/account-access.ts):
 *
 * - an account: `X-Sai-User: <username>` and `X-Sai-Account: <id>`, so an entry may name it by its
 *   frozen username or as `account:<id>`;
 * - a bootstrap token: `X-Sai-User: <sub>`, as always (an instance credential);
 * - any other principal (a channel sender, an A2A peer, a scene/job/workflow run), and under
 *   multi-user auth a name with no kind: `X-Sai-User: principal:<raw>`, which only a
 *   `principal:<raw>` entry matches.
 *
 * The raw name went out for every caller, so a mail From address or a Telegram id equal to a name
 * in an account's `allowedUsers` was granted that mailbox. With one operator identities carry no
 * kind and the header is the name, exactly as before.
 */
export function mailIdentityHeaders(who: Identity | undefined): Record<string, string> {
  if (!who?.userId) return {};
  if (who.account) return { "X-Sai-User": who.userId, "X-Sai-Account": who.account };
  if (who.principal === "bootstrap") return { "X-Sai-User": who.userId };
  if (who.principal || multiUserAuth()) return { "X-Sai-User": `${ACL_PRINCIPAL_PREFIX}${who.userId}` };
  return { "X-Sai-User": who.userId };
}

function multiUserAuth(): boolean {
  try {
    return getConfig().auth?.enabled === true;
  } catch {
    return true; // fail closed: never the bare name
  }
}

/**
 * Format a non-2xx mail-service response as a human-readable error string.
 * Surfaces the upstream `error` or `message` field when present.
 */
export function formatMailServiceError<T>(response: MailServiceResponse<T>): string {
  const body = response.body as Record<string, unknown> | null | undefined;
  const detail = typeof body?.["error"] === "string"
    ? body.error
    : typeof body?.["message"] === "string"
      ? body.message
      : "";
  return detail
    ? `Mail service returned HTTP ${response.status}: ${detail}`
    : `Mail service returned HTTP ${response.status}`;
}

export function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { success: true, output, metadata };
}

export function fail(error: string, metadata?: Record<string, unknown>): ToolResult {
  return { success: false, output: "", error, metadata };
}
