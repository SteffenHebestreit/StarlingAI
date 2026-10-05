/**
 * Input Guardian — Layer 1 of the guardrails system.
 * Scans user messages for prompt injection attempts before they reach the LLM.
 */
import { getGuardrails } from "./store.js";
import { getExtensionGuardrailHooks } from "../extension/index.js";

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  severity?: "low" | "medium" | "high";
  detectedPatterns?: string[];
}

/**
 * DAN as the jailbreak PERSONA, never the name Dan (verified 2026-10-05: "Schreib eine Mail an
 * Dan wegen des Termins." was hard-blocked as jailbreak_dan by a case-insensitive \bDAN\b, so any
 * mail to a colleague called Dan dead-ended).
 *  - The persona's own spelling — "DAN" in capitals, standing alone — blocks on its own, as it
 *    always did ("Hey DAN", "Switch to DAN", "DAN 11.0 Ignore everything"). The exception is a
 *    message written mostly in capitals, where "DAN" is just the name shouted.
 *  - The name in any other case ("Dan", "dan") blocks only with persona framing right before it
 *    ("respond as Dan", "be Dan", "simulate Dan") or a persona behaviour description near it
 *    ("… Dan has no filters", "never refuses", "can say anything").
 *  - The persona's expansion ("do anything now") and the generic jailbreak terms still block on
 *    their own.
 */
