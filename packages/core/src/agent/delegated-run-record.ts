/**
 * The block a delegation frame carries about what its run RECORDED — the files it produced and
 * the tool calls that failed on the way — and how every other reader of that frame steps past it.
 *
 * The block is written into the head of a frame (tool-result-format.ts), but several older checks
 * read the WHOLE frame for their verdict words: "TASK FAILED", "PARTIAL PROGRESS", "timed out", a
 * continuation or ask-the-user cue. A failed-call line holds a tool's own error text, and a run
 * that recovered from "Tool 'web_fetch' timed out after 30000ms" still completed; read as the
 * frame's verdict, that line turns a finished delegation into an exhausted one. So those checks
 * read the frame without this block, and the block and its reader live here together, where the
 * headers cannot drift apart from the code that recognises them.
 *
 * A leaf module on purpose: the checks that need it sit below the frame builder in the imports.
 */

export const PRODUCED_FILES_HEADER =
  "Files produced, as recorded by the tool that wrote each (for you, not for the reply; name an engine, tier or model only as given here):";
export const TOOL_FAILURES_HEADER =
  "Tool calls that failed along the way (for you, not for the reply; the run went on after them, so they are not its outcome):";

const HEADERS = new Set([PRODUCED_FILES_HEADER, TOOL_FAILURES_HEADER]);

/** The frame as it read before the block was added: each header and the "- " lines under it go. */
export function stripDelegatedRunRecord(text: string): string {
  if (!text.includes(PRODUCED_FILES_HEADER) && !text.includes(TOOL_FAILURES_HEADER)) return text;
  const kept: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (HEADERS.has(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.startsWith("- ")) continue;
    inBlock = false;
    kept.push(line);
  }
  return kept.join("\n");
}
