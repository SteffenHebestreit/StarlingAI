/**
 * Sub-Agent Prompt Guidance
 *
 * Pure prompt-section builders and task-text helpers used to assemble a
 * sub-agent's system prompt. Each function turns the run's static facts
 * (agent name, effective tool list, model id, allowed delegate targets) into a
 * guidance string, or normalizes the incoming task text. They depend only on
 * the loaded config — never on the sub-agent runner loop or its singletons —
 * so they are extracted here to keep the runner module focused on execution.
 */

import { getConfig } from "../config/loader.js";

export const ORCHESTRATION_DISCOVERY_TOOL_NAMES = new Set<string>([
  "list_agents",
  "search_agents",
  "search_tools",
  "search_workflows",
  "delegate_to_agent",
  "swarm_delegate",
  "run_workflow",
  "parallel_delegate",
  "run_task_graph",
]);

export function getEffectiveToolNames(agentName: string, configuredTools: string[] | undefined, _task: string): string[] | undefined {
  // The task-keyword-gated tool-list narrowing (computer observation-only,
  // mail read-only) was removed: routing/capability must not be decided from
  // topic words in the task text. The agent keeps its full configured tool set
  // and its own system prompt governs read-only discipline.
  return configuredTools;
}

/**
 * Tools a staged artifact build actually needs. BOTH halves are required, and the
 * pair is what makes this a capability test rather than a role guess: write_file
 * creates the skeleton, edit_file fills one stub per later pass. An agent holding
 * only one of them cannot stage anything, so the directive would be noise. This is
 * deliberately NOT ARTIFACT_PRODUCING_TOOLS (which also holds shell_exec, create_dir
 * and the one-shot generate_* emitters — none of which build in passes).
 */
export const STAGED_BUILD_REQUIRED_TOOLS = ["write_file", "edit_file"] as const;

/**
 * Task size (characters) above which a whole-artifact build must be staged.
 *
 * The live probe against the serving model bracketed the failure but did not locate
 * its knee: a 46-char task ("Write a file hello.txt containing exactly: hi") reasoned
 * 109 chars and called its tool in ~4 s, while a 2,400-char spec with 8 numbered
 * requirement groups produced 60,385 reasoning chars, ZERO tool calls, and was killed
 * at the 20-minute stream cap (run f08195d2). So the knee is somewhere in (46, 2400].
 *
 * It is NOT in the middle. The reasoning-to-task ratio over that bracket grew from
 * ~2.4x (109/46) to ~25x (60385/2400) — a 10x blow-up — so the transition sits much
 * nearer the small end than the large one. The geometric midpoint of the bracket,
 * sqrt(46 * 2400) ~= 332, is the honest centre of a multiplicative range; we round UP
 * to 600 to buy margin against false positives. 600 chars is ~150 tokens, roughly three
 * sentences: below it a delegation is an INSTRUCTION (which lands in seconds), above it
 * it is a SPECIFICATION. Staging a task that did not need it costs one extra tool call;
 * not staging one that did costs the entire run, so the asymmetry still favours firing.
 */
export const STAGED_BUILD_TASK_CHAR_THRESHOLD = 600;

/**
 * Structural classifier for "this run must build in passes": the agent can both
 * create and amend a file, and the task is a specification rather than an
 * instruction. Capability + size only — no topic words, no language tables.
 */
export function isStagedArtifactBuildRun(toolNames: string[] | undefined, task: string): boolean {
  const available = new Set(toolNames ?? []);
  if (!STAGED_BUILD_REQUIRED_TOOLS.every((toolName) => available.has(toolName))) return false;
  return task.trim().length > STAGED_BUILD_TASK_CHAR_THRESHOLD;
}

/**
 * The staged-build directive itself. Every capability it names is real: write_file
 * (mode defaults to "overwrite", mode:"append" exists), edit_file (EXACT string
 * replacement that fails on an absent or ambiguous old_string — hence the unique
 * anchors), read_file and grep_files. There is no range/line-number patch tool, so
 * the directive never mentions one.
 *
 * The pass budget is derived from the run's own maxIterations rather than fixed:
 * the runner strips every tool on the last iteration to force a synthesis, so the
 * usable build passes are maxIterations minus the skeleton, the verification read
 * and that final synthesis. It is then clamped to the runner's per-path edit_file
 * ceiling (passed in — the constant lives in the runner, which imports this module)
 * so the directive can never promise more passes than the harness will allow.
 */
