import { describe, expect, it } from "vitest";
import { buildEvaluationProvenance, buildVersionedEvaluationReportPath } from "../agent/evaluation-provenance.js";

const source = {
  revision: "0123456789abcdef0123456789abcdef01234567",
  diff: "diff --git a/a.ts b/a.ts\n+index 1..2 100644",
  status: " M packages/core/src/a.ts",
};

const hardware = {
  nodeVersion: "v22.12.0",
  platform: "win32",
  arch: "x64",
  release: "10.0.26100",
  totalMemoryBytes: 34_359_738_368,
  cpus: [{ model: "Test CPU" }],
};

const plan = { cases: [{ agentName: "researcher" }] };

function provenance(systemPrompt = "Research with sources.") {
  return buildEvaluationProvenance({
    plan,
    config: { subAgents: { researcher: { systemPrompt } } },
    results: [{ agentName: "researcher", stats: { model: "test/model" } }],
    source,
    hardware,
  });
}

describe("evaluation provenance", () => {
  it("is deterministic for identical eval inputs", () => {
    expect(provenance()).toEqual(provenance());
  });

  it("changes the prompt fingerprint when the effective evaluated prompt changes", () => {
    expect(provenance("Research with primary sources.").promptDigest).not.toBe(provenance().promptDigest);
  });

  it("records the transport and folds it into the source digest so a gateway run can't pose as in-process", () => {
    const inProcess = provenance();
    expect(inProcess.transport).toBe("in_process");

    const viaGateway = buildEvaluationProvenance({
      plan,
      config: { subAgents: { researcher: { systemPrompt: "Research with sources." } } },
      results: [{ agentName: "researcher", stats: { model: "test/model" } }],
      source,
      hardware,
      transport: "gateway",
    });
    expect(viaGateway.transport).toBe("gateway");
    expect(viaGateway.source.digest).not.toBe(inProcess.source.digest);
    expect(viaGateway).not.toEqual(inProcess);
  });

  it("records source state without storing raw diffs or configuration", () => {
    const report = provenance();
    expect(report.source).toEqual({
      available: true,
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: true,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(report.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.modelDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.hardware.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses a versioned report destination under artifacts/evaluations", () => {
    // The root must be absolute ON THE HOST PLATFORM. A hardcoded "F:/repo" is absolute
    // on Windows but RELATIVE on Linux, where buildVersionedEvaluationReportPath's
    // resolve() prepends the CWD — so this passed locally on Windows and failed on the
    // ubuntu CI runner ("/home/runner/.../packages/core/F:/repo/..."). Use the same root
    // the function itself defaults to (process.cwd(), i.e. packages/core under test):
    // absolute on every platform and inside the repo, so the fixture never names a path
    // outside the tree. Nothing is written — this asserts pure path construction: the
    // artifacts/evaluations directory plus the sanitized
    // <kind>-<timestamp>-<revision12>.json filename.
    const root = process.cwd();
    const expected = `${root.replace(/\\/g, "/")}/artifacts/evaluations/agent-2026-07-16T12-34-56-789Z-0123456789ab.json`;
    const path = buildVersionedEvaluationReportPath("agent", "2026-07-16T12:34:56.789Z", provenance(), root);
    expect(path.replace(/\\/g, "/")).toBe(expected);
  });
});