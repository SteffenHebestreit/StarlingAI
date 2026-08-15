/**
 * HTML → PDF over raw CDP (Chrome DevTools Protocol).
 *
 * The renderer is the headed Chrome already running in the `browser-vnc` container
 * for the human-handoff browser preview. Driving it directly costs no new image and
 * no new dependency: `ws` is already a core dep, and the whole exchange is
 *
 *   PUT  /json/new?about:blank        → open a private tab
 *   ws://…                            → Page.setDocumentContent(html)
 *                                       Page.printToPDF(ReturnAsBase64)
 *   GET  /json/close/<targetId>       → close the tab
 *
 * Two properties of that shape matter for security and are deliberate:
 *
 *  - The HTML is PUSHED into the page with `Page.setDocumentContent`. Nothing is
 *    served over HTTP and no `data:` URL is navigated, so there is no URL for the
 *    page to be pointed at and no SSRF exemption is needed anywhere.
 *  - The PDF comes back base64 on the same socket (`ReturnAsBase64`), so no volume
 *    is shared with the browser container and no file is written on its side.
 *
 * Callers are responsible for inlining every asset (images as data: URIs, CSS in a
 * <style>) before calling: a page that still references remote assets renders
 * whatever it can reach from the browser container, which is not what a document
 * renderer should do. `renderHtmlToPdf` blocks non-inline subresource loads as a
 * backstop so an authoring mistake degrades to a missing image, never to a silent
 * outbound fetch from a container that can reach the public network.
 *
 * Every failure is returned as a typed error, never thrown: an unreachable browser
 * must degrade to a clear tool error, not a broken turn.
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("render:cdp-pdf");

export interface PdfRenderOptions {
  /** Paper size. Ignored when the HTML sets an @page size and preferCssPageSize is true. */
  format?: "A4" | "Letter" | "Legal";
  landscape?: boolean;
  /** Margins in inches. Ignored when the stylesheet's @page margin wins. */
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  printBackground?: boolean;
  /** Let the document's own `@page { size: … }` decide the paper. Default true. */
  preferCssPageSize?: boolean;
  scale?: number;
  headerHtml?: string;
  footerHtml?: string;
}

export type PdfRenderResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

/** Render a fully self-contained HTML document to PDF bytes. */
export async function renderHtmlToPdf(html: string, opts: PdfRenderOptions = {}): Promise<PdfRenderResult> {
  const cfg = getConfig().render.pdf;
  if (!cfg.enabled) {
    return { ok: false, error: "PDF rendering is disabled (render.pdf.enabled=false)." };
  }
  const htmlBytes = Buffer.byteLength(html, "utf8");
  if (htmlBytes > cfg.maxHtmlBytes) {
    return {
      ok: false,
      error: `Document is too large to render (${htmlBytes} bytes > render.pdf.maxHtmlBytes ${cfg.maxHtmlBytes}). Split it into several documents or reduce embedded images.`,
    };
  }

  const base = cfg.cdpUrl.replace(/\/+$/, "");
  const deadline = Date.now() + cfg.timeoutMs;

  let target: CdpTarget | null = null;
  try {
    target = await openTarget(base, deadline);
    return await printInTarget(target, html, opts, cfg.settleMs, deadline);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, cdpUrl: base }, "PDF render failed");
    return { ok: false, error: renderFailureHint(message, base) };
  } finally {
    if (target) {
      // Best-effort: a leaked tab would accumulate in a long-lived browser.
      await fetch(`${base}/json/close/${encodeURIComponent(target.id)}`)
        .catch(() => { /* the render already succeeded or failed; nothing to add */ });
    }
  }
}

