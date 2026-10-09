import { describe, expect, it } from "vitest";
import { isImageAttachment } from "../retrieval/document-rag.js";

/**
 * Uploaded chat pictures now carry a workspace path (so they can be offered as an edit base), and
 * the per-turn auto-ingest reads every attachment that has one. A picture must not be read as a
 * document: its analysis is already inlined into the message, and an extraction failure there
 * added an "attachment not readable" note contradicting it.
 */
describe("isImageAttachment", () => {
  it("recognises a picture by its declared type", () => {
    expect(isImageAttachment({ filename: "x", relativePath: "uploads/x", contentType: "image/png" })).toBe(true);
    expect(isImageAttachment({ filename: "x", contentType: "IMAGE/JPEG" })).toBe(true);
  });

  it("falls back to the file name only when no type was sent", () => {
    expect(isImageAttachment({ filename: "harbour.JPG", relativePath: "uploads/harbour.JPG" })).toBe(true);
    expect(isImageAttachment({ filename: "notes.pdf", relativePath: "uploads/notes.pdf" })).toBe(false);
  });

  it("trusts a declared non-image type over an image-looking name", () => {
    expect(isImageAttachment({ filename: "scan.png", contentType: "application/pdf" })).toBe(false);
  });
});
