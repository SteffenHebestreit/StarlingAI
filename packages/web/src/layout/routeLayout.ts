/**
 * Which frame the app shell draws around a route's page.
 *
 * A route whose meta says `layout: "bare"` has the whole viewport to itself: App.vue then draws
 * none of its chrome — no header, navigation, model banner, sign-in dialog, toasts, command
 * palette or operator dock — only the page. It is meant for screens that are not the dashboard:
 * a kiosk, a check-in terminal, a page put in front of someone who is not an operator. Every
 * other route keeps the shell. The meta field itself is declared in router/index.ts.
 */
import { START_LOCATION, type RouteMeta, type Router } from "vue-router";

/** Whether a route's meta asks for the bare layout. Anything but exactly "bare" keeps the shell. */
export function isBareLayout(meta: RouteMeta | null | undefined): boolean {
  return meta?.layout === "bare";
}

/**
 * Whether the page the router shows is bare — or, before its first navigation has settled, the
 * page it is opening.
 *
 * The app mounts without waiting for that first navigation, and while a lazily loaded page is
 * still on its way the router sits on its start location, whose meta is empty. Read that, and a
 * bare page opened from the address bar would first flash the whole shell, with the sign-in
 * dialog taking the focus. The address being opened is known from the start, and its route
 * records carry their meta without the page being loaded, so the layout is decided from there.
 *
 * It reads `router.currentRoute`, so a computed() around it follows every navigation.
 */
export function routeIsBare(router: Router): boolean {
  const current = router.currentRoute.value;
  if (current !== START_LOCATION) return isBareLayout(current.meta);
  return isBareLayout(router.resolve(router.options.history.location).meta);
}
