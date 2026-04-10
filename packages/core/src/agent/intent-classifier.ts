/**
 * Turn Intent Classifier
 *
 * Centralises all per-turn keyword/regex heuristics that were previously
 * scattered across the top of runtime.ts.  The runtime calls
 * `buildDynamicTurnGuidance()` and `buildLanguageAndIdentityTurnGuidance()`
 * from here rather than resolving them inline, keeping the runtime file
 * focused on the execution loop.
 *
 * No LLM calls are made here — all classification is deterministic, fast,
 * and side-effect-free.
 */

import { getConfig } from "../config/loader.js";
import { loadMainAssistantPersonality } from "../personality/service.js";
import type { MainAssistantToolMode } from "./default-tools.js";

// ── Intent term / pattern tables ─────────────────────────────────────────────

export const FRESHNESS_HINT_TERMS = [
  "aktuell", "aktuelle", "aktuellen", "heute", "jetzt", "live", "neu", "neueste", "neusten",
  "letzte ziehung", "letzten ziehung", "gewinnzahlen", "zahlen heute",
  "2025", "2026", "current", "currently", "fresh", "latest", "live", "new", "news", "now",
  "recent", "recently", "today", "updated", "updates",
];

export const SOURCE_HINT_TERMS = [
  "beleg", "belege", "offizielle quelle", "offizielle quellen", "quelle", "quellen",
  "cite", "cites", "citation", "citations", "docs", "documentation", "official", "release notes",
  "repo", "repository", "roadmap", "source", "sources", "spec", "specification", "standard",
];

export const WEB_LOOKUP_HINT_TERMS = [
  "suche online", "such online", "suche im internet", "online suchen", "recherchiere online",
  "recherchiere im internet", "im internet suchen", "search online", "search the web",
  "web search", "online search", "look it up", "look this up", "find online", "check online",
];

export const MAIL_HINT_TERMS = [
  "e-mail", "e-mails", "email", "emails", "mail", "mails", "testmail",
  "inbox", "mailbox", "mailboxes", "posteingang", "postfach",
  "draft", "drafts", "entwurf", "entwürfe", "reply", "replies", "antwort", "antworten",
];

export const MAIL_TASK_PATTERNS = [
  /\b(schreib|schreibe|verfass|verfasse|send|sende|versend|versende|draft|entwurf|reply|antworte?)\b[\s\S]{0,60}\b(e-?mail|emails?|mails?)\b/,
  /\b(lese|lies|zeige|fass zusammen|zusammenfassung|summary|summarize)\b[\s\S]{0,60}\b(e-?mail|emails?|mails?|inbox|posteingang)\b/,
];

export const PRODUCTIVITY_HINT_TERMS = [
  "remind", "reminder", "reminders", "timer", "timers", "alarm", "alarms",
  "note", "notes", "notiz", "notizen", "todo", "todos", "follow-up", "follow up",
  "remember this", "take a note", "merk dir", "erinnere mich",
];

export const PRODUCTIVITY_TASK_PATTERNS = [
  /\b(remind me|set a reminder|set reminder|erinnere mich|erinnerung)\b/,
  /\b(start|set|create)\b[\s\S]{0,40}\b(timer|alarm)\b/,
  /\b(cancel|stop|remove|delete)\b[\s\S]{0,40}\b(timer|reminder)\b/,
  /\b(note|notes|notiz|notizen|remember this|take a note|save this)\b/,
];

export const COMPUTER_ACCESS_HINT_TERMS = [
  "use my computer", "access my computer", "my computer", "my pc", "my machine",
  "remote windows pc", "remote pc", "remote desktop", "rdp", "vnc",
  "work on it", "work on my", "control my computer", "connect to my pc",
  "local desktop", "local windows desktop", "lokalen desktop", "localen desktop", "lokaler desktop",
];

export const OWNED_COMPUTER_ACCESS_PATTERNS = [
  /\b(my|our)\s+(remote\s+)?(windows\s+|linux\s+|mac\s+|macos\s+)?(pc|computer|machine|workstation|desktop|laptop)\b/,
  /\b(access|control|connect to|use|work on)\s+(my|our)\s+(remote\s+)?(windows\s+|linux\s+|mac\s+|macos\s+)?(pc|computer|machine|workstation|desktop|laptop)\b/,
];

