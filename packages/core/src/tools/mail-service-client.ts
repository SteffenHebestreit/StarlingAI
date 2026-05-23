/**
 * Shared HTTP client for the headless mail-service backend.
 *
 * Used by the mail, calendar, and contacts tools. Centralises:
 *  - serviceUrl / timeout / auth-token resolution from config + env overrides
 *  - JSON request/response handling with timeout abort
 *  - error formatting that surfaces the upstream `error`/`message` field
 */
import { getConfig } from "../config/loader.js";
import { currentUserId } from "../runtime/request-context.js";
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
  const userId = currentUserId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.serviceUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
        ...(userId ? { "X-Sai-User": userId } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as T;
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
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
