/**
 * The page a browser answer reports being on. No imports: the sub-agent runner reads it from every
 * view of the open tab its agent takes, and must not pull in the browser tools (web.ts registers
 * tools when it is loaded).
 */

/** The page URLs a Playwright MCP answer reports, from its "- Page URL: …" lines. */
export function reportedPageUrls(output: string): string[] {
  return [...output.matchAll(/^[ \t]*-[ \t]+Page URL:[ \t]*(\S+)/gm)].map((match) => match[1]!);
}

/** Whether a page URL is the browser's own empty page, which a tab shows before anything opened a page in it. */
export function isBlankBrowserPage(pageUrl: string): boolean {
  return /^about:blank(?:[?#]|$)/i.test(pageUrl);
}
