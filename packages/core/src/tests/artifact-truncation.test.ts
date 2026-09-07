import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactFileLooksTruncated } from "../agent/sub-agent.js";

// Regression (audit e5b5850b): web_coder's chunked build was killed by the
// 240s turn timeout after writing only the HTML/CSS skeleton chunk — the file
// ended mid-<script> with no data, no logic, and no closing tag — and the
// deterministic artifact completion branded it "Deliverable completed". The
// detector below is what downgrades such runs to an honest PARTIAL.
describe("artifactFileLooksTruncated", () => {
  let dir: string;

  const writeTemp = (name: string, content: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  };

  /** Same, but inside the artifact zone — where a marker is the artifact, not a mention of one. */
  const writeArtifact = (name: string, content: string): string => {
    const zone = path.join(dir, "generated");
    fs.mkdirSync(zone, { recursive: true });
    const p = path.join(zone, name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sai-artifact-trunc-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flags an HTML document that ends mid-file without </html> (audit e5b5850b shape)", () => {
    const p = writeTemp("quiz.html", [
      "<!DOCTYPE html>",
      "<html lang=\"de\">",
      "<head><title>iSAQB CPSA-F Lernplattform</title><style>body{color:#fff}</style></head>",
      "<body><div id=\"app\"></div>",
      "<script>",
      "// ============================================================",
      "// DATA — iSAQB CPSA-F Question Bank",
      "// ============================================================",
    ].join("\n"));
    const reason = artifactFileLooksTruncated({ path: p, filename: "quiz.html" });
    expect(reason).toContain("</html>");
  });

  it("accepts a complete HTML document", () => {
    const p = writeTemp("done.html", "<!DOCTYPE html>\n<html><head></head><body>ok</body></html>\n");
    expect(artifactFileLooksTruncated({ path: p, filename: "done.html" })).toBeNull();
  });

  it("does not judge an HTML fragment that never opened an <html> tag", () => {
    const p = writeTemp("fragment.html", "<section><h1>Partial template</h1></section>");
    expect(artifactFileLooksTruncated({ path: p, filename: "fragment.html" })).toBeNull();
  });

  it("flags a JSON file that does not parse", () => {
    const p = writeTemp("questions.json", "[{\"id\":1,\"question\":\"Was ist Softwarearchitektur?\",\"options\":[\"A\",\"B\"");
    const reason = artifactFileLooksTruncated({ path: p, filename: "questions.json" });
    expect(reason).toContain("JSON");
  });

  it("accepts valid JSON", () => {
    const p = writeTemp("ok.json", "[{\"id\":1}]");
    expect(artifactFileLooksTruncated({ path: p, filename: "ok.json" })).toBeNull();
  });

  it("returns null for other formats and missing files (fail-open)", () => {
    const p = writeTemp("notes.md", "# unfinished markdown has no terminator");
    expect(artifactFileLooksTruncated({ path: p, filename: "notes.md" })).toBeNull();
    expect(artifactFileLooksTruncated({ path: path.join(dir, "missing.html"), filename: "missing.html" })).toBeNull();
    expect(artifactFileLooksTruncated({ filename: "no-path.html" })).toBeNull();
  });

  // The format rules above are all TERMINATOR checks, and a staged build that stops
  // half way defeats every one of them: it wrote its closing tags in pass one. The
  // marker is the artifact saying outright which subsystem is missing.
  it("flags a script whose subsystem is still an unfilled staged-build marker", () => {
    const p = writeTemp("app.js", "export function boot(){\n  throw new Error(\"UNFINISHED_STUB: physics\");\n}\n");
    expect(artifactFileLooksTruncated({ path: p, filename: "app.js" })).toContain("UNFINISHED_STUB");
  });

  it("accepts the same script once the subsystem is written", () => {
    // Without this pair the check above is satisfied by a function that flags every .js
    // file, and the reason string would carry no information.
    const p = writeTemp("app-done.js", "export function boot(){\n  return { gravity: 9.81 };\n}\n");
    expect(artifactFileLooksTruncated({ path: p, filename: "app-done.js" })).toBeNull();
  });

  it("does not judge a prose file OUTSIDE the artifact zone — it is discussing the convention", () => {
    // A plan or design note may name the marker without being an unfinished artifact. That
    // is why prose is scoped by location rather than extension: scanForStubMarkers states
    // the same rule for itself — "a marker outside generated/ is prose about the
    // convention, not a build".
    const p = writeTemp("plan.md", "Next up: UNFINISHED_STUB: physics");
    expect(artifactFileLooksTruncated({ path: p, filename: "plan.md" })).toBeNull();
  });

  it("judges a SCRIPT anywhere — there the marker is a statement that throws", () => {
    // The location scope applies to prose only. In code the directive writes the marker as
    // executable code, so it cannot be the file talking about the convention.
    const p = writeTemp("loose.js", "throw new Error(\"UNFINISHED_STUB: physics\");");
    expect(artifactFileLooksTruncated({ path: p, filename: "loose.js" })).toContain("UNFINISHED_STUB");
  });

  /**
   * The marker check is a check on the artifact's own words, not on its syntax, so gating it
   * behind a web-format allowlist made it blind to exactly the builds paper_author runs.
   * Session 00b3675d ran four staged builds whose artifacts were Markdown; every one was
   * reported complete because .md was not on the list. scanForStubMarkers — the other half of
   * the same contract — reads every file it walks, so the two halves disagreed about which
   * files count.
   */
  it("flags an unfilled marker in a MARKDOWN artifact (session 00b3675d)", () => {
    const p = writeArtifact("openai_vs_anthropic_subscription_comparison.md", [
      "# Subscription comparison",
      "",
      "## Executive summary",
      "Both vendors offer individual and team tiers.",
      "",
      "## Pricing table",
      "UNFINISHED_STUB: pricing_table",
      "",
      "## Recommendation",
      "See above.",
    ].join("\n"));
    const reason = artifactFileLooksTruncated({ path: p, filename: "openai_vs_anthropic_subscription_comparison.md" });
    expect(reason).toBeTruthy();
    expect(reason).toContain("UNFINISHED_STUB");
  });

  it("flags an unfilled marker in a plain-text artifact too", () => {
    const p = writeArtifact("notes.txt", "Findings\n\nUNFINISHED_STUB: sources\n");
    expect(artifactFileLooksTruncated({ path: p, filename: "notes.txt" })).toBeTruthy();
  });

  it("passes a COMPLETE markdown artifact — the widening must not flag prose", () => {
    const p = writeArtifact("complete.md", [
      "# Subscription comparison",
      "",
      "| Plan | Price |",
      "| --- | --- |",
      "| Pro | $20/mo |",
      "",
      "Every section is written.",
    ].join("\n"));
    expect(artifactFileLooksTruncated({ path: p, filename: "complete.md" })).toBeNull();
  });

  it("does not read binary containers as text, even inside the zone", () => {
    // generate_pdf/generate_docx output: unreadable as UTF-8, judged by no format rule, and
    // skipped before the read so widening the check costs nothing on that path.
    const p = writeArtifact("report.pdf", "%PDF-1.7\n%binary\nUNFINISHED_STUB should not be read here\n");
    expect(artifactFileLooksTruncated({ path: p, filename: "report.pdf" })).toBeNull();
  });
});
