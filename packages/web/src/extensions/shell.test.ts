import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import type { WebExtension } from "./registry";
import { collectShellComponents } from "./shell";

const component = (name: string) => defineComponent({ name, render: () => null });

describe("collectShellComponents", () => {
  it("merges every extension's shell components, in extension order and each list's own order", () => {
    const watcher = component("Watcher");
    const toasts = component("Toasts");
    const banner = component("Banner");
    const extensions: WebExtension[] = [
      { name: "alpha", shellComponents: [watcher, toasts] },
      { name: "beta", routes: [], nav: [] },
      { name: "gamma", shellComponents: [banner] },
    ];
    expect(collectShellComponents(extensions)).toEqual([
      { extension: "alpha", component: watcher },
      { extension: "alpha", component: toasts },
      { extension: "gamma", component: banner },
    ]);
  });

  it("has nothing to mount when no extension contributes any", () => {
    expect(collectShellComponents([])).toEqual([]);
    expect(collectShellComponents([{ name: "alpha" }, { name: "beta", shellComponents: [] }])).toEqual([]);
  });
});
