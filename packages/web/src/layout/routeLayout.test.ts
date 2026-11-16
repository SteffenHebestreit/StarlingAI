/**
 * The bare layout flag (layout/routeLayout.ts): which routes App.vue draws without its shell, and
 * that the answer is right from the first frame of a cold load, before the page has arrived.
 * The type checks at the bottom are enforced by vue-tsc (pnpm check), not by vitest.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { computed, defineComponent, type Component } from "vue";
import {
  START_LOCATION,
  createMemoryHistory,
  createRouter,
  type RouteComponent,
  type RouteMeta,
  type RouteRecordRaw,
} from "vue-router";
import { isBareLayout, routeIsBare } from "./routeLayout";

const page = defineComponent({ render: () => null });

/** A lazily loaded page that arrives only when the test lets it. */
function pageOnItsWay(): { load: () => Promise<Component>; arrive: () => void } {
  let arrive = (): void => {};
  const loaded = new Promise<Component>((resolve) => {
    arrive = () => resolve(page);
  });
  return { load: () => loaded, arrive };
}

/** A router whose address bar shows `start`, as a freshly opened tab does; nothing navigated yet. */
function routerOpening(start: string, kiosk: RouteComponent | (() => Promise<Component>) = page) {
  const history = createMemoryHistory();
  history.replace(start);
  return createRouter({
    history,
    routes: [
      { path: "/", component: page },
      { path: "/kiosk", component: kiosk, meta: { layout: "bare" } },
      { path: "/terminal", component: page, meta: { layout: "bare" }, children: [{ path: "step", component: page }] },
      { path: "/:pathMatch(.*)*", redirect: "/" },
    ],
  });
}

describe("isBareLayout", () => {
  it("is bare for a meta that says so", () => {
    expect(isBareLayout({ layout: "bare" })).toBe(true);
  });

  it("keeps the shell for a route without a layout, and for no meta at all", () => {
    expect(isBareLayout({})).toBe(false);
    expect(isBareLayout({ title: "Jobs" })).toBe(false);
    expect(isBareLayout(undefined)).toBe(false);
    expect(isBareLayout(null)).toBe(false);
  });

  it("keeps the shell for any other value a route written in plain JavaScript might carry", () => {
    for (const layout of ["Bare", "bare ", "full", "", true, 1]) {
      expect(isBareLayout({ layout } as unknown as RouteMeta)).toBe(false);
    }
  });
});

describe("routeIsBare", () => {
  it("follows the router from page to page", async () => {
    const router = routerOpening("/");
    await router.push("/");
    expect(routeIsBare(router)).toBe(false);
    await router.push("/kiosk");
    expect(routeIsBare(router)).toBe(true);
    await router.push("/");
    expect(routeIsBare(router)).toBe(false);
  });

  it("holds for the pages nested under a bare route", async () => {
    const router = routerOpening("/");
    await router.push("/terminal/step");
    expect(routeIsBare(router)).toBe(true);
  });

  it("decides from the address being opened while the first navigation still loads the page", async () => {
    const kiosk = pageOnItsWay();
    const router = routerOpening("/kiosk", kiosk.load);
    // What app.use(router) starts; the app mounts without waiting for it.
    const first = router.push(router.options.history.location);
    await Promise.resolve();
    expect(router.currentRoute.value).toBe(START_LOCATION);
    expect(routeIsBare(router)).toBe(true);

    kiosk.arrive();
    await first;
    expect(router.currentRoute.value.path).toBe("/kiosk");
    expect(routeIsBare(router)).toBe(true);
  });

  it("keeps the shell before the first navigation towards a page that has it", () => {
    expect(routeIsBare(routerOpening("/"))).toBe(false);
    // An unknown address is caught by the redirect home, which has the shell too.
    expect(routeIsBare(routerOpening("/no/such/page"))).toBe(false);
  });

  it("drives a computed, the way App.vue reads it", async () => {
    const router = routerOpening("/kiosk");
    const bare = computed(() => routeIsBare(router));
    expect(bare.value).toBe(true);
    await router.push("/kiosk");
    await router.push("/");
    expect(bare.value).toBe(false);
    await router.push("/terminal");
    expect(bare.value).toBe(true);
  });
});

// How an extension declares its routes (extensions/registry.ts). Only the type is taken, so the
// registry's build-time discovery does not run in this test, and the calls below are never made.
declare const defineWebExtension: typeof import("@/extensions/registry").defineWebExtension;

describe("the layout field of a route's meta", () => {
  it("is typed: \"bare\", or absent for the shell", () => {
    expectTypeOf<RouteMeta["layout"]>().toEqualTypeOf<"bare" | undefined>();
    // @ts-expect-error -- "bare" is the only layout besides the default shell
    const misspelt: RouteRecordRaw = { path: "/x", component: page, meta: { layout: "wide" } };
    expect(isBareLayout(misspelt.meta)).toBe(false);
  });

  it("is accepted, and checked, where an extension declares its routes", () => {
    const declareRoutes = (): void => {
      defineWebExtension({ name: "kiosk", routes: [{ path: "/kiosk", component: page, meta: { layout: "bare" } }] });
      // @ts-expect-error -- the same misspelling is caught in an extension's manifest
      defineWebExtension({ name: "kiosk", routes: [{ path: "/kiosk", component: page, meta: { layout: "wide" } }] });
    };
    expectTypeOf(declareRoutes).toBeFunction();
  });
});
