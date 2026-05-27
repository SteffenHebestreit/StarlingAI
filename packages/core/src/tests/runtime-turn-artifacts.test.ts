import { describe, expect, it } from "vitest";
import { createSession } from "../agent/session.js";
import { collectTurnArtifactAttachments } from "../agent/runtime.js";

describe("collectTurnArtifactAttachments", () => {
  it("collects a direct artifact from a tool result's metadata", () => {
    const session = createSession({ channel: "test" });
    session.addMessage({ role: "user", content: "make me an svg" });
    session.addMessage({ role: "assistant", content: "calling tool" });
    session.addMessage({
      role: "tool",
      content: "ok",
      tool_call_id: "t1",
      metadata: {
        artifactKind: "image",
        outputPath: "logo.svg",
        filename: "logo.svg",
        contentType: "image/svg+xml",
        previewMode: "image",
        bytes: 1234,
        sourceTool: "generate_svg",
      },
    });

    const attachments = collectTurnArtifactAttachments(session);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: "logo.svg",
      relativePath: "logo.svg",
      contentType: "image/svg+xml",
      previewMode: "image",
      size: 1234,
      sourceTool: "generate_svg",
    });
  });

  it("recurses into nested artifacts[] from a delegation tool result", () => {
    const session = createSession({ channel: "test" });
    session.addMessage({ role: "user", content: "write me a report" });
    session.addMessage({ role: "assistant", content: "delegating" });
    session.addMessage({
      role: "tool",
      content: "delegated",
      tool_call_id: "t1",
      metadata: {
        agentName: "content_writer",
        artifacts: [
          {
            outputPath: "reports/q3.md",
            filename: "q3.md",
            previewMode: "markdown",
            contentType: "text/markdown",
            sourceTool: "write_file",
          },
          {
            outputPath: "reports/q3.pdf",
            filename: "q3.pdf",
            previewMode: "pdf",
            contentType: "application/pdf",
            sourceTool: "generate_pdf",
            size: 50_000,
          },
        ],
      },
    });

    const attachments = collectTurnArtifactAttachments(session);
    expect(attachments).toHaveLength(2);
    expect(attachments.map((a) => a["filename"])).toEqual(["q3.md", "q3.pdf"]);
  });

  it("does not pull artifacts from previous turns (stops at the user message)", () => {
    const session = createSession({ channel: "test" });
    // Prior turn — should be ignored.
    session.addMessage({ role: "user", content: "old turn" });
    session.addMessage({ role: "assistant", content: "prior" });
    session.addMessage({
      role: "tool",
      content: "ok",
      tool_call_id: "old",
      metadata: { outputPath: "stale.svg", filename: "stale.svg", sourceTool: "generate_svg" },
    });
    // Current turn — only this should be returned.
    session.addMessage({ role: "user", content: "current turn" });
    session.addMessage({ role: "assistant", content: "current" });
    session.addMessage({
      role: "tool",
      content: "ok",
      tool_call_id: "new",
      metadata: { outputPath: "fresh.svg", filename: "fresh.svg", sourceTool: "generate_svg" },
    });

    const attachments = collectTurnArtifactAttachments(session);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.["filename"]).toBe("fresh.svg");
  });

  it("dedupes the same artifact when it bubbles through multiple tool calls", () => {
    const session = createSession({ channel: "test" });
    session.addMessage({ role: "user", content: "make stuff" });
    session.addMessage({ role: "assistant", content: "iter1" });
    session.addMessage({
      role: "tool",
      content: "ok",
      tool_call_id: "t1",
      metadata: { outputPath: "out.md", filename: "out.md", sourceTool: "write_file" },
    });
    // Same artifact re-surfaced via a delegation result.
    session.addMessage({ role: "assistant", content: "iter2" });
    session.addMessage({
      role: "tool",
      content: "delegated",
      tool_call_id: "t2",
      metadata: {
        artifacts: [
          { outputPath: "out.md", filename: "out.md", sourceTool: "write_file" },
        ],
      },
    });

    const attachments = collectTurnArtifactAttachments(session);
    expect(attachments).toHaveLength(1);
  });

  it("returns nothing when the turn produced no artifacts", () => {
    const session = createSession({ channel: "test" });
    session.addMessage({ role: "user", content: "hi" });
    session.addMessage({ role: "assistant", content: "calling search" });
    session.addMessage({
      role: "tool",
      content: "no results",
      tool_call_id: "t1",
      metadata: { searchDegraded: true },
    });

    expect(collectTurnArtifactAttachments(session)).toHaveLength(0);
  });
});
