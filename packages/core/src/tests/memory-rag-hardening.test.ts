import { describe, it, expect } from "vitest";
import neo4j from "neo4j-driver";
import { isDegenerateVector } from "../db/vector-store.js";
import { coerceIntParams, isConnectivityError } from "../db/neo4j.js";
import { factEmbeddingSignature, isUsableEmbeddingBatch } from "../swarm/memory.js";

// Regression coverage for the July 2026 memory/RAG hardening round (review findings
// [3], [5], [6], [12], [14], [15]). Each helper was extracted/guarded to fix a
// silent-degradation bug; these lock in the corrected behavior.

describe("isDegenerateVector — reject unstorable embeddings (finding [6])", () => {
  it("flags an all-zero vector (undefined cosine direction → NaN in pgvector)", () => {
    expect(isDegenerateVector([0, 0, 0, 0])).toBe(true);
    expect(isDegenerateVector(new Float32Array(8))).toBe(true);
  });

  it("flags any non-finite component (truncated / failed embed)", () => {
    expect(isDegenerateVector([0.1, NaN, 0.2])).toBe(true);
    expect(isDegenerateVector([0.1, Infinity, 0.2])).toBe(true);
    expect(isDegenerateVector([0.1, -Infinity])).toBe(true);
  });

  it("accepts a normal finite vector, including one with some zero components", () => {
    expect(isDegenerateVector([0.1, -0.4, 0.9])).toBe(false);
    expect(isDegenerateVector([0, 0, 1, 0])).toBe(false); // a single non-zero direction is valid
  });
});

describe("coerceIntParams — don't corrupt embedding arrays (finding [5])", () => {
  it("coerces top-level scalar integers to Bolt Integers (the LIMIT $n case)", () => {
    const out = coerceIntParams({ n: 10, cutoff: 1782000000000 });
    expect(neo4j.isInt(out["n"] as never)).toBe(true);
    expect(neo4j.isInt(out["cutoff"] as never)).toBe(true);
  });

  it("leaves floats and strings untouched", () => {
    const out = coerceIntParams({ score: 0.5, id: "fact:agent:key" });
    expect(out["score"]).toBe(0.5);
    expect(out["id"]).toBe("fact:agent:key");
  });

  it("passes embedding arrays through as-is — integer-valued floats stay floats", () => {
    const embedding = [0.5, 1.0, -1.0, 0.0, 0.3];
    const out = coerceIntParams({ embedding });
    expect(out["embedding"]).toBe(embedding); // same reference, not remapped
    // No component was converted to a Bolt Integer (which would corrupt similarity).
    for (const component of out["embedding"] as number[]) {
      expect(neo4j.isInt(component as never)).toBe(false);
    }
  });
});

describe("isConnectivityError — down vs. semantic error (finding [3])", () => {
  it("classifies driver connectivity failures as connectivity errors", () => {
    expect(isConnectivityError({ code: "ServiceUnavailable" })).toBe(true);
    expect(isConnectivityError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isConnectivityError(new Error("Failed to connect to server"))).toBe(true);
    expect(isConnectivityError(new Error("connection refused"))).toBe(true);
  });

  it("does NOT flag a Cypher / semantic error as a connectivity failure", () => {
    expect(isConnectivityError({ code: "Neo.ClientError.Statement.SyntaxError" })).toBe(false);
    expect(isConnectivityError(new Error("Variable `x` not defined"))).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
  });
});

describe("factEmbeddingSignature — cache key correctness (findings [14], [15])", () => {
  it("changes when the embedding model changes (invalidates stale-dimension vectors)", () => {
    const entries: Array<[string, string]> = [["role", "engineer"]];
    expect(factEmbeddingSignature(entries, "model-a")).not.toBe(factEmbeddingSignature(entries, "model-b"));
  });

  it("is order-independent over the entry set", () => {
    const a: Array<[string, string]> = [["a", "1"], ["b", "2"]];
    const b: Array<[string, string]> = [["b", "2"], ["a", "1"]];
    expect(factEmbeddingSignature(a, "m")).toBe(factEmbeddingSignature(b, "m"));
  });

  it("does not collide when keys/values contain ':' or newlines", () => {
    // Old `${key}:${value}` join collapsed these to the same string "a:b:c".
    const s1 = factEmbeddingSignature([["a", "b:c"]], "m");
    const s2 = factEmbeddingSignature([["a:b", "c"]], "m");
    expect(s1).not.toBe(s2);
    const s3 = factEmbeddingSignature([["a", "b\nc"]], "m");
    const s4 = factEmbeddingSignature([["a\nb", "c"]], "m");
    expect(s3).not.toBe(s4);
  });
});

describe("isUsableEmbeddingBatch — never cache a partial embed (finding [12])", () => {
  it("accepts one non-empty vector per input", () => {
    expect(isUsableEmbeddingBatch([new Float32Array([1]), new Float32Array([2])], 2)).toBe(true);
  });

  it("rejects a short response (fewer vectors than inputs)", () => {
    expect(isUsableEmbeddingBatch([new Float32Array([1])], 2)).toBe(false);
  });

  it("rejects a batch containing an empty / missing vector", () => {
    expect(isUsableEmbeddingBatch([new Float32Array([1]), new Float32Array(0)], 2)).toBe(false);
    expect(isUsableEmbeddingBatch([new Float32Array([1]), null], 2)).toBe(false);
    expect(isUsableEmbeddingBatch([new Float32Array([1]), undefined], 2)).toBe(false);
  });
});
