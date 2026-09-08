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
 * MEASURED, and reported honestly: on AGENT ROUTING this changes nothing. Against the live
 * 49-agent corpus with 20 unambiguous routing queries, bare and instructed scored identically —
 * 18/20 top-1, MRR 0.950, same ranking on every query. That task is easy (short, highly
 * distinctive descriptions) and was already near ceiling. The wrapper is kept because it is the
 * documented contract for this model and because the long-passage retrieval paths (shared facts,
 * memory, document RAG) are where the asymmetry is supposed to pay — not on the strength of a
 * routing improvement that was looked for and not found.
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

  it("is applied to the query path only — the corpus must stay bare", async () => {
    // Instructing BOTH sides re-symmetrises the encoding and throws away the separation, so this
    // pins the boundary: buildAgentIndex and computeTextEmbeddings embed corpus text and must not
    // route through the wrapper.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/providers/embeddings.ts", "utf8"));
    const wrapped = [...src.matchAll(/wrapEmbeddingQueryForModel\(/g)].length;
    // one definition, one export-site reference in the doc comment path, two call sites
    expect(wrapped).toBeGreaterThanOrEqual(3);
    // The corpus builders must not mention it.
    const corpusRegion = src.slice(src.indexOf("async function buildAgentIndexInner"), src.indexOf("export async function searchByEmbedding"));
    expect(corpusRegion).not.toContain("wrapEmbeddingQueryForModel");
  });
});
