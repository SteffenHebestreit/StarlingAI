/**
 * Routing accuracy benchmarks.
 *
 * Verifies that resolveAgentRouting() picks the correct first-choice specialist
 * for representative real-world queries. Tests run against a fixed agent fixture
 * that mirrors the core routing-relevant fields of starlingai.json.
 *
 * Failures here indicate a routing regression — usually caused by changes to
 * agent descriptions, capabilities, or the scoring logic in embeddings.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Representative subset of agents from starlingai.json, focusing on the
// routing-relevant fields (description, capabilities, tags, tools).
const ROUTING_FIXTURE = {
  agents: { defaults: { model: { primary: "lmstudio/qwen3.5-9b" } } },
  subAgents: {
    researcher: {
      description: "Finds facts, documentation, and public information on the web. Summarizes sources.",
      capabilities: ["web research", "documentation lookup", "fact finding", "source summarization"],
      tags: ["research", "web", "docs"],
      tools: ["web_search", "web_fetch"],
      maxIterations: 8,
    },
    citation_researcher: {
      description: "Finds citation-grade primary sources for papers, reports, and technical briefs.",
      capabilities: ["official source lookup", "citation research", "specification discovery", "bibliography prep"],
      tags: ["citations", "research", "sources", "papers"],
      tools: ["web_search", "web_fetch", "share_finding"],
      maxIterations: 8,
    },
    coder: {
      description: "Writes, edits, and saves source code files across any programming language.",
      capabilities: ["code writing", "code generation", "programming", "file editing"],
      tags: ["code", "programming"],
      tools: ["write_file", "read_file", "list_directory"],
      maxIterations: 8,
    },
    code_analyst: {
      description: "Reviews and explains existing code. Answers questions about code structure and logic.",
      capabilities: ["code review", "code analysis", "code explanation", "architecture review"],
      tags: ["code", "analysis"],
      tools: ["read_file", "list_directory", "workspace_search"],
      maxIterations: 6,
    },
    browser_agent: {
      description: "Automates browser sessions: logs into websites, fills forms, and extracts page data.",
      capabilities: ["browser automation", "login flows", "form filling", "web scraping"],
      tags: ["browser", "automation"],
      systemPrompt: "Use stored credentials, inspect the page, then fill the login form and submit it.",
      tools: ["get_site_credentials", "mcp__playwright__browser_click", "mcp__playwright__browser_type"],
      maxIterations: 10,
    },
    email_drafter: {
      description: "Drafts polished professional emails, follow-ups, and business messages.",
      capabilities: ["email drafting", "business writing", "professional communication"],
      tags: ["email", "writing", "communication"],
      tools: ["read_file", "write_file"],
      maxIterations: 4,
    },
    translator: {
      description: "Translates text between languages accurately while preserving tone and meaning.",
      capabilities: ["translation", "language conversion", "multilingual"],
      tags: ["translation", "language"],
      tools: ["read_file", "write_file"],
      maxIterations: 3,
    },
    summarizer: {
      description: "Condenses documents, articles, or long texts into clear, concise summaries.",
      capabilities: ["summarization", "text condensing", "content distillation"],
      tags: ["summarization", "writing"],
      tools: ["read_file"],
      maxIterations: 3,
    },
    paper_author: {
      description: "Drafts source-grounded papers, literature reviews, and evidence-based reports from collected evidence.",
      capabilities: ["scientific writing", "paper drafting", "literature review drafting", "source-grounded reports"],
      tags: ["papers", "reports", "citations", "drafting"],
      tools: ["read_file", "write_file", "read_shared_facts"],
      maxIterations: 5,
    },
    source_verifier: {
      description: "Checks drafts for unsupported claims, fabricated references, and citation issues.",
      capabilities: ["citation verification", "fact checking", "source validation", "bibliography audit"],
      tags: ["verification", "citations", "bibliography", "research"],
      tools: ["read_file", "read_shared_facts", "web_fetch"],
      maxIterations: 4,
    },
    data_analyst: {
      description: "Analyzes datasets, computes statistics, and interprets tabular data.",
      capabilities: ["data analysis", "statistics", "CSV processing", "data interpretation"],
      tags: ["data", "analysis", "statistics"],
      tools: ["read_file", "write_file", "execute_python"],
      maxIterations: 6,
    },
    shell_agent: {
      description: "Executes shell commands and terminal operations. Runs scripts and system tasks.",
      capabilities: ["shell execution", "terminal commands", "scripting", "system operations"],
      tags: ["shell", "terminal", "devops"],
      tools: ["execute_shell"],
      maxIterations: 5,
    },
    git_agent: {
      description: "Runs git operations: status, commits, branches, diffs, and log inspection.",
      capabilities: ["git operations", "version control", "commit management", "branch management"],
      tags: ["git", "vcs"],
      tools: ["execute_shell"],
      maxIterations: 5,
    },
    scheduler: {
      description: "Creates, updates, and lists scheduled tasks and calendar items.",
      capabilities: ["task scheduling", "calendar management", "reminders", "due dates"],
      tags: ["scheduling", "calendar", "tasks"],
      tools: ["webhook__n8n_add_task", "webhook__n8n_list_tasks"],
      maxIterations: 4,
    },
    media_analyst: {
      description: "Analyse images and extract structured content from documents and media files.",
      capabilities: ["image analysis", "visual question answering", "document extraction", "file content conversion", "chart and diagram interpretation", "screenshot analysis"],
      tags: ["image", "vision", "media", "document", "extract", "analyse"],
      tools: ["analyse_image", "extract_file_content", "read_file", "write_file"],
      maxIterations: 5,
    },
    transcription_agent: {
      description: "Transcribe audio files to text using the configured speech-to-text service.",
      capabilities: ["audio transcription", "speech to text", "podcast transcription", "meeting notes", "voice memo transcription", "multi-language transcription"],
      tags: ["audio", "transcription", "speech", "stt", "voice", "qwen3-asr"],
      tools: ["transcribe_audio", "write_file", "read_file"],
      maxIterations: 4,
    },
    voice_narrator: {
      description: "Convert text to speech using available TTS voices and save the audio output.",
      capabilities: ["text to speech", "voice synthesis", "audio narration", "podcast production", "accessibility audio", "voice selection"],
      tags: ["tts", "speech", "voice", "audio", "narration", "synthesize"],
      tools: ["synthesize_speech", "list_tts_voices", "write_file"],
      maxIterations: 4,
    },
    retrieval_analyst: {
      description: "Workspace retrieval and document analysis specialist. Searches all text files in the project for relevant content, reads and synthesises findings, and returns cited, structured answers.",
      capabilities: ["workspace search", "document retrieval", "knowledge lookup", "code search"],
      tags: ["retrieval", "rag", "search", "workspace"],
      tools: ["workspace_search", "read_file", "list_files", "write_file"],
      maxIterations: 4,
    },
    incident_responder: {
      description: "Runtime incident triage agent. Diagnoses provider connectivity issues, MCP server failures, channel errors, and gateway health problems. Reads logs, checks endpoints, and produces a structured incident report with recommended remediation.",
      capabilities: ["incident triage", "health diagnosis", "provider troubleshooting", "log analysis"],
      tags: ["ops", "monitoring", "incident", "reliability"],
      tools: ["shell_exec", "read_file", "list_files", "web_fetch"],
      maxIterations: 5,
    },
    workflow_designer: {
      description: "n8n and webhook workflow design specialist. Analyses automation requirements, designs n8n workflow structures, generates webhook configurations, and documents the integration architecture.",
      capabilities: ["n8n workflows", "webhook design", "automation planning", "integration architecture"],
      tags: ["n8n", "workflow", "automation", "integration"],
      tools: ["read_file", "write_file", "list_files", "web_search"],
      maxIterations: 4,
    },
    channel_operator: {
      description: "Communication channel troubleshooting specialist. Diagnoses Telegram, Slack, Discord, WhatsApp, and email channel connectivity issues, checks token validity, tests webhook reachability, and produces actionable remediation steps.",
      capabilities: ["channel troubleshooting", "webhook testing", "token validation", "delivery diagnosis"],
      tags: ["channels", "telegram", "slack", "discord", "whatsapp", "ops"],
      tools: ["shell_exec", "read_file", "web_fetch"],
      maxIterations: 5,
    },
    prompt_optimizer: {
      description: "Agent prompt quality analyst. Reviews sub-agent system prompts for clarity, tool-use convergence, and output consistency. Produces rewrite suggestions with rationale.",
      capabilities: ["prompt analysis", "system prompt rewriting", "convergence tuning", "agent quality"],
      tags: ["prompts", "quality", "optimization", "evaluation"],
      tools: ["read_file", "write_file", "list_files"],
      maxIterations: 3,
    },
  },
};

/** Query → expected first-choice agent name */
const ROUTING_CASES: Array<{ query: string; expected: string; description: string }> = [
  { query: "search the web for the latest Node.js LTS release notes", expected: "researcher", description: "web research" },
  { query: "find official documentation for the Anthropic API tool_use parameter", expected: "researcher", description: "documentation lookup" },
  { query: "find official sources and citations for a paper on MCP and A2A", expected: "citation_researcher", description: "citation-grade source lookup" },
  { query: "write a TypeScript function that parses ISO dates", expected: "coder", description: "code writing" },
  { query: "create a Python script that reads a CSV and computes averages", expected: "data_analyst", description: "code + data (data_analyst wins on CSV keywords)" },
  { query: "explain what this source file does and describe its structure", expected: "code_analyst", description: "code explanation" },
  { query: "review this code for potential security vulnerabilities", expected: "code_analyst", description: "code review" },
  { query: "log into the client portal and download the latest invoice", expected: "browser_agent", description: "browser login" },
  { query: "fill out the job application form on the website", expected: "browser_agent", description: "form filling" },
  { query: "draft a follow-up email to the client about the project timeline", expected: "email_drafter", description: "email drafting" },
  { query: "write a professional reply to a job offer in English", expected: "email_drafter", description: "business email" },
  { query: "translate this German paragraph to English", expected: "translator", description: "translation" },
  { query: "summarize this 500-word article into three bullet points", expected: "summarizer", description: "summarization" },
  { query: "write a source-backed technical paper from the collected notes and citations", expected: "paper_author", description: "source-grounded writing" },
  { query: "check this draft for fabricated citations and unsupported claims", expected: "source_verifier", description: "citation verification" },
  { query: "analyze this CSV dataset and compute monthly revenue averages", expected: "data_analyst", description: "data analysis" },
  { query: "execute the shell command 'df -h' and report disk usage", expected: "shell_agent", description: "shell command" },
  { query: "show me the git log for the last 10 commits", expected: "git_agent", description: "git operations" },
  { query: "git commit all staged changes with a descriptive commit message", expected: "git_agent", description: "git commit" },
  { query: "schedule a reminder for the team standup at 9am tomorrow", expected: "scheduler", description: "task scheduling" },
  { query: "add a new task: review pull requests, due Friday", expected: "scheduler", description: "calendar task" },
  { query: "analyse this screenshot and tell me what UI components are visible", expected: "media_analyst", description: "image analysis" },
  { query: "extract the text content from this PDF document", expected: "media_analyst", description: "document extraction" },
  { query: "transcribe this audio recording from the meeting", expected: "transcription_agent", description: "audio transcription" },
  { query: "convert this voice memo to text", expected: "transcription_agent", description: "speech to text" },
  { query: "read out this article using a natural voice", expected: "voice_narrator", description: "text to speech" },
  { query: "synthesize speech for this podcast intro script", expected: "voice_narrator", description: "speech synthesis" },
  { query: "search the workspace for all files that reference the AuthService class", expected: "retrieval_analyst", description: "workspace code search" },
  { query: "find every mention of the database connection string in the project", expected: "retrieval_analyst", description: "workspace retrieval" },
  { query: "the LM Studio provider keeps returning 502 errors, diagnose the issue", expected: "incident_responder", description: "provider incident triage" },
  { query: "gateway health check is failing and agents are timing out", expected: "incident_responder", description: "runtime health diagnosis" },
  { query: "design an n8n workflow that triggers a webhook when a new order arrives", expected: "workflow_designer", description: "n8n webhook workflow" },
  { query: "create an automation pipeline that connects the CRM to our email system", expected: "workflow_designer", description: "integration automation" },
  { query: "the Telegram bot stopped receiving messages, troubleshoot the channel", expected: "channel_operator", description: "telegram channel troubleshooting" },
  { query: "check why Slack webhook delivery is failing and fix it", expected: "channel_operator", description: "slack webhook diagnosis" },
  { query: "review the researcher agent system prompt and suggest improvements for convergence", expected: "prompt_optimizer", description: "prompt quality review" },
  { query: "the coder agent keeps looping without producing output, optimize its prompt", expected: "prompt_optimizer", description: "prompt convergence tuning" },
];

