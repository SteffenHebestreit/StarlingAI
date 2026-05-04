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
