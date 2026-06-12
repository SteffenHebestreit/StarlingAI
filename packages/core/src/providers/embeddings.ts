/**
 * Semantic agent search via local embeddings.
 *
 * Uses LM Studio's /v1/embeddings endpoint (same OpenAI-compatible client).
 * Recommended model: "qwen3-embedding" or "nomic-embed-text"
 *
 * Gracefully falls back to keyword search if no embedding model is available.
 */
import type { LMStudioProvider } from "./lmstudio.js";
import type { SubAgentConfig } from "../config/schema.js";
import { childLogger } from "../logger.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { PRODUCT } from "../product/index.js";

const log = childLogger("embeddings");

interface EmbeddingEntry {
  agentName: string;
  description: string;
  vector: Float32Array;
}

interface EmbeddingSearchResult {
  agentName: string;
  description: string;
  score: number;
}

interface CachedEmbeddingQuery {
  storedAt: number;
  results: EmbeddingSearchResult[];
}

/** Extension-contributed routing keywords (see extension SDK `toolKeywords`). */
const EXTENSION_KEYWORD_RULES: Array<{ pattern: RegExp; keywords: string[] }> = [];

/** @internal extension-loader-only. */
export function registerExtensionToolKeywords(rules: Array<{ pattern: RegExp; keywords: string[] }>): void {
  EXTENSION_KEYWORD_RULES.push(...rules);
}

/** Test hook. */
export function _resetExtensionToolKeywordsForTests(): void {
  EXTENSION_KEYWORD_RULES.length = 0;
}

const TOOL_KEYWORD_RULES: Array<{ pattern: RegExp; keywords: string[] }> = [
  // The web_search/web_fetch rule used to inject ["news","updates","latest",
  // "current","release notes"] into every agent that owns a web tool.  That
  // pulled FRESHNESS queries to incidental web-tool holders (channel_operator,
  // prompt_optimizer, etc.) just because they happened to have web_fetch.
  // Keep "release notes" — it's a documentation-shaped artifact specific
  // to researcher's scope — but drop the news/freshness keywords; those
  // routing decisions now flow through the freshnessNewsIntent /
  // looksNewsTask heuristics rather than via tool-rule keyword inflation.
  { pattern: /web_search|web_fetch|searxng/, keywords: ["research", "web", "search", "facts", "documentation", "sources", "release notes"] },
  { pattern: /playwright|browser_/, keywords: ["browser", "automation", "login", "forms", "screenshots", "navigation", "scraping"] },
  { pattern: /code_sandbox|run_js|run_ts/, keywords: ["coding", "scripts", "execution", "analysis", "transform"] },
  { pattern: /shell_exec|run_script/, keywords: ["shell", "terminal", "devops", "ops", "commands"] },
  { pattern: /read_file|list_files|filesystem/, keywords: ["files", "workspace", "code", "analysis"] },
  { pattern: /write_file/, keywords: ["write", "draft", "report", "output"] },
  { pattern: /get_site_credentials/, keywords: ["credentials", "auth", "login", "selectors", "stored"] },
  { pattern: /site_fill_credentials/, keywords: ["credentials", "auth", "login", "forms", "password", "username", "secure fill"] },
  { pattern: /computer_type_credential/, keywords: ["credentials", "auth", "login", "desktop", "rdp", "remote desktop", "password", "username"] },
  { pattern: /delegate_to_agent/, keywords: ["orchestration", "workflow", "delegation"] },
];

const RESEARCH_INTENT_TOKENS = new Set([
  "research", "spec", "specs", "specification", "specifications", "documentation", "docs",
  "official", "principles", "design", "protocol", "api", "mcp", "a2a", "reference",
  "references", "architecture", "concepts",
]);

const WRITING_INTENT_TOKENS = new Set([
  "draft", "email", "reply", "message", "proposal", "proposals", "pitch", "cover",
  "letter", "outreach", "subject", "application",
]);

const MAIL_INTENT_TOKENS = new Set([
  "mail", "email", "emails", "inbox", "mailbox", "mailboxes", "posteingang", "postfach",
  "unread", "ungelesen", "draft", "drafts", "entwurf", "entwurfe", "reply", "replies",
]);

const GIT_VCS_TOKENS = new Set([
  "git", "commit", "branch", "merge", "rebase", "stash", "diff",
  "checkout", "pull", "push", "clone",
]);

const CODE_ANALYSIS_TOKENS = new Set([
  "explain", "review", "analyze", "analyse", "structure",
  "vulnerabilities", "security", "audit", "inspect",
]);

const CODE_CONTEXT_TOKENS = new Set([
  "code", "source", "file", "function", "class", "module",
  "codebase", "implementation",
]);

const WORKFLOW_AUTOMATION_TOKENS = new Set([
  "automation", "pipeline", "workflow", "n8n", "integrate", "integration",
  "orchestrate", "orchestration",
]);

const FRESHNESS_NEWS_TOKENS = new Set([
  "news", "latest", "recent", "current", "today", "release", "releases", "update", "updates",
  "releasenotes", "entwicklungen", "neuigkeiten", "aktuell", "aktuelle", "aktuellen", "neuesten",
  "nachrichten", "meldungen", "trends",
]);

const BROAD_DELIVERABLE_TOKENS = new Set([
  "comprehensive", "guide", "overview", "report", "summary", "update", "audit", "comparison",
  "compare", "umfangreiches", "umfangreiche", "uberblick", "überblick", "zusammenfassung", "vergleich",
]);

const AGGREGATED_NEWS_TOKENS = new Set([
  "news", "updates", "neuigkeiten", "nachrichten", "meldungen", "trends",
]);

const SCHEDULING_INTENT_TOKENS = new Set([
  "schedule", "scheduled", "scheduling", "calendar", "reminder", "reminders",
  "task", "tasks", "todo", "deadline", "due", "tomorrow", "friday", "monday",
  "tuesday", "wednesday", "thursday", "saturday", "sunday",
]);

const TTS_PHRASES: RegExp[] = [
  /\bread\s+(out|aloud)\b/,
  /\btext\s+to\s+speech\b/,
  /\bsynthesize\s+speech\b/,
  /\bnarrate\b/,
  /\bspeak\s+(this|the|it)\b/,
  /\bvoice\s+over\b/,
  /\baudio\s+narrat/,
];

const STT_PHRASES: RegExp[] = [
  /\btranscrib/,
  /\bspeech\s+to\s+text\b/,
  /\bvoice\s+memo\b/,
  /\b(audio|voice|recording)\s+to\s+text\b/,
  /\bmeeting\s+(notes|transcript|recording)/,
];

function hasPhrase(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasToken(tokens: string[], dictionary: Set<string>): boolean {
  return tokens.some((token) => dictionary.has(token));
}

function isWritingSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return keywords.some((keyword) =>
    keyword.includes("email")
    || keyword.includes("proposal")
    || keyword.includes("communication")
    || keyword.includes("outreach")
    || keyword.includes("draft")
    || keyword.includes("message")
    || keyword.includes("cover")
  ) || /(email|proposal|communication|outreach|draft|cover letter|business communicator)/.test(combined);
}

function isResearchSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  return (cfg.tools ?? []).some((tool) => tool === "web_search" || tool === "web_fetch" || tool === "workspace_search")
    || keywords.some((keyword) =>
      keyword.includes("research")
      || keyword.includes("retrieval")
      || keyword.includes("documentation")
      || keyword.includes("docs")
      || keyword.includes("search")
      || keyword.includes("sources")
      || keyword.includes("workspace")
    );
}

function isMailSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return (cfg.tools ?? []).some((tool) => tool.startsWith("mail_"))
    || keywords.some((keyword) =>
      keyword.includes("inbox")
      || keyword.includes("mailbox")
      || keyword.includes("draft")
      || keyword.includes("reply")
      || keyword.includes("triage")
      || keyword.includes("posteingang")
    )
    || /(inbox|mailbox|posteingang|draft|reply|triage|categoriz)/.test(combined);
}

function isNotificationSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.some((tool) => tool.startsWith("send_"))
    || /(notification|notifications|alert|alerts|slack|discord|telegram|channel)/.test(combined);
}

function isTtsSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return tools.some(t => t === "synthesize_speech" || t === "list_tts_voices")
    || caps.includes("text to speech") || caps.includes("voice synthesis") || caps.includes("audio narration");
}

function isSttSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return tools.some(t => t === "transcribe_audio")
    || caps.includes("audio transcription") || caps.includes("speech to text");
}

function isCodeAnalysisSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return caps.includes("code review") || caps.includes("code analysis")
    || caps.includes("code explanation") || caps.includes("architecture review");
}

function isCodeWriterSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return caps.includes("code writing") || caps.includes("code generation") || caps.includes("programming");
}

function isPromptSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  return caps.includes("prompt analysis") || caps.includes("prompt rewriting") || caps.includes("convergence tuning");
}

function isWorkflowSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  const tags = (cfg.tags ?? []).join(" ").toLowerCase();
  return caps.includes("automation") || caps.includes("workflow") || caps.includes("integration architecture")
    || tags.includes("workflow") || tags.includes("automation") || tags.includes("n8n");
}

function isApiSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.includes("http_request")
    || /(api testing|rest|graphql|http debugging|http api|endpoint validation|response validation)/.test(combined);
}

function isBrowserSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.some((tool) => tool.startsWith("browser_") || tool === "get_site_credentials" || tool === "site_fill_credentials")
    || /(browser automation|login flows|form filling|portal automation|web scraping)/.test(combined);
}

function isWorkspaceRetrievalSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.includes("workspace_search")
    || /(workspace retrieval|document retrieval|knowledge lookup|code search|workspace search)/.test(combined);
}

function isGitSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.some((tool) => tool.startsWith("git_"))
    || /(git|version control|repository review|branch management|commit management|vcs)/.test(combined);
}

function isDedicatedGitSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  return tools.some((tool) => tool.startsWith("git_"));
}

function isSourceGroundedAuthor(cfg: SubAgentConfig): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return /(source-grounded|scientific writing|paper drafting|literature review|evidence-based reports|technical paper)/.test(combined);
}

function isNavigationSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  const tags = (cfg.tags ?? []).join(" ").toLowerCase();
  return caps.includes("distance calculation")
    || caps.includes("travel time")
    || caps.includes("fahrzeit")
    || caps.includes("entfernung")
    || caps.includes("route planning")
    || tags.includes("navigation")
    || tags.includes("distance")
    || tags.includes("travel")
    || tags.includes("fahrzeit")
    || tags.includes("reisezeit")
    || tags.includes("route");
}

function isWebResearchCoordinator(cfg: SubAgentConfig): boolean {
  if (cfg.role === "coordinator" && (cfg.domain === "web" || cfg.domain === "research")) return true;
  const tools = cfg.tools ?? [];
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  const tags = (cfg.tags ?? []).join(" ").toLowerCase();
  const description = cfg.description.toLowerCase();

  const coordinates = tools.includes("delegate_to_agent") || tools.includes("parallel_delegate") || tools.includes("run_task_graph");
  const webFocus = /web|research|browser|evidence|source|retrieval/.test(`${description} ${caps} ${tags}`);
  return coordinates && webFocus;
}

function isPlanningCoordinator(cfg: SubAgentConfig): boolean {
  if (cfg.role === "coordinator" || cfg.role === "planner") return true;
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  const coordinates = tools.includes("delegate_to_agent") || tools.includes("parallel_delegate") || tools.includes("run_task_graph");
  return coordinates && /(planning|planner|coordination|coordinator|roadmap|dependencies|deliverable|workflow)/.test(combined);
}

function isQualitySupervisor(cfg: SubAgentConfig): boolean {
  if (cfg.role === "supervisor" || cfg.role === "reviewer") return true;
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return /(quality assurance|quality gate|\bqa\b|acceptance criteria|verification|supervisor|review gate|gap analysis)/.test(combined);
}

function isPentestSpecialist(cfg: SubAgentConfig): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return /(pentest|penetration test|security|offensive|exploit|vulnerability|cve|sqlmap|nikto|nmap|hydra|metasploit)/.test(combined);
}

function isComputerUseSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.some((tool) => tool.startsWith("computer_"))
    || /(computer.?use|desktop.?(control|automation|access)|remote.?desktop|rdp|screen.?control|vnc)/.test(combined);
}

function isVisualizationSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.includes("generate_chart_html")
    || tools.includes("generate_mermaid_diagram")
    || /(chart|plot|graph|diagram|visualization|visualisation|table|html chart|mermaid)/.test(combined);
}

function isDataSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.includes("metric_query")
    || tools.includes("metric_write")
    || /(data analysis|statistics|csv|json|spreadsheet|metrics|tabular|dataset|time-series|time series|data cleanup|normali[sz]ation)/.test(combined);
}

function isExecutionCoordinator(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  const coordinates = tools.includes("delegate_to_agent") || tools.includes("parallel_delegate") || tools.includes("run_task_graph");
  return coordinates && /(mission|execution|parallel|partition|dependency|dependencies|quality|orchestration)/.test(combined);
}

function isCitationResearchSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.some((tool) => tool === "web_search" || tool === "web_fetch")
    && /(citation research|citation-grade|official source lookup|source lookup|primary source|specification discovery|bibliograph)/.test(combined);
}

function isNarrativeSpecialist(cfg: SubAgentConfig, keywords: string[]): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return isWritingSpecialist(cfg, keywords)
    || /(summary|summari[sz]ation|writer|writing|paper|report|brief|synthesis)/.test(combined);
}

function isChannelOpsSpecialist(cfg: SubAgentConfig): boolean {
  const caps = (cfg.capabilities ?? []).join(" ").toLowerCase();
  const tags = (cfg.tags ?? []).join(" ").toLowerCase();
  return caps.includes("channel troubleshooting") || caps.includes("delivery diagnosis")
    || tags.includes("channels");
}

function isSchedulerSpecialist(cfg: SubAgentConfig): boolean {
  const tools = cfg.tools ?? [];
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return tools.some((tool) => /(?:add|list|update).*(?:task|calendar)|calendar|reminder/i.test(tool))
    || /(task scheduling|calendar management|reminders|due dates|scheduler|scheduling|calendar item)/.test(combined);
}

