/**
 * An audit trail records WHICH image, not the image.
 *
 * A 1024x1024 PNG is ~1.5 MB and ~2 MB once base64-encoded, and it was being written into
 * `tool_call_completed` metadata and again into the delegation's `artifacts`. One
 * two-minute image session put 3.89 MB into audit.jsonl and the file reached 8.4 MB — a log
 * no operator can read and that every later grep pays for.
 *
 * Nothing is lost by dropping it: the bytes are already on disk and the same object carries
 * the `outputPath` they went to, so the log keeps the pointer. The rule is by SHAPE rather
 * than by field name, so screenshots, uploads and whatever produces bytes next are covered
 * without anyone remembering to add them to a list.
 */
import { describe, expect, it } from "vitest";

import { sanitizeAuditData } from "../audit/logger.js";

/** Base64 long enough to trip the guard — the real ones are ~2,000,000 chars. */
const bigBase64 = "A".repeat(5000);
const bigDataUrl = `data:image/png;base64,${bigBase64}`;

describe("audit inline payloads", () => {
  it("drops a base64 data URL and names the file it was written to", () => {
    const out = sanitizeAuditData({
      sourceTool: "generate_image",
      outputPath: "generated/.starlingai/generated/image-1790057954150.png",
      dataUrl: bigDataUrl,
      bytes: 1565883,
    }) as Record<string, string>;

    expect(out["dataUrl"]).not.toContain("AAAA");
    expect(out["dataUrl"]).toContain("omitted");
    // The pointer is the point: an anonymous "[omitted]" cannot be traced to an artifact.
    expect(out["dataUrl"]).toContain("generated/.starlingai/generated/image-1790057954150.png");
    // Everything else survives untouched.
    expect(out["outputPath"]).toBe("generated/.starlingai/generated/image-1790057954150.png");
    expect(out["bytes"]).toBe(1565883);
    expect(out["sourceTool"]).toBe("generate_image");
  });

  it("drops bare base64 too, not only data: URLs", () => {
    const out = sanitizeAuditData({ path: "shot.png", image: bigBase64 }) as Record<string, string>;
    expect(out["image"]).toContain("omitted");
    expect(out["image"]).toContain("shot.png");
  });

  it("reports the decoded size, so the log still says how big it was", () => {
    const out = sanitizeAuditData({ dataUrl: bigDataUrl }) as Record<string, string>;
    // 5000 base64 chars ≈ 3750 bytes.
    expect(out["dataUrl"]).toMatch(/3,750-byte/);
  });

  it("leaves ORDINARY strings alone — the control that keeps the log useful", () => {
    // Without this, a guard keyed on length alone would eat prompts, errors and paths, and
    // the audit would lose exactly the content it exists to hold.
    const prose = "Das Bild wurde erfolgreich generiert und gespeichert. ".repeat(80);
    const out = sanitizeAuditData({
      prompt: prose,
      error: "The image model generates 1024x1024 only and rejects any other size",
      outputPath: "generated/sunset.png",
    }) as Record<string, string>;

    expect(out["prompt"]).toBe(prose);
    expect(out["error"]).toContain("1024x1024 only");
    expect(out["outputPath"]).toBe("generated/sunset.png");
  });

  it("leaves a SHORT base64 value alone", () => {
    // Hashes and short encoded fields are legitimately worth keeping. Deliberately NOT under
    // a key like `token`: the secret redactor claims those by name, which would make this
    // pass for a reason that has nothing to do with the size guard.
    const short = "aGVsbG8gd29ybGQ=";
    const out = sanitizeAuditData({ checksum: short }) as Record<string, string>;
    expect(out["checksum"]).toBe(short);
  });

  it("reaches payloads nested inside arrays, which is where artifacts live", () => {
    const out = sanitizeAuditData({
      artifacts: [{ outputPath: "generated/a.png", dataUrl: bigDataUrl }],
    }) as { artifacts: Array<Record<string, string>> };

    expect(out.artifacts[0]!["dataUrl"]).toContain("omitted");
    expect(out.artifacts[0]!["outputPath"]).toBe("generated/a.png");
  });

  it("also covers the DEBUG export, which renders the session's own history", async () => {
    // The audit log went from 8.4 MB to 43 KB, and the debug export still produced a
    // multi-megabyte file: it renders rawHistory and message metadata, which carry the same
    // dataUrl. Same guard, one implementation — a second copy would drift.
    const { buildSessionDebugMarkdownFromSnapshot } = await import("../agent/debug-session-export.js");
    const rendered = await buildSessionDebugMarkdownFromSnapshot({
      sessionId: "s1",
      channel: "webchat",
      createdAt: "2026-09-22T07:16:34.505Z",
      updatedAt: "2026-09-22T07:19:34.620Z",
      status: "Active",
      turnCount: 2,
      workspacePath: "/workspace",
      systemPrompt: "",
      transcript: [],
      rawHistory: [{
        role: "tool",
        content: "Image generated successfully.",
        metadata: { outputPath: "generated/sunset.png", dataUrl: bigDataUrl },
      }],
      auditEvents: [],
      subSessionIds: [],
    } as never);

    expect(rendered).not.toContain("AAAAAAAAAA");
    expect(rendered).toContain("omitted");
    expect(rendered).toContain("generated/sunset.png");
  });
});
