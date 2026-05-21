import { describe, expect, it } from "vitest";
import {
  parseSteps,
  runPipeline,
  substituteTemplates,
  type PipelineStep,
  type StepRecord,
} from "../tools/tool-pipeline.js";
import type { ToolResult } from "../tools/registry.js";

function ok(output: string): ToolResult { return { success: true, output }; }
function fail(error: string): ToolResult { return { success: false, output: "", error }; }

describe("tool pipeline — parsing", () => {
  it("assigns default ids and rejects bad input", () => {
    const parsed = parseSteps([{ tool: "read_file", args: { path: "a" } }, { tool: "web_fetch" }], 8);
    expect(Array.isArray(parsed)).toBe(true);
    const steps = parsed as PipelineStep[];
    expect(steps[0]?.id).toBe("step1");
    expect(steps[1]?.id).toBe("step2");

    expect(parseSteps([], 8)).toContain("non-empty");
    expect(parseSteps([{ args: {} }], 8)).toContain("missing a tool");
    expect(parseSteps(new Array(9).fill({ tool: "x" }), 8)).toContain("Too many steps");
    expect(parseSteps([{ id: "a", tool: "x" }, { id: "a", tool: "y" }], 8)).toContain("duplicate step id");
  });
});

describe("tool pipeline — templating", () => {
  it("substitutes a prior step output into later args", () => {
    const records: StepRecord[] = [{ id: "load", tool: "read_file", success: true, output: "HELLO" }];
    const resolved = substituteTemplates({ text: "value={{steps.load.output}}", nested: { x: ["{{steps.load.output}}"] } }, records, 4000);
    expect(resolved["text"]).toBe("value=HELLO");
    expect((resolved["nested"] as { x: string[] }).x[0]).toBe("HELLO");
  });

  it("truncates substituted output to the configured cap", () => {
    const records: StepRecord[] = [{ id: "big", tool: "t", success: true, output: "X".repeat(100) }];
    const resolved = substituteTemplates({ v: "{{steps.big.output}}" }, records, 10);
    expect(resolved["v"]).toBe("X".repeat(10));
  });

  it("leaves unknown references untouched", () => {
    const resolved = substituteTemplates({ v: "{{steps.missing.output}}" }, [], 4000);
    expect(resolved["v"]).toBe("{{steps.missing.output}}");
  });
});

describe("tool pipeline — execution", () => {
  it("runs steps in order and passes outputs forward via the guarded executor", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const execute = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
      calls.push({ tool, args });
      if (tool === "read_file") return ok("CONTENT");
      if (tool === "write_file") return ok("written");
      return ok("");
    };

    const steps = parseSteps([
      { id: "load", tool: "read_file", args: { path: "in.txt" } },
      { id: "save", tool: "write_file", args: { path: "out.txt", content: "{{steps.load.output}}" } },
    ], 8) as PipelineStep[];

    const { records, aborted } = await runPipeline(steps, { execute, stopOnError: true, maxTemplateOutputChars: 4000 });
    expect(aborted).toBe(false);
    expect(records.every((r) => r.success)).toBe(true);
    expect(calls[1]?.args["content"]).toBe("CONTENT"); // output forwarded
  });

  it("stops at the first failing step when stopOnError is true", async () => {
    const execute = async (tool: string): Promise<ToolResult> => (tool === "bad" ? fail("boom") : ok("fine"));
    const steps = parseSteps([
      { id: "a", tool: "bad", args: {} },
      { id: "b", tool: "good", args: {} },
    ], 8) as PipelineStep[];

    const { records } = await runPipeline(steps, { execute, stopOnError: true, maxTemplateOutputChars: 4000 });
    expect(records).toHaveLength(1);
    expect(records[0]?.success).toBe(false);
  });

  it("rejects steps outside the caller's allowed tool set", async () => {
    let called = false;
    const execute = async (): Promise<ToolResult> => { called = true; return ok("nope"); };
    const steps = parseSteps([
      { id: "a", tool: "read_file", args: {} },
      { id: "b", tool: "http_request", args: {} },
    ], 8) as PipelineStep[];

    const { records } = await runPipeline(steps, {
      execute,
      stopOnError: false,
      maxTemplateOutputChars: 4000,
      allowedTools: new Set(["read_file"]),
    });
    expect(records[0]?.success).toBe(true);
    expect(records[1]?.success).toBe(false);
    expect(records[1]?.error).toContain("not in this agent's allowed tool set");
    // http_request was rejected before dispatch; read_file still ran.
    expect(called).toBe(true);
  });

  it("blocks delegation/recursion tools as steps", async () => {
    let called = false;
    const execute = async (): Promise<ToolResult> => { called = true; return ok("nope"); };
    const steps = parseSteps([{ id: "x", tool: "delegate_to_agent", args: {} }], 8) as PipelineStep[];

    const { records } = await runPipeline(steps, { execute, stopOnError: true, maxTemplateOutputChars: 4000 });
    expect(called).toBe(false);
    expect(records[0]?.success).toBe(false);
    expect(records[0]?.error).toContain("not allowed inside a pipeline");
  });

  it("aborts when the signal is already aborted", async () => {
    const execute = async (): Promise<ToolResult> => ok("x");
    const controller = new AbortController();
    controller.abort();
    const steps = parseSteps([{ id: "a", tool: "read_file", args: {} }], 8) as PipelineStep[];

    const { records, aborted } = await runPipeline(steps, { execute, stopOnError: true, maxTemplateOutputChars: 4000, signal: controller.signal });
    expect(aborted).toBe(true);
    expect(records).toHaveLength(0);
  });
});
