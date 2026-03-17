/**
 * Shared reliable delivery utility for all outbound channel messages.
 *
 * Features:
 * - Exponential backoff with jitter (3 attempts by default)
 * - Dead-letter logging on final failure
 * - Audit trail entry on every failure
 */
import { logAudit } from "../audit/logger.js";
import { appendDeadLetter } from "./dead-letter.js";
import { childLogger } from "../logger.js";
import { recordChannelDelivery } from "./registry.js";

const log = childLogger("channels:delivery");

export interface DeliveryOptions {
  channel: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  error?: string;
}

export async function deliverWithRetry(
  sendFn: () => Promise<void>,
  messagePreview: string,
  opts: DeliveryOptions
): Promise<DeliveryResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const startedAt = Date.now();
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sendFn();
      recordChannelDelivery(opts.channel, true, undefined, Date.now() - startedAt);
      return { delivered: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ channel: opts.channel, attempt, maxAttempts, error: lastError }, "Delivery attempt failed");

      if (attempt < maxAttempts) {
        // Exponential backoff with ±20% jitter, capped at 30 seconds
        const jitter = 1 + (Math.random() * 0.4 - 0.2);
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) * jitter, 30_000);
        await new Promise(r => setTimeout(r, Math.round(delay)));
      }
    }
  }

  // All attempts exhausted — log to audit + dead-letter queue
  logAudit("channel_delivery_failed", {
    channel: opts.channel,
    attempts: maxAttempts,
    error: lastError,
    messagePreview: messagePreview.slice(0, 200),
  }, { severity: "error" });

  appendDeadLetter({
    channel: opts.channel,
    messagePreview: messagePreview.slice(0, 500),
    error: lastError,
    attempts: maxAttempts,
  });

  recordChannelDelivery(opts.channel, false, lastError, Date.now() - startedAt);

  return { delivered: false, attempts: maxAttempts, error: lastError };
}
