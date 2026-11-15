/**
 * What an open page does when a new build of the web UI has taken it over.
 *
 * The service worker (main.ts, vite-plugin-pwa in `autoUpdate` mode) installs a new build in the
 * background and claims the open tabs; the page then still runs the old bundle. The plugin's
 * default for that moment is `window.location.reload()` on the spot — whatever is on screen, a
 * half-typed message or a visitor in the middle of a kiosk flow, is thrown away without a word.
 * The handler that was meant to ask first (`onNeedRefresh` with a `window.confirm()`) never runs
 * in that mode, and where it would, it put a blocking, English-only system dialog over the page —
 * on an unattended screen with nobody there to answer it.
 *
 * So the page decides (appUpdateStep):
 *  - nobody has used the page since it loaded (no pointer, touch or key press yet — a tab that
 *    opened from a stale cache, a display nobody has touched): reload now, there is nothing to lose;
 *  - a route whose meta says `layout: "bare"` (a kiosk or check-in screen, a page in front of
 *    someone who is not an operator): no notice and no reload under the visitor's hands. The page
 *    picks the moment itself: it can watch `appUpdatePending` and call `applyAppUpdate()` at an
 *    idle point (its start screen, between visitors); failing that, the new build loads with the
 *    next page change;
 *  - a tab in the background: reload now, nobody is looking — also when a tab whose update is
 *    still waiting goes to the background later;
 *  - otherwise: an in-app notice with a Reload button, and the next page change loads the new
 *    build if the button was not used, so a stale bundle does not linger.
 *
 * A page change is a change of path: a query or hash update within a page (a filter, a selected
 * row) keeps the page as it is. Until the swap the old bundle keeps running, and its lazily loaded
 * chunks may be gone: main.ts's `router.onError` recovery catches a route's page, nothing catches
 * a component loaded inside a page — one more reason for a long-lived bare page to apply the
 * update at its idle point.
 */
import { computed, ref } from "vue";
import { START_LOCATION, type Router } from "vue-router";
import { browserLanguage } from "./chatText";
import type { TurnLanguage } from "./turnText";

export type AppUpdateStep = "reload" | "notify" | "defer";

export interface AppUpdatePage {
  /** Someone has used the page since it loaded (trackUse): there may be something on screen to lose. */
  used: boolean;
  /** The tab is in the background (document.visibilityState is "hidden"). */
  hidden: boolean;
  /** The meta of the route on screen. Only `layout` is read, as plain text. */
  meta: { readonly layout?: unknown } | null | undefined;
}

/** What to do with a new build that has taken the page over (see the module comment). */
export function appUpdateStep(page: AppUpdatePage): AppUpdateStep {
  if (!page.used) return "reload";
  if (page.meta?.layout === "bare") return "defer";
  return page.hidden ? "reload" : "notify";
}

/** The events that count as using the page. Moving the pointer or scrolling does not. */
const USE_EVENTS = ["pointerdown", "touchstart", "keydown"] as const;

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Start noting whether someone uses the page (a pointer, touch or key press anywhere in it), and
 * return the reading. Listens in the capture phase, so a handler that stops propagation does not
 * hide a press; stops listening after the first.
 */
export function trackUse(target: Listenable): () => boolean {
  let used = false;
  const mark = (): void => {
    used = true;
    for (const type of USE_EVENTS) target.removeEventListener(type, mark, true);
  };
  for (const type of USE_EVENTS) target.addEventListener(type, mark, { capture: true, passive: true });
  return () => used;
}

export interface AppUpdateNotice {
  /** The same id every time: a second update replaces the notice instead of stacking another. */
  id: string;
  title: string;
  message: string;
  /** The notice's button: its label, and what it does. */
  action: { label: string; run: () => void };
}

const pick = (lang: TurnLanguage, en: string, de: string): string => (lang === "de" ? de : en);

/** The notice in the browser's language, with a button that runs `reload`. */
export function appUpdateNotice(lang: TurnLanguage, reload: () => void): AppUpdateNotice {
  return {
    id: "app-update",
    title: pick(lang, "New version available", "Neue Version verfügbar"),
    message: pick(lang,
      "A new version of this interface has been installed. Reload to use it — otherwise it loads when you open another page.",
      "Eine neue Version dieser Oberfläche ist installiert. Neu laden, um sie zu verwenden — sonst wird sie beim Öffnen einer anderen Seite geladen."),
    action: { label: pick(lang, "Reload", "Neu laden"), run: reload },
  };
}

