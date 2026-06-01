import { describe, expect, it } from "vitest";
import { looksLikeRawToolEvidenceDump } from "../agent/runtime.js";

/**
 * Last-resort terminal guard (audit 003f5aeb). When the "create a verified reveal.js
 * presentation about Dresden" turn researched successfully but the artifact-build step
 * timed out, the failure-path evidence backstop shipped the raw web_fetch dump verbatim:
 * a search-results block stitched to the Dresden_Castle Wikipedia nav menu ("Jump to
 * content Main menu move to sidebar … Create account Log in"). looksLikeRawToolEvidenceDump
 * flags that shape so the runtime swaps it for the curated, sourced findings under an
 * honest could-not-finish message instead of dumping scraped chrome on the user.
 * Structural detection only — topic- and site-agnostic.
 */
describe("terminal junk guard — looksLikeRawToolEvidenceDump", () => {
  const navDump =
    "Web Search Results for: \"Dresden Zwinger architecture\" (via searxng) "
    + "Dresden Castle: the lavish palace of the Saxon royals - Barcelo https://www.barcelo.com/guia-turismo/dresden-castle "
    + "Content from: https://en.wikipedia.org/wiki/Dresden_Castle Dresden Castle - Wikipedia "
    + "Jump to content Main menu Main menu move to sidebar hide Navigation Main page Contents "
    + "Current events Random article About Wikipedia Contact us Search Search Appearance Donate "
    + "Create account Log in Personal tools Donate Create account Log in Contents move to sidebar hide";

  it("flags a raw search-results + scraped-chrome dump", () => {
    expect(looksLikeRawToolEvidenceDump(navDump)).toBe(true);
  });

  it("flags a recovered-evidence scaffolding dump", () => {
    const recovered =
      "Recovered evidence snippets (partial progress before interruption): "
      + "web_fetch: Content from: https://example.com/spec Skip to content Main menu move to sidebar "
      + "Home Products Support About Contact Cookie settings Privacy policy Newsletter subscribe Log in";
    expect(looksLikeRawToolEvidenceDump(recovered)).toBe(true);
  });

  it("does NOT flag a genuine synthesized answer that cites one URL", () => {
    const real =
      "Der Dresdner Zwinger ist ein barockes Bauensemble, erbaut zwischen 1709 und 1728 nach Plänen von "
      + "Matthäus Daniel Pöppelmann. Er gilt als bedeutendes Werk des Spätbarock. Eine ausführliche Darstellung "
      + "findet sich unter https://en.wikipedia.org/wiki/Zwinger mit weiteren Belegen zur Baugeschichte.";
    expect(looksLikeRawToolEvidenceDump(real)).toBe(false);
  });

  it("does NOT flag a short message that happens to mention one marker", () => {
    expect(looksLikeRawToolEvidenceDump("I couldn't log in to the portal — please check the credentials.")).toBe(false);
  });

  it("requires two distinct structural markers (one alone is not enough)", () => {
    const onlySearch =
      "Web Search Results for: \"reveal.js theme\" returned several relevant pages about presentation "
      + "frameworks, theming options, and CDN usage, none of which contained any navigation boilerplate at all.";
    expect(looksLikeRawToolEvidenceDump(onlySearch)).toBe(false);
  });
});
