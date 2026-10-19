/**
 * Inline override flags a chat message may carry (--auto, --iter, --agent, --timeout, --effort):
 * parsed by chat.send (gateway/rpc.ts), and by the harness lab for task messages written for it.
 */
import { resolveEffortTier } from "../runtime/effort-context.js";
import type { EffortTier } from "../config/schema.js";

export interface OverrideFlags {
  autoApprove: boolean;
  maxIterationsOverride?: number;
  forceAgent?: string;
  turnTimeoutSec?: number;
  effort?: EffortTier;
}

/**
 * Parse inline override flags from a message string.
 * Supported flags:
 *   --auto         — auto-approve all tool calls this turn
 *   --iter N       — override sub-agent maxIterations (0 = unlimited, else 1–50)
 *   --agent NAME   — force delegation to a specific agent
 *   --timeout N    — override turn timeout in seconds (0 = unlimited, else 10–3600)
 *   --effort TIER  — one-off effort tier for this message (low | medium | high | max)
 * Returns the cleaned message (flags stripped) and the parsed flags.
 */
export function parseOverrideFlags(message: string): { clean: string; flags: OverrideFlags } {
  let clean = message;
  const flags: OverrideFlags = { autoApprove: false };

  const effortMatch = clean.match(/--effort\s+(\S+)/i);
  if (effortMatch) {
    const tier = resolveEffortTier(effortMatch[1]);
    if (tier) flags.effort = tier;
    clean = clean.replace(/\s*--effort\s+\S+/i, "");
  }

  if (/--auto\b/.test(clean)) {
    flags.autoApprove = true;
    clean = clean.replace(/\s*--auto\b/g, "");
  }

  const iterMatch = clean.match(/--iter\s+(\d+)\b/);
  if (iterMatch) {
    const parsedIterations = parseInt(iterMatch[1]!, 10);
    // An operator who types --iter 80 gets 80. The old Math.min(50, …) silently returned
    // 50 and reported nothing, which is the same class of defect as the unbounded grant an
    // enclosing timer ignored: an explicit human number overridden in silence. 200 stays as
    // the runaway backstop (and is what --iter 0 already meant), so a typo still cannot
    // spin forever.
    flags.maxIterationsOverride = parsedIterations === 0
      ? 200
      : Math.max(1, Math.min(200, parsedIterations));
    clean = clean.replace(/\s*--iter\s+\d+\b/, "");
  }

  const agentMatch = clean.match(/--agent\s+(\S+)/);
  if (agentMatch) {
    flags.forceAgent = agentMatch[1]!;
    clean = clean.replace(/\s*--agent\s+\S+/, "");
  }

  const timeoutMatch = clean.match(/--timeout\s+(\d+)\b/);
  if (timeoutMatch) {
    const parsedTimeoutSec = parseInt(timeoutMatch[1]!, 10);
    flags.turnTimeoutSec = parsedTimeoutSec === 0
      ? 7200
      : Math.max(10, Math.min(3600, parsedTimeoutSec));
    clean = clean.replace(/\s*--timeout\s+\d+\b/, "");
  }

  return { clean: clean.trim(), flags };
}
