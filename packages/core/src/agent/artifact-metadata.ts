/**
 * Reads the files a tool result says were produced, from its `metadata.artifacts`.
 *
 * The sub-agent loop copies the metadata of every file a tool wrote into `artifacts`, and
 * delegate_to_agent, execute_plan, parallel_delegate and run_task_graph pass those lists up.
 * Which tool and agent wrote a file, and on which engine, tier and model, is recorded only there;
 * the prose around it is the specialist's own account. This returns those records as plain values.
 * The inline bytes (`dataUrl`) are never copied out.
 *
 * INVARIANT: pure and dependency-free, so any module can import it.
 */

export interface ArtifactRecord {
  /** outputPath, or filename when no path was recorded. Records are deduplicated on it. */
  readonly ref: string;
  readonly outputPath?: string;
  readonly filename?: string;
  readonly sourceTool?: string;
  readonly sourceAgent?: string;
  /** Human name of what rendered the file (e.g. "Qwen-Image 2.1"), where the tool records one. */
  readonly engine?: string;
  readonly tier?: string;
  readonly model?: string;
  readonly elapsedMs?: number;
}

/** Nested `artifacts` lists are followed this deep; the shapes seen in practice are one or two. */
const MAX_NESTING = 4;

const STRING_KEYS = ["outputPath", "filename", "sourceTool", "sourceAgent", "engine", "tier", "model"] as const;

/**
 * Every file recorded in `metadata.artifacts`, including nested `artifacts` lists, one record per
 * path. When the same path appears twice, the later record wins: the later write is the file that
 * is on disk. The first appearance keeps its position. Entries with neither outputPath nor
 * filename are skipped.
 */
export function collectArtifactRecords(metadata: unknown): ArtifactRecord[] {
  const byRef = new Map<string, ArtifactRecord>();
  const visit = (entries: unknown, depth: number): void => {
    if (!Array.isArray(entries) || depth > MAX_NESTING) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      const record: Record<string, unknown> = {};
      for (const key of STRING_KEYS) {
        const raw = value[key];
        const trimmed = typeof raw === "string" ? raw.trim() : "";
        if (trimmed) record[key] = trimmed;
      }
      const elapsedMs = value["elapsedMs"];
      if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0) record["elapsedMs"] = elapsedMs;
      const ref = (record["outputPath"] ?? record["filename"]) as string | undefined;
      if (ref) byRef.set(ref, { ref, ...record } as ArtifactRecord);
      visit(value["artifacts"], depth + 1);
    }
  };
  if (metadata && typeof metadata === "object") visit((metadata as Record<string, unknown>)["artifacts"], 0);
  return [...byRef.values()];
}
