/**
 * MIS-202 slice 1: mission contracts and child narrowing.
 *
 * A contract states what an execution scope is ALLOWED to do: which agents and
 * tools it may use, the most permissive effect class it may exercise
 * (SEC-106's vocabulary), its deadline, and its budget envelope. The root
 * contract is created once per root session; every delegated child derives a
 * NARROWED contract — the invariant is that a child can never silently widen
 * any dimension. A widening request is CLAMPED to the parent bound and
 * audited (`contract_narrowing_clamped`), never granted and never dropped
 * silently.
 *
 * Slice 1 keeps contracts in a process-local ledger and attaches contract ids
 * to delegation attempts (audit + attempt metadata). Durable storage in the
 * mission event store, acceptance/stop propagation from the turn plan, and
 * federation propagation are later slices.
 */
import { randomUUID } from "node:crypto";
import { logAudit } from "../audit/logger.js";

const REVERSIBILITY_RANK: Record<string, number> = { pure: 0, idempotent: 1, compensatable: 2, irreversible: 3 };

export interface ContractEffectPolicy {
  /** Most permissive reversibility class this scope may exercise. */
  maxReversibility: "pure" | "idempotent" | "compensatable" | "irreversible";
  /** Effect domains this scope may touch; undefined = all domains. */
  allowedDomains?: string[];
}

export interface ContractBudget {
  /** 0 = unlimited (matches BUD-203 semantics). */
  tokens: number;
  toolCalls: number;
  activeTimeMs: number;
}

export interface MissionContract {
  contractId: string;
  parentContractId?: string;
  rootSessionId: string;
  depth: number;
  objective: string;
  acceptanceCriteria: string[];
  stopConditions: string[];
  /** undefined = unrestricted. An EMPTY array means "nothing allowed". */
  allowedAgents?: string[];
  allowedTools?: string[];
  effectPolicy: ContractEffectPolicy;
  /** ISO instant after which work under this contract must stop. undefined = none. */
  deadlineAt?: string;
  budget: ContractBudget;
  createdAt: string;
}

export interface ContractNarrowRequest {
  objective?: string;
  acceptanceCriteria?: string[];
  stopConditions?: string[];
  allowedAgents?: string[];
  allowedTools?: string[];
  effectPolicy?: Partial<ContractEffectPolicy>;
  deadlineAt?: string;
  budget?: Partial<ContractBudget>;
}

export interface ClampedField {
  field: string;
  requested: string;
  granted: string;
}

// ── Process-local contract ledger ────────────────────────────────────────────

const _contracts = new Map<string, MissionContract>();          // contractId → contract
const _rootBySession = new Map<string, string>();               // rootSessionId → contractId
const MAX_CONTRACTS = 2000;

function remember(contract: MissionContract): void {
  _contracts.set(contract.contractId, contract);
  // Bounded: evict oldest entries (insertion order) past the cap.
  if (_contracts.size > MAX_CONTRACTS) {
    for (const key of _contracts.keys()) {
      if (_contracts.size <= MAX_CONTRACTS) break;
      const evicted = _contracts.get(key);
      _contracts.delete(key);
      if (evicted && _rootBySession.get(evicted.rootSessionId) === key) {
        _rootBySession.delete(evicted.rootSessionId);
      }
    }
  }
}

export function getContract(contractId: string): MissionContract | undefined {
  return _contracts.get(contractId);
}

export function resetMissionContractsForTests(): void {
  _contracts.clear();
  _rootBySession.clear();
}

/** Create (or return) the root contract for a root session. Idempotent. */
export function getOrCreateRootContract(
  rootSessionId: string,
  init: Omit<ContractNarrowRequest, "effectPolicy"> & { effectPolicy?: Partial<ContractEffectPolicy> },
): MissionContract {
  const existingId = _rootBySession.get(rootSessionId);
  if (existingId) {
    const existing = _contracts.get(existingId);
    if (existing) return existing;
  }
  const contract: MissionContract = {
    contractId: randomUUID(),
    rootSessionId,
    depth: 0,
    objective: init.objective ?? "",
    acceptanceCriteria: init.acceptanceCriteria ?? [],
    stopConditions: init.stopConditions ?? [],
    ...(init.allowedAgents ? { allowedAgents: [...init.allowedAgents] } : {}),
    ...(init.allowedTools ? { allowedTools: [...init.allowedTools] } : {}),
    effectPolicy: {
      maxReversibility: init.effectPolicy?.maxReversibility ?? "irreversible",
      ...(init.effectPolicy?.allowedDomains ? { allowedDomains: [...init.effectPolicy.allowedDomains] } : {}),
    },
    ...(init.deadlineAt ? { deadlineAt: init.deadlineAt } : {}),
    budget: {
      tokens: init.budget?.tokens ?? 0,
      toolCalls: init.budget?.toolCalls ?? 0,
      activeTimeMs: init.budget?.activeTimeMs ?? 0,
    },
    createdAt: new Date().toISOString(),
  };
  remember(contract);
  _rootBySession.set(rootSessionId, contract.contractId);
  return contract;
}

