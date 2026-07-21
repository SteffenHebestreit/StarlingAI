import { describe, it, expect } from "vitest";
import { GmailQueryParser } from "../query-parser.js";

/**
 * Round 7 (July 2026 review): the AND-merge dropped all-but-first same-key criterion
 * (wrong emails returned), and Gmail relative dates parsed to Invalid Date.
 */
describe("GmailQueryParser AND-merge (MAIL-1)", () => {
  it("ANDs two body terms via De Morgan instead of dropping the second", () => {
    const q = GmailQueryParser.parse("invoice payment").imapQueries[0]!;
    // NOT( NOT invoice OR NOT payment ) === invoice AND payment
    expect(q).toEqual({ not: { or: [{ not: { body: "invoice" } }, { not: { body: "payment" } }] } });
  });

  it("still merges distinct-key criteria as an implicit-AND object", () => {
    const q = GmailQueryParser.parse("from:alice@example.com subject:hello").imapQueries[0]!;
    // No key collision → plain object merge (imapflow ANDs top-level keys).
    expect(q["from"]).toBe("alice@example.com");
    expect(String(q["subject"] ?? "")).toContain("hello");
    expect(q["not"]).toBeUndefined();
  });
});

describe("GmailQueryParser relative dates (MAIL-2)", () => {
  it("parses newer_than:7d into a valid SINCE date ~7 days ago", () => {
    const q = GmailQueryParser.parse("newer_than:7d").imapQueries[0]!;
    const since = q["since"] as Date | undefined;
    expect(since).toBeInstanceOf(Date);
    expect(Number.isNaN(since!.getTime())).toBe(false);
    const ageDays = (Date.now() - since!.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(6.5);
    expect(ageDays).toBeLessThan(7.5);
  });

  it("parses older_than:1m into a valid BEFORE date (months, not minutes)", () => {
    const q = GmailQueryParser.parse("older_than:1m").imapQueries[0]!;
    const before = q["before"] as Date | undefined;
    expect(before).toBeInstanceOf(Date);
    expect(Number.isNaN(before!.getTime())).toBe(false);
    const ageDays = (Date.now() - before!.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(25); // ~1 month back
  });
});

describe("quoted operator values", () => {
  it("keeps a quoted multi-word phrase as the operator's value", () => {
    // The word scanner stops at the quote, so this used to parse as
    // subject:"" AND body:"SMTP verification" and match nothing.
    const { imapQueries } = GmailQueryParser.parse('subject:"SMTP verification"');
    expect(imapQueries).toHaveLength(1);
    // The whole phrase must land on the subject criterion — not split into an
    // empty subject plus a stray body term.
    expect(imapQueries[0]).toEqual({ subject: "SMTP verification" });
  });

  it("still handles the single-word operator form", () => {
    const { imapQueries } = GmailQueryParser.parse("subject:StarlingAI");
    expect(JSON.stringify(imapQueries[0])).toContain("StarlingAI");
  });
});
