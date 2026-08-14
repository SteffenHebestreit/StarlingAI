import { describe, it, expect } from "vitest";
import {
  validateArtifactBytes,
  validateCodeIntegrityText,
  validateHtmlText,
  checkFormatMatchesExtension,
  extensionOf,
} from "../agent/artifact-validators.js";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const bin = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** Smallest real PNG (1x1 transparent). */
const PNG = bin("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

async function realPdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("hello", { x: 40, y: 700, size: 12, font });
  return doc.save();
}

async function realDocx(): Promise<Uint8Array> {
  const { Document, Packer, Paragraph } = await import("docx");
  const doc = new Document({ sections: [{ properties: {}, children: [new Paragraph("hi")] }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}

describe("validateArtifactBytes — PDF", () => {
  it("passes a real PDF", async () => {
    const r = await validateArtifactBytes("out/report.pdf", await realPdf());
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/1 page/);
  });

  it("fails a PDF truncated before its trailer — the render-died-midway case", async () => {
    const full = await realPdf();
    const cut = full.subarray(0, Math.floor(full.length * 0.6));
    const r = await validateArtifactBytes("out/report.pdf", cut);
    expect(r.status).toBe("fail");
    expect(r.severity).toBe("hard");
    expect(r.detail).toMatch(/%%EOF|cut off/i);
  });

  it("fails bytes that are not a PDF at all", async () => {
    const r = await validateArtifactBytes("out/report.pdf", enc("Sorry, I could not generate that."));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not a PDF/);
  });

  it("fails a zero-byte file before looking at format", async () => {
    const r = await validateArtifactBytes("out/report.pdf", new Uint8Array(0));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/zero-byte/);
  });
});

describe("validateArtifactBytes — OOXML / zip", () => {
  it("passes a real DOCX", async () => {
    const r = await validateArtifactBytes("out/letter.docx", await realDocx());
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/valid DOCX/);
  });

  it("fails a DOCX truncated mid-archive", async () => {
    const full = await realDocx();
    const r = await validateArtifactBytes("out/letter.docx", full.subarray(0, Math.floor(full.length * 0.5)));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/central directory|unreadable/i);
  });

  it("fails a valid ZIP that is missing the DOCX main part", async () => {
    // A real zip, but not a Word document — the exact "wrong thing in the right
    // wrapper" case that a magic-byte check alone would wave through.
    const docx = await realDocx();
    const r = await validateArtifactBytes("out/notes.xlsx", docx);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/xl\/workbook\.xml/);
  });
});

