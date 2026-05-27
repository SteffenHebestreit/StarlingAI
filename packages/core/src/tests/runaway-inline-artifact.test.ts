import { describe, expect, it } from "vitest";
import { looksLikeRunawayInlineArtifact } from "../agent/runtime.js";

const FENCE = "```";

function bodyOf(lang: string, body: string, closed = true): string {
  return `${FENCE}${lang}\n${body}${closed ? `\n${FENCE}\n` : ""}`;
}

describe("looksLikeRunawayInlineArtifact", () => {
  it("flags a large closed html fence", () => {
    const huge = "<div>x</div>\n".repeat(500); // ~6.5 KB
    const content = `Hier ist die Datei:\n${bodyOf("html", huge)}`;
    expect(looksLikeRunawayInlineArtifact(content)).toBe(true);
  });

  it("flags a huge javascript fence", () => {
    const huge = "console.log('test');\n".repeat(300); // ~6 KB
    expect(looksLikeRunawayInlineArtifact(bodyOf("javascript", huge))).toBe(true);
  });

  it("flags a fence that hit the token cap mid-body (unclosed)", () => {
    const huge = "<style>body { padding: 20px; }</style>\n".repeat(200); // ~7.5 KB
    expect(looksLikeRunawayInlineArtifact(bodyOf("html", huge, false))).toBe(true);
  });

  it("does NOT flag a small html snippet in a tutorial answer", () => {
    const small = "<button>Click</button>\n<input type='text'>";
    expect(looksLikeRunawayInlineArtifact(`Here's an example:\n${bodyOf("html", small)}`)).toBe(false);
  });

  it("does NOT flag long prose without code fences", () => {
    const longProse = "Architektur ist abstrakt. ".repeat(500); // ~13 KB
    expect(looksLikeRunawayInlineArtifact(longProse)).toBe(false);
  });

  it("does NOT flag a json fence (configuration / data dump is legitimate)", () => {
    const huge = JSON.stringify({ items: Array(500).fill({ k: "v" }) }, null, 2);
    expect(looksLikeRunawayInlineArtifact(bodyOf("json", huge))).toBe(false);
  });

  it("does NOT flag a shell-script fence (CLI examples are legitimate)", () => {
    const huge = "echo \"hello\"\n".repeat(800);
    expect(looksLikeRunawayInlineArtifact(bodyOf("bash", huge))).toBe(false);
  });

  it("does NOT flag content under the 5KB body threshold", () => {
    const just4k = "<p>x</p>\n".repeat(400); // ~3.6 KB
    expect(looksLikeRunawayInlineArtifact(bodyOf("html", just4k))).toBe(false);
  });

  it("flags vue/svelte SFC dumps (same pattern as html)", () => {
    const hugeVue = "<template><div>{{ x }}</div></template>\n".repeat(150);
    expect(looksLikeRunawayInlineArtifact(bodyOf("vue", hugeVue))).toBe(true);
  });

  it("flags content with multiple small fences whose total stays small", () => {
    // Two 2 KB html fences — each under threshold individually, total < 5 KB.
    // Not a runaway. This guards against a too-aggressive heuristic.
    const small = "<div>x</div>\n".repeat(150); // ~2 KB
    const content = `Block A:\n${bodyOf("html", small)}\nBlock B:\n${bodyOf("html", small)}`;
    expect(looksLikeRunawayInlineArtifact(content)).toBe(false);
  });
});