export function computeAgentIntentAdjustment(query: string, cfg: SubAgentConfig, keywords: string[]): number {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  const researchIntent = hasToken(queryTokens, RESEARCH_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /official specification/,
      /design principles/,
      /technical documentation/,
      /protocol reference/,
      /api reference/,
    ]);

  // Suppress writing intent from "message" when the query is about git (e.g. "commit message")
  const gitContext = hasToken(queryTokens, GIT_VCS_TOKENS);
  const writingIntentRaw = hasToken(queryTokens, WRITING_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /cover letter/,
      /cold outreach/,
      /draft email/,
      /write (a )?proposal/,
      /write (a )?message/,
    ]);
  const writingIntent = writingIntentRaw
    && !(gitContext && queryTokens.filter(t => WRITING_INTENT_TOKENS.has(t)).every(t => t === "message"));
  const mailIntent = hasToken(queryTokens, MAIL_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /last\s+\d+\s+emails?/,
      /recent\s+emails?/,
      /latest\s+emails?/,
      /new\s+emails?/,
      /unread\s+emails?/,
      /check.*(?:emails?|inbox|mailbox)/,
      /summari[sz]e.*(?:emails?|inbox|mailbox)/,
      /letzten?\s+\d+\s+emails?/,
      /zeige.*emails?/,
    ]);
  const inboundMailboxIntent = hasPhrase(normalizedQuery, [
    /inbox/,
    /mailbox/,
    /posteingang/,
    /unread/,
    /recent\s+emails?/,
    /latest\s+emails?/,
    /new\s+emails?/,
    /summari[sz]e.*(?:emails?|inbox|mailbox)/,
    /check.*(?:emails?|inbox|mailbox)/,
    /read.*(?:emails?|inbox|mailbox)/,
  ]);
  const outboundNotificationIntent = hasPhrase(normalizedQuery, [
    /send.*slack/,
    /send.*discord/,
    /send.*telegram/,
    /send.*notification/,
    /send.*alert/,
    /notify/,
    /notification/,
    /alert/,
    /broadcast/,
  ]);

  // Audio direction intent
  const ttsIntent = hasPhrase(normalizedQuery, TTS_PHRASES);
  const sttIntent = hasPhrase(normalizedQuery, STT_PHRASES);

  // Code analysis intent (requires both an analysis verb AND code-related context)
  const codeAnalysisIntent = hasToken(queryTokens, CODE_ANALYSIS_TOKENS)
    && hasToken(queryTokens, CODE_CONTEXT_TOKENS);

  // Workflow / automation intent
  const workflowIntent = hasToken(queryTokens, WORKFLOW_AUTOMATION_TOKENS);
  const freshnessNewsIntent = hasToken(queryTokens, FRESHNESS_NEWS_TOKENS)
    || hasPhrase(normalizedQuery, [
      /latest\s+news/,
      /recent\s+news/,
      /current\s+news/,
      /technical\s+news/,
      /tech\s+news/,
      /release\s+notes/,
      /aktuelle[nrsm]*\s+nachrichten/,
      /technische[nrsm]*\s+nachrichten/,
      /news\s+technical/,
    ]);
  const broadDeliverableIntent = hasToken(queryTokens, BROAD_DELIVERABLE_TOKENS)
    || hasPhrase(normalizedQuery, [
      /umfangreiches?\s+update/,
      /comprehensive\s+(update|overview|report)/,
      /step by step/,
      /deep dive/,
      /grosses?\s+update/,
    ]);
  const aggregatedNewsIntent = hasToken(queryTokens, AGGREGATED_NEWS_TOKENS)
    || hasPhrase(normalizedQuery, [
      /latest\s+news/,
      /recent\s+news/,
      /current\s+news/,
      /technical\s+news/,
      /tech\s+news/,
      /aktuelle[nrsm]*\s+nachrichten/,
      /technische[nrsm]*\s+nachrichten/,
      /news\s+technical/,
    ]);
  const navigationIntent = hasPhrase(normalizedQuery, [
    /\b(how long|how far|distance|travel time|driving time|walking time|route)\b[\s\S]{0,80}\b(from|between|to)\b/,
    /\b(wie lange|wie weit|fahrzeit|reisezeit|entfernung|route)\b[\s\S]{0,80}\b(von|zwischen)\b/,
    /\b(von|zwischen)\b[\s\S]{0,80}\b(nach|bis)\b/,
  ]);

  const writingSpecialist = isWritingSpecialist(cfg, keywords);
  const researchSpecialist = isResearchSpecialist(cfg, keywords);
  const mailSpecialist = isMailSpecialist(cfg, keywords);
  const notificationSpecialist = isNotificationSpecialist(cfg);
  const navigationSpecialist = isNavigationSpecialist(cfg);
  const apiSpecialist = isApiSpecialist(cfg);
  const browserSpecialist = isBrowserSpecialist(cfg);
  const workspaceRetrievalSpecialist = isWorkspaceRetrievalSpecialist(cfg);
  const gitSpecialist = isGitSpecialist(cfg);
  const dedicatedGitSpecialist = isDedicatedGitSpecialist(cfg);
  const sourceGroundedAuthor = isSourceGroundedAuthor(cfg);
  const citationResearchSpecialist = isCitationResearchSpecialist(cfg);
  const webResearchCoordinator = isWebResearchCoordinator(cfg);
  const planningCoordinator = isPlanningCoordinator(cfg);
  const qualitySupervisor = isQualitySupervisor(cfg);
  const pentestSpecialist = isPentestSpecialist(cfg);
  const visualizationSpecialist = isVisualizationSpecialist(cfg);
  const dataSpecialist = isDataSpecialist(cfg);
  const schedulerSpecialist = isSchedulerSpecialist(cfg);
  const dataHeavyIntent = /\b(data|dataset|csv|json|spreadsheet|metrics?|average|averages|trend|trends|monthly|yearly|quarterly|statistics?|analy[sz]e|analyse|calculate)\b/i.test(normalizedQuery);
  const visualizationIntent = /\b(chart|graph|plot|table|diagram|visuali[sz]ation|dashboard|mermaid)\b/i.test(normalizedQuery);
  const sequentialIntent = /\b(first|then|after|before|next|based on|using the findings|using findings|depends on|dependency|dependencies|workflow|pipeline|plan)\b/i.test(normalizedQuery);
  const synthesisIntent = /\b(compare|comparison|merge|combine|reconcile|aggregate|synthesi[sz]e|summari[sz]e)\b/i.test(normalizedQuery);
  const externalDataIntent = /\b(weather|climate|temperature|temperatures|sales|revenue|prices?|market|population|forecast|statistics?|source|sources)\b/i.test(normalizedQuery);
  const dataPreparationIntent = /\b(clean|structure|format|normalize|normalise|tabulate|reshape|organize|organise)\b/i.test(normalizedQuery)
    && /\b(data|dataset|json|csv|values?|temperatures?|metrics?|averages?)\b/i.test(normalizedQuery)
    && !/\b(create|render|generate|produce|visuali[sz]e|plot|diagram|dashboard)\b/i.test(normalizedQuery);
  const externalDataLookupIntent = externalDataIntent
    && !navigationIntent
    && !visualizationIntent
    && /\b(research|researcher|find|collect|get|gather|retrieve|lookup|look up|historical|monthly|yearly|quarterly|last year|previous year|average|averages|data)\b/i.test(normalizedQuery);
  const securityIntent = /\b(pentest|penetration|security|vulnerability|vulnerabilities|cve|exploit|scan|scanning|attack|attacks|nikto|sqlmap|nmap|hydra|metasploit|authorized scope|target host|target hosts)\b/i.test(normalizedQuery);
  const vulnerabilityResearchIntent = /\b(cve|cvss|vulnerability|vulnerabilities|advisory|advisories|exploit(?:-db)?|nvd|patch(?:es| status)?|threat intelligence)\b/i.test(normalizedQuery);
  const apiExecutionIntent = /\b(endpoint|endpoints|request|response|responses|payload|headers?|rest|graphql|http|json|validate|call|test)\b/i.test(normalizedQuery);
  const documentationLookupIntent = researchIntent && /\b(documentation|docs|spec|specification|reference|official)\b/i.test(normalizedQuery) && !apiExecutionIntent;
  const browserExecutionIntent = /\b(log ?in|login|sign ?in|fill out|submit|download)\b/i.test(normalizedQuery)
    && /\b(portal|website|site|page|form|invoice|dashboard)\b/i.test(normalizedQuery);
  const hasDesktopKeyword = /\b(meinem?\s+(?:pc|computer|rechner|desktop|workstation)|my\s+(?:pc|computer|desktop|workstation)|on\s+(?:the\s+)?(?:pc|computer|desktop|machine)\s+at|lokale[mnrs]?\s+(?:pc|computer|rechner|desktop))\b/i.test(normalizedQuery);
  const hasIpAddress = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(normalizedQuery);
  // Bare IP alone is ambiguous (could be pentest target, browser URL, etc.).
  // Only treat it as computer-use intent when paired with desktop/app context.
  const ipWithDesktopContext = hasIpAddress
    && /\b(rdp|vnc|ssh|desktop|lm\s*studio|obs|vs\s*code|app(?:lication)?|open|type|click|screenshot|launched?|running|installed|loaded|geladen|gestartet|geöffnet|bildschirm|fenster)\b/i.test(normalizedQuery)
    && !securityIntent && !browserExecutionIntent;
  const computerUseIntent = (hasDesktopKeyword || ipWithDesktopContext)
    && !securityIntent;
  const codeGenerationIntent = !codeAnalysisIntent
    && /\b(write|create|implement|build)\b/i.test(normalizedQuery)
    && /\b(function|class|script|module|component|utility|cli|program)\b/i.test(normalizedQuery);
  const sourceGroundedAuthoringIntent = writingIntent
    && /\b(paper|report|brief|review|article)\b/i.test(normalizedQuery)
    && /\b(source|sources|citation|citations|notes|evidence|collected)\b/i.test(normalizedQuery);
  const citationSourceLookupIntent = /\b(find|locate|lookup|look up|get|collect|gather)\b/i.test(normalizedQuery)
    && /\b(official|primary|source|sources|citation|citations|reference|references)\b/i.test(normalizedQuery)
    && /\b(paper|papers|report|reports|brief|briefs)\b/i.test(normalizedQuery)
    && !writingIntent;
  const schedulingIntent = hasToken(queryTokens, SCHEDULING_INTENT_TOKENS)
    || hasPhrase(normalizedQuery, [
      /schedule\s+(?:a\s+)?reminder/,
      /add\s+(?:a\s+)?new\s+task/,
      /due\s+(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/,
      /calendar\s+(?:item|event|task)/,
      /remind\s+me/,
    ]);
  const workspaceLookupIntent = /\b(workspace|project|repository|repo)\b/i.test(normalizedQuery)
    && /\b(search|find|reference|references|mention|mentions|files?|where|all)\b/i.test(normalizedQuery);
  const channelMentions = ["slack", "discord", "telegram", "email", "mail"].filter((channel) => new RegExp(`\\b${channel}\\b`, "i").test(normalizedQuery)).length;
  const multiChannelNotificationIntent = outboundNotificationIntent || (/\bsend\b/i.test(normalizedQuery) && channelMentions >= 2);
  const qualityGateIntent = hasPhrase(normalizedQuery, [
    /quality\s+check/,
    /qa\s+check/,
    /acceptance\s+criteria/,
    /meets?\s+the\s+requirements/,
    /met\s+the\s+requirements/,
    /good\s+enough/,
    /verify\s+(the\s+)?(draft|response|answer|deliverable)/,
    /review\s+(the\s+)?(draft|response|answer|deliverable)\s+against/,
    /should\s+we\s+rerun/,
    /another\s+(targeted\s+)?run/,
  ]);

  const compositeIntent = sequentialIntent
    || (visualizationIntent && (externalDataIntent || dataHeavyIntent || researchIntent || freshnessNewsIntent))
    || (synthesisIntent && ((researchIntent ? 1 : 0) + (dataHeavyIntent ? 1 : 0) + (writingIntent ? 1 : 0) >= 2))
    || (broadDeliverableIntent && ((researchIntent ? 1 : 0) + (dataHeavyIntent ? 1 : 0) + (visualizationIntent ? 1 : 0) + (writingIntent ? 1 : 0) >= 2));

  let adjustment = 0;

  // ── Research vs writing ──
  if (researchIntent && !writingIntent) {
    if (researchSpecialist) adjustment += 0.12;
    if (writingSpecialist && !researchSpecialist) adjustment -= 0.25;
  }

  if (writingIntent) {
    if (writingSpecialist) adjustment += 0.1;
    if (researchSpecialist && !writingSpecialist) adjustment -= 0.04;
  }

  if (documentationLookupIntent) {
    if (researchSpecialist && !citationResearchSpecialist) adjustment += 0.12;
    if (apiSpecialist) adjustment -= 0.14;
  }

  if (apiExecutionIntent && !documentationLookupIntent) {
    if (apiSpecialist) adjustment += 0.14;
    if (researchSpecialist && !apiSpecialist) adjustment -= 0.05;
  }

  // ── Mailbox triage / reading / drafting ──
  if (mailIntent) {
    if (mailSpecialist) adjustment += 0.38;
    if (researchSpecialist && !mailSpecialist) adjustment -= 0.12;
  }

  if (inboundMailboxIntent) {
    if (mailSpecialist) adjustment += 0.22;
    if (notificationSpecialist && !mailSpecialist) adjustment -= 0.28;
  }

  if (outboundNotificationIntent) {
    if (notificationSpecialist) adjustment += 0.16;
    if (mailSpecialist && !notificationSpecialist) adjustment -= 0.06;
  }

  if (multiChannelNotificationIntent) {
    if (notificationSpecialist) adjustment += 0.2;
    if (writingSpecialist && !notificationSpecialist) adjustment -= 0.16;
    if (mailSpecialist && !notificationSpecialist) adjustment -= 0.12;
  }

  // ── TTS vs STT ──
  if (ttsIntent && !sttIntent) {
    if (isTtsSpecialist(cfg)) adjustment += 0.12;
    if (isSttSpecialist(cfg) && !isTtsSpecialist(cfg)) adjustment -= 0.15;
  }
  if (sttIntent && !ttsIntent) {
    if (isSttSpecialist(cfg)) adjustment += 0.12;
    if (isTtsSpecialist(cfg) && !isSttSpecialist(cfg)) adjustment -= 0.15;
  }

  // ── Code analysis vs code writing / prompt optimization ──
  if (codeAnalysisIntent) {
    if (isCodeAnalysisSpecialist(cfg)) adjustment += 0.12;
    if (isCodeWriterSpecialist(cfg) && !isCodeAnalysisSpecialist(cfg)) adjustment -= 0.08;
    if (isPromptSpecialist(cfg)) adjustment -= 0.12;
  }

  if (codeGenerationIntent) {
    if (isCodeWriterSpecialist(cfg)) adjustment += 0.18;
    if (dataSpecialist && !isCodeWriterSpecialist(cfg)) adjustment -= 0.14;
    if (researchSpecialist && !isCodeWriterSpecialist(cfg)) adjustment -= 0.06;
  }

  if (browserExecutionIntent && !compositeIntent) {
    if (browserSpecialist) adjustment += 0.22;
    if (webResearchCoordinator) adjustment -= 0.14;
    if (researchSpecialist && !browserSpecialist) adjustment -= 0.08;
  }

  if (vulnerabilityResearchIntent) {
    if (pentestSpecialist) adjustment += 0.24;
    else if (researchSpecialist) adjustment += 0.12;

    if (navigationSpecialist) adjustment -= 0.9;
    if (mailSpecialist) adjustment -= 0.18;
    if (writingSpecialist && !pentestSpecialist && !researchSpecialist) adjustment -= 0.14;
  }

  // ── Computer-use / remote desktop access ──
  if (computerUseIntent) {
    if (isComputerUseSpecialist(cfg)) adjustment += 0.48;
    if (browserSpecialist && !isComputerUseSpecialist(cfg)) adjustment -= 0.3;
    if (researchSpecialist && !isComputerUseSpecialist(cfg)) adjustment -= 0.2;
    if (planningCoordinator && !isComputerUseSpecialist(cfg)) adjustment -= 0.15;
  }

  if (externalDataLookupIntent) {
    if (researchSpecialist && !citationResearchSpecialist) adjustment += 0.4;
    else if (webResearchCoordinator) adjustment += 0.12;
    if (dataSpecialist && !researchSpecialist) adjustment -= 0.24;
    if (visualizationSpecialist && !researchSpecialist) adjustment -= 0.28;
    if (navigationSpecialist) adjustment -= 0.34;
    if (writingSpecialist && !researchSpecialist) adjustment -= 0.08;
  }

  if (dataPreparationIntent) {
    if (dataSpecialist) adjustment += 0.28;
    if (visualizationSpecialist) adjustment -= 0.24;
    if (researchSpecialist && !dataSpecialist) adjustment -= 0.08;
  }

  // ── Workflow automation vs channel ops ──
  if (workflowIntent) {
    if (isWorkflowSpecialist(cfg)) adjustment += 0.1;
    if (isChannelOpsSpecialist(cfg) && !isWorkflowSpecialist(cfg)) adjustment -= 0.08;
    if (writingSpecialist && !isWorkflowSpecialist(cfg)) adjustment -= 0.1;
    if (mailSpecialist && !isWorkflowSpecialist(cfg)) adjustment -= 0.08;
  }

  if (workspaceLookupIntent) {
    if (workspaceRetrievalSpecialist) adjustment += 0.18;
    if (webResearchCoordinator) adjustment -= 0.14;
    if (apiSpecialist) adjustment -= 0.08;
  }

  if (gitContext && !schedulingIntent) {
    if (dedicatedGitSpecialist) adjustment += 0.2;
    else if (gitSpecialist) adjustment += 0.08;
    if (writingSpecialist && !gitSpecialist) adjustment -= 0.08;
  }

  if (sourceGroundedAuthoringIntent) {
    if (sourceGroundedAuthor) adjustment += 0.32;
    if (writingSpecialist && sourceGroundedAuthor) adjustment += 0.08;
    if (citationResearchSpecialist && !sourceGroundedAuthor) adjustment -= 0.24;
    if (researchSpecialist && !sourceGroundedAuthor) adjustment -= 0.1;
  }

  if (citationSourceLookupIntent) {
    if (citationResearchSpecialist) adjustment += 0.34;
    if (sourceGroundedAuthor) adjustment -= 0.22;
    if (researchSpecialist && !citationResearchSpecialist) adjustment += 0.08;
  }

  if (schedulingIntent) {
    if (schedulerSpecialist) adjustment += 0.34;
    if (gitSpecialist && !schedulerSpecialist) adjustment -= 0.22;
    if (writingSpecialist && !schedulerSpecialist) adjustment -= 0.06;
  }

  // ── Fresh/current news and release updates ──
  if (freshnessNewsIntent) {
    if (webResearchCoordinator) {
      if (aggregatedNewsIntent) adjustment += broadDeliverableIntent ? 0.36 : 0.28;
      else adjustment += broadDeliverableIntent ? 0.26 : 0.18;
    } else if (researchSpecialist) {
      if (aggregatedNewsIntent) adjustment += broadDeliverableIntent ? 0.14 : 0.1;
      else adjustment += broadDeliverableIntent ? 0.18 : 0.14;
    }

    if (navigationSpecialist) adjustment -= 0.28;
    if (writingSpecialist && !researchSpecialist) adjustment -= 0.08;
    if (mailSpecialist) adjustment -= 0.1;
  }

  // ── Composite / dependency-heavy missions ──
  if (compositeIntent) {
    if (planningCoordinator && (!pentestSpecialist || securityIntent)) adjustment += 0.24;
    else if (webResearchCoordinator && (researchIntent || freshnessNewsIntent || externalDataIntent)) adjustment += 0.1;

    if (researchSpecialist && !planningCoordinator && visualizationIntent) adjustment -= 0.06;
    if (writingSpecialist && !planningCoordinator && (dataHeavyIntent || visualizationIntent)) adjustment -= 0.04;
  }

  if (pentestSpecialist && !securityIntent) {
    adjustment -= compositeIntent ? 0.28 : 0.18;
  }

  if (navigationSpecialist && !navigationIntent && (visualizationIntent || dataHeavyIntent || externalDataIntent || compositeIntent || externalDataLookupIntent)) {
    adjustment -= 0.22;
  }

  if (visualizationIntent) {
    if (visualizationSpecialist) adjustment += (dataHeavyIntent || externalDataIntent || researchIntent) ? 0.2 : 0.12;
    if (writingSpecialist && !visualizationSpecialist) adjustment -= 0.08;
    if (researchSpecialist && !visualizationSpecialist && !planningCoordinator && dataHeavyIntent) adjustment -= 0.04;
  }

  if (qualityGateIntent) {
    if (qualitySupervisor) adjustment += 0.28;
    if (planningCoordinator && !qualitySupervisor) adjustment += 0.06;
    if (researchSpecialist && !qualitySupervisor) adjustment -= 0.06;
    if (writingSpecialist && !qualitySupervisor) adjustment -= 0.08;
  }

  // ── Navigation / route distance ──
  if (navigationIntent) {
    if (navigationSpecialist) adjustment += 0.42;
    if (researchSpecialist && !navigationSpecialist) adjustment -= 0.12;
    if (writingSpecialist && !navigationSpecialist) adjustment -= 0.18;
  }

  return adjustment;
}

