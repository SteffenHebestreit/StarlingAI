/**
 * The links of a fetched page, as the bounded list web_fetch appends after the page's text.
 *
 * web_fetch turned every HTML page into plain text and kept no anchor's target: stripHtml
 * replaces `<a href>` with a space, the browser path read document.body.innerText, and the
 * snapshot fallback deleted the `- /url:` lines. In the E2E run (2026-10-07) the researcher
 * fetched the fixture shop's start page, read "Dokumentation" as a word with no URL behind
 * it, guessed 14 paths, got 14 browser-rendered 404 pages back as successes, and ran out of
 * web_fetch calls before it reached /dokumentation.html.
 *
 * Three sources — a raw HTML page, a Playwright MCP (1.61) snapshot, and [href, label] pairs
 * collected in the browser — normalised the same way: absolute http(s) URLs without an in-page
 * fragment (a hash route stays), deduplicated by URL, the first non-empty label kept.
 * formatLinkSection writes the section itself. No imports: result-shaping imports
 * LINK_SECTION_RE from here, and nothing this module pulls in may close a cycle back to it.
 */

/** One link of a page: an absolute http(s) URL without an in-page fragment, and its label ("" when it has none). */
export interface PageLink {
  url: string;
  label: string;
}

/** Anchors read per page, in the HTML and in the browser; bounds the work on a page made of links. */
export const LINK_SCAN_MAX = 1000;
/** Characters kept of a link's label. */
export const LINK_LABEL_MAX = 80;
/** A longer URL is left out of the list rather than printed cut: a cut URL is a wrong URL. */
export const LINK_URL_MAX = 300;
/** The section takes this share of maxLength from a body longer than maxLength, which is cut anyway. */
export const LINK_BUDGET_MIN_SHARE = 0.15;
/** The section never takes more than this share of maxLength, however short the body. */
export const LINK_BUDGET_MAX_SHARE = 0.2;

/**
 * The section as formatLinkSection writes it: its header line and the "- " lines under it.
 * extractKeyFacts removes it, so a page's link list never becomes a shared "fact".
 */
export const LINK_SECTION_RE = /^\[Links on this page[^\n]*\]\n(?:- [^\n]*(?:\n|$))*/gm;

/** Characters an anchor's label is read from: up to the next `</a>` or `<a` inside them. */
const LABEL_WINDOW_CHARS = 2000;

/** An opening tag's attributes; a quoted '>' inside a value does not end the tag. */
const ANCHOR_OPEN_RE = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const BASE_TAG_RE = /<base\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const IMG_TAG_RE = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", laquo: "\u00ab", raquo: "\u00bb",
};

/** Character references, decoded in one pass so "&amp;lt;" becomes "&lt;" and not "<". */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (whole: string, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * An opening tag's attributes, names lower-cased, the first of a repeated name kept (as a browser
 * keeps it). Read as name[=value] pairs in order, so text inside a quoted value — a title that says
 * "see href=/x" — is never taken for an attribute, and data-href is not href.
 */
function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const m of source.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attributes;
}

/**
 * A fragment that addresses a view of a hash-routed app (Docsify-style docs, a Vue or Angular app
 * on hash URLs): "#/configuration", "#/", "#!/page", "#!key=value". Told apart from an in-page
 * fragment (#top, #e31) by its shape alone; a bare "#!" is a no-op link, not a view. Clearing
 * these turned every in-app link into the page's own URL, so a rendered docs app listed none of
 * its chapters.
 */
function isRouteFragment(fragment: string): boolean {
  return /^#(?:\/|!.)/.test(fragment);
}

/**
 * `href` as an absolute http(s) URL without an in-page fragment, or null (a link to a place on
 * the page, mailto:, javascript: …). A hash route is part of the address and stays.
 */
function resolveLink(href: string, base: string | undefined): string | null {
  const target = href.trim();
  if (!target || (target.startsWith("#") && !isRouteFragment(target))) return null;
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(target) : new URL(target, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!isRouteFragment(parsed.hash)) parsed.hash = "";
  return parsed.href;
}

