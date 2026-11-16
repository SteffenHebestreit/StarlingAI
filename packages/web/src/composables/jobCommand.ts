/**
 * `/job <name> [key=value …]` typed into the chat composer.
 *
 * The chat queues it over REST (POST /api/jobs/:name/run, stores/scenes.ts runJob) instead of
 * sending it as a turn, so no turn status reports what came of it. A job that was not queued (an
 * unknown name, or a parameter the gateway's input guardrail refused) was said nowhere the user
 * looked: the composer had been cleared on send, and the Jobs menu shows a failure only while it
 * lists no job. This is that logic, free of Vue so it can be exercised on its own.
 */

export interface JobCommand {
  name: string;
  params?: Record<string, string>;
}

/** The job command a composer text is, or null. `/job help …` is none: it is a turn of its own. */
export function parseJobCommand(text: string): JobCommand | null {
  const match = text.match(/^\/job\s+(\S+)(?:\s+(.*))?$/s);
  if (!match || match[1]!.toLowerCase() === "help") return null;
  const params = parseInlineParams(match[2] ?? "");
  return { name: match[1]!, ...(Object.keys(params).length > 0 ? { params } : {}) };
}

/** `key=value` pairs; a value with spaces goes in double quotes. */
export function parseInlineParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    params[match[1]!] = (match[2] ?? "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
  }
  return params;
}

export type JobCommandOutcome =
  | { queued: true }
  /** Not queued: the typed text, to give back to the composer, and why, to show beside it. */
  | { queued: false; text: string; reason: string };

/**
 * Queues a typed job command. `queue` answers the queued job or nothing (stores/scenes.ts runJob);
 * `lastError` is the gateway's reason the store recorded for the last attempt.
 */
export async function submitJobCommand(
  text: string,
  command: JobCommand,
  queue: (name: string, params?: Record<string, string>) => Promise<unknown>,
  lastError: () => string | null,
): Promise<JobCommandOutcome> {
  if (await queue(command.name, command.params)) return { queued: true };
  return { queued: false, text, reason: lastError() ?? `Job ${command.name} was not queued.` };
}
