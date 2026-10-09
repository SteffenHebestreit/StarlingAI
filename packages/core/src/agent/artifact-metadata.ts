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

/**
 * Appends the attachment entries a tool result's metadata describes — its own file, then every
 * nested `artifacts` record — to `out`, skipping any whose key is in `seen`. The runtime pins
 * these on a turn's final answer; the transcript reads the same shape back, so both sides derive
 * an entry, and its key, here.
 */
export function extractArtifactsFromMetadata(
  metadata: Record<string, unknown>,
  out: Array<Record<string, unknown>>,
  seen: Set<string>,
): void {
  const filename = typeof metadata["filename"] === "string" ? metadata["filename"].trim() : "";
  const outputPath = typeof metadata["outputPath"] === "string" ? metadata["outputPath"].trim() : "";
  const externalUrl = typeof metadata["externalUrl"] === "string" ? metadata["externalUrl"].trim() : "";

  if (filename || outputPath || externalUrl) {
    const key = [outputPath, externalUrl, filename, typeof metadata["sourceTool"] === "string" ? metadata["sourceTool"] : ""].join("::");
    if (!seen.has(key)) {
      seen.add(key);
      // A `filename` is required by the transcript builder. Derive one when
      // only a path is available. `pop()` can yield an empty string for a
      // trailing-slash path (e.g. "subdir/") — fall back to the raw path
      // so the transcript builder never sees an empty filename.
      const derivedFilename = filename
        || (outputPath ? (outputPath.split("/").pop() || outputPath) : "")
        || externalUrl;
      const entry: Record<string, unknown> = { filename: derivedFilename };
      if (outputPath) entry["relativePath"] = outputPath;
      if (externalUrl) entry["externalUrl"] = externalUrl;
      if (typeof metadata["contentType"] === "string") entry["contentType"] = metadata["contentType"];
      if (typeof metadata["previewMode"] === "string") entry["previewMode"] = metadata["previewMode"];
      if (typeof metadata["size"] === "number") entry["size"] = metadata["size"];
      else if (typeof metadata["bytes"] === "number") entry["size"] = metadata["bytes"];
      if (metadata["isDirectory"] === true) entry["isDirectory"] = true;
      if (typeof metadata["title"] === "string" && metadata["title"]) entry["title"] = metadata["title"];
      if (typeof metadata["sourceTool"] === "string" && metadata["sourceTool"]) entry["sourceTool"] = metadata["sourceTool"];
      out.push(entry);
    }
  }

  const nested = metadata["artifacts"];
  if (Array.isArray(nested)) {
    for (const item of nested) {
      if (item && typeof item === "object") {
        extractArtifactsFromMetadata(item as Record<string, unknown>, out, seen);
      }
    }
  }
}

/** Identity of an attachment entry as extractArtifactsFromMetadata builds it. */
export function attachmentEntryKey(entry: { relativePath?: unknown; externalUrl?: unknown; filename?: unknown; sourceTool?: unknown }): string {
  const field = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  return [field(entry.relativePath), field(entry.externalUrl), field(entry.filename), field(entry.sourceTool)].join("::");
}
