import { describe, expect, it } from "vitest";
import { wrapEmbeddingQueryForModel } from "../providers/embeddings.js";

/**
 * QWEN3-EMBEDDING IS ASYMMETRIC AND WE WERE USING IT SYMMETRICALLY.
 *
 * Its model card specifies an instruction on the QUERY side only:
 *
 *   Instruct: {task}
 *   Query: {query}
 *
 * with corpus text embedded bare. Every call in this repo went through `provider.embed(text)`
 * with no distinction, so queries and documents were encoded identically and the separation the
 * model was trained to produce was discarded.
 *
 * THE ORIGINAL NOTE HERE SAID "on AGENT ROUTING this changes nothing — 18/20 top-1, MRR 0.950,
 * same ranking on every query". That measurement was real but it measured the WRONG QUANTITY.
 * It compared RANKING. Agent routing does not gate on ranking; it gates on an ABSOLUTE score
 * (agent-routing.ts:94, floor 0.72 against the rescaled (cos+1)/2), and the instruction shifts
 * absolute cosine down hard while leaving the order roughly intact — which is exactly why a
 * ranking-only eval saw nothing:
 *
 *   web_task_coordinator vs "weather forecast for tomorrow current conditions"
 *     bare     cos 0.6923 -> 0.8461  >= 0.72  qualifies
 *     wrapped  cos 0.4118 -> 0.7059  <  0.72  zeroed, and dropped before the visible gate
 *
 * Session b9d9cf01 is what that cost: 0 of 49 agents matched a query that is nearly verbatim
 * web_task_coordinator's own description, and a weather question was misrouted to researcher.
 *
 * The wrapper is KEPT, because on the task its instruction string actually names — a query
 * against passages that answer it — it measurably pays: mean separation 0.1798 -> 0.2345 over
 * six query/passage pairs, 6/6 rank-1. It is now reached only through
 * computeRetrievalQueryEmbedding. Where it must NOT go, and why, is asserted behaviourally in
 * embedding-query-asymmetry.test.ts.
 */
describe("Qwen3-Embedding query instruction", () => {
  const QWEN = "text-embedding-qwen3-embedding-0.6b";

  it("wraps a query for a Qwen3 embedding model", () => {
    const out = wrapEmbeddingQueryForModel("current postgres version", QWEN);
    expect(out).toBe(
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\n"
      + "Query: current postgres version",
    );
  });

  it("matches the model card exactly — Instruct line, newline, Query line", () => {
    const out = wrapEmbeddingQueryForModel("q", QWEN).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]!.startsWith("Instruct: ")).toBe(true);
    expect(out[1]).toBe("Query: q");
  });

  it("recognises the id under every alias this server exposes", () => {
    for (const id of [
      "text-embedding-qwen3-embedding-0.6b",
      "qwen3-embedding-0.6b",
      "lmstudio/text-embedding-qwen3-embedding-0.6b",
      "Qwen3-Embedding-8B",
    ]) {
      expect(wrapEmbeddingQueryForModel("q", id)).toContain("Instruct:");
    }
  });

  it("leaves a NON-Qwen embedding model untouched — the format is that family's convention", () => {
    for (const id of ["nomic-embed-text", "text-embedding-3-small", "bge-large-en"]) {
      expect(wrapEmbeddingQueryForModel("q", id)).toBe("q");
    }
  });

  it("never reaches the corpus builders", async () => {
    // Instructing BOTH sides re-symmetrises the encoding and throws away the separation this
    // exists to create. The previous version of this test also counted call sites and required
    // at least three; that number encoded the UNCONDITIONAL application which is the very thing
    // that broke agent routing, so it is gone. The boundary it was reaching for — corpus text
    // never passes through the wrapper — is what is asserted here, and the behavioural contract
    // (which paths instruct and which do not) lives in embedding-query-asymmetry.test.ts.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/providers/embeddings.ts", "utf8"));

    // The anchors are asserted to EXIST first. The previous version searched for
    // "async function buildAgentIndexInner" — the real name is _buildAgentIndexInner, with a
    // leading underscore — so indexOf returned -1, the slice came back empty, and
    // "".not.toContain(...) passed without ever reading the corpus builder.
    // One anchor, not two: the body runs to the next top-level export. Naming a second anchor
    // is how the original went wrong — it is one rename away from silently selecting nothing.
    const bodyOf = (declaration: string): string => {
      const start = src.indexOf(declaration);
      expect(start, `declaration not found: ${declaration}`).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport ", start + declaration.length);
      const body = src.slice(start, next === -1 ? src.length : next);
      expect(body.length, `empty body for: ${declaration}`).toBeGreaterThan(declaration.length);
      return body;
    };

    // Both corpus paths: the agent index builder and the batch text embedder.
    for (const declaration of [
      "async function _buildAgentIndexInner",
      "export async function computeTextEmbeddings",
    ]) {
      expect(bodyOf(declaration)).not.toContain("wrapEmbeddingQueryForModel");
    }
  });
});
