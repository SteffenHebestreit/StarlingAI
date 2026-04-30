/**
 * A2A protocol — minimal JSON-RPC 2.0 + agent-card types for the Stage 12
 * Open Interop wave.  StarlingAI implements only the subset of the spec
 * (https://a2aproject.dev) needed for cross-vendor delegation: agent
 * discovery via the well-known agent card, single-turn `tasks/send`, and
 * `tasks/get` for status polling.  Streaming + multi-part artifacts are
 * out of scope for this wave but the message shape leaves room for them.
 */
export const A2A_PROTOCOL_VERSION = "0.2.0";

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  /** Free-form tag list for client-side filtering (e.g. ["search", "research"]). */
  tags?: string[];
  examples?: string[];
}

export interface A2AAgentCard {
  /** Display name advertised to peers. */
  name: string;
  /** Short description shown in peer dashboards. */
  description: string;
  /** Public URL of THIS instance's `/a2a/v1` endpoint. */
  url: string;
  /** Implementation version (StarlingAI build). */
  version: string;
  /** Spec version we speak. */
  protocolVersion: string;
  /** Default IO modes; we always default to text. */
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** Capabilities advertised — only `streaming: false` for the MVP. */
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  /** Auth schemes accepted by the peer's `/a2a/v1` endpoint. */
  authentication: { schemes: ("bearer" | "none")[] };
  /** Per-agent skills exposed by this instance. */
  skills: A2AAgentSkill[];
}

export type A2ATaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled";

export interface A2ATaskMessage {
  role: "user" | "agent";
  parts: Array<{ type: "text"; text: string }>;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2ATaskMessage;
  /** ISO timestamp of the last state transition. */
  timestamp: string;
}

export interface A2ATask {
  id: string;
  sessionId: string;
  status: A2ATaskStatus;
  artifacts?: A2ATaskMessage[];
  history?: A2ATaskMessage[];
}

/**
 * `tasks/send` parameter envelope.  We intentionally keep it minimal: the
 * skill (== agent) is selected by `agentId`, the actual user input rides
 * inside `message.parts[].text`.  Optional `metadata.context` lets the
 * caller provide supporting information without polluting the user-facing
 * task text.
 */
export interface A2ATasksSendParams {
  id?: string;
  sessionId?: string;
  agentId?: string;
  message: A2ATaskMessage;
  metadata?: Record<string, unknown>;
}

export interface A2AJsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: P;
  id: string | number | null;
}

export interface A2AJsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  result?: R;
  error?: { code: number; message: string; data?: unknown };
  id: string | number | null;
}

export const A2A_ERROR = {
  PARSE: { code: -32700, message: "Parse error" },
  INVALID: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL: { code: -32603, message: "Internal error" },
  AGENT_NOT_FOUND: { code: -32001, message: "Agent not found" },
  UNAUTHORIZED: { code: -32002, message: "Unauthorized" },
  TASK_NOT_FOUND: { code: -32004, message: "Task not found" },
} as const;
