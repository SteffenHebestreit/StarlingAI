import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  appUpdateNotice,
  appUpdatePending,
  appUpdateStep,
  applyAppUpdate,
  browserUpdateEffects,
  serviceWorkerHooks,
  trackUse,
  watchAppUpdate,
  type AppUpdateNotice,
  type AppUpdatePage,
} from "./appUpdate";

const page = (meta: AppUpdatePage["meta"], hidden = false): AppUpdatePage => ({ used: true, hidden, meta });

/** Let the router run its guards (they chain on promises). */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe("appUpdateStep", () => {
  it("offers a reload on a page with the shell that someone is using", () => {
    expect(appUpdateStep(page({}))).toBe("notify");
    expect(appUpdateStep(page(undefined))).toBe("notify");
  });

  it("reloads a tab in the background at once, as before", () => {
    expect(appUpdateStep(page({}, true))).toBe("reload");
  });

  it("neither asks nor reloads on a bare page that someone is using, visible or not", () => {
    expect(appUpdateStep(page({ layout: "bare" }))).toBe("defer");
    expect(appUpdateStep(page({ layout: "bare" }, true))).toBe("defer");
  });

  it("reads the layout as exact text: anything else keeps the shell's behaviour", () => {
    for (const layout of ["Bare", "full", "", 1, true, null]) {
      expect(appUpdateStep(page({ layout }))).toBe("notify");
    }
  });

  it("reloads while nobody has used the page, bare or not: there is nothing to lose", () => {
    expect(appUpdateStep({ used: false, hidden: false, meta: { layout: "bare" } })).toBe("reload");
    expect(appUpdateStep({ used: false, hidden: false, meta: {} })).toBe("reload");
  });
});

describe("trackUse", () => {
  it("notes the first pointer, touch or key press, and nothing else", () => {
    for (const type of ["pointerdown", "touchstart", "keydown"]) {
      const target = new EventTarget();
      const used = trackUse(target);
      target.dispatchEvent(new Event("pointermove"));
      target.dispatchEvent(new Event("scroll"));
      expect(used()).toBe(false);
      target.dispatchEvent(new Event(type));
      expect(used()).toBe(true);
    }
  });

  it("stops listening after the first press", () => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, "removeEventListener");
    trackUse(target);
    target.dispatchEvent(new Event("keydown"));
    expect(remove).toHaveBeenCalledTimes(3);
  });
});

