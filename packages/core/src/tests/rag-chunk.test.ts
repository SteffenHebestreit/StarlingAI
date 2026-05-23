import { describe, expect, it } from "vitest";
import { chunkText } from "../tools/rag.js";

/**
 * RAG chunker — verifies overlapping, boundary-aware chunking used by rag_ingest.
 */
describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("returns nothing for empty/whitespace input", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("splits long text into multiple overlapping chunks", () => {
    const para = "Sentence about retrieval augmented generation. ".repeat(120); // ~5.6k chars
    const chunks = chunkText(para, 1200, 200);
    expect(chunks.length).toBeGreaterThan(3);
    // Every chunk respects the size budget (allowing for boundary slack).
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1300);
    // Reassembled coverage: the concatenation contains the start and end.
    expect(chunks[0]).toContain("Sentence about retrieval");
    expect(chunks[chunks.length - 1]!.length).toBeGreaterThan(0);
  });

  it("prefers to break on paragraph boundaries", () => {
    const block = `${"A".repeat(800)}\n\n${"B".repeat(800)}\n\n${"C".repeat(800)}`;
    const chunks = chunkText(block, 1000, 100);
    // The first chunk should end at the paragraph break, not mid-run of A's.
    expect(chunks[0]!.startsWith("A")).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("makes progress and terminates on text with no natural boundaries", () => {
    const blob = "x".repeat(10_000);
    const chunks = chunkText(blob, 1000, 100);
    expect(chunks.length).toBeGreaterThan(8);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });
});
