import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * gatewayRestBaseUrl() is the one derivation of the REST base from the socket URL. LoginModal and
 * 25 pages and stores used to carry their own `wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "")`,
 * which breaks on a query string, a hash or a trailing slash (`wss://host/ws?x=1` became
 * `https://host/ws?x=1/api/...`). No test mounts those pages or LoginModal, so this scan is what
 * keeps such a copy from coming back, in an existing file or a new one.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The module that owns the derivation, relative to src/ with forward slashes. */
const OWNER = "composables/gatewayUrl.ts";

const HAND_ROLLED: Array<{ what: string; pattern: RegExp }> = [
  { what: "a regex replace anchored on the ws scheme", pattern: /\.replace(?:All)?\(\s*\/\^wss?/g },
  { what: "a regex that strips a trailing /ws", pattern: /\\\/ws\$\//g },
  { what: "a string replace of the ws scheme", pattern: /\.replace(?:All)?\(\s*(["'`])wss?(?::|:\/\/)?\1/g },
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") files.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx|vue)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(relative(SRC, path).split(sep).join("/"));
    }
  }
  return files;
}

function handRolledDerivations(source: string): string[] {
  const hits: string[] = [];
  for (const { what, pattern } of HAND_ROLLED) {
    for (const match of source.matchAll(pattern)) {
      hits.push(`line ${source.slice(0, match.index).split("\n").length}: ${what}`);
    }
  }
  return hits;
}

describe("REST base call sites", () => {
  const files = sourceFiles(SRC);

  it("scans the whole web source tree", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toEqual(expect.arrayContaining([OWNER, "components/LoginModal.vue", "pages/Jobs.vue", "pages/Settings.vue", "stores/auth.ts", "stores/gateway.ts"]));
  });

  // Labelled cases: vitest would read the `$1` in a source string as a placeholder in the title.
  it.each([
    ["the plain regex copy", 'gateway.wsUrl.replace(/^ws/, "http").replace(/\\/ws$/, "")', 2],
    ["the wss-aware regex copy with a fallback URL", '(gateway.wsUrl ?? "ws://localhost:8765/ws").replace(/^ws(s?)/, "http$1").replace(/\\/ws$/, "")', 2],
    ["a regex replace split over two lines", "value\n  .replace(/^wss?/, 'http')", 1],
    ["a string replace of the bare scheme", 'url.replace("ws", "http")', 1],
    ["a string replace of the scheme with slashes", "url.replace('wss://', 'https://')", 1],
    ["a replaceAll of the scheme with a colon", "url.replaceAll(`ws:`, `http:`)", 1],
  ])("recognises %s", (_label, source, count) => {
    expect(handRolledDerivations(source)).toHaveLength(count);
  });

  it.each([
    ["a call of the shared helper", "gatewayRestBaseUrl(gateway.wsUrl)"],
    ["an API path that starts with ws", "`${gatewayRestBaseUrl(gateway.wsUrl)}/api/ws-sessions`"],
    ["the opposite direction (http to ws)", 'httpUrl.replace(/^http/, "ws")'],
    ["a string replace of a longer word", 'label.replace("wsUrl", "url")'],
  ])("leaves %s alone", (_label, source) => {
    expect(handRolledDerivations(source)).toEqual([]);
  });

  it(`finds no hand-rolled REST base outside ${OWNER}; use gatewayRestBaseUrl() from @/stores/gateway`, () => {
    const offenders = files
      .filter((file) => file !== OWNER)
      .flatMap((file) => handRolledDerivations(readFileSync(join(SRC, file), "utf8")).map((hit) => `${file} ${hit}`));
    expect(offenders).toEqual([]);
  });
});
