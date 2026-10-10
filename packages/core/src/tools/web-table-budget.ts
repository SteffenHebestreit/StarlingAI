/**
 * The pages each sub-agent run has read with web_table, kept apart from tools/web-table.ts so the
 * sub-agent loop can clear a run's count when it ends without importing the tool module, whose
 * import registers the tool (agent/sub-agent.ts explains why that breaks tests' own fakes).
 *
 * Keyed by the session id a call runs under: a sub-agent run's own subSessionId, so parallel runs
 * do not share a budget. Insertion order doubles as recency for the LRU backstop.
 */

/** Pages one run may read with web_table, over all its calls. */
export const WEB_TABLE_PAGES_PER_RUN = 40;
/** Sessions whose counts are kept; the least recently charged is dropped past this. */
const MAX_SESSIONS = 1_024;

const pagesBySession = new Map<string, number>();

export function webTablePagesUsed(sessionId: string): number {
  return pagesBySession.get(sessionId) ?? 0;
}

export function chargeWebTablePages(sessionId: string, pages: number): void {
  const used = webTablePagesUsed(sessionId) + pages;
  pagesBySession.delete(sessionId);
  pagesBySession.set(sessionId, used);
  while (pagesBySession.size > MAX_SESSIONS) {
    const oldest = pagesBySession.keys().next().value;
    if (oldest === undefined) break;
    pagesBySession.delete(oldest);
  }
}

/** Forget a run's page count; the sub-agent loop calls it when the run ends, beside clearSearchSessionState. */
export function clearWebTableSessionState(sessionId: string): void {
  pagesBySession.delete(sessionId);
}
