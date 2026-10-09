/**
 * A running workflow's entry on the execution stack (RunTurnOptions._workflowExecutionStack), which
 * run_workflow's recursion check reads (tools/workflow-catalog.ts). Both places that put a workflow
 * there build the entry here: run_workflow's inline runs, and the scene worker's queued runs
 * (agent/scene-worker.ts), which import nothing else of the catalog.
 */
export function buildWorkflowExecutionKey(name: string, workflowType: "scene" | "job"): string {
  return `${workflowType}:${name}`;
}
