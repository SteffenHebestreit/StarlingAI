import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());
vi.mock("../tools/registry.js", () => ({ executeTool: executeToolMock }));

const orchestrationMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/effort-context.js", () => ({ effectiveOrchestration: orchestrationMock }));

vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

import {
  runArtifactVerificationGate,
  buildRepairTask,
  buildFailureCaveat,
} from "../agent/artifact-verification-gate.js";

const ORCHESTRATION_ON = { verifyArtifacts: true, verifyArtifactsRepair: true, verifyArtifactsMaxRepairAttempts: 1 };

describe("runArtifactVerificationGate", () => {
  const cleanup: string[] = [];
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "sai-verify-"));
    cleanup.push(workspace);
    executeToolMock.mockReset();
    orchestrationMock.mockReset();
    orchestrationMock.mockReturnValue(ORCHESTRATION_ON);
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string | Uint8Array): void {
    const abs = join(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content as never);
  }

  /** Minimal session + deps stand-in; artifacts are whatever the callback returns. */
  function deps(artifacts: Array<Record<string, unknown>>, opts: { aborted?: boolean } = {}) {
    const increments = { count: 0 };
    return {
      d: {
        session: { id: "s1", getWorkspacePath: () => workspace } as never,
        signal: { aborted: opts.aborted ?? false } as AbortSignal,
        toolContext: { sessionId: "s1", workspacePath: workspace } as never,
        collectTurnArtifactAttachments: () => artifacts,
        incrementDelegationCount: () => { increments.count++; },
      },
      increments,
    };
  }

  const pdfBytes = async (): Promise<Uint8Array> => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText("ok", { x: 40, y: 700, size: 12, font });
    return doc.save();
  };

  it("passes a turn whose artifacts are all well-formed", async () => {
    write("generated/cv.pdf", await pdfBytes());
    const { d } = deps([{ relativePath: "generated/cv.pdf", filename: "cv.pdf" }]);

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("pass");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the turn produced no artifacts", async () => {
    const { d } = deps([]);
    const out = await runArtifactVerificationGate(d);
    expect(out.status).toBe("not_applicable");
    expect(out.probedCount).toBe(0);
  });

  it("respects the flag being off", async () => {
    orchestrationMock.mockReturnValue({ ...ORCHESTRATION_ON, verifyArtifacts: false });
    write("generated/cv.pdf", "not a pdf at all");
    const { d } = deps([{ relativePath: "generated/cv.pdf" }]);

    const out = await runArtifactVerificationGate(d);
    expect(out.status).toBe("not_requested");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  // The core behavior: a broken file triggers a REBUILD, not a text rewrite.
  it("delegates a rebuild when an artifact is corrupt, and reports repaired when the rebuild fixes it", async () => {
    write("generated/cv.pdf", "Sorry, here is your CV as text.");
    const good = await pdfBytes();
    const { d, increments } = deps([{ relativePath: "generated/cv.pdf" }]);

    // The delegation "rebuilds" the file, as a real builder agent would.
    executeToolMock.mockImplementation(async () => {
      write("generated/cv.pdf", good);
      return { success: true, output: "rebuilt" };
    });

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("repaired");
    expect(out.repairAttempts).toBe(1);
    expect(increments.count).toBe(1);
    const [toolName, args] = executeToolMock.mock.calls[0]!;
    expect(toolName).toBe("delegate_to_agent");
    expect(String((args as Record<string, unknown>)["task"])).toMatch(/ARTIFACT REPAIR/);
    expect(String((args as Record<string, unknown>)["task"])).toMatch(/cv\.pdf/);
  });

  it("reports fail — never silently ships — when the rebuild does not fix it", async () => {
    write("generated/cv.pdf", "still not a pdf");
    const { d } = deps([{ relativePath: "generated/cv.pdf" }]);
    executeToolMock.mockResolvedValue({ success: true, output: "tried" });

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("fail");
    expect(out.failures).toMatch(/cv\.pdf/);
    expect(out.repairAttempts).toBe(1);
  });

  it("does not attempt repair when repair is disabled, but still reports the failure", async () => {
    orchestrationMock.mockReturnValue({ ...ORCHESTRATION_ON, verifyArtifactsRepair: false });
    write("generated/cv.pdf", "broken");
    const { d } = deps([{ relativePath: "generated/cv.pdf" }]);

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("fail");
    expect(out.repairAttempts).toBe(0);
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("honours the repair attempt budget", async () => {
    orchestrationMock.mockReturnValue({ ...ORCHESTRATION_ON, verifyArtifactsMaxRepairAttempts: 3 });
    write("generated/cv.pdf", "broken");
    const { d } = deps([{ relativePath: "generated/cv.pdf" }]);
    executeToolMock.mockResolvedValue({ success: true, output: "tried" });

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("fail");
    expect(out.repairAttempts).toBe(3);
    expect(executeToolMock).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when the delegation itself fails", async () => {
    orchestrationMock.mockReturnValue({ ...ORCHESTRATION_ON, verifyArtifactsMaxRepairAttempts: 3 });
    write("generated/cv.pdf", "broken");
    const { d } = deps([{ relativePath: "generated/cv.pdf" }]);
    executeToolMock.mockResolvedValue({ success: false, error: "no agent" });

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("fail");
    expect(executeToolMock).toHaveBeenCalledTimes(1); // gave up rather than looping
  });

  it("reports unverifiable — not fail — for a format it cannot check", async () => {
    write("generated/model.dwg", "binary-ish content");
    const { d } = deps([{ relativePath: "generated/model.dwg" }]);

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("unverifiable");
    expect(executeToolMock).not.toHaveBeenCalled(); // never burn a rebuild on uncertainty
  });

  it("catches the wrong format delivered under the right name", async () => {
    const { Document, Packer, Paragraph } = await import("docx");
    const docx = await Packer.toBuffer(new Document({ sections: [{ properties: {}, children: [new Paragraph("hi")] }] }));
    write("generated/cv.pdf", new Uint8Array(docx));
    const { d } = deps([{ relativePath: "generated/cv.pdf" }]);
    executeToolMock.mockResolvedValue({ success: true, output: "tried" });

    const out = await runArtifactVerificationGate(d);

    expect(out.status).toBe("fail");
    expect(out.failures).toMatch(/ZIP-based|wrong format/i);
  });

  it("bails out cleanly when the turn was aborted", async () => {
    write("generated/cv.pdf", "broken");
    const { d } = deps([{ relativePath: "generated/cv.pdf" }], { aborted: true });
    const out = await runArtifactVerificationGate(d);
    expect(out.status).toBe("not_applicable");
    expect(executeToolMock).not.toHaveBeenCalled();
  });
});

describe("user-facing text", () => {
  it("names the file and the defect, and does not claim the file is fine", () => {
    const caveat = buildFailureCaveat("generated/cv.pdf: PDF trailer missing — the file was cut off");
    expect(caveat).toMatch(/cv\.pdf/);
    expect(caveat).toMatch(/cut off/);
    expect(caveat).toMatch(/may not open correctly/);
  });

  it("tells the repair agent the bytes are the problem, not the wording", () => {
    const task = buildRepairTask("a.pdf: truncated");
    expect(task).toMatch(/NOT usable/);
    expect(task).toMatch(/re-writing or re-explaining the response will not fix it/i);
    expect(task).toMatch(/SAME path/);
  });
});
