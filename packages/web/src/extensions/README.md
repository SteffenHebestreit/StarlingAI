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