describe("appUpdateNotice", () => {
  it("speaks the browser's language and its button reloads", () => {
    const reload = vi.fn();
    const en = appUpdateNotice("en", reload);
    const de = appUpdateNotice("de", reload);
    expect(en).toMatchObject({ id: "app-update", title: "New version available", action: { label: "Reload" } });
    expect(de).toMatchObject({ id: "app-update", title: "Neue Version verfügbar", action: { label: "Neu laden" } });
    expect(de.message).not.toBe(en.message);
    expect(reload).not.toHaveBeenCalled();
    de.action.run();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("serviceWorkerHooks", () => {
  it("hands the moment the new build has taken over to the page, and lets a waiting build take over", () => {
    const onNewBuild = vi.fn();
    const skipWaiting = vi.fn();
    const hooks = serviceWorkerHooks(onNewBuild, skipWaiting);
    expect(hooks.onNeedReload).toBe(onNewBuild);
    expect(skipWaiting).not.toHaveBeenCalled();
    hooks.onNeedRefresh();
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(onNewBuild).not.toHaveBeenCalled();
  });
});

describe("browserUpdateEffects", () => {
  function fakeWindow() {
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const win = Object.assign(new EventTarget(), { location: { reload: vi.fn(), assign: vi.fn() }, document });
    return { win, document };
  }

  it("reloads, loads and reads the tab's visibility through the window", () => {
    const { win, document } = fakeWindow();
    const effects = browserUpdateEffects(win, vi.fn());
    effects.reload();
    effects.load("/jobs?x=1");
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.location.assign).toHaveBeenCalledWith("/jobs?x=1");
    expect(effects.hidden()).toBe(false);
    document.visibilityState = "hidden";
    expect(effects.hidden()).toBe(true);
  });

  it("notes use of the page from the moment it is made", () => {
    const { win } = fakeWindow();
    const effects = browserUpdateEffects(win, vi.fn());
    expect(effects.used()).toBe(false);
    win.dispatchEvent(new Event("pointerdown"));
    expect(effects.used()).toBe(true);
  });

  it("tells when the tab goes to the background, not when it comes back", () => {
    const { win, document } = fakeWindow();
    const listener = vi.fn();
    browserUpdateEffects(win, vi.fn()).onHidden(listener);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("watchAppUpdate", () => {
  const Page = { render: () => null };

  async function setup(start: string, options: { hidden?: boolean; used?: boolean } = {}) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: Page },
        { path: "/jobs", component: Page },
        { path: "/kiosk", component: Page, meta: { layout: "bare" } },
        { path: "/kiosk/done", component: Page, meta: { layout: "bare" } },
      ],
    });
    const state = { hidden: options.hidden ?? false, used: options.used ?? true };
    const notices: AppUpdateNotice[] = [];
    const hiddenListeners: Array<() => void> = [];
    const effects = {
      reload: vi.fn(),
      load: vi.fn(),
      hidden: () => state.hidden,
      used: () => state.used,
      onHidden: (listener: () => void) => { hiddenListeners.push(listener); },
      notify: (notice: AppUpdateNotice) => { notices.push(notice); },
      language: () => "en" as const,
    };
    const onNewBuild = watchAppUpdate(router, effects);
    await router.push(start);
    const goHidden = () => {
      state.hidden = true;
      for (const listener of hiddenListeners) listener();
    };
    return { router, effects, notices, onNewBuild, goHidden };
  }

  it("puts a notice with a Reload button on a shell page instead of reloading", async () => {
    const { effects, notices, onNewBuild } = await setup("/jobs");
    onNewBuild();
    expect(effects.reload).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    notices[0]!.action.run();
    expect(effects.reload).toHaveBeenCalledTimes(1);
  });

  it("shows no notice on a bare page and loads the new build with the next page change", async () => {
    const { router, effects, notices, onNewBuild } = await setup("/kiosk");
    onNewBuild();
    expect(notices).toHaveLength(0);
    expect(effects.reload).not.toHaveBeenCalled();
    // A query change within the page keeps it as it is.
    await router.push("/kiosk?step=2");
    expect(effects.load).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe("/kiosk?step=2");
    // The page moves on: a full load of where it was going, not the old bundle's view of it.
    void router.push("/kiosk/done?visit=1");
    await settle();
    expect(effects.load).toHaveBeenCalledWith("/kiosk/done?visit=1");
    expect(router.currentRoute.value.path).toBe("/kiosk");
  });

  it("loads the new build with the next page change when the notice was left alone, and holds that navigation", async () => {
    const { router, effects, onNewBuild } = await setup("/jobs");
    onNewBuild();
    let settled = false;
    void router.push("/").then(() => { settled = true; });
    await settle();
    expect(effects.load).toHaveBeenCalledWith("/");
    expect(effects.reload).not.toHaveBeenCalled();
    // Not cancelled: a cancelled navigation would settle (with a failure) while the page unloads.
    expect(settled).toBe(false);
    expect(router.currentRoute.value.path).toBe("/jobs");
  });

  it("does not undo a Back while the new build loads: the history stays where the user went", async () => {
    const { router, effects, onNewBuild } = await setup("/jobs");
    await router.push("/");
    onNewBuild();
    router.back();
    await settle();
    expect(effects.load).toHaveBeenCalledWith("/jobs");
    // A cancelled Back is undone with history.go(+1), and in a browser that stops the load.
    expect(router.options.history.location).toBe("/jobs");
  });

  it("navigates as usual while no new build is waiting", async () => {
    const { router, effects } = await setup("/kiosk");
    await router.push("/jobs");
    expect(effects.load).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe("/jobs");
  });

  it("reloads a background tab at once", async () => {
    const { effects, notices, onNewBuild } = await setup("/jobs", { hidden: true });
    onNewBuild();
    expect(effects.reload).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(0);
  });

  it("reloads at once while nobody has used the page, even with a page on screen", async () => {
    for (const start of ["/jobs", "/kiosk"]) {
      const { effects, notices, onNewBuild } = await setup(start, { used: false });
      onNewBuild();
      expect(effects.reload).toHaveBeenCalledTimes(1);
      expect(notices).toHaveLength(0);
    }
  });

  it("reloads a shell tab whose notice is still up once it goes to the background", async () => {
    const { effects, onNewBuild, goHidden } = await setup("/jobs");
    onNewBuild();
    expect(effects.reload).not.toHaveBeenCalled();
    goHidden();
    expect(effects.reload).toHaveBeenCalledTimes(1);
  });

  it("leaves a bare page, and a tab with nothing waiting, alone when it goes to the background", async () => {
    const bare = await setup("/kiosk");
    bare.onNewBuild();
    bare.goHidden();
    expect(bare.effects.reload).not.toHaveBeenCalled();
    const idle = await setup("/jobs");
    idle.goHidden();
    expect(idle.effects.reload).not.toHaveBeenCalled();
  });

  it("lets a bare page load the waiting build at its own moment", async () => {
    const { effects, onNewBuild } = await setup("/kiosk");
    expect(appUpdatePending.value).toBe(false);
    expect(applyAppUpdate()).toBe(false);
    expect(effects.reload).not.toHaveBeenCalled();
    onNewBuild();
    expect(appUpdatePending.value).toBe(true);
    expect(effects.reload).not.toHaveBeenCalled();
    expect(applyAppUpdate()).toBe(true);
    expect(effects.reload).toHaveBeenCalledTimes(1);
  });
});

describe("the wiring", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("main.ts gives registerSW the hooks, never a blocking dialog", () => {
    const main = source("../main.ts");
    const call = main.slice(main.indexOf("registerSW({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("...serviceWorkerHooks(onNewBuild,");
    expect(main).toMatch(/watchAppUpdate\(router, browserUpdateEffects\(window,/);
    // In the code, that is; the comments tell why there is none.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const text of [main, source("./appUpdate.ts")]) expect(code(text)).not.toMatch(/\bconfirm\s*\(/);
  });

  it("App.vue puts a toast's button on screen, and the button dismisses the toast and runs the action", () => {
    const app = source("../App.vue");
    expect(app).toMatch(/v-if="item\.action"[\s\S]{0,300}@click="runNotificationAction\(item\)"[\s\S]{0,80}\{\{ item\.action\.label \}\}/);
    const handler = app.slice(app.indexOf("function runNotificationAction("));
    expect(handler.slice(0, handler.indexOf("\n}"))).toMatch(/notifications\.dismiss\(item\.id\);\s*item\.action\?\.run\(\);/);
  });
});
