import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("generate_website", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function tool() {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./website.js"),
    ]);
    return getTool("generate_website")!;
  }

  function tempWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-website-"));
    cleanup.push(dir);
    return dir;
  }

  it("is registered", async () => {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./website.js"),
    ]);
    expect(getTool("generate_website")).toBeDefined();
  });

  it("rejects pages without an index.html entry", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "site",
      title: "My site",
      pages: [
        { path: "about.html", title: "About", content: "# About" },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(false);
    expect(result.error).toContain("index.html");
    expect(existsSync(join(ws, "site", "about.html"))).toBe(false);
  });

  it("writes index.html, theme.css, and renders markdown", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "site",
      title: "My Site",
      description: "Test description",
      theme: "default",
      pages: [
        {
          path: "index.html",
          title: "Home",
          content: "# Welcome\n\nThis is **my** site with `code` and a [link](https://example.com).",
        },
        {
          path: "about.html",
          title: "About",
          content: "# About\n\n- item one\n- item two",
        },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    expect(result.metadata?.["artifactKind"]).toBe("website");
    expect(result.metadata?.["pageCount"]).toBe(2);
    expect(result.metadata?.["indexPath"]).toBe("site/index.html");

    const indexHtml = readFileSync(join(ws, "site", "index.html"), "utf8");
    expect(indexHtml).toContain("<title>Home");
    expect(indexHtml).toContain("<h1>Welcome</h1>");
    expect(indexHtml).toContain("<strong>my</strong>");
    expect(indexHtml).toContain("<code>code</code>");
    expect(indexHtml).toContain("href=\"https://example.com\"");
    expect(indexHtml).toContain("href=\"theme.css\"");
    expect(indexHtml).toContain("<meta name=\"description\" content=\"Test description\">");

    const aboutHtml = readFileSync(join(ws, "site", "about.html"), "utf8");
    expect(aboutHtml).toContain("<li>item one</li>");
    expect(aboutHtml).toContain("<li>item two</li>");

    const css = readFileSync(join(ws, "site", "theme.css"), "utf8");
    expect(css).toContain("generate_website theme: default");
    expect(css).toContain("--bg:");
  });

  it("auto-generates nav from included pages; honors navLabel + includeInNav=false", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        { path: "index.html", title: "Home", content: "# Home" },
        { path: "docs.html", title: "Documentation", content: "# Docs", navLabel: "Docs" },
        { path: "hidden.html", title: "Hidden", content: "# Hidden", includeInNav: false },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    const indexHtml = readFileSync(join(ws, "site", "index.html"), "utf8");
    expect(indexHtml).toMatch(/<a href="index\.html"[^>]*class="active"[^>]*>\s*Home\s*<\/a>/);
    expect(indexHtml).toMatch(/<a href="docs\.html"[^>]*>\s*Docs\s*<\/a>/);
    expect(indexHtml).not.toContain("Hidden");
  });

  it("fenced code block renders as <pre><code class=\"language-foo\">", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        {
          path: "index.html",
          title: "Home",
          content: "```ts\nconst x: number = 1;\n```\n",
        },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    const html = readFileSync(join(ws, "site", "index.html"), "utf8");
    expect(html).toContain("<pre><code class=\"language-ts\">");
    expect(html).toContain("const x: number = 1;");
  });

  it("GFM table renders as <table>", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        {
          path: "index.html",
          title: "Home",
          content: "| Name | Qty |\n|------|----:|\n| Foo  | 3   |\n| Bar  | 12  |\n",
        },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    const html = readFileSync(join(ws, "site", "index.html"), "utf8");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain('style="text-align:right">Qty</th>');
    expect(html).toContain("<td>Foo</td>");
  });

  it("nested pages get ../theme.css link (correct relative depth)", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        { path: "index.html", title: "Home", content: "# Home" },
        { path: "docs/getting-started.html", title: "Start", content: "# Start" },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    const subHtml = readFileSync(join(ws, "site", "docs", "getting-started.html"), "utf8");
    expect(subHtml).toContain('href="../theme.css"');
    expect(subHtml).toContain('href="../index.html"');
  });

  it("writes utf8 and base64 assets into the site dir", async () => {
    const ws = tempWorkspace();
    const pngBase64 = Buffer.from("fake-png-bytes").toString("base64");
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [{ path: "index.html", title: "Home", content: "# Home" }],
      assets: [
        { path: "extra.js", content: "console.log(1);", encoding: "utf8" },
        { path: "img/logo.png", content: pngBase64, encoding: "base64" },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    expect(readFileSync(join(ws, "site", "extra.js"), "utf8")).toBe("console.log(1);");
    expect(readFileSync(join(ws, "site", "img", "logo.png"))).toEqual(Buffer.from("fake-png-bytes"));
  });

  it("refuses directory traversal in page and asset paths", async () => {
    const ws = tempWorkspace();
    const bad1 = await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        { path: "index.html", title: "Home", content: "# Home" },
        { path: "../evil.html", title: "Evil", content: "# Evil" },
      ],
    }, { sessionId: "s1", workspacePath: ws });
    expect(bad1.success).toBe(false);
    expect(bad1.error).toContain("..");

    const bad2 = await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [{ path: "index.html", title: "Home", content: "# Home" }],
      assets: [{ path: "../secret.txt", content: "x" }],
    }, { sessionId: "s1", workspacePath: ws });
    expect(bad2.success).toBe(false);
    expect(bad2.error).toContain("..");
  });

  it("mermaid code block renders as <pre class=\"mermaid\"> when includeMermaid=true", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        {
          path: "index.html",
          title: "Home",
          content: "```mermaid\nflowchart LR; A --> B\n```\n",
        },
      ],
      includeMermaid: true,
    }, { sessionId: "s1", workspacePath: ws });

    const html = readFileSync(join(ws, "site", "index.html"), "utf8");
    expect(html).toContain("<pre class=\"mermaid\">");
    expect(html).toContain("mermaid.esm.min.mjs");
  });

  it("raw HTML format passes through verbatim", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [
        {
          path: "index.html",
          title: "Home",
          format: "html",
          content: "<section class=\"hero\"><h1>Welcome</h1><p>Raw HTML allowed.</p></section>",
        },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    const html = readFileSync(join(ws, "site", "index.html"), "utf8");
    expect(html).toContain("<section class=\"hero\">");
    expect(html).toContain("<h1>Welcome</h1>");
  });

  it("overwrite=false refuses when index.html already exists", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [{ path: "index.html", title: "Home", content: "# Home" }],
    }, { sessionId: "s1", workspacePath: ws });

    const second = await (await tool()).execute({
      outputDir: "site",
      title: "S",
      pages: [{ path: "index.html", title: "Home", content: "# Replaced" }],
      overwrite: false,
    }, { sessionId: "s1", workspacePath: ws });

    expect(second.success).toBe(false);
    expect(second.error).toContain("Refusing");
  });
});