describe("routing accuracy benchmarks", () => {
  let tempDir: string;

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("routes representative queries to the correct first-choice agent", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-routing-accuracy-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify(ROUTING_FIXTURE), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    const { resolveAgentRouting } = await import("../tools/sub-agent.js");

    let passed = 0;
    const failures: string[] = [];

    for (const { query, expected, description } of ROUTING_CASES) {
      const resolution = await resolveAgentRouting(query, { minConfidence: "low" });
      const topAgent = resolution.results[0]?.name;
      if (topAgent === expected) {
        passed++;
      } else {
        failures.push(`[${description}] "${query}" → got "${topAgent ?? "none"}", expected "${expected}"`);
      }
    }

    const total = ROUTING_CASES.length;
    const accuracy = Math.round((passed / total) * 100);
    console.log(`\nRouting accuracy: ${passed}/${total} (${accuracy}%)`);
    if (failures.length > 0) {
      console.log("Misrouted queries:\n" + failures.map(f => `  - ${f}`).join("\n"));
    }

    // Require at least 75% accuracy — a regression gate, not a perfection target
    expect(passed, `Routing accuracy ${accuracy}% is below the 75% threshold.\n${failures.join("\n")}`).toBeGreaterThanOrEqual(Math.ceil(total * 0.75));
  }, 30_000);
});
