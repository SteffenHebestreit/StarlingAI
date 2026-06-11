import { describe, expect, it } from "vitest";
import { salvageTruncatedWriteFileArgs } from "../agent/sub-agent.js";

/**
 * Truncated-giant-write salvage (audits 5fec8427, c2f76a00, 77944865): the slow local
 * model emits an ENTIRE large file as one write_file argument, the output limit cuts
 * the JSON mid-string, and the unparseable args execute as {} -> "path is required" ->
 * zero bytes after ~2 minutes of generation. Prompt-level chunking instructions failed
 * twice, so the salvage is mechanical: recover the complete path + partial content and
 * turn the truncation into a PARTIAL WRITE the model continues with mode:"append".
 */
describe("salvageTruncatedWriteFileArgs", () => {
  // JSON-escaped body as it appears inside the raw tool-call argument string.
  const longBody = "<!DOCTYPE html>\\n<html>\\n<head><style>\\n" + ".quiz { padding: 4px; }\\n".repeat(30);

  it("salvages path + partial content from JSON cut off mid-content-string", () => {
    const raw = `{"path": "cpsa-prep/index.html", "mode": "create", "content": "${longBody}`;
    const salvaged = salvageTruncatedWriteFileArgs(raw);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.path).toBe("cpsa-prep/index.html");
    expect(salvaged!.mode).toBe("create");
    expect(salvaged!.content).toContain("<!DOCTYPE html>");
    expect(salvaged!.content).toContain(".quiz { padding: 4px; }");
  });

  it("strips a trailing half-finished escape sequence at the cut point", () => {
    const cutMidUnicode = `{"path": "index.html", "content": "${longBody}\\u00`;
    expect(salvageTruncatedWriteFileArgs(cutMidUnicode)).not.toBeNull();
    const cutMidBackslash = `{"path": "index.html", "content": "${longBody}\\`;
    expect(salvageTruncatedWriteFileArgs(cutMidBackslash)).not.toBeNull();
  });

  it("returns null without a complete path (the 77944865 shape) — coaching handles it", () => {
    expect(salvageTruncatedWriteFileArgs(`{"content": "${longBody}`)).toBeNull();
  });

  it("returns null when the salvageable content is too small to be worth a partial file", () => {
    expect(salvageTruncatedWriteFileArgs(`{"path": "index.html", "mode": "create", "content": "tiny start`)).toBeNull();
  });

  it("omits an invalid mode and keeps a valid append mode", () => {
    const appendRaw = `{"path": "index.html", "mode": "append", "content": "${longBody}`;
    expect(salvageTruncatedWriteFileArgs(appendRaw)!.mode).toBe("append");
    const weirdRaw = `{"path": "index.html", "mode": "yolo", "content": "${longBody}`;
    expect(salvageTruncatedWriteFileArgs(weirdRaw)!.mode).toBeUndefined();
  });

  it("unescapes JSON escapes in the salvaged content (quotes, newlines)", () => {
    const raw = `{"path": "a.html", "content": "line1\\n<div class=\\"x\\">${"y".repeat(300)}`;
    const salvaged = salvageTruncatedWriteFileArgs(raw);
    expect(salvaged!.content).toContain("line1\n");
    expect(salvaged!.content).toContain("<div class=\"x\">");
  });
});
