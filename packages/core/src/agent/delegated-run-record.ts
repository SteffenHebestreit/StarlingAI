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
export const TOOL_DECLINES_HEADER =
  "Tool calls the user declined (their choice, not a failure; nothing was done in them, so do not retry them):";
/**
 * How a partial run was stopped: the loop it was stuck in, the warden, or its iteration limit
 * (orchestration.loopAwareDelegation). Its line carries the looped call's arguments, which are the
 * model's own text: a grep for "next step" read as the frame's continuation cue would steer the
 * turn, so it lives in this block, where no verdict check reads.
 */
export const RUN_STOP_HEADER =
  "How the run was stopped (for you, not for the reply; its evidence below is partial):";

const HEADERS = new Set([PRODUCED_FILES_HEADER, TOOL_FAILURES_HEADER, TOOL_DECLINES_HEADER, RUN_STOP_HEADER]);

/** The frame as it read before the block was added: each header and the "- " lines under it go. */
export function stripDelegatedRunRecord(text: string): string {
  if (![...HEADERS].some((header) => text.includes(header))) return text;
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