// The reliable artifact path for "create an HTML/reveal.js presentation" — the
// recurring Dresden-deck failure was the slow model timing out on a single giant
// write_file HTML blob. generate_presentation lets the model author compact Markdown
// per slide while the tool assembles the full reveal.js HTML deterministically.
describe("generate_presentation", () => {
  const cleanup: string[] = [];
  beforeEach(() => { cleanup.length = 0; });
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function tool() {
    const [{ getTool }] = await Promise.all([import("./registry.js"), import("./website.js")]);
    return getTool("generate_presentation")!;
  }
  function tempWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-deck-"));
    cleanup.push(dir);
    return dir;
  }

  it("is registered", async () => {
    const [{ getTool }] = await Promise.all([import("./registry.js"), import("./website.js")]);
    expect(getTool("generate_presentation")).toBeDefined();
  });

  it("builds a reveal.js deck: one <section> per slide, markdown + bullets rendered", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "Dresden Architecture",
      theme: "white",
      slides: [
        { title: "Der Zwinger", content: "Ein **barockes** Bauensemble.\n\nErbaut 1709–1728." },
        { title: "Highlights", bullets: ["Kronentor", "Nymphenbad", "Glockenspielpavillon"], notes: "Speaker note here." },
      ],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    expect(result.metadata?.["artifactKind"]).toBe("website");
    expect(result.metadata?.["slideCount"]).toBe(2);
    expect(result.metadata?.["indexPath"]).toBe("deck/index.html");

    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).toContain("<title>Dresden Architecture</title>");
    expect(html).toContain('class="reveal"');
    expect((html.match(/<section>/g) ?? []).length).toBe(2);
    expect(html).toContain("<h2>Der Zwinger</h2>");
    expect(html).toContain("<strong>barockes</strong>");
    expect(html).toContain("<li>Kronentor</li>");
    expect(html).toContain('<aside class="notes">');
    expect(html).toContain("reveal.js@4.6.1/dist/reveal.js");
    expect(html).toContain("theme/white.css");
  });

  it("honors theme + revealVersion and sanitizes a bad version to the default", async () => {
    const ws = tempWorkspace();
    await (await tool()).execute({
      outputDir: "deck",
      title: "T",
      theme: "night",
      revealVersion: "5.0.4",
      slides: [{ title: "One", content: "Body" }],
    }, { sessionId: "s1", workspacePath: ws });
    let html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).toContain("reveal.js@5.0.4/");
    expect(html).toContain("theme/night.css");

    const ws2 = tempWorkspace();
    await (await tool()).execute({
      outputDir: "deck",
      title: "T",
      revealVersion: "../../etc/passwd",
      slides: [{ title: "One", content: "Body" }],
    }, { sessionId: "s1", workspacePath: ws2 });
    html = readFileSync(join(ws2, "deck", "index.html"), "utf8");
    expect(html).toContain("reveal.js@4.6.1/");
    expect(html).not.toContain("passwd");
  });

  it("rejects a bad theme and an empty/invalid slide list", async () => {
    const ws = tempWorkspace();
    const badTheme = await (await tool()).execute({
      outputDir: "deck", title: "T", theme: "neon", slides: [{ title: "x" }],
    }, { sessionId: "s1", workspacePath: ws });
    expect(badTheme.success).toBe(false);
    expect(badTheme.error).toContain("theme");

    const emptySlides = await (await tool()).execute({
      outputDir: "deck", title: "T", slides: [],
    }, { sessionId: "s1", workspacePath: ws });
    expect(emptySlides.success).toBe(false);

    const emptySlide = await (await tool()).execute({
      outputDir: "deck", title: "T", slides: [{ notes: "only notes, no content" }],
    }, { sessionId: "s1", workspacePath: ws });
    expect(emptySlide.success).toBe(false);
    expect(emptySlide.error).toContain("at least one of");
  });

  it("overwrite=false refuses an existing deck", async () => {
    const ws = tempWorkspace();
    const args = { outputDir: "deck", title: "T", slides: [{ title: "One", content: "Body" }] };
    await (await tool()).execute(args, { sessionId: "s1", workspacePath: ws });
    const second = await (await tool()).execute({ ...args, overwrite: false }, { sessionId: "s1", workspacePath: ws });
    expect(second.success).toBe(false);
    expect(second.error).toContain("Refusing");
  });

  // The slow local model often serializes the slides array (and per-slide bullets) as a
  // JSON *string* instead of a real array — the deck must still build on the first call
  // rather than bouncing on "slides must be an array" and burning the per-tool cap
  // (audit 2daf5f54: 5 turns wasted before one call happened to pass a real array).
  it("coerces a JSON-string slides argument into a real deck", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "Coerced",
      slides: JSON.stringify([
        { title: "Der Zwinger", content: "Ein **barockes** Bauensemble." },
        { title: "Highlights", bullets: ["Kronentor", "Nymphenbad"] },
      ]),
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    expect(result.metadata?.["slideCount"]).toBe(2);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect((html.match(/<section>/g) ?? []).length).toBe(2);
    expect(html).toContain("<h2>Der Zwinger</h2>");
    expect(html).toContain("<strong>barockes</strong>");
    expect(html).toContain("<li>Kronentor</li>");
  });

  it("coerces a JSON-string bullets field on a slide", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "Coerced bullets",
      slides: [{ title: "Highlights", bullets: JSON.stringify(["Kronentor", "Nymphenbad", "Glockenspielpavillon"]) }],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).toContain("<li>Kronentor</li>");
    expect(html).toContain("<li>Glockenspielpavillon</li>");
  });

  it("wraps a single slide object (not in an array) into a one-slide deck", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "Single",
      slides: { title: "Only One", content: "Body" } as unknown as never,
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    expect(result.metadata?.["slideCount"]).toBe(1);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect((html.match(/<section>/g) ?? []).length).toBe(1);
    expect(html).toContain("<h2>Only One</h2>");
  });

  // Images: a slide can embed a verified image URL via the `image` field (the deck-build
  // half of the image unit — the image_sourcer agent supplies the verified URLs).
  it("embeds a slide image from the `image` field with alt text", async () => {
    const ws = tempWorkspace();
    const url = "https://upload.wikimedia.org/wikipedia/commons/8/8a/Zwinger_Dresden.jpg";
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "Bilder",
      slides: [{ title: "Der Zwinger", image: url, imageAlt: "Zwinger Gesamtansicht", content: "Barock." }],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).toContain(`<img src="${url}" alt="Zwinger Gesamtansicht">`);
    // Image is placed before the body content.
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("Barock"));
  });

  it("renders an `images` list (incl. a JSON-string) as figures with captions", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "Galerie",
      slides: [{
        title: "Highlights",
        images: JSON.stringify([
          { url: "https://example.com/a.jpg", caption: "Kronentor" },
          { url: "https://example.com/b.png", alt: "Nymphenbad" },
        ]),
      }],
    }, { sessionId: "s1", workspacePath: ws });

    expect(result.success).toBe(true);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).toContain('<img src="https://example.com/a.jpg"');
    expect(html).toContain("<figcaption>Kronentor</figcaption>");
    expect(html).toContain('<img src="https://example.com/b.png" alt="Nymphenbad">');
  });

  it("a slide with only a valid image (no title/content/bullets) still builds", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "T",
      slides: [{ image: "https://example.com/only.jpg" }],
    }, { sessionId: "s1", workspacePath: ws });
    expect(result.success).toBe(true);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).toContain('<img src="https://example.com/only.jpg"');
  });

  it("rejects a non-http(s)/data image URL (no javascript:/file: injection into the deck)", async () => {
    const ws = tempWorkspace();
    const result = await (await tool()).execute({
      outputDir: "deck",
      title: "T",
      // The bad image is dropped; the slide still has a title so it builds without an <img>.
      slides: [{ title: "Safe", image: "javascript:alert(1)" }],
    }, { sessionId: "s1", workspacePath: ws });
    expect(result.success).toBe(true);
    const html = readFileSync(join(ws, "deck", "index.html"), "utf8");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("<h2>Safe</h2>");

    // A slide whose ONLY content is a rejected image is empty → error.
    const empty = await (await tool()).execute({
      outputDir: "deck2",
      title: "T",
      slides: [{ image: "file:///etc/passwd" }],
    }, { sessionId: "s1", workspacePath: ws });
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("at least one of");
  });
});