export function computeAgentTaskShapeAdjustment(query: string, cfg: SubAgentConfig): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const inferredKeywords = inferAgentSearchKeywords("shape", cfg);
  const webResearchCoordinator = isWebResearchCoordinator(cfg);
  const planningCoordinator = isPlanningCoordinator(cfg);
  const executionCoordinator = isExecutionCoordinator(cfg);
  const visualizationSpecialist = isVisualizationSpecialist(cfg);
  const dataSpecialist = isDataSpecialist(cfg);
  const researchSpecialist = isResearchSpecialist(cfg, inferredKeywords);
  const narrativeSpecialist = isNarrativeSpecialist(cfg, inferredKeywords);
  const sourceGroundedAuthor = isSourceGroundedAuthor(cfg);
  const citationResearchSpecialist = isCitationResearchSpecialist(cfg);

  const sourceAcquisitionIntent = /\b(official|source|sources|citation|citations|documentation|docs|reference|references|latest|current|recent|today|now|last year)\b/i.test(normalizedQuery);
  const externalDomainIntent = /\b(weather|climate|temperature|temperatures|sales|revenue|prices?|market|population|forecast|benchmark|benchmarks|statistics?)\b/i.test(normalizedQuery);
  const structuredAnalysisIntent = /\b(data|dataset|csv|json|spreadsheet|metrics?|average|averages|trend|trends|monthly|yearly|quarterly|statistics?|analy[sz]e|analyse|calculate|normalize|normalise|clean|tabulate|aggregate)\b/i.test(normalizedQuery);
  const visualizationIntent = /\b(chart|graph|plot|table|diagram|visuali[sz]ation|dashboard|mermaid|html)\b/i.test(normalizedQuery);
  const browserIntent = /\b(browser|website|portal|page|login|log in|form|click|scrape|scraping|navigate|interactive)\b/i.test(normalizedQuery);
  const sequentialIntent = /\b(first|then|after|before|next|depends on|dependency|dependencies|workflow|pipeline|plan)\b/i.test(normalizedQuery);
  const groundedInputIntent = /\b(already|verified|provided|given|attached|collected|existing|these|this data|the data|following|from these|from this|using the verified|using the collected)\b/i.test(normalizedQuery);
  const citationIntent = /\b(citation|citations|bibliograph|paper|papers|report|reports|brief|briefs)\b/i.test(normalizedQuery);
  const newsIntent = /\b(news|update|updates|release|releases|release notes|trend|trends|nachrichten|neuigkeiten|aktuell|aktuelle|aktuellen)\b/i.test(normalizedQuery);
  const pureStructuredAnalysisIntent = structuredAnalysisIntent
    && !visualizationIntent
    && !sourceAcquisitionIntent
    && !browserIntent;
  const externalDataResearchIntent = externalDomainIntent
    && !visualizationIntent
    && !browserIntent
    && !groundedInputIntent
    && /\b(find|collect|get|gather|retrieve|historical|monthly|yearly|quarterly|last year|previous year|average|averages|data)\b/i.test(normalizedQuery);
  const dataPreparationIntent = pureStructuredAnalysisIntent
    && /\b(clean|structure|format|normalize|normalise|tabulate|reshape|organize|organise)\b/i.test(normalizedQuery);
  const evidenceAuthorshipIntent = groundedInputIntent
    && /\b(write|draft|author|compose|prepare)\b/i.test(normalizedQuery)
    && /\b(paper|papers|report|reports|brief|briefs|review|article)\b/i.test(normalizedQuery)
    && /\b(notes|citation|citations|evidence|findings|sources)\b/i.test(normalizedQuery)
    && !/\b(find|search|look up|lookup|collect|gather|get|fetch)\b/i.test(normalizedQuery);

  const renderFromEvidenceIntent = groundedInputIntent
    && visualizationIntent
    && !sourceAcquisitionIntent
    && !externalDomainIntent
    && !sequentialIntent;

  const evidenceToArtifactWorkflow = visualizationIntent
    && (sourceAcquisitionIntent || externalDomainIntent || structuredAnalysisIntent)
    && (!renderFromEvidenceIntent || sequentialIntent);

  let adjustment = 0;

  if (renderFromEvidenceIntent) {
    if (visualizationSpecialist) adjustment += 0.24;
    if (planningCoordinator) adjustment -= 0.14;
    if (researchSpecialist && !visualizationSpecialist && !planningCoordinator) adjustment -= 0.08;
    if (narrativeSpecialist && !visualizationSpecialist) adjustment -= 0.12;
  }

  if (evidenceToArtifactWorkflow) {
    if (executionCoordinator) adjustment += 0.24;
    else if (planningCoordinator) adjustment += 0.12;

    if (webResearchCoordinator && browserIntent) adjustment += 0.08;
    else if (webResearchCoordinator && !browserIntent && structuredAnalysisIntent && visualizationIntent) adjustment -= 0.08;
    else if (webResearchCoordinator && !browserIntent && structuredAnalysisIntent) adjustment -= 0.03;

    if (visualizationSpecialist && !planningCoordinator && !renderFromEvidenceIntent) adjustment -= 0.08;
    if (narrativeSpecialist && !planningCoordinator) adjustment -= 0.1;
  }

  if (pureStructuredAnalysisIntent) {
    if (dataSpecialist) adjustment += 0.12;
    if (visualizationSpecialist && !dataSpecialist) adjustment -= 0.18;
    if (planningCoordinator) adjustment -= 0.06;
    if (narrativeSpecialist && !dataSpecialist) adjustment -= 0.08;
  }

  if (externalDataResearchIntent) {
    if (researchSpecialist && !citationResearchSpecialist) adjustment += 0.24;
    if (dataSpecialist && !researchSpecialist) adjustment -= 0.18;
    if (visualizationSpecialist && !researchSpecialist) adjustment -= 0.2;
    if (planningCoordinator) adjustment -= 0.06;
    if (narrativeSpecialist && !researchSpecialist) adjustment -= 0.08;
  }

  if (dataPreparationIntent) {
    if (dataSpecialist) adjustment += 0.18;
    if (visualizationSpecialist && !dataSpecialist) adjustment -= 0.18;
    if (planningCoordinator) adjustment -= 0.04;
  }

  if (evidenceAuthorshipIntent) {
    if (sourceGroundedAuthor) adjustment += 0.28;
    else if (narrativeSpecialist) adjustment += 0.14;

    if (citationResearchSpecialist && !sourceGroundedAuthor) adjustment -= 0.18;
    if (researchSpecialist && !sourceGroundedAuthor && !citationResearchSpecialist) adjustment -= 0.06;
    if (planningCoordinator) adjustment -= 0.08;
  }

  if (sourceAcquisitionIntent && !visualizationIntent && !structuredAnalysisIntent) {
    if (webResearchCoordinator) adjustment += newsIntent ? 0.12 : 0.08;
    else if (researchSpecialist && !planningCoordinator && !citationResearchSpecialist) adjustment += newsIntent ? 0.1 : 0.08;

    if (!citationIntent && citationResearchSpecialist) adjustment -= 0.06;
  }

  if (newsIntent && !visualizationIntent && !structuredAnalysisIntent && !sourceAcquisitionIntent) {
    if (webResearchCoordinator) adjustment += 0.1;
    else if (researchSpecialist && !planningCoordinator) adjustment += 0.08;
  }

  return Math.max(-0.3, Math.min(0.3, adjustment));
}

