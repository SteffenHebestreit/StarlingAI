# Web extensions

Fork-owned web modules, discovered at build time — the web-side sibling of
`packages/core/src/extensions/`. Each subdirectory `<name>/index.ts`
default-exports a `defineWebExtension({...})` manifest:

```ts
import { defineWebExtension } from "../registry";

export default defineWebExtension({
  name: "mfa",
  routes: [
    { path: "/mfa/patients", component: () => import("./pages/PatientList.vue") },
  ],
  nav: [
    { label: "Patienten", path: "/mfa/patients", roles: ["mfa", "doctor", "admin"], order: 10 },
  ],
});
```

- **Routes** merge into the router ahead of the catch-all — no router edits.
- **Nav entries** render in the app shell after the core navigation; `roles`
  filters visibility against the signed-in user's role (display-only — the
  gateway enforces real access).
- **Shell components** mount once, app-wide — see below.
- Keep pages and components inside your extension directory.
- Branding (product name, tagline, accent) comes from `GET /api/product`
  (driven by the repo-root `product.json`), not from extensions.
- **New UI builds** never interrupt a route with `meta: { layout: "bare" }` once
  someone has used it: no notice, no reload. The build loads with the next
  change of path, or sooner if the page calls `applyAppUpdate()` from
  `@/composables/appUpdate` at an idle moment (its start screen, between
  visitors; `appUpdatePending` says whether one is waiting). A page that stays
  on one path should do that, or it keeps the old build until it is reloaded.

## App-wide components: `shellComponents`

A route's page is mounted only while that page is open. Something that has to
run or show whatever page is open — a watcher that polls for alerts, a toast
or banner region — goes in `shellComponents`:

```ts
import { defineAsyncComponent } from "vue";
import { defineWebExtension } from "../registry";
import AlertWatcher from "./shell/AlertWatcher.vue";

export default defineWebExtension({
  name: "helpdesk",
  routes: [/* … */],
  shellComponents: [
    // In the main bundle: it loads with the app, or the app does not load.
    AlertWatcher,
    // Out of the main bundle, loaded when the shell first mounts it.
    defineAsyncComponent({
      loader: () => import("./shell/BannerRegion.vue"),
      onError: (error, retry, fail, attempts) => (attempts <= 3 ? setTimeout(retry, attempts * 1000) : fail()),
    }),
  ],
});
```

- The app shell (`App.vue`) mounts them on every page that has the shell and
  keeps them mounted across navigation. They go with the shell: a page drawn
  without the shell does not get them, and they are mounted afresh when the
  shell comes back.
- They are mounted **afresh whenever the signed-in user changes** — sign-in,
  sign-out, switch of account — so nothing one user's session left in them is
  there for the next user. They are also mounted while nobody is signed in:
  show nothing from the gateway then (anything drawn above the sign-in dialog
  would stay on top of it), and check that someone is before calling it.
- They get **no props**. Read what you need from the stores (`useAuthStore`,
  `useGatewayStore`, …).
- They render at the **end of the shell, after the page, with no wrapper**.
  Render nothing for a pure watcher; give anything visible `position: fixed`
  or wrap it in `<Teleport to="body">`, as the shell's own toasts and dock do.
- Several extensions can contribute; they mount in directory-name order, each
  extension's list in its own order, one tick after the shell itself.
- Each one sits behind its **own error boundary**: an error from its setup,
  render, first mount, hooks, watchers or async loading is logged as
  `[extensions] <name>: error in a shell component …` and reaches neither the
  shell nor the other components. The failing component stays mounted (a
  render that throws just draws nothing that time). Errors Vue never sees — a
  timer callback, a promise nobody awaits — are the component's own to catch.
- **Lazy loading can fail.** If the chunk of a `defineAsyncComponent` fails to
  load — a network blip on the first visit — the component is simply missing,
  with only the log line above to show for it; Vue does not try again by
  itself. Import a component that must not go missing (an alert watcher)
  statically, as above, and give a lazy one an `onError` that retries.

**Upstream ships nothing here except this README, top-level `.ts` files, and the
dormant `_example/`** — directories starting with `_` or `.` are skipped at
discovery. Copy `_example/` to start your own. See
`docs/fork-boilerplate-plan.md` for the full forking model.

## Pages without the shell: `meta.layout: "bare"`

A page that is not part of the dashboard — a kiosk, a check-in terminal, a
screen put in front of someone who is not an operator — can ask for the whole
viewport:

```ts
routes: [
  { path: "/mfa/check-in", component: () => import("./pages/CheckIn.vue"), meta: { layout: "bare" } },
],
```

On such a route the app shell (`App.vue`) draws **only the page**: no header or
navigation, no model banner, no sign-in dialog, no toasts, no command palette,
no theme dialog, no operator dock, no background orbs. The page fills the
viewport (`h-full` gives it the full height). Children of a bare route are bare
too, since route meta is merged down the matched records. `"bare"` is the only
value (typed on `RouteMeta` in `src/router/index.ts`); leave `layout` out for
the normal shell. The decision is made from the first frame of a cold load, so
the shell never flashes before a bare page.

What that leaves to the page:

- **Authentication UI is the page's job.** The shell's sign-in dialog (and its
  focus trap) is never shown on a bare route, also not when the browser holds
  no token or the token was rejected. A page that needs a credential asks for
  it, stores it and sends it itself. The shell's background work does not
  change: if the browser does hold a dashboard token, the shell still connects
  the gateway with it — it only shows nothing of that connection.
- **The keyboard is the page's.** Ctrl/Cmd+K does not open the command palette
  and is not swallowed; no shell menu or dialog answers Escape (moving on to a
  bare page closes any that were open).
- **No way back.** There is no navigation; link out of the page yourself if
  anyone should leave it. The browser tab title is set as for any page; set
  `document.title` in the page if it should read differently.
- **Kept:** the confirm dialog of `composables/useConfirm.ts`. It appears only
  when the page itself calls `confirmAction()` (which would otherwise never be
  answered); give it the page's wording via `eyebrow`, `confirmLabel` and
  `cancelLabel`.

A `nav` entry for a bare page leads out of the dashboard with no way back; add
one only if that is what you want.
