/**
 * Document rendering — HTML → PDF via the headed Chrome that already runs in the
 * `browser-vnc` container, driven over raw CDP (Chrome DevTools Protocol).
 *
 * Why reuse that container rather than add a renderer service: it is already a
 * default compose service with a CDP endpoint on the internal network, so this
 * costs no new image, no new npm dependency (the `ws` client is already a core
 * dep), and no new attack surface — the HTML is pushed into the page with
 * `Page.setDocumentContent` and the PDF comes back base64 over the same socket,
 * so nothing is ever served over HTTP and no volume is shared.
 *
 * `enabled: false` (or an unreachable endpoint) degrades to a clear tool error;
 * it never takes the gateway down.
 */
import { z } from "zod";

export const RenderSchema = z.object({
  pdf: z.object({
    enabled: z.boolean().default(true),
    /** CDP HTTP endpoint of the Chrome that renders pages. Compose service name by default. */
    cdpUrl: z.string().default("http://browser-vnc:9222"),
    /** Whole-render budget: tab open → content set → printToPDF → tab close. */
    timeoutMs: z.number().int().min(1000).max(300000).default(30000),
    /**
     * Settle delay after the document content is set, before printing. Web fonts and
     * layout need a tick; the render is otherwise deterministic (no network loads,
     * since the HTML is fully inlined before it is pushed to the page).
     */
    settleMs: z.number().int().min(0).max(10000).default(400),
    /** Hard cap on the HTML pushed into the page, so a runaway document can't wedge Chrome. */
    maxHtmlBytes: z.number().int().min(10000).max(50000000).default(8000000),
  }).default({}),
}).default({});

export type RenderConfig = z.infer<typeof RenderSchema>;
