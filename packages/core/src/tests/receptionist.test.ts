/**
 * Receptionist fast lane — generic gatekeeper gate + micro-call + fork policy.
 *
 * Core ships NO domain deny-list; escalation comes from the task-intent
 * classifier, registered fork policies, and config.alwaysEscalateTerms. The
 * Stage-0 gate is pure (no LLM); the micro-call is exercised with an injected
 * `complete`, so the suite runs in CI without a provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ESCALATE_SENTINEL,
  buildMemoryCapsule,
  buildReceptionistMessages,
  previousQuestion,
  languageIsUndetermined,
  classifyFrontDesk,
  runReceptionist,
} from "../agent/receptionist.js";
import {
  _resetReceptionistPoliciesForTests,
  registerReceptionistPolicy,
} from "../agent/receptionist-policy.js";
import { _clearDurableMemoryCaches, storeWorkspaceMemoryRecord } from "../memory/service.js";

const dirs: string[] = [];
beforeEach(() => _resetReceptionistPoliciesForTests());
afterEach(() => {
  _resetReceptionistPoliciesForTests();
  _clearDurableMemoryCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SMALLTALK = ["hi", "hello", "Guten Morgen", "wie geht's dir?", "danke dir!", "thanks!", "alles klar"];

// De-lexicalization (cleanup/lean-base): the Stage-0 gate no longer detects
// task intent from keywords — buildDynamicTurnGuidance's mail/task flags default
// OFF, so a short request like "schreib eine E-Mail an den Chef" is no longer
// escalated with reason "task-intent" at the deterministic gate (the micro-call
// LLM is the arbiter for it now). That obsolete "task-intent" fixture was removed.
// The gate still escalates on message SHAPE (not short + conversational), which
// this structural fixture continues to verify.
const NOT_SMALLTALK: Array<[string, string]> = [
  [
    "ich wollte dir einfach mal ganz in Ruhe und ausführlich erzählen wie entspannt der lange gemütliche Spaziergang am kleinen Waldsee für mich gewesen ist",
    "not-short-conversational",
  ],
];

describe("receptionist — generic gate", () => {
  it("fast-lanes smalltalk and escalates everything else (precision/recall = 1.0)", () => {
    let tp = 0;
    for (const msg of SMALLTALK) if (classifyFrontDesk(msg).fastLane) tp++;
    let fp = 0;
    for (const [msg] of NOT_SMALLTALK) if (classifyFrontDesk(msg).fastLane) fp++;
    const recall = tp / SMALLTALK.length;
    const precision = tp / (tp + fp);
    // eslint-disable-next-line no-console
    console.log(`receptionist gate — precision ${precision.toFixed(2)} · recall ${recall.toFixed(2)}`);
    expect(recall).toBe(1);
    expect(precision).toBe(1);
  });

  it("escalates each non-smalltalk message with the right reason", () => {
    for (const [msg, reason] of NOT_SMALLTALK) {
      const decision = classifyFrontDesk(msg);
      expect(decision.fastLane).toBe(false);
      if (!decision.fastLane) expect(decision.reason).toBe(reason);
    }
  });

  it("honours operator-configured always-escalate terms", () => {
    expect(classifyFrontDesk("magst du Fußball?").fastLane).toBe(true);
    expect(classifyFrontDesk("magst du Fußball?", { alwaysEscalateTerms: ["fußball"] }).fastLane).toBe(false);
  });
});

describe("receptionist — fork policy hook", () => {
  it("escalates terms registered by a fork policy (core ships none)", () => {
    // Core knows nothing about "rezept" — without a policy it fast-lanes.
    expect(classifyFrontDesk("brauche ich ein Rezept?").fastLane).toBe(true);
    // A fork (e.g. medical) registers its clinical deny-list → now it escalates.
    registerReceptionistPolicy("mfa", { escalateTerms: ["rezept", "termin"] });
    const decision = classifyFrontDesk("brauche ich ein Rezept?");
    expect(decision.fastLane).toBe(false);
    if (!decision.fastLane) expect(decision.reason).toBe("escalate-term");
  });

  it("injects fork persona lines into the micro-call prompt", () => {
    const messages = buildReceptionistMessages("hi", {
      personaLines: ["You are the front desk of a German medical office."],
    });
    expect(messages[0]!.content).toContain("German medical office");
  });
});

// On the routing model "switch to Claude" and "change your voice" were answered "I cannot" and "stop
// using the cloud" "Understood" 12 times in 64; with this line 0 in 64, and greetings stayed with
// the desk as often as before (63 of 64, 2026-11-06).
describe("receptionist — what it cannot do is not for it to say", () => {
  it.each([false, true])("leaves declining to the full assistant (confidence attempt: %s)", (confidenceAttempt) => {
    const content = String(buildReceptionistMessages("Switch to Claude please.", { confidenceAttempt })[0]!.content);
    expect(content).toContain(`Never say you cannot do something, and never say what you can do: only the full assistant knows what it can do. A request you would decline, or a question about what you can do, gets exactly ${ESCALATE_SENTINEL}`);
  });

  // "Was kannst du so?" was answered by the desk with its own job, small talk. The licence to answer
  // "what you can broadly help with" itself has to be gone, or it outweighs the line above. On the
  // routing model 8 such questions x 8 reached the full assistant 33 times in 64 before, 63 after;
  // greetings stayed with the desk 62 times in 64 (64 before, 2026-11-08).
  it.each([false, true])("does not describe what the assistant can do (confidence attempt: %s)", (confidenceAttempt) => {
    const content = String(buildReceptionistMessages("Was kannst du so?", { confidenceAttempt })[0]!.content);
    expect(content).not.toContain("what you can broadly help with");
  });
});

// Regression (session a75e1c26): the fast lane answered "wie funktioniert das Pfandsystem in
// Dänemark?" from the tiny routing model — a source-sensitive real-world question that bypasses
// ALL the orchestrator's honesty guards. The smalltalk-only prompt licensed "simple general-
// knowledge questions", which the model over-applied. The micro-call prompt must instead escalate
// any real-world / how-a-specific-system-works question so it reaches the guarded orchestrator path.
describe("receptionist — source-sensitivity in the micro-call prompt", () => {
  it("smalltalk-only mode escalates real-world / how-it-works questions (the old general-knowledge loophole is gone)", () => {
    const content = String(buildReceptionistMessages("Wie funktioniert das Pfandsystem in Dänemark?")[0]!.content);
    expect(content).toContain(ESCALATE_SENTINEL);
    expect(content).toContain("SOCIAL turns");               // only social/meta turns are self-handled
    expect(content.toLowerCase()).toContain("real-world information");
    expect(content.toLowerCase()).toContain("how something actually works");
    expect(content.toLowerCase()).not.toContain("general-knowledge questions"); // loophole removed
  });

  it("confidence-attempt mode forbids answering specific real-world facts (no 'a fact, a simple explanation' invitation)", () => {
    const content = String(buildReceptionistMessages("Wie funktioniert das Pfandsystem in Dänemark?", { confidenceAttempt: true })[0]!.content);
    expect(content).toContain(ESCALATE_SENTINEL);
    expect(content.toLowerCase()).toContain("specific real-world facts");
    expect(content.toLowerCase()).not.toContain("a fact, a simple explanation");
  });

  it("a bare greeting gets ONE unconditional German directive, with no competing same-language rule", () => {
    // Regression: the prompt-only conditional ("...if ambiguous default to German") lost to the
    // stronger "ALWAYS reply in the SAME language (English → English)" rule on the tiny fast-lane
    // model, which read "hi" as English and answered in English. The competing rule must be ABSENT
    // for an undetermined-language message, leaving one unconditional instruction.
    for (const opts of [{}, { confidenceAttempt: true }]) {
      const content = String(buildReceptionistMessages("hi", opts)[0]!.content);
      expect(content).toContain("Reply in GERMAN");
      expect(content).not.toContain("English → English"); // the rule that overrode the old fix
    }
  });

  it("keeps the same-language rule when the message DOES carry a language", () => {
    const content = String(buildReceptionistMessages("what kinds of things can you help me with?")[0]!.content);
    expect(content).toContain("English → English");
    expect(content).not.toContain("Reply in GERMAN");
  });

  it("languageIsUndetermined: bare social tokens carry no language; real sentences do", () => {
    for (const bare of ["hi", "hey", "ok", "danke", "thanks", "👋", "hallo", "  ", "yo!"]) {
      expect(languageIsUndetermined(bare)).toBe(true);
    }
    for (const determined of [
      "wie funktioniert das Pfandsystem?",        // German (umlaut-free but multi-word)
      "what can you help me with today?",          // English sentence
      "Können Sie mir helfen?",                    // umlaut → positive German marker
    ]) {
      expect(languageIsUndetermined(determined)).toBe(false);
    }
  });

  it("languageIsUndetermined: counts the characters of a script written without spaces as words", () => {
    // Split at spaces, a Chinese or Japanese sentence was one word and got the bare-greeting directive.
    for (const sentence of ["如何在冬天储存电池？", "今日のニュースは？", "你今天过得怎么样？"]) {
      expect(languageIsUndetermined(sentence)).toBe(false);
      expect(String(buildReceptionistMessages(sentence, { defaultLanguage: "German" })[0]!.content)).not.toContain("Reply in GERMAN");
    }
    // Two characters stay as bare as two short words.
    for (const bare of ["你好", "谢谢"]) expect(languageIsUndetermined(bare)).toBe(true);
  });
});

describe("receptionist — micro-call", () => {
  it("never calls the model when the gate escalates", async () => {
    registerReceptionistPolicy("mfa", { escalateTerms: ["rezept"] });
    const complete = vi.fn(async () => "should not be called");
    const r = await runReceptionist("ich brauche ein Rezept", { complete });
    expect(r.handled).toBe(false);
    expect(r.escalateReason).toBe("escalate-term");
    expect(complete).not.toHaveBeenCalled();
  });

  it("answers a greeting and escalates the disguised-task control", async () => {
    const ok = await runReceptionist("hi", { complete: async () => "Hello! How can I help?" });
    expect(ok.handled).toBe(true);
    expect(ok.response).toContain("Hello");

    const control = await runReceptionist("write me a short poem", { complete: async () => ESCALATE_SENTINEL });
    expect(control.handled).toBe(false);
    expect(control.escalateReason).toBe("model-escalated");
  });

  it("escalates a fast-lane answer that asserts external-world specifics (structural belt)", async () => {
    // The 9b routing model answered a source-sensitive question despite its prompt: the
    // answer asserts named-fact-shape specifics (a fee + a year), so the structural belt
    // must escalate it to the verifiable full path rather than ship it unvalidated.
    const fabricated = await runReceptionist(
      "how much is the annual fee for the Acme Pro plan?",
      { complete: async () => "The Acme Pro plan costs 90 EUR per year and was last updated in 2026." },
    );
    expect(fabricated.handled).toBe(false);
    expect(fabricated.escalateReason).toBe("asserts-specifics");

    // In-scope fast-lane answers (greeting / about-you / definition) carry no fact-shape
    // tokens and are still handled directly.
    const greeting = await runReceptionist("hi there", { complete: async () => "Hi! I'm your assistant — how can I help today?" });
    expect(greeting.handled).toBe(true);
  });

  it("redacts a leaked secret and escalates on empty/over-long/throw", async () => {
    // Made-up keys are assembled at run time: as literals they are secret-scanner hits (GitHub, 2026-09-29).
    const fakeKey = ["sk", "abcdefghijklmnopqrstuvwxyz1234567890ABCD"].join("-");
    const leaked = `Sure! Your key is ${fakeKey} by the way.`;
    const red = await runReceptionist("hi", { complete: async () => leaked });
    expect(red.handled).toBe(true);
    expect(red.response).not.toContain(fakeKey);
    expect(red.response).toContain("[REDACTED");

    expect((await runReceptionist("hi", { complete: async () => "" })).handled).toBe(false);
    expect((await runReceptionist("hi", { complete: async () => "x".repeat(500), maxResponseChars: 400 })).escalateReason).toBe("response-too-long");
    expect((await runReceptionist("hi", { complete: async () => { throw new Error("down"); } })).escalateReason).toBe("micro-call-error");
  });
});

describe("receptionist — memory capsule", () => {
  it("builds a compact facts/decisions/preferences capsule, capped", () => {
    const ws = mkdtempSync(join(tmpdir(), "recept-mem-"));
    dirs.push(ws);
    storeWorkspaceMemoryRecord(ws, { key: "tone", subject: "Tone", content: "Greet users politely.", kind: "preference" });
    storeWorkspaceMemoryRecord(ws, { key: "hours", subject: "Hours", content: "Open Monday to Friday.", kind: "decision" });
    // Durable FACTS (e.g. user identity/role) must be in the capsule too — they
    // are exactly the "user-memory to rely on" injected as data on every path.
    storeWorkspaceMemoryRecord(ws, { key: "role", subject: "Role", content: "User is a freelance software engineer.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "scratch", subject: "Scratch", content: "ephemeral scratch note", kind: "note" });

    const capsule = buildMemoryCapsule(ws, 400);
    expect(capsule).toContain("politely");
    expect(capsule).toContain("Monday to Friday");
    expect(capsule).toContain("freelance software engineer");
    expect(capsule).not.toContain("ephemeral scratch");
    expect(capsule.length).toBeLessThanOrEqual(420);
  });

  it("names each fact's subject, so a bare value still says what it is", () => {
    // Found by the E2E suite (2026-10-07): the capsule carried "- Polarstern-Rooibos", and asked for
    // the favourite tea in a new session the model had nothing to connect it to.
    const ws = mkdtempSync(join(tmpdir(), "recept-mem-"));
    dirs.push(ws);
    storeWorkspaceMemoryRecord(ws, { key: "favorite_tea", subject: "Lieblingsteesorte", content: "Polarstern-Rooibos", kind: "preference" });
    storeWorkspaceMemoryRecord(ws, { key: "editor", subject: "Editor", content: "Editor of choice is Helix.", kind: "preference" });

    const capsule = buildMemoryCapsule(ws, 400);
    expect(capsule).toContain("- Lieblingsteesorte: Polarstern-Rooibos");
    // A content that already names its subject is not prefixed twice.
    expect(capsule).toContain("- Editor of choice is Helix.");
  });

  it("keeps the whole value when the subject is long, and shortens the subject instead", () => {
    // A subject has no length cap (memory_promote copies an outcome's task text), and the line was
    // cut after the subject was prepended: this one left "… and live tracking: Us" and no value.
    const ws = mkdtempSync(join(tmpdir(), "recept-mem-"));
    dirs.push(ws);
    const value = "Use Kurierdienst Nord: 39 EUR, insured to 500 EUR, cut-off 14:00.";
    storeWorkspaceMemoryRecord(ws, {
      key: "courier_choice",
      subject: "Research the three cheapest same-day courier options from Hamburg Altona to Lübeck for a 4 kg parcel with insurance, pickup before noon, and live tracking",
      content: value,
      kind: "decision",
    });

    const line = buildMemoryCapsule(ws, 600);
    expect(line).toContain(`…: ${value}`);
    expect(line.startsWith("- Research the three cheapest same-day courier options")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(160);
  });

  it("leaves the subject out when the value fills the line", () => {
    // A value that fills the line on its own is shown the way it was before subjects were added: cut
    // at the line cap, so the room goes to the value rather than to its label.
    const ws = mkdtempSync(join(tmpdir(), "recept-mem-"));
    dirs.push(ws);
    const value = `Ship every parcel with Kurierdienst Nord ${"and keep the insurance receipt ".repeat(5)}`.trim();
    storeWorkspaceMemoryRecord(ws, { key: "courier_rule", subject: "Courier rule", content: value, kind: "decision" });

    expect(buildMemoryCapsule(ws, 600)).toBe(`- ${value}`.slice(0, 160));
  });
});

// The desk saw the message alone: "ja bitte" after "shall I set up a daily check?" was small talk
// to it, it answered "Gerne!", and what the user had just agreed to was never done.
describe("receptionist — what a short message may be an answer to", () => {
  it("finds the question the previous reply ends on", () => {
    expect(previousQuestion("The draft is ready. Should I go ahead and send it?")).toBe("Should I go ahead and send it?");
    expect(previousQuestion("Es gibt drei Wege. Welche der drei Varianten soll ich umsetzen: A, B oder C?")).toBe("Welche der drei Varianten soll ich umsetzen: A, B oder C?");
    expect(previousQuestion("Soll ich das machen? Sonst lasse ich es so.")).toBe("Soll ich das machen?");
    expect(previousQuestion("要我每天早上检查一次吗？")).toBe("要我每天早上检查一次吗？");
  });

  it("finds none in a reply that asks nothing, or asked long before its end", () => {
    expect(previousQuestion("The capital of Australia is Canberra.")).toBeUndefined();
    expect(previousQuestion(undefined)).toBeUndefined();
    expect(previousQuestion(`Shall I? ${"A sentence of the report. ".repeat(30)}`)).toBeUndefined();
  });

  it("shows a long question's end only", () => {
    const question = `Soll ich ${"wirklich ".repeat(60)}anfangen?`;
    const shown = previousQuestion(question)!;
    expect(shown.length).toBeLessThanOrEqual(241);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("anfangen?")).toBe(true);
  });

  it("puts that question in front of the message, and leaves the message alone when there is none", () => {
    const asked = buildReceptionistMessages("ja bitte", { previousReply: "Das geht. Soll ich dafür einen täglichen Check einrichten?" });
    expect(asked[1]!.content).toBe('[The assistant had just asked: "Soll ich dafür einen täglichen Check einrichten?"]\n\nja bitte');
    const plain = buildReceptionistMessages("danke dir", { previousReply: "Die Datei ist gespeichert unter reports/q3.pdf." });
    expect(plain[1]!.content).toBe("danke dir");
    expect(buildReceptionistMessages("hi")[1]!.content).toBe("hi");
  });

  it("says the same to the model whether or not a question is shown: the system text is one prefix", () => {
    const withQuestion = buildReceptionistMessages("ja bitte", { previousReply: "Soll ich?" });
    const without = buildReceptionistMessages("ja bitte");
    expect(withQuestion[0]!.content).toBe(without[0]!.content);
    expect(String(without[0]!.content)).toContain("a message that says yes to it, answers it or picks one of its options is the full assistant's to act on");
  });

  it("hands the previous reply from the turn to the model's messages", async () => {
    let seen = "";
    await runReceptionist("ok mach", {
      previousReply: "Ich kann das jeden Morgen prüfen. Soll ich?",
      complete: async (messages) => { seen = String(messages[1]!.content); return ESCALATE_SENTINEL; },
    });
    expect(seen).toBe('[The assistant had just asked: "Soll ich?"]\n\nok mach');
  });
});