export function buildStagedArtifactBuildGuidance(maxIterations: number, perPathEditCap: number): string {
  const fillPasses = Math.max(2, Math.min(maxIterations - 3, perPathEditCap));
  return [
    "STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.",
    "A whole artifact emitted in a single completion does not finish on this hardware: the model reasons for tens of thousands of characters and the call is killed before any tool runs. Build the artifact in passes, ONE tool call per iteration, smallest working version first.",
    "1. SKELETON (first tool call): one write_file with a minimal but VALID whole artifact — correct outer structure that already CLOSES (for HTML: doctype, head, body and the closing </html>), every subsystem present only as a short stub, and each stub preceded by a UNIQUE anchor comment on its own line (e.g. `<!-- SECTION: physics -->`). Keep this call to a few KB.",
    `2. FILL (one subsystem per iteration, about ${fillPasses} of them): replace exactly ONE stub per call with edit_file, passing that anchor line plus a little surrounding text as old_string. edit_file is an EXACT string replacement and FAILS unless old_string matches exactly one place, so keep every anchor distinct and add surrounding lines rather than falling back to write_file. Use grep_files to re-locate an anchor if a replacement is rejected. Never re-emit the whole file to change part of it.`,
    "3. FINISH: read_file the artifact, confirm the structure still closes and no stub anchors remain, then report the path — not the contents.",
    "Budget the subsystems to the passes you have and merge the small ones. If you run out of budget the artifact on disk is still valid and is handed back as a partial; a file that was never written is not.",
  ].join("\n");
}

export function buildTaskModeGuidance(agentName: string, _task: string): string {
  // Task-text keyword branches (mail read-only, shell/ops remote-CLI, computer
  // observation-only) were removed — guidance must not be selected from topic
  // words in the task. The agent's own system prompt carries that discipline.
  // The remaining line is agent-identity-gated (computer_use_agent), not keyword-gated.
  if (agentName === "computer_use_agent") {
    return "CREDENTIAL LOOKUP: Before making http_request calls to a service, call get_site_credentials with the hostname or short name to retrieve the stored URL, port, and API key. Do NOT guess default ports or URLs from training data.";
  }
  return "";
}

export function isDirectRemoteCliTask(agentName: string, task: string): boolean {
  if (agentName !== "shell_agent") {
    return false;
  }
  return /\b(docker\s+ps|whoami|systemctl(?:\s+status)?|journalctl|df\s+-h|uname\s+-a|ps\s+aux)\b/i.test(task)
    && /\b(ssh|server|host|docker|container|containers|n8n-server)\b/i.test(task);
}

export function buildModelExecutionGuidance(modelId: string | undefined, enableThinking: boolean | undefined): string {
  if (!modelId || !modelId.toLowerCase().includes("gemma-4-e4b-it")) {
    return "";
  }

  return [
    "MODEL FIT — COMPACT SPECIALIST EXECUTION.",
    "Keep the plan short and implicit. Do not write long preambles before acting.",
    "Prefer one decisive tool call at a time unless the current agent is explicitly coordinating parallel work.",
    "After each tool result, either make the next needed tool call immediately or stop and summarize. Do not narrate future actions.",
    "Stop as soon as the task can be completed from the current evidence. Do not keep searching for marginal improvements.",
    "If two consecutive steps fail or return no materially new evidence, report the blocker instead of looping.",
    enableThinking
      ? "Use deeper reasoning only when reconciling conflicting evidence, extracting exact conclusions from dense output, or choosing between multiple plausible next steps."
      : "Keep reasoning lightweight. Favor direct evidence extraction and deterministic tool sequences over speculative exploration.",
  ].join("\n");
}

export function isOrchestrationCapableRun(toolNames: string[] | undefined): boolean {
  return toolNames?.some((toolName) => ORCHESTRATION_DISCOVERY_TOOL_NAMES.has(toolName)) ?? false;
}

export function buildSubAgentToolInventory(toolNames: string[] | undefined): string {
  const availableTools = toolNames ?? [];
  if (availableTools.length === 0) {
    return [
      "TOOL INVENTORY",
      "No callable tools are available in this run.",
      "Do not claim to have used tools you do not have. If the task cannot be completed from the provided context alone, say so explicitly.",
    ].join("\n");
  }

  const guidance = [
    "TOOL INVENTORY",
    `You may use only these tools in this run: ${availableTools.join(", ")}`,
    "The runtime provides the real tool schemas separately. Use those exact tool definitions for names and parameters. Do not invent or paraphrase tool names.",
  ];

  const hasDirectWebResearch = availableTools.includes("web_search") || availableTools.includes("web_fetch");
  const canSearchForSpecialists = availableTools.includes("search_agents");
  const canDelegateToSpecialists = availableTools.includes("delegate_to_agent") || availableTools.includes("swarm_delegate");

  if (hasDirectWebResearch) {
    guidance.push("When the task depends on current, external, or source-sensitive facts, validate them with up-to-date web evidence whenever feasible instead of relying only on prior knowledge.");
  } else if (canSearchForSpecialists && canDelegateToSpecialists) {
    guidance.push("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, use search_agents and then delegate_to_agent to route the work to a research-capable specialist before answering.");
  } else if (canSearchForSpecialists) {
    guidance.push("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, use search_agents to identify a research-capable specialist instead of guessing.");
  } else if (canDelegateToSpecialists) {
    guidance.push("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, delegate to a research-capable specialist instead of guessing.");
  }

  if (availableTools.includes("search_agents")) {
    guidance.push("If the right specialist is not obvious, call search_agents before delegating.");
  }
  if (availableTools.includes("search_workflows")) {
    guidance.push("If the request looks like a recurring packet, paper, review, or other reusable flow, call search_workflows before inventing a new plan.");
  }
  if (availableTools.includes("list_agents")) {
    guidance.push("Call list_agents(query) — not list_agents() — when you need to browse several agent candidates at once. It requires a task description and searches semantically, same as search_agents but returns up to 10 candidates.");
  }
  if (availableTools.includes("delegate_to_agent")) {
    guidance.push("Sub-agent names are not tools. Invoke another specialist only through delegate_to_agent or swarm_delegate.");
  } else if (availableTools.includes("swarm_delegate")) {
    guidance.push("Sub-agent names are not tools. Invoke specialists through swarm_delegate and let the swarm pick the right agent.");
  }
  if (availableTools.includes("parallel_delegate")) {
    guidance.push("Use parallel_delegate only for genuinely independent partitions of work.");
  }
  if (availableTools.includes("run_task_graph")) {
    guidance.push("Use run_task_graph when later steps depend on earlier findings.");
  }
  if (availableTools.includes("run_workflow")) {
    guidance.push("Use run_workflow when a scene or job already matches the task shape closely.");
  }

  return guidance.join("\n");
}