export interface AppUpdateEffects {
  /** Reload the page as it is (window.location.reload). */
  reload(): void;
  /** Load an address as a full page load (window.location.assign). */
  load(href: string): void;
  /** Put the notice on screen (the shell's toasts). */
  notify(notice: AppUpdateNotice): void;
  /** Whether the tab is in the background. */
  hidden(): boolean;
  /** Whether someone has used the page since it loaded (trackUse). */
  used(): boolean;
  /** Call `listener` each time the tab goes to the background. */
  onHidden(listener: () => void): void;
  /** The language of the notice; the browser's by default. */
  language?(): TurnLanguage;
}

/** The parts of `window` the effects use. */
export interface AppUpdateWindow extends Listenable {
  location: Pick<Location, "reload" | "assign">;
  document: Listenable & Pick<Document, "visibilityState">;
}

/** The effects on a real page; `notify` puts the notice on screen. Starts noting use at once. */
export function browserUpdateEffects(win: AppUpdateWindow, notify: (notice: AppUpdateNotice) => void): AppUpdateEffects {
  const used = trackUse(win);
  const hidden = (): boolean => win.document.visibilityState === "hidden";
  return {
    reload: () => win.location.reload(),
    load: (href) => win.location.assign(href),
    notify,
    hidden,
    used,
    onHidden: (listener) => win.document.addEventListener("visibilitychange", () => {
      if (hidden()) listener();
    }),
  };
}

/** The hooks for vite-plugin-pwa's registerSW: who decides once a new build has taken over. */
export interface AppUpdateHooks {
  onNeedReload: () => void;
  onNeedRefresh: () => void;
}

/**
 * registerSW's hooks. `onNeedReload` runs once the new build has taken the page over (in
 * `autoUpdate` mode always, in `prompt` mode after the swap); without it the plugin reloads on the
 * spot. `onNeedRefresh` runs only in `prompt` mode while the new build waits: it takes over at
 * once (`skipWaiting`, i.e. `updateSW(true)`), and `onNeedReload` decides as above. Nothing here
 * asks with a blocking dialog.
 */
export function serviceWorkerHooks(onNewBuild: () => void, skipWaiting: () => void): AppUpdateHooks {
  return { onNeedReload: onNewBuild, onNeedRefresh: () => skipWaiting() };
}

const pending = ref(false);
let reloadNow: () => void = () => {};

/** A new build has taken the page over and waits for a reload (on a bare page, or a notice not acted on). */
export const appUpdatePending = computed(() => pending.value);

/**
 * Load the waiting new build now. For a bare page at its own idle point — its start screen,
 * between visitors — where the page would otherwise keep the old build until its path changes.
 * Returns whether a build was waiting (and the page is reloading).
 */
export function applyAppUpdate(): boolean {
  if (!pending.value) return false;
  reloadNow();
  return true;
}

/**
 * Follow the router so that a new build can be put off to the next page change, and return the
 * handler to call when a new build has taken the page over (registerSW's `onNeedReload`).
 */
export function watchAppUpdate(router: Router, effects: AppUpdateEffects): () => void {
  pending.value = false;
  reloadNow = () => effects.reload();
  const step = (): AppUpdateStep => appUpdateStep({
    used: effects.used(),
    hidden: effects.hidden(),
    meta: router.currentRoute.value.meta,
  });
  router.beforeEach((to, from) => {
    if (!pending.value || from === START_LOCATION || to.path === from.path) return true;
    // A full load of where the user was going, instead of the old bundle's view of it. The
    // navigation is held, never settled: a cancelled Back/Forward makes the router put the old
    // address back with history.go(), and in the browser that traversal stops this load.
    effects.load(router.resolve(to.fullPath).href);
    return new Promise<boolean>(() => {});
  });
  // A tab whose update is still waiting goes to the background: decide again (nobody is looking).
  effects.onHidden(() => {
    if (pending.value && step() === "reload") effects.reload();
  });
  return () => {
    const next = step();
    if (next === "reload") {
      effects.reload();
      return;
    }
    pending.value = true;
    if (next === "notify") {
      effects.notify(appUpdateNotice((effects.language ?? browserLanguage)(), () => effects.reload()));
    }
  };
}