/** Collects links in page order, one per URL; a URL seen first without a label takes the next non-empty one. */
function linkCollector(): { links: PageLink[]; add: (url: string | null, label: string) => void } {
  const links: PageLink[] = [];
  const indexOf = new Map<string, number>();
  return {
    links,
    add(url, label) {
      if (url === null) return;
      // A cut that lands inside a surrogate pair would leave half a character behind.
      const clean = collapseWhitespace(label).slice(0, LINK_LABEL_MAX).replace(/[\uD800-\uDBFF]$/, "");
      const at = indexOf.get(url);
      if (at === undefined) {
        indexOf.set(url, links.length);
        links.push({ url, label: clean });
      } else if (!links[at]!.label && clean) {
        links[at]!.label = clean;
      }
    },
  };
}

/**
 * The anchors of a raw HTML page in document order. Relative links resolve against `<base href>`
 * when the page has one, else against `pageUrl`, which must be the URL that finally answered
 * (after redirects): /produkte answered from /produkte/seite-1.html lists "seite-2.html" as
 * /produkte/seite-2.html. Anchors inside script, style and comments are not links.
 *
 * The label is the anchor's text up to its `</a>`, or up to the next `<a` when it is never
 * closed, read within LABEL_WINDOW_CHARS; an anchor with no text there is named by its
 * aria-label, title or image alt, and otherwise listed by its URL alone.
 */
export function extractHtmlLinks(html: string, pageUrl: string): PageLink[] {
  const scanned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  let base = pageUrl;
  const baseHref = readAttributes(BASE_TAG_RE.exec(scanned)?.[1] ?? "").get("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      // an unusable <base href> leaves the page's own URL as the base, as a browser does
    }
  }

  const out = linkCollector();
  let anchors = 0;
  for (const m of scanned.matchAll(ANCHOR_OPEN_RE)) {
    const attributes = readAttributes(m[1] ?? "");
    const href = attributes.get("href");
    if (href === undefined) continue;
    if (++anchors > LINK_SCAN_MAX) break;
    const after = m.index + m[0].length;
    const ahead = scanned.slice(after, after + LABEL_WINDOW_CHARS);
    const end = ahead.search(/<\/a\s*>|<a\b/i);
    const inner = end >= 0 ? ahead.slice(0, end) : "";
    const label = collapseWhitespace(decodeEntities(inner.replace(/<[^>]*>/g, " ")))
      || collapseWhitespace(attributes.get("aria-label") ?? "")
      || collapseWhitespace(attributes.get("title") ?? "")
      || collapseWhitespace(readAttributes(IMG_TAG_RE.exec(inner)?.[1] ?? "").get("alt") ?? "");
    out.add(resolveLink(href, base), label);
  }
  return out.links;
}

