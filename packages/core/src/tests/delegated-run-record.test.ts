import { describe, expect, it } from "vitest";
import {
  addExecutionRecord,
  capOutcomeForUnbackedFigures,
  executionRecordLine,
  noExecutionCompleted,
  readExecutionRecord,
  unbackedFiguresMasked,
  type DelegatedExecutionRecord,
} from "../agent/delegated-run-record.js";

/**
 * THE RECORD OF WHAT A DELEGATED RUN EXECUTED (E2E 2026-10-07).
 *
 * It travels as delegation metadata (specialistExecutions) through every level of a turn, and the
 * frame, the relay, the synthesis directive and the scorecard act on it. Metadata from another
 * level or an older run must read as no record, never as a wrong one.
 */
const INCIDENT: DelegatedExecutionRecord = { attempted: 7, failed: 4, succeededWithOutput: 0, unobservedFigures: 2 };

describe("reading a run's execution record", () => {
  it("keeps a well-formed record and nothing else from it", () => {
    expect(readExecutionRecord(INCIDENT)).toEqual(INCIDENT);
    expect(readExecutionRecord({ attempted: 1, failed: 0, succeededWithOutput: 1, extra: "x" })).toEqual({ attempted: 1, failed: 0, succeededWithOutput: 1 });
  });

  it("reads anything malformed as no record", () => {
    for (const value of [
      undefined,
      null,
      "7",
      [7, 4, 0],
      { attempted: 7, failed: 4 },
      { attempted: -1, failed: 0, succeededWithOutput: 0 },
      { attempted: 2.5, failed: 0, succeededWithOutput: 0 },
      { attempted: "7", failed: 4, succeededWithOutput: 0 },
      { attempted: 2, failed: 2, succeededWithOutput: 1 },
      { attempted: 7, failed: 4, succeededWithOutput: 0, unobservedFigures: -2 },
    ]) {
      expect(readExecutionRecord(value)).toBeNull();
    }
  });
});

describe("what a record says", () => {
  it("a coordinator adds its specialist's record to its own", () => {
    const own: DelegatedExecutionRecord = { attempted: 1, failed: 0, succeededWithOutput: 1 };
    addExecutionRecord(own, INCIDENT);
    addExecutionRecord(own, null);
    expect(own).toEqual({ attempted: 8, failed: 4, succeededWithOutput: 1, unobservedFigures: 2 });
    const quiet: DelegatedExecutionRecord = { attempted: 0, failed: 0, succeededWithOutput: 0 };
    addExecutionRecord(quiet, { attempted: 1, failed: 1, succeededWithOutput: 0 });
    expect(quiet).toEqual({ attempted: 1, failed: 1, succeededWithOutput: 0 });
  });

  it("the gate is open only while something ran and nothing completed with output", () => {
    expect(noExecutionCompleted(INCIDENT)).toBe(true);
    expect(noExecutionCompleted({ attempted: 3, failed: 1, succeededWithOutput: 1 })).toBe(false);
    expect(noExecutionCompleted({ attempted: 0, failed: 0, succeededWithOutput: 0 })).toBe(false);
    expect(noExecutionCompleted(null)).toBe(false);
    expect(unbackedFiguresMasked(INCIDENT)).toBe(true);
    expect(unbackedFiguresMasked({ ...INCIDENT, unobservedFigures: 0 })).toBe(false);
    expect(unbackedFiguresMasked(undefined)).toBe(false);
  });

  it("caps only a success, and only over masked figures", () => {
    expect(capOutcomeForUnbackedFigures("success", INCIDENT)).toBe("partial");
    expect(capOutcomeForUnbackedFigures("success", { ...INCIDENT, unobservedFigures: 0 })).toBe("success");
    expect(capOutcomeForUnbackedFigures("success", null)).toBe("success");
    expect(capOutcomeForUnbackedFigures("failure", INCIDENT)).toBe("failure");
    expect(capOutcomeForUnbackedFigures("partial", INCIDENT)).toBe("partial");
    expect(capOutcomeForUnbackedFigures(undefined, INCIDENT)).toBeUndefined();
  });

  it("reads as one line, in both states and in the singular", () => {
    expect(executionRecordLine(INCIDENT)).toBe("7 code executions, none completed with output (4 failed, 3 printed nothing); "
      + "2 figures in the run's account appear in no tool result and are masked as [not observed]");
    expect(executionRecordLine({ attempted: 1, failed: 1, succeededWithOutput: 0, unobservedFigures: 1 })).toBe(
      "1 code execution, none completed with output (1 failed); 1 figure in the run's account appears in no tool result and is masked as [not observed]",
    );
    expect(executionRecordLine({ attempted: 3, failed: 1, succeededWithOutput: 1 })).toBe(
      "3 code executions: 1 completed with output, 1 failed, 1 printed nothing",
    );
    // A coordinator's own entry among the runs that masked figures: the code was its specialists'.
    expect(executionRecordLine({ attempted: 0, failed: 0, succeededWithOutput: 0, unobservedFigures: 2 })).toBe(
      "ran no code itself; 2 figures in the run's account appear in no tool result and are masked as [not observed]",
    );
  });
});