function intersectList(
  parent: string[] | undefined,
  requested: string[] | undefined,
  field: string,
  clamped: ClampedField[],
): string[] | undefined {
  if (requested === undefined) return parent ? [...parent] : undefined;
  if (parent === undefined) return [...requested];
  const granted = requested.filter((item) => parent.includes(item));
  const widened = requested.filter((item) => !parent.includes(item));
  if (widened.length > 0) {
    clamped.push({ field, requested: widened.join(","), granted: granted.join(",") || "(none)" });
  }
  return granted;
}

/** Min of two budget dimensions under 0-means-unlimited semantics. */
function narrowBudgetDim(parent: number, requested: number | undefined): number {
  if (requested === undefined) return parent;
  if (parent === 0) return requested;
  if (requested === 0) return parent; // requesting "unlimited" under a bounded parent = the parent bound
  return Math.min(parent, requested);
}

/**
 * Derive a child contract from a parent. Every dimension is intersected /
 * min'd against the parent; a request that would WIDEN any dimension is
 * clamped to the parent bound and reported (and audited by the caller via
 * the returned clamp list) — never granted, never silently dropped.
 */
export function narrowContract(
  parent: MissionContract,
  requested: ContractNarrowRequest,
): { contract: MissionContract; clamped: ClampedField[] } {
  const clamped: ClampedField[] = [];

  const allowedAgents = intersectList(parent.allowedAgents, requested.allowedAgents, "allowedAgents", clamped);
  const allowedTools = intersectList(parent.allowedTools, requested.allowedTools, "allowedTools", clamped);

  const parentRank = REVERSIBILITY_RANK[parent.effectPolicy.maxReversibility] ?? 3;
  const requestedReversibility = requested.effectPolicy?.maxReversibility;
  let maxReversibility = parent.effectPolicy.maxReversibility;
  if (requestedReversibility !== undefined) {
    const requestedRank = REVERSIBILITY_RANK[requestedReversibility] ?? 3;
    if (requestedRank > parentRank) {
      clamped.push({ field: "effectPolicy.maxReversibility", requested: requestedReversibility, granted: parent.effectPolicy.maxReversibility });
    } else {
      maxReversibility = requestedReversibility;
    }
  }
  const allowedDomains = intersectList(parent.effectPolicy.allowedDomains, requested.effectPolicy?.allowedDomains, "effectPolicy.allowedDomains", clamped);

  let deadlineAt = parent.deadlineAt;
  if (requested.deadlineAt !== undefined) {
    if (parent.deadlineAt !== undefined && Date.parse(requested.deadlineAt) > Date.parse(parent.deadlineAt)) {
      clamped.push({ field: "deadlineAt", requested: requested.deadlineAt, granted: parent.deadlineAt });
    } else {
      deadlineAt = requested.deadlineAt;
    }
  }

  const budget: ContractBudget = {
    tokens: narrowBudgetDim(parent.budget.tokens, requested.budget?.tokens),
    toolCalls: narrowBudgetDim(parent.budget.toolCalls, requested.budget?.toolCalls),
    activeTimeMs: narrowBudgetDim(parent.budget.activeTimeMs, requested.budget?.activeTimeMs),
  };
  for (const dim of ["tokens", "toolCalls", "activeTimeMs"] as const) {
    const parentDim = parent.budget[dim];
    const requestedDim = requested.budget?.[dim];
    if (requestedDim !== undefined && parentDim !== 0 && (requestedDim === 0 || requestedDim > parentDim)) {
      clamped.push({ field: `budget.${dim}`, requested: String(requestedDim === 0 ? "unlimited" : requestedDim), granted: String(parentDim) });
    }
  }

  const contract: MissionContract = {
    contractId: randomUUID(),
    parentContractId: parent.contractId,
    rootSessionId: parent.rootSessionId,
    depth: parent.depth + 1,
    objective: requested.objective ?? parent.objective,
    acceptanceCriteria: requested.acceptanceCriteria ?? [...parent.acceptanceCriteria],
    stopConditions: [...new Set([...parent.stopConditions, ...(requested.stopConditions ?? [])])],
    ...(allowedAgents !== undefined ? { allowedAgents } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    effectPolicy: { maxReversibility, ...(allowedDomains !== undefined ? { allowedDomains } : {}) },
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    budget,
    createdAt: new Date().toISOString(),
  };
  remember(contract);
  return { contract, clamped };
}

/** Narrow + audit in one step: the standard path for delegation call sites. */
export function deriveChildContract(
  parent: MissionContract,
  requested: ContractNarrowRequest,
  auditContext: { sessionId: string; taskId?: string },
): MissionContract {
  const { contract, clamped } = narrowContract(parent, requested);
  if (clamped.length > 0) {
    logAudit("contract_narrowing_clamped", {
      contractId: contract.contractId,
      parentContractId: parent.contractId,
      ...(auditContext.taskId ? { taskId: auditContext.taskId } : {}),
      clamped,
    }, { sessionId: auditContext.sessionId, severity: "warn" });
  }
  return contract;
}
