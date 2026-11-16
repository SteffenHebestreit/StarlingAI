import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createRenderer,
  createSSRApp,
  defineAsyncComponent,
  defineComponent,
  h,
  nextTick,
  onErrorCaptured,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type Component,
  type Ref,
} from "vue";
import { renderToString } from "vue/server-renderer";
import appSource from "../App.vue?raw";
import ExtensionShellHost from "./ExtensionShellHost";
import type { WebExtensionShellComponent } from "./shell";

// The web tests run in node, without a DOM. A renderer that builds a plain tree stands in for
// one: enough to mount components for real (setup, render, hooks, watchers) and read back what
// they drew.
interface TestNode {
  tag: string;
  text: string;
  children: TestNode[];
  parent: TestNode | null;
}

const testNode = (tag: string, text = ""): TestNode => ({ tag, text, children: [], parent: null });

function detach(child: TestNode): void {
  const parent = child.parent;
  if (!parent) return;
  parent.children.splice(parent.children.indexOf(child), 1);
  child.parent = null;
}

/** A tag this "DOM" cannot create, as a custom element whose constructor throws would be. */
const UNCREATABLE = "broken-element";

const { createApp } = createRenderer<TestNode, TestNode>({
  createElement: (tag) => {
    if (tag === UNCREATABLE) throw new Error("element constructor threw");
    return testNode(tag);
  },
  createText: (text) => testNode("#text", text),
  createComment: (text) => testNode("#comment", text),
  insert: (child, parent, anchor) => {
    detach(child);
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, child);
    child.parent = parent;
  },
  remove: detach,
  setText: (node, text) => {
    node.text = text;
  },
  setElementText: (element, text) => {
    for (const child of element.children) child.parent = null;
    element.children = [];
    if (text) {
      const child = testNode("#text", text);
      child.parent = element;
      element.children.push(child);
    }
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    const parent = node.parent;
    return parent ? parent.children[parent.children.indexOf(node) + 1] ?? null : null;
  },
  patchProp: () => {},
});

/** What a tree shows: its elements and text, without the comments Vue leaves as placeholders. */
function shown(node: TestNode): string {
  if (node.tag === "#text") return node.text;
  if (node.tag === "#comment") return "";
  const inner = node.children.map(shown).join("");
  return node.tag === "root" ? inner : `<${node.tag}>${inner}</${node.tag}>`;
}

const draws = (tag: string, text: string): Component => defineComponent({ setup: () => () => h(tag, text) });

/** A component that counts its mounts and unmounts. */
function counted() {
  const mounts = vi.fn();
  const unmounts = vi.fn();
  const component = defineComponent({
    setup() {
      onMounted(mounts);
      onUnmounted(unmounts);
      return () => null;
    },
  });
  return { component, mounts, unmounts };
}

/**
 * A stand-in for App.vue: some chrome, the host, the page. It notes every error that reaches it.
 * The app gets no `config.errorHandler`, so an error nobody captures is rethrown by Vue's
 * development build — as it would tear down the real shell's render.
 */
function shellWith(components: WebExtensionShellComponent[], page: Ref<string> = ref("page"), session: Ref<string> = ref("alice")) {
  const reachedShell: unknown[] = [];
  const Shell = defineComponent({
    setup() {
      onErrorCaptured((error) => {
        reachedShell.push(error);
      });
      return () => [h("header", "shell"), h(ExtensionShellHost, { components, session: session.value }), h("main", page.value)];
    },
  });
  return { Shell, reachedShell, page, session };
}

/** Mounts the shell, then lets the host mount the components (one tick after the shell). */
async function mount(components: WebExtensionShellComponent[], page?: Ref<string>, session?: Ref<string>) {
  const shell = shellWith(components, page, session);
  const app = createApp(shell.Shell);
  const root = testNode("root");
  app.mount(root);
  await nextTick();
  return { ...shell, app, root };
}

