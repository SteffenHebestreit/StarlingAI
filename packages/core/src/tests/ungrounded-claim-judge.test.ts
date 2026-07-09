import { describe, it, expect } from "vitest";
import {
  buildUngroundedClaimJudgeMessages,
  buildSourceSensitiveQuestionJudgeMessages,
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

  it("weighs the SUBJECT (concept in principle vs specific real-world scheme), not the phrasing", () => {
    const content = String(buildUngroundedClaimJudgeMessages("q", "d")[0]!.content).toLowerCase();
    expect(content).toContain("judge the subject");
    expect(content).toContain("in principle");        // concept side → no
    expect(content).toContain("specific real-world");  // real-world scheme side → yes
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
    expect(parseUngroundedClaimVerdict("I think this answer looks mostly fine to me honestly")).toBe(false); // no yes/no token
    expect(parseUngroundedClaimVerdict("maybe?")).toBe(false);
  });

  it("honors a bare OR trailing yes/no even without the VERDICT label (verbose small-model replies)", () => {
    expect(parseUngroundedClaimVerdict("yes")).toBe(true);
    expect(parseUngroundedClaimVerdict("ja")).toBe(true);
    // A small routing model that drops the label but concludes with yes/no is honored via the LAST
    // token (models conclude at the end) — this is the reliability fix so the up-front classifier does
    // not silently fail to NO on a verbose reply (audit 0b86d025: it never engaged).
    expect(parseUngroundedClaimVerdict("This names a specific operator and prices, so yes")).toBe(true);
    expect(parseUngroundedClaimVerdict("This is general knowledge, so no")).toBe(false);
    expect(parseUngroundedClaimVerdict("There are no official sources cited, but it asserts an operator, therefore yes")).toBe(true);
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

// The UP-FRONT classifier reads the QUESTION (no draft) so the runtime can force research BEFORE the
// model drafts — fixing the "answer, then research" ordering (audit a75e1c26 follow-up).
describe("buildSourceSensitiveQuestionJudgeMessages", () => {
  it("classifies the question (no draft) and asks for a one-line VERDICT", () => {
    const msgs = buildSourceSensitiveQuestionJudgeMessages("Wie funktioniert das Pfandsystem in Dänemark?");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toBe("Wie funktioniert das Pfandsystem in Dänemark?"); // question only, no draft
    expect(msgs[0]!.content).toMatch(/VERDICT: yes/);
    expect(msgs[0]!.content).toMatch(/VERDICT: no/);
    expect(String(msgs[0]!.content).toLowerCase()).toContain("before any answer is written");
  });

  it("is subject-independent (no topic keyword table)", () => {
    const a = buildSourceSensitiveQuestionJudgeMessages("q1");
    const b = buildSourceSensitiveQuestionJudgeMessages("q2");
    expect(a[0]!.content).toBe(b[0]!.content);
  });

  // Regression (audit c88851e8): the classifier returned upfront_source_sensitive_clear on
  // "wie funktioniert das pfand-system in dänemark?" — a false negative from the blanket "unsure → no"
  // treating a named country's scheme like a general "how does X work" concept. The prompt must now
  // discriminate on the SUBJECT (specific real-world scheme → yes; general concept → no), semantically,
  // with NO topic keyword table.
  it("discriminates the SUBJECT (specific real-world scheme vs general concept), not the phrasing", () => {
    const content = String(buildSourceSensitiveQuestionJudgeMessages("q")[0]!.content).toLowerCase();
    expect(content).toContain("judge the subject");
    expect(content).toContain("particular real thing"); // the 'yes' side: a named real scheme/institution
    expect(content).toContain("in principle");          // the 'no' side: a general concept
    // No topic/keyword table for the repro itself.
    expect(content).not.toContain("pfand");
    expect(content).not.toContain("denmark");
    expect(content).not.toContain("deposit");
  });

  it("round-trips: a model keying on 'how a specific real system works' says yes; a creative task says no", async () => {
    const model = (assertsSourceSensitive: (q: string) => boolean) =>
      (q: string) => `VERDICT: ${assertsSourceSensitive(q) ? "yes" : "no"}`;
    const srcSensitive = model((q) => /pfand|deposit|system/i.test(q));
    const creative = model(() => false);
    expect(parseUngroundedClaimVerdict(srcSensitive(String(buildSourceSensitiveQuestionJudgeMessages("how does the deposit system work?")[1]!.content)))).toBe(true);
    expect(parseUngroundedClaimVerdict(creative(String(buildSourceSensitiveQuestionJudgeMessages("write me a short poem")[1]!.content)))).toBe(false);
  });
});
