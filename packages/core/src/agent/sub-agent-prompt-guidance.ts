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
 * The token an unbuilt subsystem carries inside a staged build.
 *
 * The directive used to ask for a COMMENT anchor above a short stub, and session
 * a7b8fe3e is what that costs: content_writer's skeleton carried three block comments
 * named CSS_STUB, JS_PART1 and JS_PART2, filled the first, ran out of iterations, and
 * shipped a 2,684-byte index.html with a script block containing nothing but the two
 * remaining comments. Structurally perfect, completely dead, reported as complete —
 * because a comment is SILENT: it neither breaks the artifact nor names itself to any
 * checker. This marker is the opposite on both counts. It throws where it sits, so the
 * half-built artifact fails at the first attempt to use it, and it is one distinctive
 * greppable string that artifactFileLooksTruncated (sub-agent.ts) reads back off disk —
 * so the prompt half and the mechanical half agree on one literal instead of the prompt
 * asking for an anchor shape nothing downstream could recognise.
 */
export const UNFINISHED_STUB_MARKER = "UNFINISHED_STUB";

/**
 * How many times one run may burn its reasoning budget before the supervisor stops
 * trying to correct it and winds the run down.
 *
 * Two, meaning ONE correction. The first burn is a cold-start failure mode — the model
 * received a whole specification and tried to compose the answer in its head — and it is
 * worth exactly one turn to say so and demand a concrete action. A model that burns again
 * AFTER being told in plain language to stop planning is not going to be talked out of it,
 * and each burn costs ~15 minutes of GPU on the measured hardware, so the second one ends
 * the run. Raising this trades a bounded wait for a diminishing chance.
 */
export const REASONING_BURN_RETRY_LIMIT = 2;

/**
 * How many times a run may announce its next step without taking it before the loop lets it end.
 *
 * Two. Run db88fa5b returned "Now I'll fill the styles stub with the full CSS subsystem" as its
 * FINAL answer with six iterations unused, and the same session's predecessors ended on "Next
 * turn: start filling the first marker (core) via edit_file" and "I'm running out of budget — one
 * iteration remains". Three runs, three announcements, three deliveries of a scaffold. One
 * hand-back is usually enough to convert an intention into a call; a model still narrating after
 * two is narrating, and the run should end honestly rather than burn its cap being asked again.
 */
export const ANNOUNCEMENT_NUDGE_LIMIT = 2;

/**
 * The corrective turn pushed into a sub-agent's history after its FIRST reasoning burn.
 *
 * Why a correction rather than a death: run dfe964f3 measured what killing it costs.
 * web_coder burned 45,001 reasoning characters with zero tool calls, the run was wound
 * down at iteration 1 of 14, and the swarm re-dispatched the byte-identical 1,709-char
 * task to the next-ranked agent, which began burning the same way. Nothing in that loop
 * ever told the MODEL what it had done wrong. The run had thirteen unused iterations.
 *
 * The text names the measured number because a model that has just produced 45,000
 * characters of plan has no idea it did — reasoning is not in its own context on the next
 * turn, so "you have already planned this" is unfalsifiable to it unless we quote the size.
 *
 * It deliberately does NOT restate the task or suggest what to build: the specification is
 * already in the history above it, and repeating it is what invites another design pass.
 * The one thing it adds is permission to produce something incomplete, because the burn is
 * a model refusing to emit until it is sure, and "smallest thing that is real" is the only
 * instruction that dissolves that.
 */
