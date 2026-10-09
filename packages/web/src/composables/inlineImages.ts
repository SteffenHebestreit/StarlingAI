/**
 * Whether an inline markdown image in a chat message can be drawn at all.
 *
 * The model writes workspace files into its answer as `![](generated/…/image.png)`. Rendered as
 * is, that is a relative <img> the browser requests from the SPA, which answers every unknown
 * path with index.html — so the picture was broken in every turn, even when the path was right.
 * The workspace file endpoint needs a token, so a plain <img> could never load it either.
 *
 * So a workspace image in the text is drawn as a short reference — its alt text, or its file
 * name — never as a broken picture. The picture itself is the attachment card above the text,
 * with enlarge and download; drawing it again inline would show it twice. The reference keeps
 * the image's place where there is no card: an image from an earlier turn, or a PDF export of
 * the transcript. Remote and data: images are drawn exactly as markdown always drew them.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */

/** Any URL scheme (http:, https:, data:, blob:, …) or a protocol-relative `//host` URL. */
const REMOTE_SRC = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function isDrawableImageSource(href: string): boolean {
  return REMOTE_SRC.test(href.trim());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The renderer's answer for one markdown image token: `false` lets marked draw a remote or data:
 * image the way it always has; a workspace file becomes a reference to it.
 */
export function renderInlineImage(token: { href: string; text?: string }): string | false {
  if (isDrawableImageSource(token.href)) return false;
  const path = token.href.trim();
  const label = token.text?.trim() || path.slice(path.lastIndexOf("/") + 1) || path;
  if (!label) return "";
  return `<span class="md-image-ref" title="${escapeHtml(path)}">[${escapeHtml(label)}]</span>`;
}