const JAILBREAK_TERMS_RE = /\b(do\s+anything\s+now|jailbreak|jailbroken|unrestricted\s+mode)\b/i;
const DAN_CAPS_RE = /(?<![A-Za-z0-9])DAN(?![A-Za-z0-9])/;
const DAN_ANY_CASE_RE = /(?<![A-Za-z0-9])dan(?![A-Za-z0-9'’])/gi;
// Persona framing that ends right where the name starts.
const DAN_FRAMING_BEFORE_RE = /(?:\b(?:respond|answer|reply|act|behave|speak|talk|write)(?:s|ing)?\s+(?:as|like)|\b(?:be|play|become|simulate|emulate|impersonate|switch\s+to|pretend\s+to\s+be|you\s+are(?:\s+now)?|you're(?:\s+now)?|you\s+will\s+(?:now\s+)?be|role\s+of|known\s+as))\s+(?:the\s+character\s+)?$/i;
const DAN_BEHAVIOUR_RE = /\b(?:no\s+(?:filters?|restrictions?|rules|limits|limitations|guidelines|censorship|boundaries)|zero\s+(?:restrictions?|rules|limits|filters?)|never\s+refuses?|(?:can|will)\s+(?:say|do)\s+anything|says?\s+anything|ignores?\s+(?:all\s+|any\s+)?(?:rules|polic(?:y|ies)|guidelines|restrictions|instructions)|broken\s+free|stay\s+in\s+character|without\s+(?:any\s+)?(?:restrictions|filters|limits))\b/i;
const DAN_BEHAVIOUR_WINDOW = 80;
const SHOUTING_MIN_LETTERS = 12;
const SHOUTING_UPPER_SHARE = 0.6;
function mostlyCapitals(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < SHOUTING_MIN_LETTERS) return false;
  return letters.filter((letter) => /\p{Lu}/u.test(letter)).length / letters.length >= SHOUTING_UPPER_SHARE;
}
const jailbreakPersona = {
  test(input: string): boolean {
    if (JAILBREAK_TERMS_RE.test(input)) return true;
    if (DAN_CAPS_RE.test(input) && !mostlyCapitals(input)) return true;
    for (const match of input.matchAll(DAN_ANY_CASE_RE)) {
      const at = match.index ?? 0;
      if (DAN_FRAMING_BEFORE_RE.test(input.slice(Math.max(0, at - 40), at))) return true;
      if (DAN_BEHAVIOUR_RE.test(input.slice(Math.max(0, at - DAN_BEHAVIOUR_WINDOW), at + 3 + DAN_BEHAVIOUR_WINDOW))) return true;
    }
    return false;
  },
};

/**
 * Credential extraction: a disclosure verb whose OBJECT is a credential the system or the user
 * HOLDS. Verified 2026-10-05: the bare word "token" (also the unit of model usage) hard-blocked
 * "What is the output token price of Claude?" and "Tell me how token limits work". The object is
 * read structurally, after the verb, within its clause:
 *  - "show me HOW …" asks how something works or is done — never a disclosure.
 *  - an environment-variable name (OPENAI_API_KEY, HF_TOKEN, DB_PASSWORD) is a credential.
 *  - a credential noun (api key, secret, password, credential, private key, a named token —
 *    access/auth/bearer/…/GitHub token) counts unless it is indefinite or generic: "an access
 *    token", "an example OAuth token", a bare plural ("API keys") explain a concept; an owner or
 *    definite article ("your", "the", "all", "den", "the server's") or a bare singular point at one.
 *  - the bare word "token" counts only with an owner or definite article, and not before a usage
 *    noun ("the token count", "your token limit", "tokens per second").
 * Word edges are (?<![A-Za-z0-9]) / (?![A-Za-z0-9]) so "_" separates: DB_PASSWORD reads as a
 * password, while "secretary" and "paid tokens" stay words of their own.
 */
const DISCLOSURE_VERB_RE = /(?<![A-Za-z0-9])(?:print|show|output|reveal|expose|list|give\s+me|tell\s+me)(?![A-Za-z0-9])/gi;
const CREDENTIAL_WINDOW = 45;
const CREDENTIAL_NOUN_RE = /(?<![A-Za-z0-9])(?:api[\s_-]?keys?|apikeys?|secrets?|passwords?|passphrases?|credentials?|private[\s_-]?keys?|(?:access|auth|authentication|authorization|bearer|refresh|session|api|oauth|jwt|id|csrf|webhook|bot|github|gh|gitlab|slack|discord|telegram|personal[\s_-]access)[\s_-]?tokens?)(?![A-Za-z0-9])/gi;
const BARE_TOKEN_RE = /(?<![A-Za-z0-9])tokens?(?![A-Za-z0-9])(?!\s*(?:price|pricing|prices|costs?|limits?|counts?|usage|budgets?|windows?|rates?|consumption|spend|spent|left|remaining|per)(?![A-Za-z0-9]))/gi;
// Case-sensitive: an environment-variable name ending in a credential part.
const ENV_VAR_CREDENTIAL_RE = /(?<![A-Za-z0-9_])\$?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|CREDENTIALS?)(?![A-Za-z0-9_])/;
// Closed classes: articles, possessives, quantifiers (EN + DE).
const OWNING_DETERMINERS = new Set([
  "the", "your", "my", "our", "their", "its", "his", "her", "this", "that", "these", "those", "all", "every", "any",
  "der", "die", "das", "den", "dem", "des", "dein", "deine", "deinen", "deinem", "deiner", "mein", "meine", "meinen",
  "meinem", "unser", "unsere", "unseren", "ihr", "ihre", "ihren", "euer", "eure", "alle",
]);
const INDEFINITE_DETERMINERS = new Set(["a", "an", "some", "example", "sample", "ein", "eine", "einen", "einem", "beispiel"]);
const DETERMINER_LOOKBACK_WORDS = 3;

/** The determiner standing in front of a noun: the nearest one within a few words before it. */
function determinerBefore(prefix: string): "owner" | "indefinite" | "none" {
  const words = prefix.split(/\s+/).map((word) => word.replace(/^[^\p{L}$]+|[^\p{L}'’]+$/gu, "")).filter(Boolean);
  for (const word of words.slice(-DETERMINER_LOOKBACK_WORDS).reverse()) {
    const lower = word.toLowerCase();
    if (INDEFINITE_DETERMINERS.has(lower)) return "indefinite";
    if (OWNING_DETERMINERS.has(lower) || /['’]s$/.test(lower)) return "owner";
  }
  return "none";
}

const credentialExtraction = {
  test(input: string): boolean {
    for (const verb of input.matchAll(DISCLOSURE_VERB_RE)) {
      const from = (verb.index ?? 0) + verb[0].length;
      const clause = input.slice(from, from + CREDENTIAL_WINDOW).split(/[.!?;\n]/)[0]!;
      if (/^\s*(?:(?:me|us|them|him|her)\s+)?(?:how|wie)(?![A-Za-z])/i.test(clause)) continue;
      if (ENV_VAR_CREDENTIAL_RE.test(clause)) return true;
      for (const noun of clause.matchAll(CREDENTIAL_NOUN_RE)) {
        const determiner = determinerBefore(clause.slice(0, noun.index));
        if (determiner === "owner") return true;
        if (determiner === "none" && !/s$/i.test(noun[0])) return true;
      }
      for (const token of clause.matchAll(BARE_TOKEN_RE)) {
        if (determinerBefore(clause.slice(0, token.index)) === "owner") return true;
      }
    }
    return false;
  },
};

// Known prompt injection patterns. `pattern` is anything with a test(): most are plain regexes,
// a few need a predicate (case-sensitive persona check, proximity window).
const INJECTION_PATTERNS: Array<{ name: string; pattern: { test(input: string): boolean }; severity: "low" | "medium" | "high" }> = [
  // Role/instruction override attempts
  { name: "ignore_instructions", pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context|rules?)/i, severity: "high" },
  { name: "new_instructions", pattern: /you\s+(are\s+now|must\s+now|should\s+now|will\s+now)\s+(act\s+as|behave\s+as|pretend\s+to\s+be|forget)/i, severity: "high" },
  { name: "disregard_safety", pattern: /(disregard|forget|override|bypass|ignore)\s+(your\s+)?(safety|guardrails?|restrictions?|limitations?|rules?)/i, severity: "high" },
  { name: "jailbreak_dan", pattern: jailbreakPersona, severity: "high" },
  { name: "system_prompt_leak", pattern: /(print|show|reveal|output|display)\b.{0,20}(system\s+prompt|initial\s+instructions?|original\s+prompt|full\s+prompt)/i, severity: "high" },
  { name: "act_as_override", pattern: /act\s+as\s+(if\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions?|limits?|rules?|guidelines?))/i, severity: "high" },
  { name: "assistant_prefix_injection", pattern: /^\s*assistant\s*:/i, severity: "medium" },
  { name: "inject_role_tag", pattern: /<\s*(system|assistant|human|user)(\s[^>]*)?\/?>/i, severity: "high" },
  // Invisible/zero-width characters (Unicode steganography)
  { name: "zero_width_chars", pattern: /[\u200B-\u200D\u2060\uFEFF\u00AD]/, severity: "medium" },
  { name: "invisible_unicode", pattern: /[\u202A-\u202E\u2066-\u2069]/, severity: "medium" }, // bidirectional overrides
  // Base64 hidden instructions
  { name: "base64_payload", pattern: /\b(?:[A-Za-z0-9+/]{40,}={0,2})\b/, severity: "medium" }, // long b64 blobs
  // Credential/secret extraction — flexible pattern to handle "Show me all API keys" (object
  // grammar: see credentialExtraction above).
  { name: "extract_credentials", pattern: credentialExtraction, severity: "high" },
  // Tool misuse attempts
  { name: "call_blocked_tool", pattern: /(call|invoke|run|execute)\s+(host_shell|docker_socket|gateway_reconfigure|skills_install)/i, severity: "high" },
  // Fake tool results
  { name: "inject_tool_result", pattern: /<\s*\/?\s*tool_result[^>]*>/i, severity: "high" },
  { name: "inject_function_result", pattern: /\[function_results?\]/i, severity: "medium" },
  // Role tag injection — HIGH severity (attacker-controlled content)
  { name: "inject_system_tag", pattern: /<\s*(system|assistant|human|user)(\s[^>]*)?\/?>[\s\S]{0,200}<\/\s*(system|assistant|human|user)(\s[^>]*)?>/i, severity: "high" },
];

const SUSPICIOUS_REPETITION_THRESHOLD = 50; // same char repeated > N times

/**
 * @param opts.trusted  The input is operator-authored, not untrusted user/channel
 *   content — e.g. a scene/job task defined in config and triggered from the
 *   dashboard. Prompt-injection patterns are then reported but NOT blocked (a
 *   legitimate instruction like "Never expose credential values" matches the
 *   credential-extraction heuristic). Length and repetition limits still apply,
 *   and every execution-layer guardrail (tool tiers, approval gates, output
 *   redaction) remains fully active when the workflow runs.
 */
export function checkInput(input: string, opts?: { trusted?: boolean }): GuardrailResult {
  const builtin = checkInputBuiltins(input, opts);
  if (!builtin.allowed) return builtin;

  // Extension-contributed input guardrails run AFTER the built-ins: they can
  // only tighten, never loosen. First block wins; failures fail open (a buggy
  // extension hook must not take the input pipeline down with it).
  for (const { extension, hooks } of getExtensionGuardrailHooks()) {
    if (!hooks.checkInput) continue;
    try {
      const result = hooks.checkInput(input);
      if (!result.allowed) {
        return {
          ...result,
          reason: `[ext:${extension}] ${result.reason ?? "blocked by extension guardrail"}`,
        };
      }
    } catch {
      // fail open — extension hook errors are not a reason to block users
    }
  }
  return builtin;
}

function checkInputBuiltins(input: string, opts?: { trusted?: boolean }): GuardrailResult {
  const { promptInjectionBlock, maxInputLength } = getGuardrails();

  if (!input || input.trim().length === 0) {
    return { allowed: true };
  }

  if (input.length > maxInputLength) {
    return {
      allowed: false,
      reason: `Input exceeds maximum length (${input.length} > ${maxInputLength})`,
      severity: "medium",
    };
  }

  if (!promptInjectionBlock) {
    return { allowed: true };
  }

  // Normalize Unicode to NFC form to prevent homoglyph bypass attacks
  const normalized = input.normalize("NFC");

  // Check for suspicious character repetition (padding attacks)
  const maxRun = longestRun(normalized);
  if (maxRun > SUSPICIOUS_REPETITION_THRESHOLD) {
    return {
      allowed: false,
      reason: "Suspicious character repetition detected",
      severity: "low",
    };
  }

  const detected: string[] = [];
  let highestSeverity: "low" | "medium" | "high" = "low";

  for (const { name, pattern, severity } of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      detected.push(name);
      if (severity === "high") highestSeverity = "high";
      else if (severity === "medium" && highestSeverity !== "high") highestSeverity = "medium";
    }
  }

  // Operator-authored (trusted) input: report matches for visibility but never
  // block — the injection scanner is for untrusted user/channel content, not the
  // system's own configured scene/job task text.
  if (opts?.trusted) {
    return detected.length > 0
      ? {
          allowed: true,
          reason: `Suspicious patterns noted in trusted input (not blocked): ${detected.join(", ")}`,
          severity: highestSeverity,
          detectedPatterns: detected,
        }
      : { allowed: true };
  }

  // High-severity patterns always block
  const highPatterns = detected.filter(name => {
    const p = INJECTION_PATTERNS.find(x => x.name === name);
    return p?.severity === "high";
  });

  if (highPatterns.length > 0) {
    return {
      allowed: false,
      reason: `Prompt injection detected: ${highPatterns.join(", ")}`,
      severity: "high",
      detectedPatterns: detected,
    };
  }

  // Multiple medium patterns also block
  const mediumPatterns = detected.filter(name => {
    const p = INJECTION_PATTERNS.find(x => x.name === name);
    return p?.severity === "medium";
  });

  if (mediumPatterns.length >= 2) {
    return {
      allowed: false,
      reason: `Multiple suspicious patterns detected: ${mediumPatterns.join(", ")}`,
      severity: "medium",
      detectedPatterns: detected,
    };
  }

  if (detected.length > 0) {
    // Low-severity or single medium: log but allow with warning
    return {
      allowed: true,
      reason: `Suspicious patterns noted (not blocked): ${detected.join(", ")}`,
      severity: highestSeverity,
      detectedPatterns: detected,
    };
  }

  return { allowed: true };
}

/**
 * Lighter-weight check for tool outputs. Only blocks patterns that indicate
 * an active injection attempt embedded in tool results (role tag injection,
 * fake tool results). Does NOT block content-level phrases like
 * "ignore previous instructions" which commonly appear in scraped web content.
 */
const TOOL_OUTPUT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // [^>]*/`\/?` after the tag name close the attribute (<system foo>) and self-close (<system/>)
  // bypass an earlier `\s*>`-only pattern allowed. `(\s[^>]*)?` requires whitespace before any
  // attributes so <systemic> is not a false positive.
  { name: "inject_role_tag", pattern: /<\s*(system|assistant|human|user)(\s[^>]*)?\/?>/i },
  { name: "inject_system_tag", pattern: /<\s*(system|assistant|human|user)(\s[^>]*)?\/?>[\s\S]{0,200}<\/\s*(system|assistant|human|user)(\s[^>]*)?>/i },
  { name: "inject_tool_result", pattern: /<\s*\/?\s*tool_result[^>]*>/i },
  { name: "inject_function_result", pattern: /\[function_results?\]/i },
  { name: "assistant_prefix_injection", pattern: /^\s*assistant\s*:/i },
];

export function checkToolOutput(output: string): GuardrailResult {
  const { promptInjectionBlock } = getGuardrails();
  if (!promptInjectionBlock || !output) return { allowed: true };

  const detected: string[] = [];
  for (const { name, pattern } of TOOL_OUTPUT_PATTERNS) {
    if (pattern.test(output)) detected.push(name);
  }

  if (detected.length > 0) {
    return {
      allowed: false,
      reason: `Suspicious injection patterns in tool output: ${detected.join(", ")}`,
      severity: "high",
      detectedPatterns: detected,
    };
  }
  return { allowed: true };
}

/**
 * Defang framework-mimicking framing markers in UNTRUSTED tool output before a sub-agent
 * re-reads it, so injected content can't pose as a real tool/function-result boundary.
 *
 * Unlike checkToolOutput (which BLOCKS — appropriate for the orchestrator's controlled tools)
 * this NEUTRALIZES: the content is fully preserved, only the exact framework tokens are
 * rewritten, so a sub-agent fetching ARBITRARY web/file/email content that merely contains
 * these tokens is never dropped (no false-positive that would break research). Scoped to the
 * two markers that have no legitimate reason to appear verbatim in fetched content; role tags
 * (`<system>` / `assistant:`) are intentionally left untouched — they DO appear in legitimate
 * research content, and the structured message role already neutralizes them.
 */
export function neutralizeToolResultFraming(text: string): string {
  if (!text) return text;
  return text
    // <tool_result …> / </tool_result …> → escape the brackets so it reads as inert text, not a
    // tag. [^>]* consumes ANY attributes or a trailing self-close slash (<tool_result attr="x"/>),
    // closing the self-closing/attribute bypass an earlier `\s*>`-only pattern allowed.
    .replace(/<\s*\/?\s*tool_result[^>]*>/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    // [function_results] / [function_result] → break the exact framework token.
    .replace(/\[\s*function_results?\s*\]/gi, (m) => `[external:${m.slice(1, -1).trim()}]`);
}

function longestRun(str: string): number {
  let max = 0, current = 0;
  let last = "";
  for (const ch of str) {
    if (ch === last) {
      current++;
      max = Math.max(max, current);
    } else {
      current = 1;
      last = ch;
    }
  }
  return max;
}
