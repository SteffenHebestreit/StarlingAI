/**
 * Receptionist policy registry — lets product forks / extensions specialise the
 * generic front-desk gatekeeper (agent/receptionist.ts) without modifying core.
 *
 * The core receptionist is product-agnostic: it answers trivial smalltalk and
 * escalates everything else. A fork registers:
 *   - `escalateTerms` — domain content that must ALWAYS go to the full assistant
 *     (e.g. a medical fork registers its clinical/PII deny-list so the front desk
 *     never answers clinical turns).
 *   - `personaLines` — domain framing appended to the micro-call prompt (e.g.
 *     "You are the front desk of a medical office").
 *
 * Mirrors the llm-boundary transformer registration pattern (providers/llm-
 * boundary.ts): keyed by source so a re-register replaces, not duplicates.
 */

export interface ReceptionistPolicy {
  /** Terms (lower-cased substring match) that must always escalate to the full
   *  assistant rather than be answered at the front desk. */
  escalateTerms?: readonly string[];
  /** Extra system-prompt lines appended to the micro-call prompt — domain
   *  persona / framing for the front desk. */
  personaLines?: readonly string[];
}

const _policies = new Map<string, ReceptionistPolicy>();

export function registerReceptionistPolicy(source: string, policy: ReceptionistPolicy): void {
  _policies.set(source, policy);
}

export function getReceptionistEscalateTerms(): string[] {
  const terms: string[] = [];
  for (const policy of _policies.values()) {
    for (const term of policy.escalateTerms ?? []) {
      const normalized = term.trim().toLowerCase();
      if (normalized) terms.push(normalized);
    }
  }
  return terms;
}

export function getReceptionistPersonaLines(): string[] {
  const lines: string[] = [];
  for (const policy of _policies.values()) {
    for (const line of policy.personaLines ?? []) {
      if (line.trim()) lines.push(line.trim());
    }
  }
  return lines;
}

/** Internal — clears registered policies between tests. */
export function _resetReceptionistPoliciesForTests(): void {
  _policies.clear();
}
