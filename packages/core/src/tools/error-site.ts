/**
 * Where an error happened, not merely what it was.
 *
 * verify_page reported `ReferenceError: state is not defined` about a 16,000-character file
 * and nothing else — no line, no column, no surrounding source. The only way to act on that
 * is to read the whole artifact looking for it, which is precisely the reading-without-
 * writing stall the supervisor then has to interrupt. Every ingredient for a precise answer
 * was already in the thrown error and was being discarded one line later.
 *
 * Two sources, best first:
 *
 * 1. V8's own header. A vm stack begins with the failing line and a caret under the
 *    offending column — the engine's view of the fault, better than anything reconstructed
 *    from a frame, and present for the compile and first-run failures that dominate here.
 * 2. The first in-script frame (`page.js:LINE:COLUMN`), used when the header is absent —
 *    an error thrown from a callback several frames deep, for instance. The source lines
 *    around it are quoted so the reader sees context rather than a number.
 */

/** Script name used inside the VM, so a failing frame is identifiable in the stack. */
export const SCRIPT_VM_FILENAME = "page.js";

/** Source lines quoted either side of the failure. */
const ERROR_CONTEXT_LINES = 2;

/** Longest source line echoed back before truncation, so one minified line cannot flood the report. */
const MAX_QUOTED_LINE_CHARS = 160;

export function describeErrorSite(err: unknown, source: string): string {
  // DUCK-TYPED, NOT `instanceof Error`. An error thrown inside a vm context is constructed by
  // THAT realm's Error, whose prototype chain has nothing to do with the host's — so
  // `err instanceof Error` is false for precisely the errors this function exists to
  // describe, and an instanceof guard rejects every one of them at the first line while
  // looking perfectly correct. It passed an isolated test only because the test built a
  // host-realm Error.
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (typeof stack !== "string") return "";

  const blocks = stack.split("\n\n");
  const header = blocks[0] ?? "";
  if (header.startsWith(`${SCRIPT_VM_FILENAME}:`) && header.includes("^")) {
    return "\n" + header.split("\n").map((line) => `    ${line}`).join("\n");
  }

  const match = new RegExp(`${SCRIPT_VM_FILENAME}:(\\d+):(\\d+)`).exec(stack);
  if (!match?.[1]) {
    // Neither the header nor an in-script frame. It still beats a bare message to hand back
    // the call path — an error thrown several frames deep names the functions involved, and
    // a function name is something the reader can search for, which a message alone is not.
    const frames = stack.split("\n").filter((l) => l.trim().startsWith("at ")).slice(0, 3);
    return frames.length > 0 ? `\n${frames.map((f) => `    ${f.trim()}`).join("\n")}` : "";
  }
  const line = Number(match[1]);
  const column = Number(match[2] ?? 0);
  if (!Number.isFinite(line) || line < 1) return "";

  const lines = source.split("\n");
  const from = Math.max(1, line - ERROR_CONTEXT_LINES);
  const to = Math.min(lines.length, line + ERROR_CONTEXT_LINES);
  const quoted: string[] = [];
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1] ?? "";
    const shown = text.length > MAX_QUOTED_LINE_CHARS ? `${text.slice(0, MAX_QUOTED_LINE_CHARS)}…` : text;
    quoted.push(`${n === line ? ">" : " "} ${n}| ${shown}`);
  }
  return ` (line ${line}, column ${column})\n${quoted.join("\n")}`;
}