/** Lets a rejected async-component load settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  // Vue warns about the component left without a render after its setup threw.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Whether an error was logged naming `extension`. */
function loggedFor(extension: string): boolean {
  return consoleError.mock.calls.some(([message]) => String(message).startsWith(`[extensions] ${extension}: `));
}

describe("ExtensionShellHost", () => {
  it("mounts every extension's components inside the shell, in order, with no element of its own", async () => {
    const watcher = defineComponent({ setup: () => () => null });
    const { root } = await mount([
      { extension: "alpha", component: draws("span", "a") },
      { extension: "alpha", component: watcher },
      { extension: "beta", component: draws("aside", "b") },
    ]);
    expect(shown(root)).toBe("<header>shell</header><span>a</span><aside>b</aside><main>page</main>");
  });

  it("draws nothing when no extension contributes a component", async () => {
    const { root } = await mount([]);
    expect(shown(root)).toBe("<header>shell</header><main>page</main>");
  });

  it("keeps the components mounted while the page changes, and unmounts them with the shell", async () => {
    const { component, mounts, unmounts } = counted();
    const { app, root, page } = await mount([{ extension: "alpha", component }]);
    page.value = "another page";
    await nextTick();
    expect(shown(root)).toBe("<header>shell</header><main>another page</main>");
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();

    app.unmount();
    expect(unmounts).toHaveBeenCalledTimes(1);
  });

  it("mounts the components afresh at sign-out, sign-in and a switch of user, with nothing left over", async () => {
    const { component, mounts, unmounts } = counted();
    const alerts = ref<string[]>([]);
    const banner = defineComponent({
      setup() {
        // State of the session it was mounted in: what a real alert banner would hold.
        const shownAlerts = [...alerts.value];
        return () => h("aside", shownAlerts.join(","));
      },
    });
    alerts.value = ["alert for alice"];
    const session = ref("alice");
    const { root } = await mount(
      [
        { extension: "alpha", component },
        { extension: "beta", component: banner },
      ],
      undefined,
      session,
    );
    expect(shown(root)).toBe("<header>shell</header><aside>alert for alice</aside><main>page</main>");
    alerts.value = [];

    session.value = ""; // signed out
    await nextTick();
    await nextTick();
    expect(unmounts).toHaveBeenCalledTimes(1);
    expect(mounts).toHaveBeenCalledTimes(2);
    expect(shown(root)).toBe("<header>shell</header><aside></aside><main>page</main>");

    session.value = "bob"; // the next user signed in
    await nextTick();
    await nextTick();
    expect(unmounts).toHaveBeenCalledTimes(2);
    expect(mounts).toHaveBeenCalledTimes(3);
  });

  it("logs an error thrown in a component's setup or render, and keeps it from the shell and the others", async () => {
    const failsInSetup = defineComponent({
      setup() {
        throw new Error("setup failed");
      },
    });
    const failsInRender = defineComponent({
      setup: () => () => {
        throw new Error("render failed");
      },
    });
    const { root, reachedShell } = await mount([
      { extension: "alpha", component: failsInSetup },
      { extension: "beta", component: failsInRender },
      { extension: "gamma", component: draws("span", "still here") },
    ]);
    expect(shown(root)).toBe("<header>shell</header><span>still here</span><main>page</main>");
    expect(reachedShell).toEqual([]);
    expect(loggedFor("alpha")).toBe(true);
    expect(loggedFor("beta")).toBe(true);
    expect(loggedFor("gamma")).toBe(false);
  });

  it("keeps an error in the DOM step of a component's first mount from aborting the shell's mount", async () => {
    const shell = shellWith([
      { extension: "alpha", component: draws(UNCREATABLE, "never drawn") },
      { extension: "beta", component: draws("span", "still here") },
    ]);
    const root = testNode("root");
    expect(() => createApp(shell.Shell).mount(root)).not.toThrow();
    await nextTick();
    expect(shown(root)).toBe("<header>shell</header><span>still here</span><main>page</main>");
    expect(shell.reachedShell).toEqual([]);
    expect(loggedFor("alpha")).toBe(true);
    expect(loggedFor("beta")).toBe(false);
  });

  it("keeps a component mounted after its watcher failed once, and it keeps watching", async () => {
    const source = ref(0);
    const seen: number[] = [];
    const watcher = defineComponent({
      setup() {
        watch(source, (value) => {
          if (value === 1) throw new Error("one bad poll");
          seen.push(value);
        });
        return () => h("span", "watching");
      },
    });
    const { root, reachedShell } = await mount([{ extension: "alpha", component: watcher }]);

    source.value = 1;
    await nextTick();
    source.value = 2;
    await nextTick();

    expect(seen).toEqual([2]);
    expect(shown(root)).toBe("<header>shell</header><span>watching</span><main>page</main>");
    expect(reachedShell).toEqual([]);
    expect(loggedFor("alpha")).toBe(true);
  });

  it("logs a failed load of an async component and keeps it from the shell", async () => {
    const neverLoads = defineAsyncComponent(() => Promise.reject(new Error("chunk failed to load")));
    const { root, reachedShell } = await mount([
      { extension: "alpha", component: neverLoads },
      { extension: "beta", component: draws("span", "loaded") },
    ]);
    await settle();
    expect(shown(root)).toBe("<header>shell</header><span>loaded</span><main>page</main>");
    expect(reachedShell).toEqual([]);
    expect(loggedFor("alpha")).toBe(true);
  });

  it("lets an async component that retries, as the README shows, recover from a failed load", async () => {
    let attemptsMade = 0;
    const loader = () => {
      attemptsMade += 1;
      return attemptsMade === 1 ? Promise.reject(new Error("chunk failed to load")) : Promise.resolve(draws("aside", "loaded"));
    };
    const retrying = defineAsyncComponent({
      loader,
      onError: (_error, retry, fail, attempts) => (attempts <= 3 ? setTimeout(retry, 0) : fail()),
    });
    const { root, reachedShell } = await mount([{ extension: "alpha", component: retrying }]);
    await settle();
    await settle();
    expect(attemptsMade).toBe(2);
    expect(shown(root)).toBe("<header>shell</header><aside>loaded</aside><main>page</main>");
    expect(reachedShell).toEqual([]);
    expect(loggedFor("alpha")).toBe(false);
  });

  it("renders on the server without them, leaving them to the client", async () => {
    const failsInSetup = defineComponent({
      setup() {
        throw new Error("setup failed");
      },
    });
    const { Shell, reachedShell } = shellWith([
      { extension: "alpha", component: failsInSetup },
      { extension: "beta", component: draws("span", "b") },
    ]);
    const html = (await renderToString(createSSRApp(Shell))).replace(/<!--.*?-->/g, "");
    expect(html).toBe("<header>shell</header><main>page</main>");
    expect(reachedShell).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

/** The value of the `v-if` on the first `<tag …>` in App.vue's template, split at `&&`. */
function guardsOf(tag: string): string[] {
  const element = new RegExp(`<${tag}\\b([^>]*)>`).exec(appSource);
  if (!element) throw new Error(`App.vue has no <${tag}>`);
  const condition = /\bv-if="([^"]*)"/.exec(element[1] ?? "")?.[1];
  return condition ? condition.split("&&").map((term) => term.trim()) : [];
}

describe("App.vue", () => {
  it("draws the host once", () => {
    expect(appSource.match(/<ExtensionShellHost\b/g)).toHaveLength(1);
  });

  // The host is part of the shell: a page App.vue draws without the rest of its shell must not get
  // the extensions' components either (a kiosk or a patient-facing screen must not show staff
  // alerts). The operator dock is the shell's own app-wide part, so the host carries every guard the
  // dock does, except the dock's connection condition: the host mounts whether or not the gateway
  // is connected.
  it("guards the host like the rest of the shell", () => {
    const required = guardsOf("OperatorRequestsDock").filter((term) => term !== "gateway.connected");
    expect(guardsOf("ExtensionShellHost")).toEqual(expect.arrayContaining(required));
  });
});
