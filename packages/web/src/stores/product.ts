import { defineStore } from "pinia";
import { ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

export interface ProductExtensionInfo {
  name: string;
  version?: string;
  description?: string;
}

/**
 * Upstream identity — ALSO the pre-fetch / offline fallback. The shell renders
 * with these before `/api/product` resolves and if the gateway is unreachable,
 * so branding never flashes empty. A fork overrides them server-side via
 * product.json; nothing in this package needs editing (docs/fork-boilerplate-plan.md WS1).
 */
const DEFAULT_NAME = "StarlingAI";
const DEFAULT_TAGLINE = "Guarded Agent Swarm";
const DEFAULT_LOGO = "/swarmLogo.svg";

/**
 * Product store — the single source of the web shell's branding (display name,
 * tagline, logo) plus extension metadata, served by `GET /api/product`.
 *
 * That endpoint is deliberately PUBLIC/unauthenticated (gateway/routes/health.ts)
 * because the login screen renders branding before any token exists — so `load()`
 * must never send an Authorization header and must not wait for a session.
 *
 * Components read `name`/`tagline`/`logo` from here instead of hardcoding
 * "StarlingAI", which is what lets a fork rebrand the whole UI by shipping a
 * product.json and touching zero files under packages/web.
 */
export const useProductStore = defineStore("product", () => {
  const gateway = useGatewayStore();

  const name = ref(DEFAULT_NAME);
  const slug = ref("starlingai");
  const tagline = ref(DEFAULT_TAGLINE);
  const logo = ref(DEFAULT_LOGO);
  /** Per-user state directory (".starlingai") — shown on the login screen as the
   *  on-disk token path, so a fork prints its own directory rather than upstream's. */
  const stateDirName = ref(".starlingai");
  /** Fork accent hint (e.g. "cyan"). Carried for forks; the shell's own colours
   *  still come from the user-selected palette in stores/theme.ts, which must not
   *  be overridden by branding. */
  const accent = ref<string | undefined>(undefined);
  const extensions = ref<ProductExtensionInfo[]>([]);
  const loaded = ref(false);

  function apiBase(): string {
    return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  /** Fetch identity once at boot. Never throws and never clears a good value —
   *  any failure leaves the upstream defaults in place. */
  async function load(): Promise<void> {
    try {
      const res = await fetch(`${apiBase()}/api/product`);
      if (!res.ok) return;
      const body = await res.json() as {
        name?: unknown; slug?: unknown; tagline?: unknown; stateDirName?: unknown;
        theme?: { accent?: unknown; logo?: unknown };
        extensions?: unknown;
      };
      // Only adopt non-empty strings, so a partial/blank payload can't blank the shell.
      if (typeof body.name === "string" && body.name.trim()) name.value = body.name.trim();
      if (typeof body.slug === "string" && body.slug.trim()) slug.value = body.slug.trim();
      if (typeof body.tagline === "string" && body.tagline.trim()) tagline.value = body.tagline.trim();
      if (typeof body.stateDirName === "string" && body.stateDirName.trim()) stateDirName.value = body.stateDirName.trim();
      if (typeof body.theme?.logo === "string" && body.theme.logo.trim()) logo.value = body.theme.logo.trim();
      if (typeof body.theme?.accent === "string" && body.theme.accent.trim()) accent.value = body.theme.accent.trim();
      if (Array.isArray(body.extensions)) extensions.value = body.extensions as ProductExtensionInfo[];
      applyDocumentIdentity();
    } catch {
      /* offline / gateway down → keep defaults */
    } finally {
      loaded.value = true;
    }
  }

  /** Mirror the identity onto the document (tab title + favicon). index.html ships
   *  the upstream values statically for first paint; this re-applies them for a fork. */
  function applyDocumentIdentity(): void {
    if (typeof document === "undefined") return;
    document.title = name.value;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon && logo.value) icon.href = logo.value;
  }

  return { name, slug, tagline, stateDirName, logo, accent, extensions, loaded, load };
});
