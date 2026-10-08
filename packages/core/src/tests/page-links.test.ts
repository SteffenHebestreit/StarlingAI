/**
 * A FETCHED PAGE KEEPS ITS LINKS.
 *
 * web_fetch turned every HTML page into text and kept no anchor's target. In the E2E run
 * (2026-10-07) the researcher read the fixture shop's start page, saw "Dokumentation" as a word
 * with no URL behind it, guessed 14 paths, got 14 browser-rendered 404s back as successes and ran
 * out of web_fetch calls before it reached /dokumentation.html. These are the pure helpers that
 * read a page's links from its HTML, a Playwright MCP 1.61 snapshot, or the rendered DOM, and
 * write the bounded list web_fetch appends.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractHtmlLinks,
  formatLinkSection,
  LINK_SCAN_MAX,
  LINK_SECTION_RE,
  LINK_URL_MAX,
  renderedLinks,
  snapshotLinks,
  type PageLink,
} from "../tools/page-links.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SHOP = "http://www.nordlicht-werkzeuge.test";

describe("extractHtmlLinks", () => {
  it("lists a page's anchors absolute, without fragments, once each, in page order, first non-empty label kept", () => {
    const html = `
      <header><strong>Nordlicht Werkzeuge GmbH</strong>
        <nav>
          <a href="/index.html">Start</a>
          <a href="/produkte/seite-1.html">Produkte</a>
          <a href="/lager.html"><span class="icon"></span></a>
          <a href="/preise.html">Preise &amp; Versand</a>
          <a href="/dokumentation.html">Dokumentation</a>
          <a href="/kontakt.html">Kontakt &amp; Bestellung</a>
        </nav>
      </header>
      <main>
        <p>Der Akku-Schrauber <a href="/produkte/seite-1.html">NW-AS 18</a> steht in der
           <a href="/dokumentation.html">Doku</a>; Fehlercode <a href="/dokumentation.html#e31">E31</a>.</p>
        <p><a href="/lager.html">Lagerbestand</a> · <a href="https://partner.example/shop">Partnershop</a></p>
      </main>`;
    expect(extractHtmlLinks(html, `${SHOP}/`)).toEqual([
      { url: `${SHOP}/index.html`, label: "Start" },
      { url: `${SHOP}/produkte/seite-1.html`, label: "Produkte" },
      { url: `${SHOP}/lager.html`, label: "Lagerbestand" },
      { url: `${SHOP}/preise.html`, label: "Preise & Versand" },
      { url: `${SHOP}/dokumentation.html`, label: "Dokumentation" },
      { url: `${SHOP}/kontakt.html`, label: "Kontakt & Bestellung" },
      { url: "https://partner.example/shop", label: "Partnershop" },
    ]);
  });

  it("gives the E2E fixture's start page the nine links the researcher needed", () => {
    const html = readFileSync(resolve(REPO, "eval/e2e/site/index.html"), "utf8");
    const pageUrl = `${SHOP}/`;
    const section = formatLinkSection(extractHtmlLinks(html, pageUrl), pageUrl, 1600);
    expect(section.text).toBe([
      "[Links on this page — 9 of 9, same site first]",
      `- Start -> ${SHOP}/index.html`,
      `- Produkte -> ${SHOP}/produkte/seite-1.html`,
      `- Preise & Versand -> ${SHOP}/preise.html`,
      `- Lagerbestand -> ${SHOP}/lager.html`,
      `- Dokumentation -> ${SHOP}/dokumentation.html`,
      `- Lieferstatus -> ${SHOP}/lieferstatus.html`,
      `- Kontakt & Bestellung -> ${SHOP}/kontakt.html`,
      `- Kundenportal: Wartungsfenster und Störungen -> ${SHOP}/langsam.html`,
      `- Impressum -> ${SHOP}/impressum.html`,
    ].join("\n"));
    expect(section.shown).toBe(9);
  });

  it("resolves a relative link against the URL the page came from", () => {
    expect(extractHtmlLinks(`<a href="seite-2.html">Seite 2</a> <a href="../preise.html">Preise</a>`, `${SHOP}/produkte/seite-1.html`)).toEqual([
      { url: `${SHOP}/produkte/seite-2.html`, label: "Seite 2" },
      { url: `${SHOP}/preise.html`, label: "Preise" },
    ]);
  });

  it("honours <base href>", () => {
    expect(extractHtmlLinks(
      `<head><base href="https://cdn.example.org/docs/"></head><a href="child.html">Child</a> <a href="/root.html">Root</a>`,
      "https://www.example.com/a/b.html",
    )).toEqual([
      { url: "https://cdn.example.org/docs/child.html", label: "Child" },
      { url: "https://cdn.example.org/root.html", label: "Root" },
    ]);
  });

  it("ignores anchors inside script, style and comments", () => {
    const html = `
      <script>document.write('<a href="/scripted.html">S</a>');</script>
      <style>/* <a href="/styled.html">C</a> */</style>
      <!-- <a href="/commented.html">C</a> -->
      <a href="/real.html">Real</a>`;
    expect(extractHtmlLinks(html, "https://www.example.com/")).toEqual([{ url: "https://www.example.com/real.html", label: "Real" }]);
  });

  it("skips fragment-only, mailto:, tel:, javascript: and data: links", () => {
    const html = `<a href="#top">Top</a> <a href="mailto:info@example.com">Mail</a> <a href="tel:+4930123">Tel</a>
      <a href="javascript:void(0)">JS</a> <a href="data:text/html,hi">Data</a> <a href="/kept.html">Kept</a>`;
    expect(extractHtmlLinks(html, "https://www.example.com/")).toEqual([{ url: "https://www.example.com/kept.html", label: "Kept" }]);
  });

  it("reads href as an attribute of its own: not data-href, not text inside another attribute's value", () => {
    const html = `<a data-href="/wrong.html" href="/right.html">Right</a>
      <a title="see href=/also-wrong.html" href="/also-right.html">Also right</a>
      <a data-href="/no-href.html">No href</a>`;
    expect(extractHtmlLinks(html, "https://www.example.com/").map((link) => link.url)).toEqual([
      "https://www.example.com/right.html",
      "https://www.example.com/also-right.html",
    ]);
  });

  it("does not end a tag at a '>' inside a quoted attribute", () => {
    expect(extractHtmlLinks(`<a title="a > b" href="/gt.html">GT</a> <a href=unquoted.html>Unquoted</a>`, "https://www.example.com/x/")).toEqual([
      { url: "https://www.example.com/gt.html", label: "GT" },
      { url: "https://www.example.com/x/unquoted.html", label: "Unquoted" },
    ]);
  });

  it("names a link without text by its aria-label, then its title, then its image's alt", () => {
    const html = `<a href="/a.html" aria-label="Warenkorb" title="Titel A"><svg></svg></a>
      <a href="/b.html" title="Merkliste"></a>
      <a href="/c.html"><img src="logo.png" alt="Nordlicht Logo"></a>
      <a href="/d.html"><img src="x.png"></a>`;
    expect(extractHtmlLinks(html, "https://www.example.com/")).toEqual([
      { url: "https://www.example.com/a.html", label: "Warenkorb" },
      { url: "https://www.example.com/b.html", label: "Merkliste" },
      { url: "https://www.example.com/c.html", label: "Nordlicht Logo" },
      { url: "https://www.example.com/d.html", label: "" },
    ]);
  });

  it("decodes character references in the href and the label", () => {
    expect(extractHtmlLinks(`<a href="/p?x=1&amp;y=2">Query &amp; &#252;bersicht &#x2192; &raquo;</a>`, "https://www.example.com/")).toEqual([
      { url: "https://www.example.com/p?x=1&y=2", label: "Query & übersicht → »" },
    ]);
  });

  it("ends an unclosed anchor's label at the next anchor", () => {
    expect(extractHtmlLinks(`<a href="/unclosed.html">Unclosed <a href="/next.html">Next</a>`, "https://www.example.com/")).toEqual([
      { url: "https://www.example.com/unclosed.html", label: "Unclosed" },
      { url: "https://www.example.com/next.html", label: "Next" },
    ]);
  });

  it(`stops after ${LINK_SCAN_MAX} anchors`, () => {
    const html = Array.from({ length: LINK_SCAN_MAX + 5 }, (_, i) => `<a href="/p/${i}.html">P ${i}</a>`).join("");
    const links = extractHtmlLinks(html, "https://www.example.com/");
    expect(links).toHaveLength(LINK_SCAN_MAX);
    expect(links.at(-1)?.url).toBe(`https://www.example.com/p/${LINK_SCAN_MAX - 1}.html`);
  });
});