export const SERVER_ACCESS_HINT_TERMS = [
  "my server", "our server", "n8n-server", "ssh into", "ssh to", "ssh on",
  "docker container", "docker containers", "docker ps", "docker compose",
  "systemctl", "journalctl", "kubectl", "server logs", "container logs",
];

export const SERVER_ACCESS_PATTERNS = [
  /\b(on|into|to)\s+(my|our)\s+(?:linux\s+|ubuntu\s+|debian\s+)?(?:server|host|vm|vps|instance)\b/,
  /\b(ssh|docker|systemctl|journalctl|kubectl)\b[\s\S]{0,80}\b(server|host|vm|vps|instance|container|containers|n8n(?:-server)?)\b/,
  /\b(server|host|vm|vps|instance|n8n(?:-server)?)\b[\s\S]{0,80}\b(docker|container|containers|systemctl|journalctl|ssh|logs?)\b/,
];

export const PENTEST_HINT_TERMS = [
  "pentest", "pentesting", "penetration test", "penetration testing", "security test", "security assessment", "vulnerability", "vuln", "scan",
  "nmap", "nikto", "sqlmap", "exploit", "cve", "audit", "hardening",
];

export const PENTEST_METHODOLOGY_PATTERNS = [
  /\b(how would you|how do you|what plan|which plan|what schema|which schema|what methodology|which methodology|what workflow|which workflow)\b[\s\S]{0,80}\b(pentest|pentesting|penetration test|penetration testing|security assessment)\b/,
  /\b(pentest|pentesting|penetration test|penetration testing|security assessment|pentest-agent|pentest agent|pentest_coordinator)\b[\s\S]{0,80}\b(plan|schema|methodology|workflow|playbook|steps|phases|prompt)\b/,
  /\b(check|inspect|review|read|analyze|ask)\b[\s\S]{0,80}\b(pentest[_ -]?agent|pentest[_ -]?coordinator|prompt)\b/,
  /\b(do not want to do the pentest|don't want to do the pentest|not asking you to do the pentest|wanna know what schema it follows)\b/,
];

export const SWARM_MAINTENANCE_HINT_TERMS = [
  "agent set", "agent-set", "agents-set", "main agent", "main-agent", "sub agent", "sub-agent", "subagent",
  "tool set", "tool-set", "toolset", "workspace/agents", "config assistant", "self tune", "self-tune",
  "system prompt", "prompt optimizer", "routing prompt", "swarm", "starlingai itself",
];

export const SWARM_MAINTENANCE_PATTERNS = [
  /\b(implement|add|update|improve|change|modify|wire|integrate|refine|fix)\b[\s\S]{0,100}\b(agent|agents|sub-?agents?|toolset|tool set|tools|prompt|system prompt|routing|main agent|main-assistant|swarm)\b/,
  /\b(toolset|tool set|agent set|agents-set|main agent|main-agent|workspace\/agents|config assistant)\b[\s\S]{0,100}\b(implement|update|improve|change|modify|fix|wire|integrate)\b/,
  /\b(why|check why|investigate why)\b[\s\S]{0,120}\b(does not want to implement|won't implement|refuses to implement|cannot implement|can not implement)\b/,
  /\b(not asking you to use the system|asking you to improve the system|improve starlingai|update starlingai|maintain the swarm)\b/,
];

export const NAVIGATION_HINT_TERMS = [
  "distance", "travel time", "driving time", "walking time", "route", "routing", "directions",
  "fahrzeit", "reisezeit", "wegzeit", "strecke", "entfernung", "route", "anfahrt", "fußweg",
];

export const NAVIGATION_PATTERNS = [
  /\b(how long|how far|distance|travel time|driving time|walking time|route)\b[\s\S]{0,80}\b(from|between|to)\b/,
  /\b(von|zwischen)\b[\s\S]{0,80}\b(nach|bis)\b/,
  /\b(wie lange|wie weit|fahrzeit|reisezeit|entfernung|route)\b[\s\S]{0,80}\b(von|zwischen)\b/,
];

export const WORKFLOW_HINT_TERMS = [
  "catalog", "catalogue", "chain", "job", "jobs", "playbook", "playbooks",
  "reusable", "reuse", "scene", "scenes", "workflow", "workflows",
];

export const WORKFLOW_ACTION_TERMS = [
  "chain", "combine", "execute", "find", "launch", "list", "orchestrate",
  "reuse", "run", "search", "show", "start", "trigger", "use",
];

export const WORKFLOW_DELIVERABLE_HINT_TERMS = [
  "api", "brief", "broadcast", "compare", "comparison", "diagram", "dossier",
  "inspection", "packet", "paper", "report", "research", "review", "suite",
  "test", "tests", "visual",
];

export const WORKFLOW_REQUEST_PATTERNS = [
  /\b(search|find|list|show|inspect|check)\b[\s\S]{0,80}\b(scene|scenes|job|jobs|workflow|workflows|playbook|playbooks|catalog|catalogue)\b/,
  /\b(run|execute|start|launch|trigger|use|reuse|chain|combine|orchestrate)\b[\s\S]{0,80}\b(scene|scenes|job|jobs|workflow|workflows|playbook|playbooks)\b/,
  /\b(scene|scenes|job|jobs|workflow|workflows|playbook|playbooks)\b[\s\S]{0,80}\b(run|execute|start|launch|trigger|use|reuse|chain|combine|orchestrate)\b/,
  /\b(specific|existing|available|reusable)\b[\s\S]{0,40}\b(scene|job|workflow|playbook)\b/,
  /\bchain\b[\s\S]{0,40}\b(them|these|workflows?|jobs?|scenes?)\b/,
];

export const WORKFLOW_DISCOVERY_STOP_WORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "i", "if", "in", "into", "is", "it", "me", "my", "of", "on", "or", "please",
  "show", "that", "the", "these", "this", "to", "use", "using", "with", "write", "you",
  "das", "der", "die", "ein", "eine", "für", "fuer", "im", "in", "ist", "mit",
  "oder", "schreib", "schreibe", "und", "von", "wie", "zu", "zum", "zur",
]);

