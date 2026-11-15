/**
 * Collecting the extensions' shell components (`shellComponents` in registry.ts) for the app shell.
 *
 * Kept apart from registry.ts on purpose: registry.ts discovers the extensions with an eager
 * `import.meta.glob`, so importing it at runtime loads every extension and everything each one
 * imports. This module has no side effects, so a test can import it without loading a fork's
 * extensions (whose `.vue` files the web package's node-environment tests cannot compile).
 */
import type { Component } from "vue";
import type { WebExtension } from "./registry";

/** One extension shell component, with the extension it came from. */
export interface WebExtensionShellComponent {
  /** The contributing extension's `name`. */
  extension: string;
  component: Component;
}

/**
 * The shell components of `extensions`, in their order and each extension's own order, each named
 * with its extension.
 */
export function collectShellComponents(
  extensions: readonly Pick<WebExtension, "name" | "shellComponents">[],
): WebExtensionShellComponent[] {
  return extensions.flatMap((ext) => (ext.shellComponents ?? []).map((component) => ({ extension: ext.name, component })));
}