describe("snapshotLinks (Playwright MCP 1.61)", () => {
  // Excerpt of the real 1.61 browser_snapshot answer for the fixture's start page.
  const SNAPSHOT = [
    "### Page",
    `- Page URL: ${SHOP}/`,
    "- Page Title: Nordlicht Werkzeuge GmbH – Werkzeug für Werkstatt und Baustelle",
    "### Snapshot",
    "```yaml",
    "- generic [active] [ref=e1]:",
    "  - banner [ref=e2]:",
    "    - strong [ref=e3]: Nordlicht Werkzeuge GmbH",
    "    - navigation [ref=e4]:",
    "      - link \"Start\" [ref=e5] [cursor=pointer]:",
    "        - /url: /index.html",
    "      - link \"Dokumentation\" [ref=e9] [cursor=pointer]:",
    "        - /url: /dokumentation.html",
    "  - main [ref=e12]:",
    "    - paragraph [ref=e29]:",
    "      - text: Alles Wissenswerte steht in der",
    "      - link \"Dokumentation\" [ref=e31] [cursor=pointer]:",
    "        - /url: /dokumentation.html",
    "    - list [ref=e33]:",
    "      - listitem [ref=e40]:",
    "        - 'link \"Kundenportal: Wartungsfenster und Störungen\" [ref=e41] [cursor=pointer]':",
    "          - /url: /langsam.html",
    "```",
  ].join("\n");

  it("pairs each link with its /url child, resolved against the Page URL, the YAML-quoted label intact", () => {
    expect(snapshotLinks(SNAPSHOT, "http://fallback.invalid/")).toEqual({
      pageUrl: `${SHOP}/`,
      links: [
        { url: `${SHOP}/index.html`, label: "Start" },
        { url: `${SHOP}/dokumentation.html`, label: "Dokumentation" },
        { url: `${SHOP}/langsam.html`, label: "Kundenportal: Wartungsfenster und Störungen" },
      ],
    });
  });

  it("takes nothing from a link without a /url child, and never gives it a later element's /url", () => {
    const snapshot = [
      "```yaml",
      "- link \"Ohne Ziel\" [ref=e2]",
      "- paragraph [ref=e3]:",
      "  - /url: /falsch.html",
      "- link \"Mit Bild\" [ref=e4] [cursor=pointer]:",
      "  - img \"Logo\" [ref=e5]",
      "  - /url: /bild.html",
      "```",
    ].join("\n");
    expect(snapshotLinks(snapshot, "https://www.example.com/").links).toEqual([
      { url: "https://www.example.com/bild.html", label: "Mit Bild" },
    ]);
  });

  it("uses the fallback URL when the answer has no Page URL, and unescapes quotes in labels and targets", () => {
    const snapshot = [
      "### Snapshot",
      "```yaml",
      "- 'link \"It''s \\\"new\\\": here\" [ref=e1] [cursor=pointer]':",
      "  - /url: \"/neu.html?a=1#x\"",
      "- link [ref=e2] [cursor=pointer]:",
      "  - /url: 'https://other.example/it''s'",
      "```",
    ].join("\n");
    expect(snapshotLinks(snapshot, "https://www.example.com/dir/")).toEqual({
      pageUrl: "https://www.example.com/dir/",
      links: [
        { url: "https://www.example.com/neu.html?a=1", label: "It's \"new\": here" },
        { url: "https://other.example/it's", label: "" },
      ],
    });
  });
});