describe("validateArtifactBytes — images and text", () => {
  it("passes a real PNG and fails a truncated one", async () => {
    expect((await validateArtifactBytes("a.png", PNG)).status).toBe("pass");
    const r = await validateArtifactBytes("a.png", PNG.subarray(0, 20));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/IEND|truncated/i);
  });

  it("validates JSON, SVG and ICS", async () => {
    expect((await validateArtifactBytes("a.json", enc('{"a":1}'))).status).toBe("pass");
    expect((await validateArtifactBytes("a.json", enc('{"a":1'))).status).toBe("fail");

    expect((await validateArtifactBytes("a.svg", enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).status).toBe("pass");
    expect((await validateArtifactBytes("a.svg", enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/>'))).status).toBe("fail");

    expect((await validateArtifactBytes("a.ics", enc("BEGIN:VCALENDAR\nEND:VCALENDAR"))).status).toBe("pass");
    expect((await validateArtifactBytes("a.ics", enc("BEGIN:VCALENDAR\nBEGIN:VEVENT"))).status).toBe("fail");
  });

  it("reports unverifiable — never fail — for a format it does not know", async () => {
    const r = await validateArtifactBytes("a.dwg", enc("whatever"));
    expect(r.status).toBe("unverifiable");
  });
});

describe("validateHtmlText", () => {
  it("passes a complete document and fails one cut off mid-tag", () => {
    expect(validateHtmlText("<html><body><p>hi</p></body></html>").status).toBe("pass");
    const r = validateHtmlText("<html><body><p>hi</p></body></htm");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/mid-tag/);
  });

  it("fails a document whose </html> never arrives", () => {
    expect(validateHtmlText("<html><body><p>hi</p>").status).toBe("fail");
  });

  // The regression that motivated stripping script/style bodies before counting.
  it("does NOT fail a valid page that prints markup inside a script string", () => {
    const html = `<html><body><script>document.write("<script>x<\\/script>");</script></body></html>`;
    expect(validateHtmlText(html).status).toBe("pass");
  });

  it("does NOT fail a tutorial page showing tags inside a comment", () => {
    const html = `<html><body><!-- example: <body> without a closer --><p>ok</p></body></html>`;
    expect(validateHtmlText(html).status).toBe("pass");
  });

  it("treats a fragment without <html> as fine", () => {
    expect(validateHtmlText("<p>just a partial</p>").status).toBe("pass");
  });
});

describe("validateCodeIntegrityText", () => {
  it("passes complete JavaScript", () => {
    const src = `function greet(name) {\n  return \`hi \${name}\`;\n}\nexport default greet;\n`;
    expect(validateCodeIntegrityText(src, ".js").status).toBe("pass");
  });

  it("fails code that ends mid-block — the completion-budget truncation", () => {
    const src = `function greet(name) {\n  if (name) {\n    console.log("hi");\n`;
    const r = validateCodeIntegrityText(src, ".js");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unclosed brace/);
  });

  it("fails code that ends inside a string literal", () => {
    const r = validateCodeIntegrityText(`const msg = "hello there\n`, ".js");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unterminated string/);
  });

  it("fails code that ends inside a block comment", () => {
    const r = validateCodeIntegrityText(`const a = 1;\n/* explanation that never ends\n`, ".ts");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unterminated block comment/);
  });

  // False-positive guards: each of these is valid code that a naive brace counter breaks on.
  it("does not fail on braces inside strings, comments or template literals", () => {
    const src = [
      `const a = "{ not a real block";`,
      `// } stray brace in a comment`,
      `/* } another */`,
      "const t = `template ${ { nested: 1 }.nested } end`;",
      `const re = /\\{[^}]*\\}/g;`,
      `const div = 10 / 2;`,
    ].join("\n");
    expect(validateCodeIntegrityText(src, ".js").status).toBe("pass");
  });

  it("handles CSS without treating / as a regex", () => {
    expect(validateCodeIntegrityText(`.a { width: calc(100% / 3); }`, ".css").status).toBe("pass");
    expect(validateCodeIntegrityText(`.a { width: 10px;`, ".css").status).toBe("fail");
  });

  it("passes TypeScript generics and arrow functions", () => {
    const src = `export const f = <T,>(x: T): T[] => [x];\ninterface A { b: string }\n`;
    expect(validateCodeIntegrityText(src, ".ts").status).toBe("pass");
  });
});

describe("checkFormatMatchesExtension", () => {
  it("returns null when the bytes match the extension", async () => {
    expect(checkFormatMatchesExtension("a.pdf", await realPdf())).toBeNull();
    expect(checkFormatMatchesExtension("a.png", PNG)).toBeNull();
  });

  it("catches a DOCX delivered as a PDF — the wrong-format delivery", async () => {
    const r = checkFormatMatchesExtension("cv.pdf", await realDocx());
    expect(r?.status).toBe("fail");
    expect(r?.detail).toMatch(/ZIP-based/);
  });

  it("catches prose written into a .pdf", () => {
    const r = checkFormatMatchesExtension("cv.pdf", enc("Here is your CV!"));
    expect(r?.status).toBe("fail");
  });

  it("says nothing about formats with no signature", () => {
    expect(checkFormatMatchesExtension("a.md", enc("# hi"))).toBeNull();
    expect(checkFormatMatchesExtension("a.txt", enc("hi"))).toBeNull();
  });
});

describe("extensionOf", () => {
  it("handles nested paths, backslashes and dotless names", () => {
    expect(extensionOf("generated/deep/report.PDF")).toBe(".pdf");
    expect(extensionOf("generated\\win\\a.docx")).toBe(".docx");
    expect(extensionOf("Makefile")).toBe("");
  });
});
