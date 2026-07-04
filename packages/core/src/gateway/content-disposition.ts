/**
 * Build a safe `Content-Disposition` header value (RFC 6266), sanitizing the
 * filename against header injection and providing the UTF-8 `filename*` form for
 * non-ASCII names. Shared by the workspace file routes and the session-markdown
 * export routes. Extracted from gateway/index.ts (god-file seam).
 */
export function buildContentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const sanitized = filename.replace(/[\r\n"]/g, "_");
  return `${disposition}; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
