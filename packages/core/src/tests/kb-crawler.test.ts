import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  isSkippableAsset,
  seedScopePrefix,
  buildScopeRules,
  isUrlInScope,
  extractHtmlTitle,
  extractLinks,
  htmlToMarkdownFallback,
  parseRobots,
  isAllowedByRobots,
} from "../retrieval/kb-crawler.js";

// Pure crawler helpers only — the network crawl loop (crawlFetch/runCrawl)
// needs live HTTP and is deliberately not covered here.

describe("normalizeUrl", () => {
  it("strips the fragment", () => {
    expect(normalizeUrl("https://example.com/docs/page#section-2")).toBe("https://example.com/docs/page");
  });

  it("drops tracking params (utm_*/fbclid/gclid/ref, case-insensitive) and keeps the rest", () => {
    expect(normalizeUrl("https://example.com/a?utm_source=x&utm_medium=y&fbclid=z&gclid=1&ref=home&keep=1"))
      .toBe("https://example.com/a?keep=1");
    expect(normalizeUrl("https://example.com/a?UTM_CAMPAIGN=loud")).toBe("https://example.com/a");
  });

  it("sorts the remaining query params for a canonical form", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1&c=3")).toBe("https://example.com/a?a=1&b=2&c=3");
  });

  it("resolves relative URLs against the base", () => {
    expect(normalizeUrl("../other", "https://example.com/docs/sub/page.html")).toBe("https://example.com/docs/other");
    expect(normalizeUrl("child.html", "https://example.com/docs/index.html")).toBe("https://example.com/docs/child.html");
    expect(normalizeUrl("/rooted", "https://example.com/docs/index.html")).toBe("https://example.com/rooted");
  });

  it("returns null for non-http(s) schemes", () => {
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.com/file")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("http//missing-scheme")).toBeNull();
  });

  it("drops default ports and credentials, keeps non-default ports", () => {
    expect(normalizeUrl("https://example.com:443/x")).toBe("https://example.com/x");
    expect(normalizeUrl("http://example.com:80/x")).toBe("http://example.com/x");
    expect(normalizeUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
    expect(normalizeUrl("https://user:pass@example.com/x")).toBe("https://example.com/x");
  });
});

describe("isSkippableAsset", () => {
  it("skips images, styles, and archives", () => {
    expect(isSkippableAsset("https://example.com/img/logo.png")).toBe(true);
    expect(isSkippableAsset("https://example.com/styles/main.css")).toBe(true);
    expect(isSkippableAsset("https://example.com/dl/bundle.zip")).toBe(true);
  });

  it("keeps html, pdf, and extensionless pages", () => {
    expect(isSkippableAsset("https://example.com/docs/page.html")).toBe(false);
    expect(isSkippableAsset("https://example.com/docs/manual.pdf")).toBe(false);
    expect(isSkippableAsset("https://example.com/docs/guide")).toBe(false);
    // dot in a DIRECTORY segment is not an extension
    expect(isSkippableAsset("https://example.com/v1.2/guide")).toBe(false);
  });

  it("treats unparseable URLs as skippable", () => {
    expect(isSkippableAsset("not-a-url")).toBe(true);
  });
});

describe("seedScopePrefix", () => {
  it("a trailing-slash seed is its own prefix", () => {
    expect(seedScopePrefix("https://example.com/docs/")).toBe("https://example.com/docs/");
  });

  it("a file-like (dotted) final segment drops to its directory", () => {
    expect(seedScopePrefix("https://example.com/docs/index.html")).toBe("https://example.com/docs/");
  });

  it("an extensionless final segment is treated as a directory (not collapsed to the parent)", () => {
    // Regression: '/docs' must scope UNDER '/docs/', not to the whole origin.
    expect(seedScopePrefix("https://example.com/docs")).toBe("https://example.com/docs/");
    expect(seedScopePrefix("https://vuejs.org/guide")).toBe("https://vuejs.org/guide/");
  });

  it("strips query and fragment", () => {
    expect(seedScopePrefix("https://example.com/docs/page?x=1#top")).toBe("https://example.com/docs/page/");
    expect(seedScopePrefix("https://example.com/docs/?q=1#frag")).toBe("https://example.com/docs/");
    expect(seedScopePrefix("https://example.com/docs/guide.html?v=2")).toBe("https://example.com/docs/");
  });

  it("a bare origin scopes to the root", () => {
    expect(seedScopePrefix("https://example.com")).toBe("https://example.com/");
  });
});

