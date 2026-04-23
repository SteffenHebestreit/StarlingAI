import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Wave B artifact emitters", () => {
  const cleanup: string[] = [];
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "starlingai-emitters-"));
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
      import("./artifact-emitters.js"),
    ]);
    return getTool(name)!;
  }

  function ctx() {
    return { sessionId: "s1", workspacePath: workspace };
  }

  // ── generate_svg ──────────────────────────────────────────────────────

  it("generate_svg writes a complete <svg> document verbatim", async () => {
    const result = await (await getTool("generate_svg")).execute({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>',
      title: "My Logo",
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["artifactKind"]).toBe("image");
    expect(result.metadata?.["format"]).toBe("svg");
    expect(result.metadata?.["outputPath"]).toBe("my-logo.svg");
    const written = readFileSync(join(workspace, "my-logo.svg"), "utf8");
    expect(written).toContain("<circle cx=\"50\"");
  });

  it("generate_svg wraps bare children with viewBox when no <svg> tag is present", async () => {
    const result = await (await getTool("generate_svg")).execute({
      svg: '<rect x="0" y="0" width="100" height="100" fill="blue"/>',
      output_file: "graphic.svg",
      width: 200,
      height: 80,
    }, ctx());

    expect(result.success).toBe(true);
    const written = readFileSync(join(workspace, "graphic.svg"), "utf8");
    expect(written).toContain('viewBox="0 0 200 80"');
    expect(written).toContain('<rect x="0"');
  });

  it("generate_svg rejects non-.svg output_file", async () => {
    const result = await (await getTool("generate_svg")).execute({
      svg: "<svg></svg>",
      output_file: "bad.png",
    }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain(".svg");
  });

  // ── generate_qr_code ──────────────────────────────────────────────────

  it("generate_qr_code produces a valid SVG with module rectangles", async () => {
    const result = await (await getTool("generate_qr_code")).execute({
      data: "https://example.com",
      output_file: "qr.svg",
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["artifactKind"]).toBe("image");
    expect(result.metadata?.["format"]).toBe("svg");
    expect(typeof result.metadata?.["moduleCount"]).toBe("number");
    expect((result.metadata?.["moduleCount"] as number) % 4).toBe(1); // 4*v + 17

    const svg = readFileSync(join(workspace, "qr.svg"), "utf8");
    expect(svg).toContain("<svg xmlns");
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain("<rect"); // contains finder/data rects
    expect(svg).toContain('fill="#000000"');
  });

  it("generate_qr_code respects errorCorrection level (Q vs L → larger version for same data)", async () => {
    const data = "x".repeat(80); // chosen to push past version 1's L capacity
    const lResult = await (await getTool("generate_qr_code")).execute({
      data, errorCorrection: "L", output_file: "qr-l.svg",
    }, ctx());
    const hResult = await (await getTool("generate_qr_code")).execute({
      data, errorCorrection: "H", output_file: "qr-h.svg",
    }, ctx());

    expect(lResult.success).toBe(true);
    expect(hResult.success).toBe(true);
    const lModules = lResult.metadata?.["moduleCount"] as number;
    const hModules = hResult.metadata?.["moduleCount"] as number;
    // H needs more EC overhead → same payload bumps to a larger version (more modules per side).
    expect(hModules).toBeGreaterThanOrEqual(lModules);
    expect(lResult.metadata?.["errorCorrection"]).toBe("L");
    expect(hResult.metadata?.["errorCorrection"]).toBe("H");
  });

  it("generate_qr_code embeds an accessible <title> when title arg given", async () => {
    const result = await (await getTool("generate_qr_code")).execute({
      data: "x", title: "Wi-Fi: Office", output_file: "qr.svg",
    }, ctx());
    expect(result.success).toBe(true);
    const svg = readFileSync(join(workspace, "qr.svg"), "utf8");
    expect(svg).toContain("<title>Wi-Fi: Office</title>");
  });

  // ── generate_ics ──────────────────────────────────────────────────────

  it("generate_ics emits RFC 5545 VCALENDAR with single event", async () => {
    const result = await (await getTool("generate_ics")).execute({
      events: [
        {
          uid: "evt-1@example.com",
          summary: "Standup",
          start: "2026-04-23T08:00:00Z",
          end: "2026-04-23T08:30:00Z",
          location: "Zoom",
          description: "Daily sync\nReview blockers",
          organizer: "alice@example.com",
          attendees: ["bob@example.com", "carol@example.com"],
          status: "CONFIRMED",
        },
      ],
      calendarName: "Team Standups",
      output_file: "cal.ics",
    }, ctx());

    expect(result.success).toBe(true);
    const ics = readFileSync(join(workspace, "cal.ics"), "utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:Team Standups");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:evt-1@example.com");
    expect(ics).toContain("DTSTART:20260423T080000Z");
    expect(ics).toContain("DTEND:20260423T083000Z");
    expect(ics).toContain("SUMMARY:Standup");
    expect(ics).toContain("DESCRIPTION:Daily sync\\nReview blockers");
    expect(ics).toContain("ATTENDEE:MAILTO:bob@example.com");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toMatch(/\r\n/); // RFC 5545 requires CRLF
  });

  it("generate_ics computes end from durationMinutes when end is omitted", async () => {
    const result = await (await getTool("generate_ics")).execute({
      events: [
        { summary: "Lunch", start: "2026-04-23T12:00:00Z", durationMinutes: 60 },
      ],
      output_file: "cal.ics",
    }, ctx());

    expect(result.success).toBe(true);
    const ics = readFileSync(join(workspace, "cal.ics"), "utf8");
    expect(ics).toContain("DTSTART:20260423T120000Z");
    expect(ics).toContain("DTEND:20260423T130000Z");
  });

  it("generate_ics escapes commas, semicolons, and backslashes in text fields", async () => {
    const result = await (await getTool("generate_ics")).execute({
      events: [
        {
          summary: "Q&A; with team, all hands",
          start: "2026-04-23T10:00:00Z",
          durationMinutes: 30,
          description: "Bring a backslash \\ and a comma, please.",
        },
      ],
      output_file: "cal.ics",
    }, ctx());
    expect(result.success).toBe(true);
    const ics = readFileSync(join(workspace, "cal.ics"), "utf8");
    expect(ics).toContain("SUMMARY:Q&A\\; with team\\, all hands");
    expect(ics).toContain("DESCRIPTION:Bring a backslash \\\\ and a comma\\, please.");
  });

  it("generate_ics auto-generates UIDs and DTSTAMP when omitted", async () => {
    const result = await (await getTool("generate_ics")).execute({
      events: [{ summary: "X", start: "2026-04-23T10:00:00Z", durationMinutes: 15 }],
      output_file: "cal.ics",
    }, ctx());
    expect(result.success).toBe(true);
    const ics = readFileSync(join(workspace, "cal.ics"), "utf8");
    expect(ics).toMatch(/UID:evt-[a-z0-9-]+@starlingai/);
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });

  it("generate_ics rejects empty events array", async () => {
    const result = await (await getTool("generate_ics")).execute({
      events: [], output_file: "cal.ics",
    }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("non-empty");
  });
});