describe("renderedLinks", () => {
  it("keeps absolute http(s) links once each, without fragments, and drops everything else", () => {
    expect(renderedLinks([
      [`${SHOP}/dokumentation.html#e31`, ""],
      [`${SHOP}/dokumentation.html`, "Dokumentation"],
      ["mailto:info@example.com", "Mail"],
      ["relative.html", "Relative"],
      [{ baseVal: "/svg-link" }, "SVG"],
      "not a pair",
      ["https://partner.example/x", "  Partner \n shop  "],
    ])).toEqual([
      { url: `${SHOP}/dokumentation.html`, label: "Dokumentation" },
      { url: "https://partner.example/x", label: "Partner shop" },
    ]);
    expect(renderedLinks(undefined)).toEqual([]);
    expect(renderedLinks("[]")).toEqual([]);
  });
});

describe("formatLinkSection", () => {
  const PAGE = "https://www.example.com/start";
  const link = (url: string, label = ""): PageLink => ({ url, label });

  it("lists the page's own site first (www and subdomains included), then other sites, each in page order, without the page itself", () => {
    const section = formatLinkSection([
      link("https://partner.example/a", "Partner A"),
      link("https://example.com/about", "About"),
      link("https://www.example.com/start", "This page"),
      link("https://docs.example.com/guide", "Guide"),
      link("https://other.example/b", "Other B"),
      link("https://notexample.com/x", "Not the site"),
      link("https://www.example.com/contact", "Contact"),
    ], PAGE, 10_000);
    expect(section.text).toBe([
      "[Links on this page — 6 of 6, same site first]",
      "- About -> https://example.com/about",
      "- Guide -> https://docs.example.com/guide",
      "- Contact -> https://www.example.com/contact",
      "- Partner A -> https://partner.example/a",
      "- Other B -> https://other.example/b",
      "- Not the site -> https://notexample.com/x",
    ].join("\n"));
    expect(section).toMatchObject({ shown: 6, total: 6 });
  });

  it("prints a link without a label, or labelled with a URL, bare, and keeps ' -> ' the line's own separator", () => {
    expect(formatLinkSection([
      link("https://www.example.com/a"),
      link("https://www.example.com/b", "https://www.example.com/b"),
      link("https://www.example.com/c", "Zurück -> Start"),
    ], PAGE, 10_000).text).toBe([
      "[Links on this page — 3 of 3, same site first]",
      "- https://www.example.com/a",
      "- https://www.example.com/b",
      "- Zurück - Start -> https://www.example.com/c",
    ].join("\n"));
  });

  it(`never prints a URL longer than ${LINK_URL_MAX} characters, cut or whole`, () => {
    const long = `https://www.example.com/${"x".repeat(LINK_URL_MAX)}`;
    const section = formatLinkSection([link(long, "Long"), link("https://www.example.com/short", "Short")], PAGE, 10_000);
    expect(section.text).toBe("[Links on this page — 1 of 1, same site first]\n- Short -> https://www.example.com/short");
  });

  it("stays within its budget and says how many links it left out", () => {
    const links = Array.from({ length: 40 }, (_, i) => link(`https://www.example.com/artikel/${i + 1}.html`, `Artikel ${i + 1}`));
    // 133 fits exactly one line under the hinted header; at 610 a tenth line would fit only if the
    // header's count stayed one digit wide — "10 of 40" is one character longer than "9 of 40".
    for (const budget of [133, 334, 610, 1000]) {
      const section = formatLinkSection(links, PAGE, budget);
      expect(section.text.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(section.shown).toBeGreaterThan(0);
      expect(section.shown).toBeLessThan(40);
      expect(section.text.split("\n")[0]).toBe(`[Links on this page — ${section.shown} of 40, same site first; a larger maxLength lists more]`);
      expect(section.text.split("\n")).toHaveLength(section.shown + 1);
      expect(section.text.split("\n")[1]).toBe("- Artikel 1 -> https://www.example.com/artikel/1.html");
    }
  });

  it("returns nothing when not even one line fits, or there is nothing to list", () => {
    expect(formatLinkSection([link("https://www.example.com/a", "A")], PAGE, 40)).toEqual({ text: "", shown: 0, total: 1 });
    expect(formatLinkSection([link(PAGE, "Self")], PAGE, 10_000)).toEqual({ text: "", shown: 0, total: 0 });
    expect(formatLinkSection([], PAGE, 10_000)).toEqual({ text: "", shown: 0, total: 0 });
  });
});

describe("LINK_SECTION_RE", () => {
  it("matches the section formatLinkSection writes, and nothing around it", () => {
    const section = formatLinkSection([
      { url: "https://www.example.com/a", label: "A" },
      { url: "https://other.example/", label: "" },
    ], "https://www.example.com/", 1000).text;
    const output = `**Content from:** https://www.example.com/\n\nText\n- a list item of the page\n\n${section}\n\n💡 suffix`;
    expect(output.replace(LINK_SECTION_RE, "")).toBe("**Content from:** https://www.example.com/\n\nText\n- a list item of the page\n\n\n💡 suffix");
    expect(`Text\n\n${section}`.replace(LINK_SECTION_RE, "")).toBe("Text\n\n");
  });
});