export const AMBIGUOUS_SHORT_LANGUAGE_TOKENS = new Set([
  "ahoi",
  "aloha",
  "bonjour",
  "ciao",
  "hello",
  "hey",
  "hi",
  "hallo",
  "moin",
  "ok",
  "okay",
  "servus",
  "yo",
]);

// ── DynamicTurnGuidance ───────────────────────────────────────────────────────

export interface DynamicTurnGuidance {
  prompt: string;
  sourceSensitive: boolean;
  freshnessSensitive: boolean;
  mailSensitive?: boolean;
  productivitySensitive?: boolean;
  computerAccessSensitive?: boolean;
  serverAccessSensitive?: boolean;
  pentestSensitive?: boolean;
  pentestMethodologySensitive?: boolean;
  swarmMaintenanceSensitive?: boolean;
  navigationSensitive?: boolean;
}

/**
 * Classify a user message and build prompt guidance injected into the system
 * prompt for the current turn.  Returns null when no guidance is needed
 * (generic message with no detectable intent signals).
 */
export function buildDynamicTurnGuidance(userMessage: string, toolMode: MainAssistantToolMode = getConfig().agents.mainAssistant.toolMode): DynamicTurnGuidance | null {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return null;

  const freshnessSensitive = FRESHNESS_HINT_TERMS.some((term) => normalized.includes(term));
  const sourceSensitive = SOURCE_HINT_TERMS.some((term) => normalized.includes(term))
    || WEB_LOOKUP_HINT_TERMS.some((term) => normalized.includes(term));
  const mailSensitive = MAIL_HINT_TERMS.some((term) => normalized.includes(term))
    || MAIL_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
  const productivitySensitive = PRODUCTIVITY_HINT_TERMS.some((term) => normalized.includes(term))
    || PRODUCTIVITY_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
  const serverAccessSensitive = SERVER_ACCESS_HINT_TERMS.some((term) => normalized.includes(term))
    || SERVER_ACCESS_PATTERNS.some((pattern) => pattern.test(normalized));
  const computerAccessSensitive = !serverAccessSensitive && (
    COMPUTER_ACCESS_HINT_TERMS.some((term) => normalized.includes(term))
    || OWNED_COMPUTER_ACCESS_PATTERNS.some((pattern) => pattern.test(normalized))
  );
  const pentestSensitive = PENTEST_HINT_TERMS.some((term) => normalized.includes(term));
  const pentestMethodologySensitive = pentestSensitive
    && PENTEST_METHODOLOGY_PATTERNS.some((pattern) => pattern.test(normalized));
  const swarmMaintenanceSensitive = SWARM_MAINTENANCE_HINT_TERMS.some((term) => normalized.includes(term))
    || SWARM_MAINTENANCE_PATTERNS.some((pattern) => pattern.test(normalized));
  const navigationSensitive = NAVIGATION_HINT_TERMS.some((term) => normalized.includes(term))
    || NAVIGATION_PATTERNS.some((pattern) => pattern.test(normalized));

  const flags = { freshnessSensitive, sourceSensitive, mailSensitive, productivitySensitive, computerAccessSensitive, serverAccessSensitive, pentestMethodologySensitive, swarmMaintenanceSensitive, navigationSensitive };
  if (!Object.values(flags).some(Boolean)) return null;

  const reasons: string[] = [];
  if (freshnessSensitive) reasons.push("freshness-sensitive");
  if (sourceSensitive) reasons.push("source-sensitive");
  if (mailSensitive) reasons.push("mail-task");
  if (productivitySensitive) reasons.push("productivity-task");
  if (computerAccessSensitive && !pentestSensitive) reasons.push("owned-computer-access");
  if (serverAccessSensitive && !pentestSensitive) reasons.push("server-admin-access");
  if (pentestMethodologySensitive) reasons.push("pentest-methodology");
  if (swarmMaintenanceSensitive) reasons.push("swarm-maintenance");
  if (navigationSensitive) reasons.push("navigation-routing");

  const delegateMode = toolMode !== "hybrid";
  const promptParts: string[] = [];

  if (reasons.length > 0) {
    promptParts.push(`This turn is ${reasons.join(" and ")}.`);
  }

  if (computerAccessSensitive && !pentestSensitive) {
    promptParts.push(
      "The user is asking you to access or operate their own computer or remote workstation, not to run a security assessment.",
      "Do not route this request to pentest_set_scope, nmap_scan, or other pentest tools unless the user explicitly asks for scanning, vulnerability testing, or exploitation.",
      "You MUST use the delegate_to_agent tool with agentName='computer_use_agent' to handle all computer-use and VS Code interaction tasks. Pass the full user request as the task, including any specific targets like window titles, input fields, or text to type. If the user mentions a specific IP or hostname, include it in the task context so the agent can match it to a configured node or create an ad-hoc connection.",
      "Do NOT attempt to call computer_* or vscode_* tools directly — they are NOT in your tool set. Do NOT call 'computer_use_agent' as a tool name — it is an agent, not a tool. Use delegate_to_agent(agentName='computer_use_agent', task='...') instead.",
      "The computer_use_agent has access to computer_list_nodes which discovers pre-configured machines. If the user asks for a specific machine by IP, hostname, or description, include that in the delegation context. The agent will match it to a node or create an ad-hoc connection.",
      "If the user asks for their local desktop or local Windows desktop, include in the task context that the computer_use_agent should prefer adapter 'remote_node' rather than 'local_vscode' unless the user explicitly asked to control the VS Code workbench itself.",
      "If delegation to computer_use_agent returns a partial or incomplete result, you may retry delegation ONCE with a more specific task description. Do NOT fall back to calling computer_* tools directly — they are NOT in your tool set and will fail.",
      "CRITICAL: If the computer_use_agent has already failed or been exhausted for this turn, do NOT retry it again. Synthesize from whatever partial results you have and tell the user what happened.",
      "Do NOT delegate a desktop/remote-PC/screenshot task to browser_agent, researcher, or any other non-computer-use agent. Only computer_use_agent can interact with the user's desktop. If it failed, report the failure honestly instead of routing to an agent that cannot see the desktop.",
      "Ignore prior pentest-related tool results unless the user explicitly switches back to security testing.",
    );
  }

  if (serverAccessSensitive && !pentestSensitive) {
    promptParts.push(
      "The user is asking for access to a headless server, SSH host, VM, or container runtime, not for remote desktop control.",
      "Requests involving SSH, Docker, containers, systemd, journalctl, kubectl, logs, or server status are infrastructure tasks, not computer-use tasks.",
      "Do NOT route this request to computer_use_agent unless the user explicitly asks for desktop or UI interaction on that machine.",
      "For straightforward remote command execution such as 'docker ps', 'systemctl status', 'journalctl', 'df -h', or similar SSH commands, use delegate_to_agent with agentName='shell_agent'.",
      "For diagnosing service failures, unhealthy containers, deployment issues, or log-driven runtime problems on a server, use delegate_to_agent with agentName='ops_triage'.",
      "If the user names a host or IP for SSH/server work, include that host in the delegation context and keep the task in the server/CLI path rather than the desktop/computer-use path.",
      "Use pentest tools only if the user explicitly asks for a security assessment or vulnerability testing.",
    );
  }

  if (mailSensitive) {
    promptParts.push(
      "The user is asking for mailbox access, inbox triage, draft preparation, or sending email.",
      "Do NOT answer that you cannot access email or send mail if the mail_agent is available. This system has a dedicated mail_agent for those tasks.",
      "You MUST use the delegate_to_agent tool with agentName='mail_agent' for reading recent emails, searching inboxes, preparing drafts, and mailbox triage.",
      "If the user asks to send an email, route the task to mail_agent so it can prepare the draft first. Sending itself must go through mail_send_draft and requires explicit per-call approval; do not claim sending is impossible.",
      "If the target account is ambiguous, have mail_agent inspect the available mail accounts or ask one concise clarification question.",
    );
  }

  if (productivitySensitive) {
    promptParts.push(
      "The user is asking for note-taking, reminders, timers, or lightweight follow-up tracking.",
      "Do NOT answer that reminders or timers are unavailable if the productivity_agent is available. This system has a dedicated productivity_agent for those tasks.",
      "You MUST use the delegate_to_agent tool with agentName='productivity_agent' for saving notes, creating reminders, starting timers, or reviewing and cancelling them.",
      "Reminder scheduling should go through reminder_create and timer countdowns should go through timer_start inside productivity_agent; do not improvise unsupported scheduling behavior.",
      "If the timing is ambiguous, have productivity_agent ask one concise clarification question rather than guessing.",
    );
  }

  if (navigationSensitive) {
    promptParts.push(
      "The user is asking for route distance or travel time between places.",
      delegateMode
        ? "You MUST use the delegate_to_agent tool with agentName='distance_specialist' immediately when that agent exists. Pass the full origin/destination request as the task."
        : "Prefer the dedicated navigation tools or the distance_specialist for route questions instead of answering from memory.",
      delegateMode
        ? "Do NOT stop at a generic estimate or a plan to look it up. Delegate the task and then synthesize the concrete result."
        : "Resolve ambiguous places before answering and include the exact coordinates used.",
      "If the locations are ambiguous, ask one concise clarification question instead of guessing.",
      "For route answers, report the travel mode, route distance, estimated travel time, and the coordinates or resolved places used.",
      "If the user did not specify a mode, prefer driving time by default and say so clearly.",
    );
  }

  if (pentestMethodologySensitive) {
    promptParts.push(
      "The user is asking about the pentest plan, methodology, configured workflow, or pentest-agent behavior. This is NOT a request to start a live pentest engagement.",
      "Do NOT ask for authorization, target scope, asset-owner confirmation, or testing windows unless the user explicitly switches to running a real engagement.",
      delegateMode
        ? "Use delegation to inspect or explain the configured pentest workflow. Prefer pentest_coordinator in maintenance mode, or another specialist that can inspect local config and docs, instead of treating this as a live assessment request."
        : "Inspect the local pentest definitions and docs first. Prefer reading workspace/agents/30-subagents-pentest.jsonc and starlingai.example.json before answering.",
      "Summarize the actual configured phases, approval gates, and specialist handoffs. If a previous answer incorrectly asked for authorization for a methodology question, say that plainly and then give the plan.",
      "Do not call pentest_set_scope, nmap_scan, nikto_scan, sqlmap_scan, metasploit_exec, pentest_exec, or other active pentest tools for this kind of request.",
    );
  }

  if (swarmMaintenanceSensitive) {
    promptParts.push(
      "The user is asking you to improve StarlingAI itself: prompts, agents, tool routing, workspace behavior, or swarm configuration.",
      "Treat this as swarm maintenance inside the current repository, not as an external deployment-only request.",
      delegateMode
        ? "You MUST use the delegate_to_agent tool with agentName='swarm_maintainer' immediately when that agent exists. Pass the full user request as the task."
        : "Inspect the local workspace definitions first and handle the change directly when your tool set allows it.",
      delegateMode
        ? "Do NOT call search_agents or list_agents first for this class of request when swarm_maintainer exists. The specialist is already known."
        : "Do not waste time on agent discovery for this class of request.",
      delegateMode
        ? "Prefer swarm_maintainer for the full request; use prompt_optimizer for narrowly prompt-only work and integration_builder or qa_guard only when a more specific implementation specialist is clearly better."
        : "Inspect the local workspace definitions first. Prefer reading workspace/agents/*, workspace/scenes/*, and starlingai.example.json before answering.",
      "Do NOT claim that you cannot modify the toolset or agent set when the requested change is achievable through repository edits under workspace/ or other writable project files.",
      "Protected infrastructure paths under config/ still require proposal-only handling or a clearly scoped manual step; do not rewrite that boundary.",
      "If the request is to change prompts or routing behavior, make the smallest concrete repo change instead of stopping at a conceptual design.",
      "After implementing or proposing the change, summarize exactly what changed and what still needs build, apply, or approval steps.",
    );
  }

  if (freshnessSensitive || sourceSensitive) {
    promptParts.push(
      delegateMode
        ? "Do not answer from memory. Delegate immediately to a suitable specialist agent for any web lookup, freshness-sensitive fact, or browser-dependent step."
        : "Use direct web tools before answering if they are available.",
      "A tool-free answer is invalid unless prior tool results already contain the necessary evidence for this exact request.",
      delegateMode
        ? "Use delegate_to_agent for atomic specialist routing. For multi-step specialist collaboration or requests that mix research, analysis, visualization, and synthesis, delegate to a coordinator-style or planning agent first."
        : "Start with web_search. Use web_fetch only if the search snippets are insufficient.",
      delegateMode
        ? "For broad current-source deliverables like comprehensive guides, comparisons, audits, or step-by-step reports, prefer a coordinator-style agent such as web_task_coordinator over a single researcher when that specialist exists."
        : "For broad current-source deliverables like comprehensive guides, comparisons, audits, or step-by-step reports, gather evidence from multiple sources before drafting the answer. If you choose to delegate, prefer a coordinator-style agent such as web_task_coordinator over a single researcher when that specialist exists.",
      delegateMode
        ? "If the deliverable is a source-grounded paper, brief, report, or merged written artifact that needs drafting plus a quality gate, prefer mission_coordinator over a lone researcher or a web-only coordinator. Reserve web_task_coordinator for retrieval- or browser-heavy web workflows."
        : "If the deliverable is a source-grounded paper, brief, report, or merged written artifact that needs drafting plus a quality gate, plan the research, drafting, and review phases explicitly instead of treating it as a single lookup.",
      "For live factual values such as lottery numbers, prices, scores, exchange rates, dates, or schedules, copy the exact value and its associated date from the freshest tool result. Do not substitute prior knowledge or older values.",
      delegateMode
        ? "If a page is JS-driven, route it through a browser specialist. If another agent needs the extracted evidence, ensure the browser specialist publishes key facts with share_finding so downstream agents can read them via read_shared_facts."
        : "If a page appears JS-driven or incomplete in web_fetch, use browser_navigate and then browser_snapshot or browser_wait_for to inspect the rendered page.",
      delegateMode
        ? "Do not stop after a browser snapshot. Route the snapshot findings to an evidence-analysis or summarization specialist when interpretation is required."
        : "Do not claim that a site is unreadable due to JavaScript or dynamic loading unless browser tools were attempted and still failed to reveal the needed data.",
      "Prefer official specifications, repositories, release notes, and vendor documentation over commentary.",
      "If the gathered evidence is incomplete, say that clearly and ask a concise follow-up question only when missing information blocks a correct answer.",
    );
  }

  return {
    prompt: promptParts.join(" "),
    sourceSensitive,
    freshnessSensitive,
    mailSensitive,
    productivitySensitive,
    computerAccessSensitive,
    serverAccessSensitive,
    pentestSensitive,
    pentestMethodologySensitive,
    swarmMaintenanceSensitive,
    navigationSensitive,
  };
}

