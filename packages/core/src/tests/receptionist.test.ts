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

const NOT_SMALLTALK: Array<[string, string]> = [
  ["schreib eine E-Mail an den Chef", "task-intent"],
  ["remind me tomorrow about the meeting", "task-intent"],
  ["wie weit ist es von Berlin nach München", "task-intent"],
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

  it("redacts a leaked secret and escalates on empty/over-long/throw", async () => {
    const leaked = "Sure! Your key is sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD by the way.";
    const red = await runReceptionist("hi", { complete: async () => leaked });
    expect(red.handled).toBe(true);
    expect(red.response).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD");
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
});
