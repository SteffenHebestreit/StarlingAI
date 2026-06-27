/**
 * Shared input/output size limits for file-reading tools.
 *
 * Source-file extractors (mbox/eml/ipynb/ics) legitimately exceed the 1 MB
 * filesystem text limit, so they get a separate, generous INPUT byte cap — but
 * still bounded, so a multi-hundred-MB upload cannot OOM the gateway. Their
 * model-facing OUTPUT is independently capped so a large parse result cannot
 * dump multi-MB straight into the model context window.
 */
import { stat } from "node:fs/promises";

/** Generous read ceiling for source-file extractors (mbox/ipynb exceed 1 MB). */
export const MAX_EXTRACTOR_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Model-facing output ceiling for an extractor result. */
export const MAX_EXTRACTOR_OUTPUT_CHARS = 32_000;

export class FileTooLargeError extends Error {
  constructor(public readonly size: number, public readonly limit: number) {
    super(`file is ${size} bytes, which exceeds the ${limit}-byte read limit`);
    this.name = "FileTooLargeError";
  }
}

/** Throw FileTooLargeError if the file exceeds the cap — before reading it into memory. */
export async function assertFileSizeWithin(
  resolved: string,
  maxBytes = MAX_EXTRACTOR_FILE_BYTES,
): Promise<void> {
  const { size } = await stat(resolved);
  if (size > maxBytes) throw new FileTooLargeError(size, maxBytes);
}

/** Truncate model-facing output to a bounded length with a marker (mirrors web.ts). */
export function truncateOutput(
  text: string,
  maxChars = MAX_EXTRACTOR_OUTPUT_CHARS,
  label = "Output",
): string {
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars) + `\n\n[${label} truncated at ${maxChars} chars]`;
}
