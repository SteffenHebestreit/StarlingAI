/**
 * Web extension registry — the fork-owned surface of the web shell
 * (docs/fork-boilerplate-plan.md WS4, the web-side sibling of
 * packages/core/src/extensions/).
 *
 * Each subdirectory `<name>/index.ts` default-exports a
 * `defineWebExtension({...})` manifest contributing routes and nav entries.
 * Discovery happens at BUILD time via `import.meta.glob`, so adding an
 * extension never touches the router or the app shell — and a fork's commits
 * here can never conflict with upstream changes on rebase.
 *
 * Directories starting with `_` or `.` are skipped (`_example/` stays
 * dormant; copy it to start your own).
 */
import type { RouteRecordRaw } from "vue-router";

export interface WebExtensionNavEntry {
  /** Visible label in the app-shell navigation. */
  label: string;
  /** Route path the entry links to. */
  path: string;
  /**
   * Role names allowed to SEE this entry (display-only convenience — the
   * gateway enforces actual access). Empty/undefined = visible to everyone.
   */
  roles?: string[];
  /** Sort order among extension nav entries (lower first, default 100). */
  order?: number;
}

export interface WebExtension {
  /** Unique id — by convention the directory name. */
  name: string;
  /** Routes merged into the router ahead of the catch-all redirect. */
  routes?: RouteRecordRaw[];
  /** Navigation entries the app shell renders after the core entries. */
  nav?: WebExtensionNavEntry[];
}

/** Identity helper — typed authoring surface, no runtime behavior. */
export function defineWebExtension<T extends WebExtension>(extension: T): T {
  return extension;
}

const modules = import.meta.glob<{ default: WebExtension }>("./*/index.ts", { eager: true });

const loaded: WebExtension[] = Object.entries(modules)
  .filter(([path]) => {
    const dir = path.split("/")[1] ?? "";
    return !dir.startsWith("_") && !dir.startsWith(".");
  })
  .map(([, mod]) => mod.default)
  .filter((ext): ext is WebExtension => Boolean(ext && typeof ext.name === "string"));

export function listWebExtensions(): readonly WebExtension[] {
  return loaded;
}

/** All extension routes, for the router to spread before its catch-all. */
export function extensionRoutes(): RouteRecordRaw[] {
  return loaded.flatMap((ext) => ext.routes ?? []);
}

/** All extension nav entries, sorted, for the app shell to render. */
export function extensionNavEntries(): WebExtensionNavEntry[] {
  return loaded
    .flatMap((ext) => ext.nav ?? [])
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
