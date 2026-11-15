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
- Keep pages and components inside your extension directory.
- Branding (product name, tagline, accent) comes from `GET /api/product`
  (driven by the repo-root `product.json`), not from extensions.

**Upstream ships nothing here except this README, `registry.ts`, and the
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