export function buildReasoningBurnCorrection(reasoningChars: number, stagedBuild: boolean): string {
  return [
    "STOP PLANNING — YOU JUST SPENT " + reasoningChars.toLocaleString("en-US") + " CHARACTERS THINKING AND PRODUCED NOTHING.",
    "That generation was cut off. No file was written, no tool ran, and none of that thinking was kept — it is not in this conversation and you cannot recover it. Repeating it will fail the same way and end this run.",
    stagedBuild
      ? "Your next message must be exactly ONE " + STAGED_BUILD_REQUIRED_TOOLS[0] + " call creating the skeleton described in your instructions: a small, complete, closing file whose unbuilt parts are single " + UNFINISHED_STUB_MARKER + " lines that throw. Do not design those parts now. Naming them is the whole job of this turn."
      : "Your next message must be exactly ONE tool call that performs the smallest concrete step of this task. Not the whole task — the first real step.",
    "Emit that tool call immediately, before any further analysis. Something small and real beats something complete and imagined; you have more turns after this one to extend it.",
  ].join("\n");
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
 *
 * That reserve of 3 buys NO input reads, which is why the preamble spends a sentence on
 * reading. Session a7b8fe3e burned five of content_writer's ten iterations re-reading a
 * 16,091-char source file it had already read whole at iteration 1, in four chunked
 * read_file calls plus two re-reads of its own output — 54,586 bytes read against 141
 * bytes written. Passes are for writing; the raw material is already in the transcript.
 *
 * Step 3 deliberately does NOT hardcode "report the path" as the only valid finish.
 * This text is generic and is injected alongside agent prompts that end on a stricter
 * contract — backend_coder must serve_app + verify_app and return the live
 * /api/app/<id>/ URL, and a directive that closed on "report the path" would be
 * telling it the files on disk are enough. The runner keeps the agent's own prompt
 * LAST for the same reason (sub-agent.ts system-prompt assembly).
 */
export function buildStagedArtifactBuildGuidance(maxIterations: number, perPathEditCap: number): string {
  const fillPasses = Math.max(2, Math.min(maxIterations - 3, perPathEditCap));
  return [
    "STAGED BUILD — THIS TASK IS TOO LARGE FOR ONE PASS.",
    "A whole artifact emitted in a single completion does not finish on this hardware: the model reasons for tens of thousands of characters and the call is killed before any tool runs. Build the artifact in passes, ONE tool call per iteration, smallest working version first. Read each source file ONCE, whole, then work from what you read — a pass spent re-reading is a pass not spent writing, and you have few.",
    `1. SKELETON (first tool call): one write_file, a few KB, holding a minimal whole artifact whose outer structure already CLOSES (for HTML: doctype, head, body and the closing </html>) and whose content is all FINAL. Never a placeholder comment, a TODO or an empty stub body — a commented-out gap is silent, so a run that stops there leaves a file that LOOKS finished and does nothing. Write each subsystem you have not built yet as ONE line carrying the exact token ${UNFINISHED_STUB_MARKER} and its name, throwing where that line sits in executable code: throw new Error("${UNFINISHED_STUB_MARKER}: physics"); That line is both your UNIQUE anchor and the loud signal — the harness greps for it and reports an artifact still holding one as INCOMPLETE instead of delivered.`,
    `2. FILL (one subsystem per iteration, about ${fillPasses} of them): replace exactly ONE ${UNFINISHED_STUB_MARKER} line per call with edit_file, that line as old_string and the subsystem's COMPLETE content as new_string — never a partial version, never a smaller placeholder. edit_file is an EXACT string replacement and FAILS unless old_string matches exactly one place, so keep every marker name distinct and add surrounding lines rather than falling back to write_file. Use grep_files to re-locate a marker if a replacement is rejected. Never re-emit the whole file to change part of it.`,
    `3. FINISH: read_file the artifact and confirm no ${UNFINISHED_STUB_MARKER} remains. If it is an HTML page and you hold verify_page, RUN IT — verify_page executes the page's scripts and reports what they throw. A page that serves a 200 and dies on its first line looks identical to a finished one from the outside, so reading the code is not evidence it works. FAIL means fix the named error and run it again; do not report a page as done while verify_page fails. Then carry out whatever final step your own instructions require (e.g. serving and verifying the app) and report the path or the live URL — not the contents.`,
    `Budget the subsystems to the passes you have and merge the small ones. If you run out of budget the partial is handed back with its remaining ${UNFINISHED_STUB_MARKER} markers named, so it is resumable and is never mistaken for a finished artifact.`,
  ].join("\n");
}

/**
 * The staged-build first-step instruction, appended to the USER turn.
 *
 * The directive above says "SKELETON (first tool call): one write_file" and run dfe964f3
 * logged `directiveInjected: true` — so the model was told, and burned 45,001 characters
 * anyway. Placement is why. The directive is assembled into the SYSTEM prompt while the
 * specification arrives as the user turn, and a model handed a 1,709-character spec of a
 * finished artifact answers the spec. The strategy was in the room; the instruction it was
 * actually responding to was not.
 *
 * So the narrowing is repeated where the ask lives, as the LAST thing in the user turn: the
 * spec is demoted to reference material in the same breath that the turn's actual job is
 * named. This duplicates the system directive by design — the point is position, not novelty.
 *
 * It is appended, never substituted. Dropping the specification from the first turn would
 * cost the model the vocabulary it needs to NAME the subsystems, and naming them is the
 * one thing this turn has to get right.
 */
export function buildStagedBuildFirstStepInstruction(): string {
  return [
    "",
    "",
    "THIS TURN: the specification above is REFERENCE MATERIAL for later passes, not the work of this turn.",
    "Right now, produce only the skeleton — one " + STAGED_BUILD_REQUIRED_TOOLS[0] + " call, a small complete file that closes, with every part you have not built yet written as a single " + UNFINISHED_STUB_MARKER + " line that throws. Decide only what the parts are CALLED, not how they work.",
    "Do not attempt to satisfy the specification in this turn. You have further turns for that, one part at a time.",
  ].join("\n");
}

/**
 * The directive for a run whose skeleton ALREADY EXISTS on disk.
 *
 * Run 2dc5832c is the failure this replaces, and it is the worst one measured so far. The
 * staged-build classifier is size-and-tools only, so it fires identically on "build me X" and
 * on "the file exists, finish it" — and the directive it injects opens with "SKELETON (first
 * tool call): one write_file". All four delegations in that session logged
 * directiveInjected: true, and the fourth answered a finish-it task by writing a fresh
 * 4,037-byte skeleton over a file in which six of eight subsystems had just been filled by
 * thirteen iterations of edit_file. The instruction was followed exactly; it was the wrong
 * instruction.
 *
 * Detection is structural and needs no topic words: unfilled markers exist on disk, and the
 * harness is the only thing that ever writes that token. Given that, the correct first move is
 * the OPPOSITE of a skeleton, so this text inverts the two rules that matter — never write_file
 * the whole artifact, and start from what is already there.
 */
export function buildStagedBuildResumeGuidance(
  markerFiles: readonly string[],
  markerCount: number,
  markerSites: readonly { file: string; line: number; text: string }[] = [],
): string {
  const shown = markerFiles.slice(0, 4).join(", ");
  // The scan that produced this count already walked past every marker, so name them.
  // Without this the directive said "go locate them", and run 6 obeyed literally: seven of
  // fourteen iterations paging a 446-line file to find the one marker left in it. A located
  // marker is also the exact old_string edit_file needs, so this removes the search AND the
  // most common cause of a rejected replacement.
  const located = markerSites.slice(0, 12)
    .map(site => `   ${site.file}:${site.line}  ${site.text}`)
    .join("\n");
  return [
    "RESUME AN EXISTING BUILD — DO NOT START OVER.",
    `A previous pass already wrote this artifact and left ${markerCount} unfilled ${UNFINISHED_STUB_MARKER} marker(s) in: ${shown}. The work already on disk is REAL and is worth more than anything you can emit in one call.`,
    ...(located
      ? [`These are the markers, already located for you — each line below is the exact old_string to replace:\n${located}`]
      : []),
    located
      ? `1. You do NOT need to search for them. Read only the code AROUND a marker if you need its context (read_file with offset/limit), then fill it.`
      : `1. READ the file once (read_file), or ${"grep_files"} for ${UNFINISHED_STUB_MARKER} to locate the markers exactly.`,
    `2. Replace ONE ${UNFINISHED_STUB_MARKER} line per call with edit_file, that line as old_string and the subsystem's COMPLETE code as new_string. Several such calls in one turn is good and is the fastest way through.`,
    `3. FINISH: confirm no ${UNFINISHED_STUB_MARKER} remains, and if it is an HTML page and you hold verify_page, RUN IT and fix whatever it reports before saying you are done. Then carry out whatever final step your own instructions require.`,
    `NEVER call write_file on this artifact. Re-emitting the whole file replaces finished subsystems with placeholders and destroys the passes that produced them — the harness will reject such a write, and the attempt costs you an iteration.`,
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
