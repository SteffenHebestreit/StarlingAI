/**
 * Input Guardian — Layer 1 of the guardrails system.
 * Scans user messages for prompt injection attempts before they reach the LLM.
 */
import { getGuardrails } from "./store.js";

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  severity?: "low" | "medium" | "high";
  detectedPatterns?: string[];
}

// Known prompt injection patterns
const INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp; severity: "low" | "medium" | "high" }> = [
  // Role/instruction override attempts
  { name: "ignore_instructions", pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context|rules?)/i, severity: "high" },
  { name: "new_instructions", pattern: /you\s+(are\s+now|must\s+now|should\s+now|will\s+now)\s+(act\s+as|behave\s+as|pretend\s+to\s+be|forget)/i, severity: "high" },
  { name: "disregard_safety", pattern: /(disregard|forget|override|bypass|ignore)\s+(your\s+)?(safety|guardrails?|restrictions?|limitations?|rules?)/i, severity: "high" },
  { name: "jailbreak_dan", pattern: /\b(DAN|do\s+anything\s+now|jailbreak|jailbroken|unrestricted\s+mode)\b/i, severity: "high" },
  { name: "system_prompt_leak", pattern: /(print|show|reveal|output|display)\b.{0,20}(system\s+prompt|initial\s+instructions?|original\s+prompt|full\s+prompt)/i, severity: "high" },
  { name: "act_as_override", pattern: /act\s+as\s+(if\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions?|limits?|rules?|guidelines?))/i, severity: "high" },
  { name: "assistant_prefix_injection", pattern: /^\s*assistant\s*:/i, severity: "medium" },
  { name: "inject_role_tag", pattern: /<\s*(system|assistant|human|user)\s*>/i, severity: "high" },
  // Invisible/zero-width characters (Unicode steganography)
  { name: "zero_width_chars", pattern: /[\u200B-\u200D\u2060\uFEFF\u00AD]/, severity: "medium" },
  { name: "invisible_unicode", pattern: /[\u202A-\u202E\u2066-\u2069]/, severity: "medium" }, // bidirectional overrides
  // Base64 hidden instructions
  { name: "base64_payload", pattern: /\b(?:[A-Za-z0-9+/]{40,}={0,2})\b/, severity: "medium" }, // long b64 blobs
  // Credential/secret extraction — flexible pattern to handle "Show me all API keys"
  { name: "extract_credentials", pattern: /(print|show|output|reveal|expose|list|give me|tell me)\b.{0,30}(api[\s_-]?key|secret|password|token|credential)/i, severity: "high" },
  // Tool misuse attempts
  { name: "call_blocked_tool", pattern: /(call|invoke|run|execute)\s+(host_shell|docker_socket|gateway_reconfigure|skills_install)/i, severity: "high" },
  // Fake tool results
  { name: "inject_tool_result", pattern: /<\s*tool_result\s*>/i, severity: "high" },
  { name: "inject_function_result", pattern: /\[function_results?\]/i, severity: "medium" },
  // Role tag injection — HIGH severity (attacker-controlled content)
  { name: "inject_system_tag", pattern: /<\s*(system|assistant|human|user)\s*>[\s\S]{0,200}<\/\s*(system|assistant|human|user)\s*>/i, severity: "high" },
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
  { name: "inject_role_tag", pattern: /<\s*(system|assistant|human|user)\s*>/i },
  { name: "inject_system_tag", pattern: /<\s*(system|assistant|human|user)\s*>[\s\S]{0,200}<\/\s*(system|assistant|human|user)\s*>/i },
  { name: "inject_tool_result", pattern: /<\s*tool_result\s*>/i },
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
