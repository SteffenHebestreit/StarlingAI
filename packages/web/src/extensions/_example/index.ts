/**
 * Reference web extension — dormant (the registry skips `_`-prefixed
 * directories). Copy this directory to `../<your-name>/` to start a real one.
 */
import { defineWebExtension } from "../registry";

export default defineWebExtension({
  name: "example",
  routes: [{ path: "/example", component: () => import("./ExamplePage.vue") }],
  nav: [{ label: "Example", path: "/example", order: 100 }],
});
