import { describe, expect, it } from "vitest";
import {
  UNOBSERVED_FIGURE_MARKER,
  addArgumentFigureKeys,
  addFigureKeys,
  countUnobservedFigures,
  figureKey,
  maskUnobservedFigures,
  verbatimQuotedCodeSpans,
  verbatimQuotedCommandSpans,
} from "../agent/figure-provenance.js";
import { INCIDENT, INVENTED_FIGURES } from "./support/figure-provenance-incident.js";

/**
 * WHICH FIGURES IN A RUN'S ANSWER SOME INPUT OF THE RUN CONTAINED (E2E 2026-10-07).
 *
 * The coder's seven sandbox runs failed or printed nothing, and its answer gave "8.393" primes
 * summing to "7.597.648.268". A figure is compared by its digits alone, so the grouping a locale
 * writes and the plain form a program prints are one key; an identifier's digits are not a figure.
 */
describe("figure keys", () => {
  it("are the digits alone, whatever grouping the locale writes", () => {
    const key = figureKey("8393");
    expect(key).toBe("8393");
    for (const written of ["8.393", "8,393", "8\u202f393", "8\u00a0393", "8'393", "8\u2019393"]) {
      expect(figureKey(written)).toBe(key);
    }
    // Leading zeros go, and a digit of another script counts by its value.
    expect(figureKey("007")).toBe("7");
    expect(figureKey("\u0668\u0663\u0669\u0663")).toBe(key);
    expect(figureKey("\uff18\uff13\uff19\uff13")).toBe(key);
  });

  it("an identifier's digits and one-digit numbers are not figures", () => {
    const keys = new Set<string>();
    addFigureKeys(keys, "node v18 on x86_64, target ES2020, user eval-1bbd174404efbce9");
    expect([...keys]).toEqual([]);
    addFigureKeys(keys, "step 1 of 3, then 7");
    expect([...keys]).toEqual([]);
    expect(maskUnobservedFigures("v18 x86_64 ES2020 eval-1bbd174404efbce9, step 3", new Set())).toEqual({
      text: "v18 x86_64 ES2020 eval-1bbd174404efbce9, step 3",
      masked: 0,
    });
  });
});

describe("the figures a run's own calls state", () => {
  it("are read from the arguments value by value, at any depth, numbers included", () => {
    const args = { path: "results.md", content: "Anzahl:\n8393", rows: [[1255204276, "Summe"]], limit: 7 };
    const keys = new Set<string>();
    addArgumentFigureKeys(keys, args);
    expect([...keys].sort()).toEqual(["1255204276", "8393"]);
    // The call's JSON glues the escape's letter to the figure behind it.
    const fromJson = new Set<string>();
    addFigureKeys(fromJson, JSON.stringify(args));
    expect(fromJson.has("8393")).toBe(false);
  });

  it("a key the caller excludes is not added", () => {
    const keys = new Set<string>();
    addFigureKeys(keys, "Anzahl 8.393, Lauf 4711", new Set(["8393"]));
    expect([...keys]).toEqual(["4711"]);
  });
});

describe("code an answer quotes verbatim", () => {
  // The incident's script: LIMIT = 200001 is the coder's own choice, in no input of the run.
  const SCRIPT = String(INCIDENT.calls[0]!.args["content"]);

  it("whole lines of a source in a closed fence are read past; the prose around them is not", () => {
    const answer = "So sieht es aus:\n```js\nconst LIMIT = 200001;\nconst sieve = new Uint8Array(LIMIT);\n```\nEs gibt 8393 Primzahlen.";
    const spans = verbatimQuotedCodeSpans(answer, [SCRIPT]);

    expect(spans).toHaveLength(1);
    expect(maskUnobservedFigures(answer, new Set(), spans)).toEqual({
      text: "So sieht es aus:\n```js\nconst LIMIT = 200001;\nconst sieve = new Uint8Array(LIMIT);\n```\nEs gibt [not observed] Primzahlen.",
      masked: 1,
    });
    expect(countUnobservedFigures(answer, new Set(), spans)).toBe(1);
  });

  it("line endings, trailing whitespace and the fence's own indent do not matter", () => {
    expect(verbatimQuotedCodeSpans("  ~~~\r\n  const LIMIT = 200001;   \r\n  ~~~\r\nfertig", [SCRIPT])).toHaveLength(1);
  });

  it("a changed line, part of a line, an open fence or no source is no quote", () => {
    for (const body of ["const LIMIT = 200002;", "LIMIT = 200001;", "200001"]) {
      expect(verbatimQuotedCodeSpans(`\`\`\`\n${body}\n\`\`\``, [SCRIPT])).toEqual([]);
    }
    expect(verbatimQuotedCodeSpans("```\nconst LIMIT = 200001;\n", [SCRIPT])).toEqual([]);
    expect(verbatimQuotedCodeSpans("```\nconst LIMIT = 200001;\n```", [])).toEqual([]);
  });
});