// ── Language / identity guidance ──────────────────────────────────────────────

export function buildLanguageAndIdentityTurnGuidance(userMessage: string): string {
  const profile = loadMainAssistantPersonality();
  const compactMessage = userMessage.trim().replace(/\s+/g, " ").slice(0, 280);
  const languageInstruction = compactMessage.length > 0
    ? buildLanguageInstructionForTurn(compactMessage)
    : "Reply in German.";
  const behaviorInstruction = shouldDefaultToGermanForMessage(compactMessage)
    ? "For short or greeting-only openings, reply with one short, polite sentence and move directly to helping. Do not use small talk. Do not introduce yourself or mention your name unless the user explicitly asks."
    : "Be polite, brief, and efficient. Avoid small talk, filler, and unnecessary pleasantries. Do not introduce yourself or mention your name unless the user explicitly asks. The user already knows they are speaking to the assistant.";
  const nameInstruction = profile.identity.name
    ? `If the user explicitly asks for your name or what to call you, use ${JSON.stringify(profile.identity.name)} as your assistant name. Do not call yourself "StarlingAI" in conversation unless the user is explicitly asking about the product or platform name.`
    : "Do not use the platform name \"StarlingAI\" as your personal name in conversation. If the user did not ask for your name, reply without naming yourself.";
  return `Language and identity for this turn: ${languageInstruction} ${behaviorInstruction} ${nameInstruction}`;
}