describe("buildScopeRules + isUrlInScope", () => {
  const base = { seedUrls: ["https://example.com/docs/"], sameOriginOnly: true };

  it("same origin under a seed prefix is in scope; outside the prefix is not", () => {
    const rules = buildScopeRules(base);
    expect(isUrlInScope("https://example.com/docs/page", rules)).toBe(true);
    expect(isUrlInScope("https://example.com/docs/sub/deeper", rules)).toBe(true);
    expect(isUrlInScope("https://example.com/blog/post", rules)).toBe(false);
  });

  it("another origin fails when sameOriginOnly", () => {
    const rules = buildScopeRules(base);
    expect(isUrlInScope("https://other.com/docs/page", rules)).toBe(false);
  });

  it("includePatterns widen the scope (still origin-gated when sameOriginOnly)", () => {
    const rules = buildScopeRules({ ...base, includePatterns: ["/blog/"] });
    expect(isUrlInScope("https://example.com/blog/post", rules)).toBe(true);
    expect(isUrlInScope("https://other.com/blog/post", rules)).toBe(false); // origin gate still applies
  });

  it("excludePatterns veto even a seed-prefix match", () => {
    const rules = buildScopeRules({ ...base, excludePatterns: ["/docs/private"] });
    expect(isUrlInScope("https://example.com/docs/private/page", rules)).toBe(false);
    expect(isUrlInScope("https://example.com/docs/public/page", rules)).toBe(true);
  });

  it("sameOriginOnly=false + includePattern allows cross-origin", () => {
    const rules = buildScopeRules({
      seedUrls: ["https://example.com/docs/"],
      sameOriginOnly: false,
      includePatterns: ["^https://other\\.com/kb/"],
    });
    expect(isUrlInScope("https://other.com/kb/page", rules)).toBe(true);
    expect(isUrlInScope("https://example.com/docs/page", rules)).toBe(true); // seed prefix still counts
    expect(isUrlInScope("https://unrelated.com/x", rules)).toBe(false);
  });

  it("unparseable URLs are never in scope", () => {
    expect(isUrlInScope("not-a-url", buildScopeRules(base))).toBe(false);
  });
});

describe("extractLinks", () => {
  const pageUrl = "https://example.com/docs/index.html";

  it("resolves absolute, relative, rooted, protocol-relative, and unquoted hrefs", () => {
    const html = `
      <a href="https://example.com/docs/abs">A</a>
      <a href="relative/page">R</a>
      <a href="/rooted">Ro</a>
      <a href="//example.com/proto">P</a>
      <a href=unquoted/page>U</a>
    `;
    const links = extractLinks(html, pageUrl);
    expect(links.sort()).toEqual([
      "https://example.com/docs/abs",
      "https://example.com/docs/relative/page",
      "https://example.com/docs/unquoted/page",
      "https://example.com/proto",
      "https://example.com/rooted",
    ].sort());
  });

  it("honors <base href> for relative resolution", () => {
    const html = `<base href="https://other.example.com/root/"><a href="child.html">C</a>`;
    expect(extractLinks(html, pageUrl)).toEqual(["https://other.example.com/root/child.html"]);
  });

  it("skips nofollow, non-navigational schemes, bare fragments, and links inside scripts/comments", () => {
    const html = `
      <a rel="nofollow" href="https://example.com/nofollow">n</a>
      <a href="mailto:x@y.z">m</a>
      <a href="javascript:void(0)">j</a>
      <a href="tel:+123456">t</a>
      <a href="#top">f</a>
      <script>document.write('<a href="https://example.com/in-script">x</a>');</script>
      <!-- <a href="https://example.com/in-comment">c</a> -->
      <a href="https://example.com/kept">k</a>
    `;
    expect(extractLinks(html, pageUrl)).toEqual(["https://example.com/kept"]);
  });

  it("dedups after normalization (fragments collapse to one link)", () => {
    const html = `
      <a href="https://example.com/dup">1</a>
      <a href="https://example.com/dup#section">2</a>
      <a href="/dup">3</a>
    `;
    expect(extractLinks(html, pageUrl)).toEqual(["https://example.com/dup"]);
  });
});

describe("extractHtmlTitle", () => {
  it("prefers <title>, decodes entities, strips inner tags", () => {
    expect(extractHtmlTitle("<title>Tom &amp; Jerry&#33;</title><h1>Ignored</h1>")).toBe("Tom & Jerry!");
    expect(extractHtmlTitle("<title>The <b>Big</b> Manual</title>")).toBe("The Big Manual");
  });

  it("falls back to the first <h1>", () => {
    expect(extractHtmlTitle(`<h1 class="hero">Fallback &lt;Title&gt;</h1>`)).toBe("Fallback <Title>");
  });

  it("returns null when neither is present", () => {
    expect(extractHtmlTitle("<p>no headings here</p>")).toBeNull();
  });
});

