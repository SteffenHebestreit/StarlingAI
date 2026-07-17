/**
 * UX-501: Swarm Flight Recorder read model.
 *
 * Assembles, for one mission, the answers to who / what / why / when / cost
 * from the durable substrates the R0–R4 work already records — the mission
 * event store (MIS-201, lifecycle + actor + timestamps), the budget ledger
 * (BUD-203, cost), and the derived status — into one operator-facing view.
 * Read-only: it never mutates a mission (controls are mission-control.ts).
 */
import { getMissionStore, type MissionRecord, type MissionEventRecord } from "./mission-store.js";
import { getMissionBudgetSnapshot, type MissionBudgetSnapshot } from "./mission-budget.js";

export interface MissionFlightRecord {
  mission: MissionRecord;
  /** The most-recent `eventLimit` events, in ascending order. See `truncated`. */
  events: MissionEventRecord[];
  /** True when the mission has MORE events than were returned (older ones omitted). */
  truncated: boolean;
  budget: MissionBudgetSnapshot;
  summary: {
    status: MissionRecord["status"];
    eventCount: number;
    tokensSpent: number;
    toolCallsSpent: number;
    activeTimeMsSpent: number;
    lastEventAt: string;
  };
}

/** Most-recently-updated missions first, with a lightweight cost rollup each. */
export async function listMissionSummaries(limit = 100): Promise<Array<MissionRecord & { budgetTokensSpent: number }>> {
  const store = await getMissionStore();
  const missions = await store.listMissions({ limit });
  // Overlap the per-mission budget round trips instead of awaiting serially
  // (N+1 → one concurrent batch; ioredis pipelines them at the socket).
  const spends = await Promise.all(
    missions.map((m) => getMissionBudgetSnapshot(m.id).then((s) => s.spent.tokens).catch(() => 0)),
  );
  return missions.map((mission, i) => ({ ...mission, budgetTokensSpent: spends[i]! }));
}

/** Full flight record for one mission, or null when the mission is unknown. */
export async function getMissionFlightRecord(missionId: string, eventLimit = 500): Promise<MissionFlightRecord | null> {
  const store = await getMissionStore();
  const mission = await store.getMission(missionId);
  if (!mission) return null;
  // A flight recorder must show the NEWEST activity: page from the tail
  // (sequences are 1..eventCount), not the oldest `eventLimit` events.
  const fromSequence = Math.max(0, mission.eventCount - eventLimit);
  const events = await store.listMissionEvents(missionId, { fromSequence, limit: eventLimit });
  const budget = await getMissionBudgetSnapshot(missionId);
  // mission.updatedAt is the true last-activity time even when events are truncated.
  const lastEventAt = mission.updatedAt;
  return {
    mission,
    events,
    truncated: mission.eventCount > events.length,
    budget,
    summary: {
      status: mission.status,
      eventCount: mission.eventCount,
      tokensSpent: budget.spent.tokens,
      toolCallsSpent: budget.spent.toolCalls,
      activeTimeMsSpent: budget.spent.activeTimeMs,
      lastEventAt,
    },
  };
}