export function shouldDefaultToGermanForMessage(userMessage: string): boolean {
  const compactMessage = userMessage.trim().toLowerCase().replace(/\s+/g, " ");
  if (!compactMessage) return true;

  const letterCount = Array.from(compactMessage).filter((char) => /\p{L}/u.test(char)).length;
  if (letterCount < 3) return true;

  // Single-word or very short messages that are ambiguous greetings
  const tokens = compactMessage.split(/\s+/);
  if (tokens.length <= 2 && tokens.every((token) => AMBIGUOUS_SHORT_LANGUAGE_TOKENS.has(token))) {
    return true;
  }

  return false;
}

export function buildLanguageInstructionForTurn(userMessage: string): string {
  const compactMessage = userMessage.trim().replace(/\s+/g, " ").slice(0, 280);
  if (!compactMessage) return "Reply in German.";
  if (shouldDefaultToGermanForMessage(compactMessage)) {
    return `The user's latest message is ${JSON.stringify(compactMessage)}. Treat this message as language-ambiguous because it is too short or only a generic greeting. Reply in German even if the wording could also look like a short English greeting.`;
  }
  return `The user's latest message is ${JSON.stringify(compactMessage)}. Reply in the same language as that message. If the message becomes mixed or ambiguous after all, reply in German.`;
}
