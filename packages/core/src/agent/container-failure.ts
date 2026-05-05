/**
 * Detect container-runner failure prefixes that the sub-agent host emits when
 * a containerized run could not produce a real result. Kept separate from
 * `agent/sub-agent.ts` because that module is heavily mocked across the test
 * suite (vi.mock factories that replace the entire module surface) — any new
 * export there would have to be added to every mock or the tests fail with
 * "No '<name>' export is defined on the mock".
 *
 * Kept separate from the generic `looksLikeFailureResult` regex because the
 * alternation there uses `\b...\b` boundaries that fail to match strings
 * ending in `:` followed by whitespace (e.g. `container error: unknown` — the
 * trailing `\b` after `:` never matches because both `:` and the following
 * space are non-word).
 *
 * The container-runner produces these strings in container-runner.ts:
 *   - `Sub-agent '<name>' container error: <reason>`
 *   - `Sub-agent '<name>' exited with code <n>.`
 *   - `Failed to spawn sub-agent container: <reason>`
 *   - `Sub-agent '<name>' timed out after <ms>ms`
 */
export function looksLikeContainerLevelFailure(value: string): boolean {
  if (!value) return false;
  const preview = value.slice(0, 400);
  return (
    /Sub-agent '[^']+' container error:/i.test(preview)
    || /Sub-agent '[^']+' exited with code\b/i.test(preview)
    || /Failed to spawn sub-agent container:/i.test(preview)
    || /Sub-agent '[^']+' timed out after\b/i.test(preview)
  );
}

/**
 * Detect when a sub-agent's output consists ENTIRELY of LLM template
 * special tokens (e.g. `<|mask_end|>`, `<|im_end|>`, `<|endoftext|>`,
 * `<|eot_id|>`).  Some local models — especially Qwen variants under
 * forced synthesis at a soft deadline — emit a stray template token as
 * the whole "synthesis" instead of real content.  The runtime previously
 * classified this as `outcome: "success"` because the string was
 * non-empty, then the main assistant saw "TASK COMPLETED" with empty
 * evidence and rationalized fabricating an answer from training memory
 * (audit session cb90e56a, May 2026 — claimed IM73A135V01 is a
 * TDK-InvenSense I²S digital MEMS when it's actually an Infineon
 * XENSIV analog mic, as the previous session's researcher correctly
 * established from the official datasheet).
 *
 * Returns true when removing every `<|...|>` template token leaves
 * nothing but whitespace.  Real outputs that mention template tokens
 * inside a larger answer (e.g. "the model emitted `<|im_end|>` early")
 * still contain substantive text after stripping, so they pass through
 * as normal content.
 */
export function looksLikeModelTemplateArtifact(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Cap inspection size — beyond a few KB the chance of "all template
  // tokens" is vanishingly small and not worth the regex pass.
  if (trimmed.length > 2_000) return false;
  const stripped = trimmed
    .replace(/<\|[a-z][a-z0-9_-]{1,40}\|>/gi, "")
    // Some templates use bare `<|...>` or `</|...|>` variants — strip those too.
    .replace(/<\/?\|?[a-z][a-z0-9_-]{1,40}\|?>/gi, "")
    .trim();
  return stripped.length === 0;
}