let _index: EmbeddingEntry[] = [];
let _available = false;
let _embeddingModel = "";
const _queryCache = new Map<string, CachedEmbeddingQuery>();
// Raw query-vector cache (distinct from `_queryCache`, which holds post-search
// `EmbeddingSearchResult[]`). Keyed by `${embeddingModel}::${normalized query}`.
// Hit by tool rerank, trajectory cache, and memory service — all of which
// previously fired an HTTP embedding call per invocation.
type CachedQueryVector = { storedAt: number; vector: Float32Array };
const _queryVectorCache = new Map<string, CachedQueryVector>();
const _queryVectorInflight = new Map<string, Promise<Float32Array | null>>();
let _lastProvider: LMStudioProvider | null = null;
let _lastSubAgents: Record<string, SubAgentConfig> = {};
let _lastEmbeddingError: string | undefined;
let _lastEmbeddingFailedAgent: string | undefined;
let _lastEmbeddingFailureAt: string | undefined;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _retryDelayMs = 0;
// Concurrency guard: only one buildAgentIndex may run at a time.
// If a second call arrives while one is in progress, it is coalesced into a
// single follow-up build so callers never see stale data but the embedding
// endpoint is never flooded with duplicate batches.
let _buildInProgress = false;
let _pendingBuild: { subAgents: Record<string, SubAgentConfig>; provider: LMStudioProvider; embeddingModel: string } | null = null;

const QUERY_CACHE_TTL_MS = 5 * 60_000;
const QUERY_CACHE_MAX_ENTRIES = 64;
const QUERY_VECTOR_CACHE_TTL_MS = 5 * 60_000;
const QUERY_VECTOR_CACHE_MAX_ENTRIES = 256;
const EMBEDDING_RETRY_INITIAL_DELAY_MS = 15_000;
const EMBEDDING_RETRY_MAX_DELAY_MS = 120_000;
const SEARCH_STOP_WORDS = new Set<string>([
  // English functional / auxiliary words
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
  "can", "check", "could", "do", "does", "for", "from",
  "get", "give", "has", "have", "how", "i", "if", "in", "is", "it",
  "its", "me", "most", "my", "no", "not", "of", "on", "ones", "or", "our",
  "please", "set", "show", "so", "such", "that", "top", "up",
  "each", "every", "last", "used", "via", "was", "what", "when", "where",
  "tell", "the", "their", "them", "these", "this", "those", "to", "us", "we", "with", "you",
  // German functional words
  "de", "der", "die", "das", "dem", "den", "des", "ein", "eine", "einer", "eines", "und",
  "für", "fuer", "im", "in", "ist", "kann", "kannst", "meine", "meinen", "meiner", "meines",
  "mir", "uns", "zeige", "alle", "auch", "auf", "aus", "bei", "bis", "du", "er", "es",
  "hat", "hier", "ich", "ihm", "ihn", "ihr", "kein", "keine", "noch", "nur", "oder",
  "sei", "seit", "sie", "so", "von", "vor", "war", "wie", "wo", "zu", "zum", "zur",
]);