/** A YAML scalar as written in a snapshot: double-quoted (JSON-style escapes), single-quoted ('' for '), or plain. */
function unquoteYamlScalar(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not JSON-compatible: drop the quotes only
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * The links of a Playwright MCP (1.61) browser_snapshot answer. A link is a `- link "LABEL" [ref=…]:`
 * line (the label is optional) whose target is its deeper-indented `- /url: X` child. A key that
 * holds ": " is written YAML single-quoted — `- 'link "Kundenportal: Wartungsfenster" [ref=e41]':` —
 * so `''` in it is one quote; `\"` in a label is one double quote. Targets resolve against the
 * answer's `- Page URL:` line, or `fallbackPageUrl` when it has none.
 */
export function snapshotLinks(snapshot: string, fallbackPageUrl: string): { pageUrl: string; links: PageLink[] } {
  const pageUrl = /^-\s+Page URL:\s*(\S+)/m.exec(snapshot)?.[1] ?? fallbackPageUrl;
  const yaml = /```ya?ml\n([\s\S]*?)```/.exec(snapshot)?.[1] ?? "";
  const out = linkCollector();
  let pending: { indent: number; label: string } | null = null;
  for (const raw of yaml.split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.search(/\S/);
    const line = raw.trim();
    const link = /^-\s+('?)link\b(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
    if (link) {
      const label = (link[2] ?? "").replace(/\\(.)/g, "$1");
      pending = { indent, label: link[1] ? label.replace(/''/g, "'") : label };
      continue;
    }
    if (pending && indent <= pending.indent) pending = null;
    const target = /^-\s+\/url:\s*(.+)$/.exec(line);
    if (target && pending) {
      out.add(resolveLink(unquoteYamlScalar(target[1]!), pageUrl), pending.label);
      pending = null;
    }
  }
  return { pageUrl, links: out.links };
}

/**
 * Links collected in the browser as [href, label] pairs. A browser's `a.href` is already
 * absolute, so anything that is not an absolute http(s) URL is dropped rather than resolved
 * against a guessed base.
 */
export function renderedLinks(pairs: unknown): PageLink[] {
  const out = linkCollector();
  if (!Array.isArray(pairs)) return out.links;
  for (const pair of pairs.slice(0, LINK_SCAN_MAX)) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
    out.add(resolveLink(pair[0], undefined), typeof pair[1] === "string" ? pair[1] : "");
  }
  return out.links;
}

/** A URL's host without a leading "www.", or null when it does not parse. */
function siteHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Same host ignoring a leading "www.", or one host a subdomain of the other. */
function isSameSite(host: string | null, pageHost: string | null): boolean {
  if (!host || !pageHost) return false;
  return host === pageHost || host.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${host}`);
}

function formatLinkLine(link: PageLink): string {
  // A label that is itself a URL says nothing the URL does not; " -> " is the line's own separator.
  const label = /^https?:\/\//i.test(link.label) ? "" : link.label.replace(/\s*->\s*/g, " - ").trim();
  return label ? `- ${label} -> ${link.url}` : `- ${link.url}`;
}

/**
 * The links section: `[Links on this page — N of M, same site first]` and one `- LABEL -> URL`
 * line per link, the page's own URL left out, links on the page's site first and then the rest,
 * each group in page order. Lines are added in that order while the whole section stays within
 * `budget` characters; when some are left out, the header says how many were listed and that a
 * larger maxLength lists more. A URL longer than LINK_URL_MAX is never listed and not counted in
 * M. Returns text "" when not even one line fits.
 */
export function formatLinkSection(links: readonly PageLink[], pageUrl: string, budget: number): { text: string; shown: number; total: number } {
  const self = resolveLink(pageUrl, undefined);
  const pageHost = siteHost(pageUrl);
  const listable = links.filter((link) => link.url !== self && link.url.length <= LINK_URL_MAX);
  const sameSite = listable.filter((link) => isSameSite(siteHost(link.url), pageHost));
  const otherSites = listable.filter((link) => !isSameSite(siteHost(link.url), pageHost));
  const lines = [...sameSite, ...otherSites].map(formatLinkLine);
  const total = lines.length;
  const header = (shown: number): string =>
    `[Links on this page — ${shown} of ${total}, same site first${shown < total ? "; a larger maxLength lists more" : ""}]`;
  if (total === 0) return { text: "", shown: 0, total: 0 };

  const whole = [header(total), ...lines].join("\n");
  if (whole.length <= budget) return { text: whole, shown: total, total };

  // Not every line fits: reserve the longest header a partial list can carry (the hint, and
  // as many digits as total - 1), so the final header never pushes the section over budget.
  const shownLines: string[] = [];
  let used = header(total - 1).length;
  for (const line of lines) {
    if (used + 1 + line.length > budget) break;
    shownLines.push(line);
    used += 1 + line.length;
  }
  if (shownLines.length === 0) return { text: "", shown: 0, total };
  return { text: [header(shownLines.length), ...shownLines].join("\n"), shown: shownLines.length, total };
}
