/**
 * Routing, warm before the lab's first attempt.
 *
 * A fresh process routes its first request cold: the agent index is still being built and the
 * embedding and reranker connections are new. A turn's discovery prefetch then misses its budget, the
 * capsule never reaches the prompt, and the turn runs as if routing had found no agent, with nothing
 * that depends on the capsule armed (agent/runtime.ts autoArtifactArmed). Probed 2026-10-29 in the
 * lab container: routing answered at 3.7 s, the prompt was built at 2.8 s, on every single-attempt
 * probe. A gateway is long warm when a person writes to it; one routing query the lab throws away
 * gives its first attempt the same.
 */

/** The request routed and thrown away: an ordinary one, so the embedding and reranker calls run. */
export const ROUTING_WARMUP_QUERY = "Summarize the attached quarterly report in three bullet points.";

/** How long the first attempt waits for the agent index at most. */
export const ROUTING_WARMUP_TIMEOUT_MS = 60_000;

export interface RoutingWarmup {
  /** Is the agent index built (providers/embeddings.ts isEmbeddingAvailable)? */
  ready: () => boolean;
  /** Route one request the way a turn's prefetch does. */
  route: () => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Wait for the agent index, then route one request. True when it routed on a built index; false
 * when the wait ran out (the embedding model is down: the attempts route as a cold gateway would,
 * and the caller goes on). Never throws.
 */
export async function warmLabRouting(warmup: RoutingWarmup): Promise<boolean> {
  const deadline = Date.now() + (warmup.timeoutMs ?? ROUTING_WARMUP_TIMEOUT_MS);
  const pollMs = warmup.pollMs ?? 250;
  while (!warmup.ready()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    await warmup.route();
  } catch {
    // A failed warm-up query leaves the process as cold as before, no worse.
  }
  return true;
}
