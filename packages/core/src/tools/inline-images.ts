/**
 * Inline LOCAL images as data: URIs so a generated deliverable (reveal.js deck,
 * markdown paper, …) is self-contained and its pictures render under ANY serving
 * path — the query-param workspace preview cannot resolve a relative
 * `images/x.jpg` reference (it drops the ?root= query), so a co-located relative
 * image shows up broken in the dock preview even though the file is right there.
 * Remote (http/https/data/protocol-relative) refs are left untouched. Bounded by
 * per-image and per-document byte caps.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const INLINE_IMAGE_MAX_BYTES = 4_000_000; // skip one oversized image
const INLINE_TOTAL_MAX_BYTES = 24_000_000; // overall cap per document

export function imageMimeFromExt(p: string): string | null {
  switch (extname(p).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".avif": return "image/avif";
    default: return null;
  }
}

function isRemoteRef(src: string): boolean {
  return /^(?:https?:|data:|\/\/)/i.test(src);
}

/** Read each local src relative to baseDir and return a src→dataURI map, bounded. */
async function buildDataUriMap(srcs: Set<string>, baseDir: string): Promise<Map<string, string>> {
  const root = resolve(baseDir);
  const map = new Map<string, string>();
  let total = 0;
  for (const src of srcs) {
    try {
      const target = resolve(baseDir, src.replace(/^\.?\//, ""));
      if (target !== root && !target.startsWith(root + sep)) continue; // stay inside the document dir
      const mime = imageMimeFromExt(target);
      if (!mime) continue;
      const st = await stat(target);
      if (!st.isFile() || st.size > INLINE_IMAGE_MAX_BYTES || total + st.size > INLINE_TOTAL_MAX_BYTES) continue;
      const bytes = await readFile(target);
      map.set(src, `data:${mime};base64,${bytes.toString("base64")}`);
      total += st.size;
    } catch { /* leave the src as-is when the file is missing/unreadable */ }
  }
  return map;
}

const HTML_IMG_SRC_RE = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi;

/** Inline `<img src="images/…">` references in rendered HTML (e.g. a reveal deck). */
export async function inlineLocalImagesInHtml(html: string, baseDir: string): Promise<string> {
  const wanted = new Set<string>();
  for (const m of html.matchAll(HTML_IMG_SRC_RE)) {
    if (!isRemoteRef(m[2]!)) wanted.add(m[2]!);
  }
  if (wanted.size === 0) return html;
  const map = await buildDataUriMap(wanted, baseDir);
  if (map.size === 0) return html;
  return html.replace(HTML_IMG_SRC_RE, (full, pre: string, src: string, post: string) =>
    map.has(src) ? `${pre}${map.get(src)}${post}` : full);
}

const MD_IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)(\s*(?:"[^"]*")?\))/g;

/** Inline `![alt](images/…)` references in Markdown source (e.g. a paper). */
export async function inlineLocalImagesInMarkdown(md: string, baseDir: string): Promise<string> {
  const wanted = new Set<string>();
  for (const m of md.matchAll(MD_IMG_RE)) {
    if (!isRemoteRef(m[2]!)) wanted.add(m[2]!);
  }
  if (wanted.size === 0) return md;
  const map = await buildDataUriMap(wanted, baseDir);
  if (map.size === 0) return md;
  return md.replace(MD_IMG_RE, (full, pre: string, src: string, post: string) =>
    map.has(src) ? `${pre}${map.get(src)}${post}` : full);
}
