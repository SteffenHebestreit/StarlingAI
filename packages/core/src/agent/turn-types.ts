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
import type { UserInputChannel } from "./user-input.js";
import type { SubAgentProgressEvent } from "./sub-agent.js";
import type { TurnPerformanceMetrics } from "./turn-metrics.js";
import type { TurnQualityScorecard } from "./turn-scorecard.js";

export interface RunTurnOptions {
  session: AgentSession;
  userMessage: string;
  userDisplayContent?: string;
  /**
   * What a person actually typed to open this turn, carried verbatim to the specialists it
   * delegates to. Set only by the chat entry points: a scene or job template in `userMessage` must
   * never be presented to a specialist as the user's words, so a caller that leaves this unset
   * gets no such block at all.
   */
  userWords?: string;
  userAttachments?: SessionTranscriptAttachment[];
  onChunk?: (text: string) => void;
  /** Live chain-of-thought tokens for the main assistant turn. Streams ahead
   * of the answer; the UI shows it in a collapsible panel that auto-collapses
   * once the first answer token arrives. */
  onReasoning?: (text: string) => void;
  onStatus?: (status: { phase: string; message: string; iteration?: number }) => void;
  /** Mid-turn messages the loop just folded into the turn, with the time of the history message
   *  that carries them. Called before the "steering" status, so a client can split the running
   *  answer there first. */
  onSteeringConsumed?: (event: { messages: Array<{ id: string; text: string }>; iteration: number; at: string }) => void;
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  onIntervention?: (notice: InterventionNotice) => void;
  onSwarmState?: (state: SwarmState) => void;
  /** D5: called with the wall-clock ms the orchestrator spent BLOCKED in a delegation tool. The
   *  gateway uses it to push its own hard-timeout out by the same amount, so the delegation-wait
   *  exclusion (orchestration.excludeDelegationWaitFromTurnBudget) holds at BOTH timeout layers. */
  onDelegationWaitMs?: (ms: number) => void;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  inputCallback?: (question: string, choices?: string[], timeoutMs?: number) => Promise<string>;
  signal?: AbortSignal;
  /** Steering token of a turn the gateway armed before calling runTurn (turn-steering.ts), so
   *  messages sent while the turn starts up are kept. Unset: the turn opens its own. */
  steeringToken?: string;
  /** The chat.send request id of this turn. Every history message the turn writes carries it, so
   *  each transcript entry names its turn (RequestContext.chatRequestId). Unset for a turn no
   *  chat.send started, a nested one included: its messages carry none. */
  requestId?: string;
  /** The chat a structured user-input request from this turn reaches (agent/user-input-broker.ts).
   *  Unset: a nested turn inherits its caller's; a top-level one has nobody to ask. */
  userInput?: UserInputChannel;
  /** Sub-agents this turn is allowed to delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** The agent the user directed this turn to (`--agent NAME`; allowedAgents narrows to it too). The
   *  turn delegates to it before it answers. */
  directiveAgent?: string;
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
  /** The turn runs a step of a workflow that is already running (tools/workflow-catalog.ts), so
   *  search_workflows and run_workflow are left out of its tools. Internal. */
  _withoutWorkflowCatalog?: boolean;
  /** The agents the step's task names, in its order (agent/workflow-step-pipeline.ts). While some of
   *  them have not run, a delegation that returned keeps the turn going instead of ending it. Internal. */
  _workflowStepPipeline?: string[];
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
  /** Canonical v2 quality payload emitted once as the terminal turn_scorecard audit event. */
  qualityScorecard?: TurnQualityScorecard;
  /** Mid-turn messages queued after the loop's last drain. Never folded in late; the client sends
   *  them on as the next turn. */
  unconsumedSteering?: Array<{ id: string; text: string }>;
}
