import { describe, expect, it, vi } from "vitest";
import { selectCorrectiveResumeTarget } from "../agent/runtime.js";

// The tool calls runCorrectiveBuild dispatches, captured instead of run (see the last describe).
const dispatched = vi.hoisted(() => [] as Array<{ name: string; args: Record<string, unknown> }>);
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      dispatched.push({ name, args });
      return { success: false, output: "", error: "no builder runs in this test" };
    }),
  };
});

/**
 * Resume-over-regenerate (the user's write_file/resume idea): when a build attempt this
 * turn leaves a file that genuinely looks cut off mid-document, the one bounded corrective
 * build should FINISH that file in place rather than regenerate it. The selection keys off
 * structural file-incompleteness (the injected truncationProbe), never the deliverable's
 * topic, so a complete-but-wrong file is left for a fresh rebuild.
 */
describe("selectCorrectiveResumeTarget", () => {
  const truncated = "generated/index.html";
  // Probe stand-in for the fs-backed artifactFileLooksTruncated: only the truncated file
  // reports a reason; everything else (complete or absent) reports null.
  const probe = (rel: string): string | null =>
    rel === truncated ? "missing closing </html> tag — the file ends mid-document" : null;

  it("returns the truncated file so the corrective build resumes it", () => {
    const target = selectCorrectiveResumeTarget(
      [{ relativePath: truncated, filename: "index.html", size: 9000 }],
      probe,
    );
    expect(target).not.toBeNull();
    expect(target!.relativePath).toBe(truncated);
    expect(target!.filename).toBe("index.html");
    expect(target!.truncationReason).toContain("</html>");
  });

  it("returns null when the only file is complete (fresh rebuild, not resume)", () => {
    // A 4 KB static welcome page is a VALID full document — wrong, but not truncated —
    // so it must NOT be resumed (appending to it can't turn it into the app).
    expect(
      selectCorrectiveResumeTarget(
        [{ relativePath: "generated/welcome.html", filename: "welcome.html" }],
        probe,
      ),
    ).toBeNull();
  });

  it("picks the truncated file even when complete artifacts precede it", () => {
    const target = selectCorrectiveResumeTarget(
      [
        { relativePath: "generated/styles.css", filename: "styles.css" }, // complete → skipped
        { relativePath: truncated, filename: "index.html" },              // truncated → chosen
      ],
      probe,
    );
    expect(target!.relativePath).toBe(truncated);
  });

  it("skips directories and external-URL-only artifacts (no local file to finish)", () => {
    const target = selectCorrectiveResumeTarget(
      [
        { isDirectory: true, relativePath: "generated", filename: "generated" },
        { externalUrl: "https://example.com/app", filename: "app" }, // no relativePath
      ],
      // Probe would "truncate" anything, proving the guard (not the probe) does the skipping.
      () => "would be truncated",
    );
    expect(target).toBeNull();
  });

  it("derives filename from the path when no filename field is present", () => {
    const target = selectCorrectiveResumeTarget([{ relativePath: truncated }], probe);
    expect(target!.filename).toBe(truncated);
  });

  it("returns null for an empty attachment list", () => {
    expect(selectCorrectiveResumeTarget([], probe)).toBeNull();
  });
});

// The runtime's own corrective build knows what it asked for. Its delegation declares a file
// (DelegationDeliverable), so a builder that answers it in prose is judged a missed deliverable —
// the declaration, not the verbs of the BUILD TASK text, is what the verdict reads.
describe("runCorrectiveBuild — the runtime's build declares the file it wants", () => {
  it("dispatches the build to delegate_to_agent with deliverable \"file\"", async () => {
    const { runCorrectiveBuild } = await import("../agent/turn-corrective.js");
    const { classifyDeliverableIntent } = await import("../agent/deliverable-intent.js");
    const userMessage = "Erstelle eine Lernwebsite zur CPSA-F Zertifizierung als HTML-Datei.";
    dispatched.length = 0;
    const built = await runCorrectiveBuild("", {
      signal: new AbortController().signal,
      session: { id: "corrective-deliverable", channel: "test", addMessage: () => {}, getWorkspacePath: () => "/w" } as never,
      userMessage,
      deliverableIntent: classifyDeliverableIntent(userMessage),
      toolContext: { sessionId: "corrective-deliverable", workspacePath: "/w" },
      getIterationCount: () => 1,
      getProvider: () => { throw new Error("no synthesis without an artifact"); },
      getStashedBuilderTaskSpec: () => null,
      getQaCorrectiveBuildUsed: () => false,
      setQaCorrectiveBuildUsed: () => {},
      incrementDelegationCount: () => {},
      forceSynthesis: async () => null,
      selectCorrectiveResumeTarget: () => null,
      collectTurnArtifactAttachments: () => [],
      extractArtifactsFromMetadata: () => {},
      logWarn: () => {},
    });
    expect(built).toBeNull(); // the mocked builder produced nothing
    const build = dispatched.find((call) => call.name === "delegate_to_agent");
    expect(build?.args["agentName"]).toBe("content_writer");
    expect(build?.args["deliverable"]).toBe("file");
  });
});
