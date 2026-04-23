import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("source-file extractors", () => {
  const cleanup: string[] = [];
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "starlingai-extractors-"));
    cleanup.push(workspace);
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function getTool(name: string) {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./extractors.js"),
    ]);
    return getTool(name)!;
  }

  function ctx() {
    return { sessionId: "s1", workspacePath: workspace };
  }

  // ── extract_notebook ──────────────────────────────────────────────────────

  it("extract_notebook converts code + markdown + outputs to markdown", async () => {
    const notebook = {
      metadata: { kernelspec: { language: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "\n", "Some intro."] },
        {
          cell_type: "code",
          execution_count: 1,
          source: ["x = 1\n", "print(x)"],
          outputs: [
            { output_type: "stream", text: "1\n" },
            { output_type: "execute_result", data: { "text/plain": "1" } },
          ],
        },
        {
          cell_type: "code",
          execution_count: 2,
          source: ["raise ValueError('boom')"],
          outputs: [{ output_type: "error", ename: "ValueError", evalue: "boom" }],
        },
      ],
    };
    writeFileSync(join(workspace, "nb.ipynb"), JSON.stringify(notebook), "utf8");

    const result = await (await getTool("extract_notebook")).execute({ path: "nb.ipynb" }, ctx());
    expect(result.success).toBe(true);
    const out = result.output;
    expect(out).toContain("# Title");
    expect(out).toContain("```python");
    expect(out).toContain("x = 1");
    expect(out).toContain("> 1"); // stream output quoted
    expect(out).toContain("> ValueError: boom");
    expect(result.metadata?.["codeCellCount"]).toBe(2);
    expect(result.metadata?.["language"]).toBe("python");
  });

  it("extract_notebook respects includeOutputs=false", async () => {
    const notebook = {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          source: ["print('hi')"],
          outputs: [{ output_type: "stream", text: "hi\n" }],
        },
      ],
    };
    writeFileSync(join(workspace, "nb.ipynb"), JSON.stringify(notebook), "utf8");

    const result = await (await getTool("extract_notebook")).execute({
      path: "nb.ipynb",
      includeOutputs: false,
    }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toContain("print('hi')");
    expect(result.output).not.toContain("> hi");
  });

  it("extract_notebook rejects non-ipynb extension", async () => {
    writeFileSync(join(workspace, "x.txt"), "{}", "utf8");
    const result = await (await getTool("extract_notebook")).execute({ path: "x.txt" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain(".ipynb");
  });

  // ── extract_email ─────────────────────────────────────────────────────────

  it("extract_email parses headers + plain-text body", async () => {
    const eml = [
      "From: alice@example.com",
      "To: bob@example.com",
      "Subject: Hello",
      "Date: Wed, 23 Apr 2026 10:00:00 +0000",
      "Message-ID: <abc@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello world.",
      "Second line.",
    ].join("\r\n");
    writeFileSync(join(workspace, "msg.eml"), eml, "utf8");

    const result = await (await getTool("extract_email")).execute({ path: "msg.eml" }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toContain("From: alice@example.com");
    expect(result.output).toContain("Subject: Hello");
    expect(result.output).toContain("Hello world.");
    expect(result.output).toContain("Second line.");
    expect(result.metadata?.["from"]).toBe("alice@example.com");
    expect(result.metadata?.["subject"]).toBe("Hello");
    expect(result.metadata?.["bodyKind"]).toBe("text");
  });

  it("extract_email decodes quoted-printable bodies", async () => {
    const eml = [
      "From: a@x.com",
      "Subject: =?UTF-8?Q?Caf=C3=A9?=",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=C3=A9 break at 3pm.",
    ].join("\r\n");
    writeFileSync(join(workspace, "qp.eml"), eml, "utf8");

    const result = await (await getTool("extract_email")).execute({ path: "qp.eml" }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toContain("Café break at 3pm.");
    expect(result.output).toContain("Subject: Café");
  });

  it("extract_email handles multipart with text + html + attachment", async () => {
    const boundary = "BOUND-1";
    const attachmentB64 = Buffer.from("PDF-contents").toString("base64");
    const eml = [
      "From: a@x.com",
      "To: b@y.com",
      "Subject: Mixed",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain body here.",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML body here.</p>",
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      attachmentB64,
      `--${boundary}--`,
    ].join("\r\n");
    writeFileSync(join(workspace, "mp.eml"), eml, "utf8");

    const result = await (await getTool("extract_email")).execute({ path: "mp.eml" }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toContain("Plain body here.");
    expect(result.output).toContain("report.pdf");
    expect(result.output).toContain("application/pdf");
    expect(result.metadata?.["attachmentCount"]).toBe(1);
  });

  it("extract_email reads the first message in an .mbox file", async () => {
    const mbox = [
      "From bob@example.com Wed Apr 23 10:00:00 2026",
      "From: bob@example.com",
      "Subject: First",
      "Content-Type: text/plain",
      "",
      "First message body.",
      "",
      "From alice@example.com Wed Apr 23 11:00:00 2026",
      "From: alice@example.com",
      "Subject: Second",
      "Content-Type: text/plain",
      "",
      "Second message body.",
    ].join("\n");
    writeFileSync(join(workspace, "inbox.mbox"), mbox, "utf8");

    const result = await (await getTool("extract_email")).execute({ path: "inbox.mbox" }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toContain("Subject: First");
    expect(result.output).toContain("First message body.");
    expect(result.output).not.toContain("Second message body.");
  });

  // ── extract_calendar ──────────────────────────────────────────────────────

  it("extract_calendar parses VEVENT blocks with attendees and rrule", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:evt-1@example.com",
      "DTSTART:20260423T080000Z",
      "DTEND:20260423T090000Z",
      "SUMMARY:Standup",
      "DESCRIPTION:Daily sync\\nReview blockers",
      "LOCATION:Zoom",
      "ORGANIZER;CN=Alice:MAILTO:alice@example.com",
      "ATTENDEE;CN=Bob:MAILTO:bob@example.com",
      "ATTENDEE;CN=Carol:MAILTO:carol@example.com",
      "STATUS:CONFIRMED",
      "RRULE:FREQ=DAILY;COUNT=5",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    writeFileSync(join(workspace, "cal.ics"), ics, "utf8");

    const result = await (await getTool("extract_calendar")).execute({ path: "cal.ics" }, ctx());
    expect(result.success).toBe(true);
    const events = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt["uid"]).toBe("evt-1@example.com");
    expect(evt["summary"]).toBe("Standup");
    expect(evt["description"]).toBe("Daily sync\nReview blockers");
    expect(evt["organizer"]).toBe("alice@example.com");
    expect(evt["attendees"]).toEqual(["bob@example.com", "carol@example.com"]);
    expect(evt["rrule"]).toBe("FREQ=DAILY;COUNT=5");
    expect(result.metadata?.["eventCount"]).toBe(1);
  });

  it("extract_calendar filters past events when includePast=false", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:past@example.com",
      "DTSTART:20200101T080000Z",
      "DTEND:20200101T090000Z",
      "SUMMARY:Old meeting",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:future@example.com",
      "DTSTART:20300101T080000Z",
      "DTEND:20300101T090000Z",
      "SUMMARY:Future meeting",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    writeFileSync(join(workspace, "cal.ics"), ics, "utf8");

    const result = await (await getTool("extract_calendar")).execute({
      path: "cal.ics",
      includePast: false,
    }, ctx());
    expect(result.success).toBe(true);
    const events = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]!["uid"]).toBe("future@example.com");
    expect(result.metadata?.["totalEventCount"]).toBe(2);
    expect(result.metadata?.["skippedPastCount"]).toBe(1);
  });

  it("extract_calendar unfolds RFC 5545 continuation lines", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:longline@example.com",
      "SUMMARY:A really long",
      "  summary that is folded",
      "  across three lines",
      "DTSTART:20260423T080000Z",
      "DTEND:20260423T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    writeFileSync(join(workspace, "cal.ics"), ics, "utf8");

    const result = await (await getTool("extract_calendar")).execute({ path: "cal.ics" }, ctx());
    expect(result.success).toBe(true);
    const events = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(events[0]!["summary"]).toBe("A really long summary that is folded across three lines");
  });

  // ── transcribe_video ──────────────────────────────────────────────────────

  it("transcribe_video rejects unsupported extensions before touching the network", async () => {
    writeFileSync(join(workspace, "x.txt"), "not a video", "utf8");
    const result = await (await getTool("transcribe_video")).execute({ path: "x.txt" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("video file");
  });

  it("transcribe_video routes to transcribe_audio for valid extensions", async () => {
    // Stub the transcribe_audio tool registration to avoid the real STT call.
    const { registerTool, getTool } = await import("./registry.js");
    await import("./extractors.js");
    registerTool({
      name: "transcribe_audio",
      description: "test stub",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return { success: true, output: `stubbed-transcript-for:${args["path"]}`, metadata: { stub: true } };
      },
    });

    const tool = getTool("transcribe_video")!;
    writeFileSync(join(workspace, "clip.mp4"), Buffer.from([0, 1, 2]));
    const result = await tool.execute({ path: "clip.mp4", language: "en" }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toBe("stubbed-transcript-for:clip.mp4");
    expect(result.metadata?.["stub"]).toBe(true);
  });
});
