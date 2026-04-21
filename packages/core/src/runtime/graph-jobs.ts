/**
 * MemGraph MAGE background jobs.
 *
 * Three periodic jobs run against the agent shared-memory graph:
 *
 *   centrality  — hourly betweenness_centrality across MemoryRecord nodes.
 *                 Scores are written to node.centrality and used by reranking.
 *
 *   communities — nightly Louvain community detection.
 *                 Scores written to node.communityId; enables cluster-aware
 *                 outlier analysis and batch topic grouping.
 *
 *   similarity  — every 30 min, builds SIMILAR_TO edges for MemoryRecord nodes
 *                 that have embeddings but no similarity links yet.
 *                 Drives outlier detection (isolated nodes) and rerank peerCount.
 *
 * All jobs degrade silently when MemGraph is unavailable.
 */

import { createCronJob } from "./scheduler.js";
import {
  graphUpdateCentrality,
  graphUpdateCommunities,
  graphBuildSimilarityLinks,
  graphDecayUnusedMemories,
} from "../memory/graph-service.js";
import { childLogger } from "../logger.js";

const log = childLogger("runtime:graph-jobs");

let _initialized = false;

export function startGraphJobs(): void {
  if (_initialized) return;
  _initialized = true;

  // ── Centrality — every hour at :05 ──────────────────────────────────────────
  createCronJob(
    "5 * * * *",
    "graph-centrality",
    "Recompute betweenness centrality for MemoryRecord nodes",
    async () => {
      const updated = await graphUpdateCentrality();
      if (updated > 0) {
        log.info({ updated }, "Centrality job complete");
      }
    },
  );

  // ── Community detection — daily at 03:10 UTC ─────────────────────────────
  createCronJob(
    "10 3 * * *",
    "graph-communities",
    "Louvain community detection across MemoryRecord graph",
    async () => {
      const updated = await graphUpdateCommunities();
      if (updated > 0) {
        log.info({ updated }, "Community detection job complete");
      }
    },
  );

  // ── Similarity links — every 30 min at :02 and :32 ──────────────────────
  // Incremental: only processes nodes written since the last run (those
  // without existing SIMILAR_TO edges are the natural candidates since
  // the query filters by embedding IS NOT NULL AND updatedAt > cutoff).
  createCronJob(
    "2,32 * * * *",
    "graph-similarity",
    "Build SIMILAR_TO edges for recently-written MemoryRecord nodes via vector_search",
    async () => {
      const created = await graphBuildSimilarityLinks();
      if (created > 0) {
        log.info({ created }, "Similarity link job complete");
      }
    },
  );

  // ── Importance decay — nightly at 03:40 UTC ────────────────────────────────
  // E26: closes the retrieval feedback loop from the opposite side. Memories
  // that keep surfacing without ever being marked useful lose rerank weight,
  // as do memories that were written but never touched in weeks.
  createCronJob(
    "40 3 * * *",
    "graph-decay",
    "Decay importance for unused / never-useful MemoryRecord nodes",
    async () => {
      const decayed = await graphDecayUnusedMemories();
      if (decayed > 0) {
        log.info({ decayed }, "Importance decay job complete");
      }
    },
  );

  log.info("MemGraph background jobs registered (centrality hourly, communities nightly, similarity every 30m, decay nightly)");
}