describe("a command an answer quotes whole", () => {
  const LISTING = "ls /usr/bin/ | head -50";
  const HEREDOC = "cat > results.md <<'X'\nAnzahl der Primzahlen: 8393\nSumme: 7597648268\nX";

  it("inline, it is read past; the prose around it is not", () => {
    const answer = `\`${LISTING}\` gab nichts aus; es gibt 8393 Primzahlen.`;
    const spans = verbatimQuotedCommandSpans(answer, [LISTING]);

    expect(spans).toHaveLength(1);
    expect(maskUnobservedFigures(answer, new Set(), spans)).toEqual({
      text: `\`${LISTING}\` gab nichts aus; es gibt [not observed] Primzahlen.`,
      masked: 1,
    });
  });

  it("in a closed fence, it is read past", () => {
    const answer = `Ausgeführt:\n\`\`\`sh\n${HEREDOC}\n\`\`\`\nfertig`;
    expect(maskUnobservedFigures(answer, new Set(), verbatimQuotedCommandSpans(answer, [HEREDOC])).masked).toBe(0);
  });

  it("part of a command, inline, or some of its lines in a fence, is no quote", () => {
    expect(verbatimQuotedCommandSpans("`head -50` gab nichts aus", [LISTING])).toEqual([]);
    expect(verbatimQuotedCommandSpans("```\nAnzahl der Primzahlen: 8393\nSumme: 7597648268\n```", [HEREDOC])).toEqual([]);
    expect(verbatimQuotedCommandSpans(`\`${LISTING}\``, [])).toEqual([]);
  });
});

describe("masking the figures no input of the run contained", () => {
  // What the coder's run received: the task and every tool result as the model read it. Not what
  // it wrote: the script and the commands are its own claims, and "200001" in them proves nothing.
  const corpus = new Set<string>();
  addFigureKeys(corpus, INCIDENT.task);
  for (const call of INCIDENT.calls) {
    addFigureKeys(corpus, call.result.success ? call.result.output : `Error: ${call.result.error}`);
  }

  it("masks exactly the two invented figures of the recorded reply and keeps the task's", () => {
    expect(INCIDENT.reply).toHaveLength(1016);
    const { text, masked } = maskUnobservedFigures(INCIDENT.reply, corpus);
    expect(masked).toBe(2);
    expect(countUnobservedFigures(INCIDENT.reply, corpus)).toBe(2);
    for (const figure of INVENTED_FIGURES) expect(text).not.toContain(figure);
    expect(text.split(UNOBSERVED_FIGURE_MARKER)).toHaveLength(3);
    // 100000 ≤ p ≤ 200000 is in the delegated task, however the reply groups it.
    expect(text).toContain("100.000");
    expect(text).toContain("200.000");
    expect(text).toContain("[100000, 200000]");
  });

  it("masking twice changes nothing: the marker holds no digit", () => {
    const once = maskUnobservedFigures(INCIDENT.reply, corpus).text;
    expect(maskUnobservedFigures(once, corpus)).toEqual({ text: once, masked: 0 });
    expect(countUnobservedFigures(once, corpus)).toBe(0);
  });

  it("leaves a figure some input contained, in any grouping", () => {
    const seen = new Set<string>();
    addFigureKeys(seen, "Anzahl der Primzahlen: 8392\nSumme der Primzahlen:   1255204276");
    const answer = "Es sind 8.392 Primzahlen, ihre Summe ist 1.255.204.276.";
    expect(maskUnobservedFigures(answer, seen)).toEqual({ text: answer, masked: 0 });
  });
});
