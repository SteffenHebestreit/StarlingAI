import { describe, it, expect } from "vitest";
import {
  buildUngroundedClaimJudgeMessages,
  parseUngroundedClaimVerdict,
  UNGROUNDED_JUDGE_MIN_CHARS,
} from "../agent/ungrounded-claim-judge.js";

describe("buildUngroundedClaimJudgeMessages", () => {
  it("puts the question and draft in the user turn and asks for a one-line VERDICT", () => {
    const msgs = buildUngroundedClaimJudgeMessages("wie funktioniert das Pfand-System in Dänemark", "Das System läuft über FDB …");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[0]!.content).toMatch(/VERDICT: yes/);
    expect(msgs[0]!.content).toMatch(/VERDICT: no/);
    // The judge must know the draft ran WITHOUT retrieval — that is the whole premise.
    expect(String(msgs[0]!.content).toLowerCase()).toContain("without any web search");
    expect(msgs[1]!.content).toContain("wie funktioniert das Pfand-System in Dänemark");
    expect(msgs[1]!.content).toContain("Das System läuft über FDB");
  });

  it("carries no topic/language keyword table — same prompt shape regardless of subject", () => {
    const a = buildUngroundedClaimJudgeMessages("q1", "draft one");
    const b = buildUngroundedClaimJudgeMessages("q2", "draft two");
    expect(a[0]!.content).toBe(b[0]!.content); // system prompt is subject-independent
  });

  it("clips an oversized draft so the routing-tier prompt stays cheap", () => {
    const huge = "x".repeat(10_000);
    const msgs = buildUngroundedClaimJudgeMessages("q", huge);
    expect(msgs[1]!.content).toContain("…[truncated]");
    expect(String(msgs[1]!.content).length).toBeLessThan(6_000);
  });
});

describe("parseUngroundedClaimVerdict — fail-safe toward NOT triggering", () => {
  it("returns true only on an explicit affirmative verdict", () => {
    expect(parseUngroundedClaimVerdict("VERDICT: yes")).toBe(true);
    expect(parseUngroundedClaimVerdict("verdict:YES")).toBe(true);
    expect(parseUngroundedClaimVerdict("Reasoning …\nVERDICT: yes")).toBe(true);
  });

  it("returns false on a negative verdict", () => {
    expect(parseUngroundedClaimVerdict("VERDICT: no")).toBe(false);
    expect(parseUngroundedClaimVerdict("VERDICT:NO")).toBe(false);
  });

  it("returns false on a missing/garbled marker or empty reply (no over-trigger on parse miss)", () => {
    expect(parseUngroundedClaimVerdict("")).toBe(false);
    expect(parseUngroundedClaimVerdict("I think this answer looks mostly fine to me honestly")).toBe(false);
    expect(parseUngroundedClaimVerdict("maybe?")).toBe(false);
  });

  it("honors a terse bare 'yes' but not a long unlabeled affirmation", () => {
    expect(parseUngroundedClaimVerdict("yes")).toBe(true);
    expect(parseUngroundedClaimVerdict("ja")).toBe(true);
    expect(parseUngroundedClaimVerdict("yes, this asserts several external facts about the operator")).toBe(false); // no marker, too long
  });
});

// End-to-end shape with an injected fake model: the judge messages carry the draft, so a model that
// keys on the draft content produces the expected verdict. This is the same seam runtime.ts uses
// (build messages → provider.complete → parse), without pulling in the full runtime.
describe("judge round-trip with an injected model", () => {
  const fakeModel = (draftAssertsSpecifics: (draft: string) => boolean) =>
    async (msgs: ReturnType<typeof buildUngroundedClaimJudgeMessages>) => {
      const draft = msgs[1]!.content ?? "";
      return `VERDICT: ${draftAssertsSpecifics(draft) ? "yes" : "no"}`;
    };

  it("triggers on a prose named-entity fabrication that carries NO numbers", async () => {
    // The exact shape the structural counter misses: a specific wrong operator, zero fact-shape tokens.
    const draft = "Das dänische Pfandsystem wird zentral über die Genossenschaft FDB und den Anbieter "
      + "Returpant betrieben, und jeder Händler ist gesetzlich verpflichtet, die Flaschen zurückzunehmen.";
    const complete = fakeModel((d) => /Returpant|FDB/.test(d));
    const verdict = parseUngroundedClaimVerdict(await complete(buildUngroundedClaimJudgeMessages("Pfand DK?", draft)));
    expect(verdict).toBe(true);
    expect(draft.length).toBeLessThan(UNGROUNDED_JUDGE_MIN_CHARS); // fixture is short; runtime floor is separate
  });

  it("does NOT trigger on a general-knowledge / reasoning answer", async () => {
    const draft = "A hash map stores key-value pairs and offers average constant-time lookup by hashing the "
      + "key into a bucket index; collisions are handled by chaining or open addressing.";
    const complete = fakeModel(() => false);
    const verdict = parseUngroundedClaimVerdict(await complete(buildUngroundedClaimJudgeMessages("how does a hash map work?", draft)));
    expect(verdict).toBe(false);
  });
});