async function openTarget(base: string, deadline: number): Promise<CdpTarget> {
  // Chrome requires PUT for /json/new (a GET is rejected as a DNS-rebinding defence).
  const res = await fetch(`${base}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
  });
  if (!res.ok) {
    throw new Error(`could not open a render tab (HTTP ${res.status})`);
  }
  const body = await res.json() as Partial<CdpTarget>;
  if (!body.id || !body.webSocketDebuggerUrl) {
    throw new Error("browser returned a target without a debugger socket");
  }
  return { id: body.id, webSocketDebuggerUrl: body.webSocketDebuggerUrl };
}

async function printInTarget(
  target: CdpTarget,
  html: string,
  opts: PdfRenderOptions,
  settleMs: number,
  deadline: number,
): Promise<PdfRenderResult> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });

  // A permanent 'error' listener that outlives every per-phase handler below.
  //
  // This is not defensive tidiness — without it a slow browser takes the whole
  // gateway down. `ws` reports a handshake abort ASYNCHRONOUSLY: close() on a
  // still-CONNECTING socket calls abortHandshake, which emits 'error' on a
  // process.nextTick (ws 8.21.0 websocket.js:302-307 → :1121 → :1053-1061). The
  // connect promise's cleanup() has by then removed its own 'error' listener, and
  // the finally below calls close() precisely in that state — so the emission
  // lands on a socket with zero listeners. In Node an unhandled 'error' event is
  // an uncaught throw, and index.ts's uncaughtException handler responds by
  // shutting the process down, killing every in-flight turn for every user.
  //
  // Trigger: browser-vnc answers PUT /json/new but never completes the WebSocket
  // upgrade (Chrome wedged, container restarting) → connect times out → crash.
  // Failures are still surfaced through the per-phase handlers; this listener
  // exists only so a late, post-cleanup abort is never unhandled.
  ws.on("error", () => { /* see above — real reporting happens in the handlers below */ });

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("timed out connecting to the browser")); },
        Math.max(1000, deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); ws.off("open", onOpen); ws.off("error", onError); };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    let nextId = 0;
    const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`${method} timed out`)); },
          Math.max(1000, deadline - Date.now()));
        const onMessage = (raw: unknown) => {
          let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
          try { msg = JSON.parse(String(raw)); } catch { return; }
          if (msg.id !== id) return;
          cleanup();
          if (msg.error) reject(new Error(`${method}: ${msg.error.message ?? "CDP error"}`));
          else resolve(msg.result ?? {});
        };
        const cleanup = () => { clearTimeout(timer); ws.off("message", onMessage); };
        ws.on("message", onMessage);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await call("Page.enable");
    // Backstop only — callers inline their assets. This blocks a page that still
    // references remote resources from making the browser container fetch them.
    await call("Network.enable").catch(() => { /* optional; blocking is best-effort */ });
    await call("Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*"] })
      .catch(() => { /* older protocol builds may not expose it; not fatal */ });

    const frameTree = await call("Page.getFrameTree");
    const frameId = ((frameTree["frameTree"] as { frame?: { id?: string } } | undefined)?.frame?.id) ?? "";
    if (!frameId) throw new Error("browser returned no frame to render into");

    await call("Page.setDocumentContent", { frameId, html });
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

    const printed = await call("Page.printToPDF", {
      printBackground: opts.printBackground ?? true,
      preferCSSPageSize: opts.preferCssPageSize ?? true,
      landscape: opts.landscape ?? false,
      transferMode: "ReturnAsBase64",
      ...(opts.scale ? { scale: opts.scale } : {}),
      ...paperFor(opts.format),
      ...marginsFor(opts.margin),
      ...(opts.headerHtml || opts.footerHtml
        ? {
            displayHeaderFooter: true,
            headerTemplate: opts.headerHtml ?? "<span></span>",
            footerTemplate: opts.footerHtml ?? "<span></span>",
          }
        : {}),
    });

    const data = printed["data"];
    if (typeof data !== "string" || data.length === 0) {
      throw new Error("browser returned an empty PDF");
    }
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
      throw new Error("browser returned data that is not a PDF");
    }
    return { ok: true, bytes };
  } finally {
    try { ws.close(); } catch { /* already closing */ }
  }
}

/** Chrome's printToPDF takes paper size in INCHES, not a named format. */
function paperFor(format: PdfRenderOptions["format"]): Record<string, number> {
  switch (format) {
    case "Letter": return { paperWidth: 8.5, paperHeight: 11 };
    case "Legal": return { paperWidth: 8.5, paperHeight: 14 };
    case "A4":
    case undefined:
    default: return { paperWidth: 8.27, paperHeight: 11.69 };
  }
}

function marginsFor(margin: PdfRenderOptions["margin"]): Record<string, number> {
  if (!margin) return {};
  const out: Record<string, number> = {};
  if (typeof margin.top === "number") out["marginTop"] = margin.top;
  if (typeof margin.right === "number") out["marginRight"] = margin.right;
  if (typeof margin.bottom === "number") out["marginBottom"] = margin.bottom;
  if (typeof margin.left === "number") out["marginLeft"] = margin.left;
  return out;
}

/**
 * Turn a transport failure into something the model can act on. "fetch failed"
 * against a compose service name almost always means the browser container is not
 * running, and the agent should be told to fall back rather than retry blindly.
 */
function renderFailureHint(message: string, base: string): string {
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `The PDF renderer is unreachable at ${base} (${message}). The browser service that renders PDFs is not running — start it, or produce the deliverable with generate_docx or generate_document instead.`;
  }
  return `PDF rendering failed: ${message}`;
}