describe("htmlToMarkdownFallback", () => {
  it("keeps heading levels and list bullets, drops script/style/nav/footer", () => {
    const html = `
      <html><head><style>.x{color:red}</style><script>var secret=1;</script></head>
      <body>
        <nav><a href="/">NavHome</a></nav>
        <h1>Guide &amp; Intro</h1>
        <p>First paragraph.</p>
        <h2>Steps</h2>
        <ul><li>One</li><li>Two</li></ul>
        <footer>FooterCopyright</footer>
      </body></html>
    `;
    const md = htmlToMarkdownFallback(html);
    expect(md).toContain("# Guide & Intro");
    expect(md).toContain("## Steps");
    expect(md).toMatch(/(^|\n)- One(\n|$)/);
    expect(md).toMatch(/(^|\n)- Two(\n|$)/);
    expect(md).toContain("First paragraph.");
    expect(md).not.toContain("NavHome");
    expect(md).not.toContain("FooterCopyright");
    expect(md).not.toContain("secret");
    expect(md).not.toContain("color:red");
  });

  it("decodes named, decimal, and hex entities", () => {
    expect(htmlToMarkdownFallback("<p>A &amp; B &#8212; caf&#xe9;</p>")).toBe("A & B — café");
  });
});

describe("parseRobots + isAllowedByRobots", () => {
  const agent = "StarlingAI-KBCrawler/1.0";

  it("the '*' group applies when no specific group matches", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private/\n", agent);
    expect(isAllowedByRobots(rules, "https://example.com/private/x")).toBe(false);
    expect(isAllowedByRobots(rules, "https://example.com/public")).toBe(true);
  });

  it("a specific agent group (token substring match) overrides '*'", () => {
    const body = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: starlingai-kbcrawler",
      "Allow: /",
      "Disallow: /admin/",
    ].join("\n");
    const rules = parseRobots(body, agent);
    // The blanket '*' Disallow:/ does NOT apply — the specific group wins.
    expect(isAllowedByRobots(rules, "https://example.com/docs")).toBe(true);
    expect(isAllowedByRobots(rules, "https://example.com/admin/panel")).toBe(false);

    // An unrelated agent still gets the '*' group.
    const star = parseRobots(body, "SomeOtherBot/9.9");
    expect(isAllowedByRobots(star, "https://example.com/docs")).toBe(false);
  });

  it("longest-match wins (Allow re-opens a subtree)", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\n", agent);
    expect(isAllowedByRobots(rules, "https://example.com/docs/public/page")).toBe(true);
    expect(isAllowedByRobots(rules, "https://example.com/docs/secret")).toBe(false);
  });

  it("Allow beats Disallow on an equal-length tie", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n", agent);
    expect(isAllowedByRobots(rules, "https://example.com/page")).toBe(true);
  });

  it("an empty Disallow allows everything", () => {
    const rules = parseRobots("User-agent: *\nDisallow:\n", agent);
    expect(isAllowedByRobots(rules, "https://example.com/anything/at/all")).toBe(true);
  });

  it("supports '*' wildcards and '$' end anchors in rule paths", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\n", agent);
    expect(isAllowedByRobots(rules, "https://example.com/docs/manual.pdf")).toBe(false);
    // '$' anchors at the end — a query string defeats the match
    expect(isAllowedByRobots(rules, "https://example.com/docs/manual.pdf?v=2")).toBe(true);
    expect(isAllowedByRobots(rules, "https://example.com/docs/page.html")).toBe(true);

    const mid = parseRobots("User-agent: *\nDisallow: /docs/*/draft\n", agent);
    expect(isAllowedByRobots(mid, "https://example.com/docs/v1/draft")).toBe(false);
    expect(isAllowedByRobots(mid, "https://example.com/docs/final")).toBe(true);
  });

  it("empty/unreachable rules allow everything; comments are stripped", () => {
    expect(isAllowedByRobots({ rules: [] }, "https://example.com/x")).toBe(true);
    const rules = parseRobots("User-agent: * # everyone\nDisallow: /private/ # internal\n", agent);
    expect(isAllowedByRobots(rules, "https://example.com/private/x")).toBe(false);
  });

  it("multiple User-agent lines stack onto ONE group", () => {
    const body = "User-agent: alphabot\nUser-agent: betabot\nDisallow: /x/\n";
    for (const token of ["alphabot/1.0", "betabot/2.0"]) {
      const rules = parseRobots(body, token);
      expect(isAllowedByRobots(rules, "https://example.com/x/page")).toBe(false);
      expect(isAllowedByRobots(rules, "https://example.com/y/page")).toBe(true);
    }
    // No '*' group and no specific match → no rules → everything allowed.
    const none = parseRobots(body, "gammabot/1.0");
    expect(none.rules).toEqual([]);
    expect(isAllowedByRobots(none, "https://example.com/x/page")).toBe(true);
  });

  it("an unparseable URL is never allowed", () => {
    expect(isAllowedByRobots({ rules: [] }, "not-a-url")).toBe(false);
  });
});