export interface EmbeddingSearchStatus {
  configured: boolean;
  available: boolean;
  model: string | null;
  indexedAgentCount: number;
  totalAgentCount: number;
  retryScheduled: boolean;
  retryDelayMs: number;
  lastError?: string;
  lastFailedAgent?: string;
  lastFailureAt?: string;
}

function summarizeEmbeddingError(err: unknown): string {
  const value = err instanceof Error
    ? err.message || err.toString()
    : String(err);
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown embedding error";
}

function recordEmbeddingFailure(err: unknown, failedAgent?: string): void {
  _lastEmbeddingError = summarizeEmbeddingError(err);
  _lastEmbeddingFailedAgent = failedAgent;
  _lastEmbeddingFailureAt = new Date().toISOString();
}

function clearEmbeddingFailure(): void {
  _lastEmbeddingError = undefined;
  _lastEmbeddingFailedAgent = undefined;
  _lastEmbeddingFailureAt = undefined;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_:/.-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value)
      .split(" ")
      .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
  )];
}

function expandTokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);

  if (token.length > 4 && token.endsWith("es")) {
    variants.add(token.slice(0, -2));
  }
  if (token.length > 3 && token.endsWith("s")) {
    variants.add(token.slice(0, -1));
  }

  return [...variants].filter((value) => value.length >= 2);
}

export function inferAgentSearchKeywords(agentName: string, cfg: SubAgentConfig): string[] {
  const keywords = new Set<string>();

  for (const token of tokenizeSearchText(`${agentName} ${cfg.description}`)) {
    keywords.add(token);
  }

  for (const value of [...(cfg.capabilities ?? []), ...(cfg.tags ?? [])]) {
    for (const token of tokenizeSearchText(value)) {
      keywords.add(token);
    }
    keywords.add(value.toLowerCase());
  }

  for (const toolName of cfg.tools ?? []) {
    for (const token of tokenizeSearchText(toolName)) {
      keywords.add(token);
    }

    for (const rule of [...TOOL_KEYWORD_RULES, ...EXTENSION_KEYWORD_RULES]) {
      if (rule.pattern.test(toolName)) {
        for (const keyword of rule.keywords) {
          keywords.add(keyword);
        }
      }
    }
  }

  return [...keywords].sort();
}

