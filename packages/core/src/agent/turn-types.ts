/**
 * Turn-shared TYPES (god-file leaf seam).
 *
 * The public turn input/output shapes (`RunTurnOptions`, `TurnOutput`) live here
 * so the turn-preparation helpers — and any other extracted runtime-cluster
 * module — can depend on them WITHOUT importing runtime.js, breaking the type
 * cycle that an in-file definition would otherwise create.
 *
 * INVARIANT: this module imports ONLY leaf modules (session/registry/schema/
 * sub-agent/interventions/turn-metrics types). It must NEVER import from
 * runtime.js or any runtime-cluster module — keep it a true leaf.
 *
 * runtime.ts re-exports these types (`export type { TurnOutput, RunTurnOptions }
 * from "./turn-types.js"`) so every external `import { TurnOutput } from
 * ".../runtime.js"` keeps working unchanged.
 */
import type { SwarmState } from "../tools/registry.js";
import type { EffortTier } from "../config/schema.js";
import type { AgentSession, SessionTranscriptAttachment } from "./session.js";
import type { InterventionNotice } from "./interventions.js";
import type { SubAgentProgressEvent } from "./sub-agent.js";
import type { TurnPerformanceMetrics } from "./turn-metrics.js";

export interface RunTurnOptions {
  session: AgentSession;
  userMessage: string;
  userDisplayContent?: string;
  userAttachments?: SessionTranscriptAttachment[];
  onChunk?: (text: string) => void;
  /** Live chain-of-thought tokens for the main assistant turn. Streams ahead
   * of the answer; the UI shows it in a collapsible panel that auto-collapses
   * once the first answer token arrives. */
  onReasoning?: (text: string) => void;
  onStatus?: (status: { phase: string; message: string; iteration?: number }) => void;
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  onIntervention?: (notice: InterventionNotice) => void;
  onSwarmState?: (state: SwarmState) => void;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  inputCallback?: (question: string, choices?: string[], timeoutMs?: number) => Promise<string>;
  signal?: AbortSignal;
  /** Sub-agents this turn is allowed to delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** Tool names that must pause for human approval this turn (enforced unconditionally) */
  humanInLoopSteps?: string[];
  /** Auto-approve all tool calls this turn — skips the approvalCallback gate entirely. */
  autoApprove?: boolean;
  /** Override sub-agent maxIterations for delegated tasks this turn. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** When set, this turn is a tool-dev session — iteration limits are lifted. */
  _toolDevSessionId?: string;
  /** Active reusable workflow execution stack for nested workflow/self-reentry guards. Internal. */
  _workflowExecutionStack?: string[];
  /** Override the per-turn timeout in ms (replaces config gateway.turnTimeoutMs). 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Per-message Qwen3.5 thinking toggle. true = on, false = off, undefined = model default. */
  enableThinking?: boolean;
  /** Effort tier for this turn (low | medium | high | max). Selects an effort profile
   *  that overlays the orchestration/latency/reasoning knobs. Undefined → config default. */
  effortTier?: EffortTier;
}

export interface TurnOutput {
  response: string;
  toolCallsExecuted: number;
  guardrailEvents: Array<{ type: string; details: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  blocked: boolean;
  swarmState?: SwarmState;
  performance?: TurnPerformanceMetrics;
}