/**
 * Compact an agent description for the inline delegation catalog. Configured
 * descriptions are written for EMBEDDING search and carry long "Example queries:"
 * bags plus multi-sentence detail — inlining 24 of them put ~12KB of padding into
 * every orchestration-capable sub-agent prompt (mission_coordinator ran at 27KB
 * while researcher ran at 4.8KB; on the prefill-bound local model that is seconds
 * of pure overhead per iteration). The catalog only needs the at-a-glance lead:
 * first sentence, examples stripped, hard cap. Semantic discovery (search_agents)
 * still sees the FULL description — this trims only the inline prompt copy.
 */
export function compactAgentCatalogDescription(description: string | undefined): string {
  const d = (description ?? "").trim();
  if (!d) return "No description available.";
  const withoutExamples = d.replace(/\s*(?:Example queries|Beispielanfragen)\s*:[\s\S]*$/i, "").trim() || d;
  const firstSentence = withoutExamples.match(/^[\s\S]{20,}?[.!?](?=\s|$)/)?.[0]?.trim() ?? withoutExamples;
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177)}…` : firstSentence;
}

export function buildSubAgentAgentDiscoveryGuidance(agentName: string, allowedAgents: string[] | undefined): string {
  const config = getConfig();
  const catalogNames = Object.keys(config.subAgents)
    .filter((name) => name !== agentName)
    .filter((name) => !allowedAgents || allowedAgents.includes(name))
    .sort((left, right) => left.localeCompare(right));

  const header = [
    "AGENT DISCOVERY",
    allowedAgents && allowedAgents.length > 0
      ? `Delegation in this run is restricted to these agents: ${allowedAgents.join(", ")}`
      : "You may delegate only to configured specialist agents that are visible in this run.",
    "If the right specialist is not obvious, search first and delegate second.",
  ];

  if (catalogNames.length === 0) {
    header.push("No other delegate targets are available in this run.");
    return header.join("\n");
  }

  const catalogLines = catalogNames.slice(0, 24).map((name) => {
    return `- ${name}: ${compactAgentCatalogDescription(config.subAgents[name]?.description)}`;
  });

  if (catalogNames.length > 24) {
    catalogLines.push(`- ${catalogNames.length - 24} more configured agents are available; use list_agents(query) or search_agents(query) to discover them semantically.`);
  }

  return [...header, ...catalogLines].join("\n");
}

export function sanitizeSubAgentTask(configuredTools: string[] | undefined, task: string): string {
  let sanitizedTask = task;
  if (configuredTools?.some((toolName: string) => toolName.startsWith("computer_"))) {
    sanitizedTask = sanitizedTask
      .replace(/(?:using|use|press|hit|with|via)\s+(?:keyboard\s+shortcut\s+)?(?:Ctrl|Alt|Shift|Cmd|Meta|Win)\+[A-Za-z+]+/gi, "using mouse clicks on visible UI elements")
      .replace(/(?:Ctrl|Alt|Cmd|Meta)\+(?:Shift|Alt)\+[A-Za-z]/gi, "(blocked shortcut — use mouse click)")
      .replace(/(?:command\s+palette|Ctrl\+Shift\+P)/gi, "visible UI elements")
      .replace(/(?:keyboard\s+shortcut|shortcut|key\s*(?:combo|combination))\s+(?:to\s+)?(?:open|toggle|show|launch)/gi, "mouse click to open");
  }
  return sanitizedTask;
}