export function buildAgentSearchDocument(agentName: string, cfg: SubAgentConfig): string {
  const tools = cfg.tools?.join(", ") ?? "general";
  const keywords = inferAgentSearchKeywords(agentName, cfg).join(", ");
  const promptExcerpt = cfg.systemPrompt?.slice(0, 800) ?? "";
  const capabilities = (cfg.capabilities ?? []).join(", ");
  const tags = (cfg.tags ?? []).join(", ");

  return [
    `Agent: ${agentName}`,
    `Description: ${cfg.description}`,
    capabilities ? `Capabilities: ${capabilities}` : "",
    tags ? `Tags: ${tags}` : "",
    `Tools: ${tools}`,
    `Search Keywords: ${keywords}`,
    promptExcerpt ? `Prompt: ${promptExcerpt}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * BM25-style inverse document frequency over the agent corpus, for the LEXICAL
 * routing fallback. Without IDF, common tokens ("web", "search", "research")
 * match nearly every agent and a degraded-embeddings ranking goes flat — the
 * 0.25-everywhere collapse that pushed routing into architect-fallback ephemerals
 * (audit 9b5196ad). Rare tokens are what actually discriminate specialists.
 * ~59 small docs → trivial to compute per search; no caching needed.
 */
export function buildAgentTokenIdf(agents: Array<[string, SubAgentConfig]>): Map<string, number> {
  const docCount = agents.length;
  const df = new Map<string, number>();
  for (const [name, cfg] of agents) {
    const tokens = new Set<string>(tokenizeSearchText([
      name,
      cfg.description,
      ...(cfg.capabilities ?? []),
      ...(cfg.tags ?? []),
      ...(cfg.tools ?? []),
    ].join(" ")));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (docCount - n + 0.5) / (n + 0.5)));
  return idf;
}

export function scoreAgentKeywordMatch(
  query: string,
  agentName: string,
  cfg: SubAgentConfig,
  idf?: Map<string, number>,
): { score: number; matchedTerms: string[] } {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);

  if (!normalizedQuery || queryTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }

  // Per-query-normalized IDF weight in [0.35, 1]: rare tokens dominate, but common
  // tokens still contribute (an all-common query must not zero out). A token absent
  // from the corpus is treated as maximally rare — it discriminates by definition.
  const maxIdf = idf && idf.size > 0 ? Math.max(...queryTokens.map((t) => idf.get(t) ?? Number.NEGATIVE_INFINITY)) : 0;
  const corpusMaxIdf = idf && idf.size > 0 ? Math.max(...idf.values()) : 0;
  const idfWeight = (token: string): number => {
    if (!idf || idf.size === 0) return 1;
    const tokenIdf = idf.get(token) ?? corpusMaxIdf;
    const reference = Math.max(maxIdf, tokenIdf, 1e-9);
    return 0.35 + 0.65 * (tokenIdf / reference);
  };

  const nameText = normalizeSearchText(agentName);
  const descriptionText = normalizeSearchText(cfg.description);
  const promptText = normalizeSearchText(cfg.systemPrompt ?? "");
  const toolsText = normalizeSearchText((cfg.tools ?? []).join(" "));
  const keywordTokens = inferAgentSearchKeywords(agentName, cfg);
  const matchedTerms = new Set<string>();

  let score = 0;

  if (nameText.includes(normalizedQuery)) score += 1.2;
  else if (descriptionText.includes(normalizedQuery)) score += 0.9;

  for (const token of queryTokens) {
    let tokenScore = 0;
    const variants = expandTokenVariants(token);

    if (variants.some((variant) => nameText.split(" ").includes(variant) || nameText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.95);
    }
    if (variants.some((variant) => descriptionText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.75);
    }
    if (variants.some((variant) => keywordTokens.some(keyword => keyword === variant || keyword.includes(variant)))) {
      tokenScore = Math.max(tokenScore, 0.85);
    }
    if (variants.some((variant) => toolsText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.65);
    }
    if (variants.some((variant) => promptText.includes(variant))) {
      tokenScore = Math.max(tokenScore, 0.4);
    }

    if (tokenScore > 0) {
      score += tokenScore * idfWeight(token);
      matchedTerms.add(token);
    }
  }

  const coverageBonus = (matchedTerms.size / queryTokens.length) * 0.4;
  const normalizedScore = Math.min(1, ((score / queryTokens.length) + coverageBonus) / 1.4);
  const adjustedScore = Math.max(0, Math.min(1, normalizedScore + computeAgentIntentAdjustment(query, cfg, keywordTokens)));

  return { score: adjustedScore, matchedTerms: [...matchedTerms] };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Persistent embedding cache ────────────────────────────────────────────────

interface PersistedEmbeddingEntry {
  /** SHA-256 of the agent's search document — used to detect changes. */
  hash: string;
  /** Base64-encoded Float32Array (little-endian). */
  vector: string;
}

interface PersistedEmbeddingCache {
  /** Embedding model name the vectors were produced with. */
  model: string;
  agents: Record<string, PersistedEmbeddingEntry>;
}

function resolveEmbeddingCachePath(): string {
  const explicit = process.env["SAI_EMBEDDING_CACHE"]?.trim();
  if (explicit) return resolve(explicit);
  const workspacePath = resolve(process.cwd(), PRODUCT.stateDirName, "embedding-cache.json");
  const homePath = resolve(homedir(), PRODUCT.stateDirName, "embedding-cache.json");
  if (existsSync(workspacePath)) return workspacePath;
  return workspacePath; // default to workspace even if it doesn't exist yet
}

function hashAgentDocument(doc: string): string {
  return createHash("sha256").update(doc).digest("hex");
}

/**
 * A cached embedding is degenerate if it is empty or all-zero — a sign the
 * embedding pipeline was broken when it was written (e.g. base64 mis-decode).
 * Such entries must be re-embedded rather than restored, so a stale cache can
 * never silently degrade semantic search after a fix.
 */
function isDegenerateCachedVector(b64: string): boolean {
  try {
    const v = base64ToFloat32(b64);
    if (v.length === 0) return true;
    for (const x of v) { if (x !== 0) return false; }
    return true;
  } catch {
    return true;
  }
}

function float32ToBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

function base64ToFloat32(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function loadEmbeddingCache(model: string): Record<string, PersistedEmbeddingEntry> {
  try {
    const path = resolveEmbeddingCachePath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8")) as PersistedEmbeddingCache;
    if (raw.model !== model) {
      log.info({ cached: raw.model, current: model }, "Embedding model changed — discarding cache");
      return {};
    }
    return raw.agents ?? {};
  } catch {
    return {};
  }
}

function saveEmbeddingCache(model: string, agents: Record<string, PersistedEmbeddingEntry>): void {
  try {
    const path = resolveEmbeddingCachePath();
    mkdirSync(resolve(path, ".."), { recursive: true });
    const data: PersistedEmbeddingCache = { model, agents };
    writeFileSync(path, JSON.stringify(data), "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to save embedding cache");
  }
}

async function _buildAgentIndexInner(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider,
  embeddingModel: string
): Promise<void> {
  _lastProvider = provider;
  _lastSubAgents = { ...subAgents };
  _embeddingModel = embeddingModel;
  // Only invalidate the search-result cache; preserve the query-vector cache
  // and its inflight-dedup map so concurrent rerankToolsForTask / memory
  // lookups keep their dedup guard and do NOT fire duplicate HTTP requests.
  _queryCache.clear();
  const entries = Object.entries(subAgents);
  if (entries.length === 0) {
    _index = [];
    _available = false;
    clearEmbeddingFailure();
    clearEmbeddingRetryTimer();
    return;
  }

  // ── Load persisted cache ──────────────────────────────────────────────────
  const cachedAgents = loadEmbeddingCache(embeddingModel);

  // Compute current hash for every agent
  const currentDocs = new Map<string, { doc: string; hash: string; cfg: SubAgentConfig }>();
  for (const [name, cfg] of entries) {
    const doc = buildAgentSearchDocument(name, cfg);
    currentDocs.set(name, { doc, hash: hashAgentDocument(doc), cfg });
  }

  // Identify which agents actually need a new embedding. Re-embed when the
  // document changed OR the cached vector is degenerate (empty / all-zero) — the
  // latter self-heals a cache persisted across an embedding-pipeline change
  // (e.g. the LM Studio base64→float fix) that would otherwise silently serve
  // zero vectors and break semantic routing.
  const toEmbed: Array<{ name: string; doc: string }> = [];
  for (const [name, { doc, hash }] of currentDocs) {
    const cached = cachedAgents[name];
    if (!cached || cached.hash !== hash || isDegenerateCachedVector(cached.vector)) {
      toEmbed.push({ name, doc });
    }
  }

  const unchanged = entries.length - toEmbed.length;
  if (toEmbed.length === 0) {
    // Everything is cached — restore index directly without any HTTP calls
    _index = entries.map(([name, cfg]) => ({
      agentName: name,
      description: cfg.description,
      vector: base64ToFloat32(cachedAgents[name]!.vector),
    }));
    // Live endpoint probe: the index loaded ENTIRELY from the on-disk cache, so NO live embed
    // happened this load. If the configured model has since been unloaded/removed from the
    // endpoint, blindly setting `_available = true` would be a lie — every query embed would
    // then fail at runtime and semantic routing/recall silently degrades to keyword scoring
    // (audit 9b5196ad: stale cache + a model that returns "No models loaded" → every catalog
    // agent scored ~0.25 → architect-fallback ephemeral with no obvious cause). Verify the
    // endpoint actually serves the configured model before trusting the cache.
    try {
      const [probe] = await provider.embed(["embedding endpoint health probe"], embeddingModel);
      if (!probe || probe.length === 0) throw new Error("embedding endpoint returned an empty vector");
      _available = true;
      _retryDelayMs = 0;
      clearEmbeddingFailure();
      clearEmbeddingRetryTimer();
      log.info({ model: embeddingModel, agentCount: _index.length }, "Agent embedding index loaded from cache (no changes); endpoint probe OK");
    } catch (err) {
      _available = false;
      recordEmbeddingFailure(err);
      log.warn(
        { err, model: embeddingModel, agentCount: _index.length },
        "Agent embedding index loaded from cache BUT the configured embedding model is NOT serving — semantic agent routing, skill/memory recall, and RAG will degrade to keyword matching until it returns. Load the model on the endpoint or repoint agents.defaults.model.embeddingModel.",
      );
      scheduleEmbeddingRetry();
    }
    return;
  }

  // ── Carry over unchanged entries from the disk cache ─────────────────────
  const updatedCache: Record<string, PersistedEmbeddingEntry> = {};
  for (const [name, { hash }] of currentDocs) {
    const cached = cachedAgents[name];
    if (cached && cached.hash === hash) {
      updatedCache[name] = cached;
    }
  }

  // ── Embed changed agents one at a time and save incremental progress ──────
  // Sending all texts in a single HTTP call causes LM Studio to queue hundreds
  // of embedding computations at once. When the request eventually times out,
  // the retry sends another full batch while LM Studio is still working on the
  // first — queue grows unboundedly. Processing one-at-a-time ensures LM
  // Studio's queue never exceeds 1 entry from this code path, and partial
  // progress is saved after every agent so retries only redo what's missing.
  let failed = false;
  for (const { name, doc } of toEmbed) {
    try {
      const [vec] = await provider.embed([doc], embeddingModel);
      if (vec) {
        updatedCache[name] = { hash: currentDocs.get(name)!.hash, vector: float32ToBase64(vec) };
        // Persist incremental progress so a retry starts from where we left off
        saveEmbeddingCache(embeddingModel, updatedCache);
      }
    } catch (err) {
      recordEmbeddingFailure(err, name);
      log.warn({ err, agent: name, model: embeddingModel }, "Failed to embed agent — will retry remaining agents");
      failed = true;
      break;
    }
  }

  // Build in-memory index from whatever we have so far (partial is better than nothing)
  _index = entries.flatMap(([name, cfg]) => {
    const entry = updatedCache[name];
    if (!entry) return [];
    return [{ agentName: name, description: cfg.description, vector: base64ToFloat32(entry.vector) }];
  });

  const embeddedCount = Object.keys(updatedCache).length - unchanged;

  if (failed) {
    // Keep whatever is indexed so far available; schedule retry for the rest
    _available = _index.length > 0;
    log.warn(
      { model: embeddingModel, indexed: _index.length, embedded: embeddedCount, cached: unchanged, remaining: toEmbed.length - embeddedCount },
      "Embedding index partially built — scheduling retry for remaining agents"
    );
    scheduleEmbeddingRetry();
  } else {
    _available = true;
    _retryDelayMs = 0;
    clearEmbeddingFailure();
    clearEmbeddingRetryTimer();
    log.info(
      { model: embeddingModel, agentCount: _index.length, embedded: embeddedCount, cached: unchanged },
      "Agent embedding index built"
    );
  }
}

export async function buildAgentIndex(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider,
  embeddingModel: string
): Promise<void> {
  if (_buildInProgress) {
    // Coalesce: remember the latest request; it will be picked up after the
    // current build finishes. Overwriting a previous pending entry is correct
    // — the most recent config is always what matters.
    _pendingBuild = { subAgents: { ...subAgents }, provider, embeddingModel };
    return;
  }
  _buildInProgress = true;
  try {
    await _buildAgentIndexInner(subAgents, provider, embeddingModel);
  } finally {
    _buildInProgress = false;
    const pending = _pendingBuild;
    if (pending) {
      _pendingBuild = null;
      buildAgentIndex(pending.subAgents, pending.provider, pending.embeddingModel).catch(() => undefined);
    }
  }
}

export async function searchByEmbedding(
  query: string,
  provider: LMStudioProvider,
  topN = 5
): Promise<EmbeddingSearchResult[]> {
  if (!_available || _index.length === 0) return [];

  const cacheKey = buildEmbeddingQueryCacheKey(query, topN);
  const cached = readCachedEmbeddingQuery(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const queryVector = await getOrComputeQueryEmbedding(query, provider, _embeddingModel);
    if (!queryVector) return [];
    const results = _index
      .map(entry => ({ agentName: entry.agentName, description: entry.description, score: cosineSimilarity(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    storeCachedEmbeddingQuery(cacheKey, results);
    return results;
  } catch (err) {
    recordEmbeddingFailure(err);
    log.warn({ err }, "Embedding search failed — falling back to keyword");
    scheduleEmbeddingRetry();
    return [];
  }
}

/**
 * Symmetric counterpart to `searchToolsByEmbedding` in the tool registry.
 * One scored helper that callers (search_agents tool, dashboard surfaces,
 * capability-gap matchers) can share instead of re-implementing cosine
 * walks against the agent index.
 *
 * Auto-resolves the embedding provider via the most-recent `buildAgentIndex`
 * call so callers don't have to thread it. Falls back to keyword token
 * overlap on description + capabilities + tags when embeddings are
 * unavailable, so unit tests + offline operators still get useful output.
 *
 * Note: this returns the *raw* embedding-similarity ranking. The
 * `search_agents` tool layers richer routing heuristics
 * (looksFresh / looksWebTask / preferred-name bumps) on top via
 * `resolveAgentRouting` — that path stays the user-facing one. This helper
 * is for surfaces that want the bare scored list.
 */
export async function searchAgentsByEmbedding(
  query: string,
  topN = 8,
  opts?: { excludeAgents?: Iterable<string> },
): Promise<{ agentName: string; description: string; score: number; mode: "embedding" | "keyword" | "empty" }[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const exclude = opts?.excludeAgents ? new Set(opts.excludeAgents) : null;

  if (_available && _index.length > 0 && _lastProvider && _embeddingModel) {
    try {
      const queryVector = await getOrComputeQueryEmbedding(trimmed, _lastProvider, _embeddingModel);
      if (queryVector) {
        const ranked = _index
          .filter((entry) => !exclude || !exclude.has(entry.agentName))
          .map((entry) => ({
            agentName: entry.agentName,
            description: entry.description,
            score: cosineSimilarity(queryVector, entry.vector),
            mode: "embedding" as const,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN);
        if (ranked.length > 0) return ranked;
      }
    } catch (err) {
      recordEmbeddingFailure(err);
      log.warn({ err }, "Agent embedding search failed — falling back to keyword");
      scheduleEmbeddingRetry();
    }
  }

  // Keyword fallback — token overlap on description + capabilities + tags.
  const subAgents = _lastSubAgents ?? {};
  const entries = Object.entries(subAgents).filter(
    ([name]) => !exclude || !exclude.has(name),
  );
  if (entries.length === 0) return [];

  const q = trimmed.toLowerCase();
  const queryTokens = q.split(/\s+/).filter((t) => t.length > 2);

  const ranked = entries
    .map(([name, cfg]) => {
      const text = [
        name,
        cfg.description ?? "",
        ...(cfg.capabilities ?? []),
        ...(cfg.tags ?? []),
        cfg.domain ?? "",
        cfg.role ?? "",
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (text.includes(q)) score = 1;
      else if (queryTokens.length > 0) {
        const hits = queryTokens.filter((token) => text.includes(token)).length;
        score = hits / queryTokens.length;
      }
      return {
        agentName: name,
        description: cfg.description ?? "",
        score,
        mode: "keyword" as const,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return ranked;
}

export function rebuildAgentIndex(
  subAgents: Record<string, SubAgentConfig>,
  provider: LMStudioProvider
): void {
  if (!_embeddingModel) return;
  clearEmbeddingQueryCache();
  buildAgentIndex(subAgents, provider, _embeddingModel).catch(() => undefined);
}

export function isEmbeddingAvailable(): boolean {
  return _available;
}

export function getEmbeddingSearchStatus(): EmbeddingSearchStatus {
  return {
    configured: Boolean(_embeddingModel),
    available: _available,
    model: _embeddingModel || null,
    indexedAgentCount: _index.length,
    totalAgentCount: Object.keys(_lastSubAgents).length,
    retryScheduled: Boolean(_retryTimer),
    retryDelayMs: _retryDelayMs,
    lastError: _lastEmbeddingError,
    lastFailedAgent: _lastEmbeddingFailedAgent,
    lastFailureAt: _lastEmbeddingFailureAt,
  };
}

/**
 * G33: Compute an embedding for an arbitrary query string using the currently
 * configured embedding provider.  Returns `null` if unavailable.
 */
export async function computeQueryEmbedding(text: string): Promise<Float32Array | null> {
  if (!_available || !_lastProvider || !_embeddingModel) return null;
  return getOrComputeQueryEmbedding(text, _lastProvider, _embeddingModel);
}

/**
 * Batched, cache-aware embedding for a set of texts (e.g. retrieval candidates
 * that have no stored vector, such as session shared-facts or agent lessons).
 * Cached vectors are returned from the same query-vector cache; every uncached
 * text is embedded in a SINGLE provider.embed() call, so semantic retrieval for
 * those scopes costs one batched request, not one call per record. Returns a
 * parallel array (null where unavailable/failed). Empty/blank texts map to null.
 */
export async function computeTextEmbeddings(texts: string[]): Promise<Array<Float32Array | null>> {
  const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
  if (!_available || !_lastProvider || !_embeddingModel || texts.length === 0) return results;
  const model = _embeddingModel;

  const toEmbed: Array<{ idx: number; text: string; cacheKey: string }> = [];
  for (let i = 0; i < texts.length; i++) {
    const normalized = normalizeSearchText(texts[i] ?? "");
    if (!normalized) continue;
    const cacheKey = `${model}::${normalized}`;
    const cached = _queryVectorCache.get(cacheKey);
    if (cached && Date.now() - cached.storedAt <= QUERY_VECTOR_CACHE_TTL_MS) {
      results[i] = cached.vector;
      continue;
    }
    if (cached) _queryVectorCache.delete(cacheKey);
    toEmbed.push({ idx: i, text: texts[i] ?? "", cacheKey });
  }

  if (toEmbed.length > 0) {
    try {
      const vectors = await _lastProvider.embed(toEmbed.map((t) => t.text), model);
      for (let k = 0; k < toEmbed.length; k++) {
        const vec = vectors[k];
        if (!vec) continue;
        const { idx, cacheKey } = toEmbed[k]!;
        results[idx] = vec;
        _queryVectorCache.set(cacheKey, { storedAt: Date.now(), vector: vec });
      }
      while (_queryVectorCache.size > QUERY_VECTOR_CACHE_MAX_ENTRIES) {
        const oldestKey = _queryVectorCache.keys().next().value;
        if (!oldestKey) break;
        _queryVectorCache.delete(oldestKey);
      }
    } catch (err) {
      recordEmbeddingFailure(err);
    }
  }
  return results;
}

async function getOrComputeQueryEmbedding(
  text: string,
  provider: LMStudioProvider,
  model: string,
): Promise<Float32Array | null> {
  const normalized = normalizeSearchText(text);
  if (!normalized) {
    try {
      const [vec] = await provider.embed([text], model);
      return vec ?? null;
    } catch (err) {
      recordEmbeddingFailure(err);
      return null;
    }
  }
  const cacheKey = `${model}::${normalized}`;
  const cached = _queryVectorCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt <= QUERY_VECTOR_CACHE_TTL_MS) {
    return cached.vector;
  }
  if (cached) _queryVectorCache.delete(cacheKey);
  const inflight = _queryVectorInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const [vec] = await provider.embed([text], model);
      if (vec) {
        _queryVectorCache.set(cacheKey, { storedAt: Date.now(), vector: vec });
        if (_queryVectorCache.size > QUERY_VECTOR_CACHE_MAX_ENTRIES) {
          const oldestKey = _queryVectorCache.keys().next().value;
          if (oldestKey) _queryVectorCache.delete(oldestKey);
        }
      }
      return vec ?? null;
    } catch (err) {
      recordEmbeddingFailure(err);
      return null;
    } finally {
      _queryVectorInflight.delete(cacheKey);
    }
  })();
  _queryVectorInflight.set(cacheKey, promise);
  return promise;
}

export function resetEmbeddingSearchStateForTests(): void {
  _index = [];
  _available = false;
  _embeddingModel = "";
  _lastProvider = null;
  _lastSubAgents = {};
  clearEmbeddingFailure();
  _retryDelayMs = 0;
  _buildInProgress = false;
  _pendingBuild = null;
  clearEmbeddingRetryTimer();
  clearEmbeddingQueryCache();
}

function clearEmbeddingRetryTimer(): void {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

function scheduleEmbeddingRetry(): void {
  if (_retryTimer || !_lastProvider || !_embeddingModel || Object.keys(_lastSubAgents).length === 0) {
    return;
  }

  const delay = _retryDelayMs > 0 ? _retryDelayMs : EMBEDDING_RETRY_INITIAL_DELAY_MS;
  _retryDelayMs = Math.min(EMBEDDING_RETRY_MAX_DELAY_MS, delay * 2);
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    buildAgentIndex(_lastSubAgents, _lastProvider!, _embeddingModel).catch(() => undefined);
  }, delay);
  _retryTimer.unref?.();
  log.info({ model: _embeddingModel, retryInMs: delay }, "Scheduled embedding index rebuild retry");
}

function buildEmbeddingQueryCacheKey(query: string, topN: number): string {
  return `${_embeddingModel}::${topN}::${normalizeSearchText(query)}`;
}

function readCachedEmbeddingQuery(cacheKey: string): EmbeddingSearchResult[] | null {
  const cached = _queryCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.storedAt > QUERY_CACHE_TTL_MS) {
    _queryCache.delete(cacheKey);
    return null;
  }
  return cached.results.map((result) => ({ ...result }));
}

function storeCachedEmbeddingQuery(cacheKey: string, results: EmbeddingSearchResult[]): void {
  _queryCache.set(cacheKey, {
    storedAt: Date.now(),
    results: results.map((result) => ({ ...result })),
  });

  if (_queryCache.size <= QUERY_CACHE_MAX_ENTRIES) return;
  const oldestKey = _queryCache.keys().next().value;
  if (oldestKey) {
    _queryCache.delete(oldestKey);
  }
}

function clearEmbeddingQueryCache(): void {
  _queryCache.clear();
  _queryVectorCache.clear();
  _queryVectorInflight.clear();
}
