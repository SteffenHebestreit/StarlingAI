export type InterventionActionKind = "stop_turn" | "new_session" | "request_approval";

export interface InterventionAction {
  kind: InterventionActionKind;
  label: string;
  prompt?: string;
}

export interface InterventionNotice {
  reasonCode: string;
  severity: "warn" | "error";
  summary: string;
  detail: string;
  toolName?: string;
  actions: InterventionAction[];
}

const DEFAULT_ACTIONS: InterventionAction[] = [
  { kind: "stop_turn", label: "Stop this run" },
  { kind: "new_session", label: "Start a new session" },
];

const APPROVAL_STOP_PROMPT = "Stop the current external process or stuck task. Ask for approval before taking any destructive action.";

const PROCESS_ACTIONS: InterventionAction[] = [
  ...DEFAULT_ACTIONS,
  {
    kind: "request_approval",
    label: "Ask the agent to stop it with approval",
    prompt: APPROVAL_STOP_PROMPT,
  },
];

export interface ToolInterventionInput {
  toolName: string;
  success: boolean;
  output?: string;
  error?: string;
  malformedArguments?: boolean;
  outputBlocked?: boolean;
  repeatedIdenticalOutput?: boolean;
}

export function classifyToolIntervention(input: ToolInterventionInput): InterventionNotice | null {
  const toolName = input.toolName;
  const normalizedError = (input.error ?? "").toLowerCase();
  const normalizedOutput = (input.output ?? "").trim();

  if (input.repeatedIdenticalOutput) {
    return {
      reasonCode: "repeated_identical_output",
      severity: "warn",
      toolName,
      summary: `${toolName} is stuck returning the same output`,
      detail: `${toolName} has returned identical output multiple times in a row. The run is looping. Stop this run or start a fresh one with a different approach.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  if (input.malformedArguments) {
    return {
      reasonCode: "invalid_arguments",
      severity: "warn",
      toolName,
      summary: `Malformed arguments for ${toolName}`,
      detail: `The model generated invalid arguments for ${toolName}. If this repeats, stop the run or start a new one with a narrower request.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  if (input.outputBlocked) {
    return {
      reasonCode: "tool_output_blocked",
      severity: "error",
      toolName,
      summary: `Output from ${toolName} was blocked`,
      detail: `The tool returned content that tripped output guardrails. Stop this run if it keeps looping, or start a fresh one with a safer, narrower task.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  if (!input.success) {
    if (/(timed out|timeout|stalled|killed|abort|aborted|cancelled|canceled)/i.test(normalizedError)) {
      return {
        reasonCode: "tool_timeout",
        severity: "error",
        toolName,
        summary: `${toolName} appears stuck or timed out`,
        detail: `The tool did not complete in time. You can stop this run, start a new one, or ask the agent to stop the external process with approval if something is still running.`,
        actions: PROCESS_ACTIONS,
      };
    }

    if (/(approval|denied by user|requires human approval|no approval channel)/i.test(normalizedError)) {
      return {
        reasonCode: "approval_required",
        severity: "warn",
        toolName,
        summary: `${toolName} needs approval`,
        detail: `The agent could not complete ${toolName} without human approval. You can retry in a fresh run or ask the agent to perform the stop action and approve it when prompted.`,
        actions: [
          { kind: "new_session", label: "Start a new session" },
          {
            kind: "request_approval",
            label: "Ask the agent to retry with approval",
            prompt: APPROVAL_STOP_PROMPT,
          },
        ],
      };
    }

    if (/(fetch failed|network socket|tls|econnreset|econnrefused|enotfound|getaddrinfo|http \d+|searxng|reachable)/i.test(normalizedError)) {
      return {
        reasonCode: "network_failure",
        severity: "warn",
        toolName,
        summary: `${toolName} hit a network or service failure`,
        detail: `The tool could not reach its target service cleanly. You can stop this run, start a new one after the dependency recovers, or ask the agent to stop and restart the affected process with approval.`,
        actions: PROCESS_ACTIONS,
      };
    }

    return {
      reasonCode: "tool_failed",
      severity: "warn",
      toolName,
      summary: `${toolName} failed`,
      detail: `The tool returned an error. If the run is no longer making progress, stop it and start a fresh one with a tighter scope.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  if (normalizedOutput.length === 0) {
    return {
      reasonCode: "empty_output",
      severity: "warn",
      toolName,
      summary: `${toolName} returned no usable output`,
      detail: `The tool reported success but returned an empty result. If the agent keeps retrying, stop this run and start a fresh one with a clearer request.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  return null;
}

export function buildWardenIntervention(
  reasonCode: string,
  detail: string,
  subject?: string,
): InterventionNotice {
  if (reasonCode === "repeated_identical_output") {
    return {
      reasonCode,
      severity: "warn",
      summary: "Agent stuck in a tool loop",
      detail: `${detail}${subject ? ` Subject: ${subject}.` : ""} The agent is calling the same tool repeatedly with identical results. Stop this run and start a fresh one with a narrower scope.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  if (reasonCode === "tool_failure_spike") {
    return {
      reasonCode,
      severity: "warn",
      summary: "Repeated tool failures detected",
      detail: `${detail}${subject ? ` Subject: ${subject}.` : ""} You can stop the current run, start a fresh one, or ask the agent to stop the underlying process with approval if an external dependency is wedged.`,
      actions: PROCESS_ACTIONS,
    };
  }

  if (reasonCode === "turn_slo_breach") {
    return {
      reasonCode,
      severity: "warn",
      summary: "The run is exceeding latency expectations",
      detail: `${detail}${subject ? ` Subject: ${subject}.` : ""} If the run appears stuck, stop it and restart with a narrower task.`,
      actions: DEFAULT_ACTIONS,
    };
  }

  return {
    reasonCode,
    severity: "warn",
    summary: "Operator attention recommended",
    detail,
    actions: DEFAULT_ACTIONS,
  };
}