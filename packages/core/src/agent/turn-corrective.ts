// Two bounded corrective closures for the final-response QA gate, extracted verbatim
// from runTurnImpl/_runTurn (runtime.ts) into module functions driven by an explicit
// context object. This file deliberately does NOT import from runtime.js — any
// runtime-private dependency (forceSynthesis, collectTurnArtifactAttachments,
// selectCorrectiveResumeTarget, extractArtifactsFromMetadata, the runtime logger) is
// supplied as a callback on CorrectiveContext, and any late-bound or mutable enclosing
// state (the active iteration count, the chat provider built later in the turn, the
// shared qaCorrectiveBuildUsed latch, the per-turn delegation counter, the stashed
// builder spec) is read/written through getter/setter callbacks so the moved bodies
// observe live turn state exactly as the original closures did.

import { join } from "node:path";
import { logAudit } from "../audit/logger.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { executeTool, type ToolContext } from "../tools/registry.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import type { AgentSession } from "./session.js";
import type { DeliverableIntent } from "./deliverable-intent.js";
import { artifactFileLooksTruncated } from "./sub-agent.js";
import {
  extractInlineHtmlDocument,
  looksLikeCompleteHtmlDocument,
  stripLargeCodeFences,
} from "./deliverable-intent.js";
import { sanitizeUserFacingAssistantResponse } from "./response-finalization.js";
import { stripLeadingReasoningPreamble, looksLikeTruncatedCodeDeliverable } from "./deliverable-relay.js";
import { looksLikeDegenerateRepetition } from "./text-dedup.js";
import { EVIDENCE_SECTION_RE } from "./interrupted-delegation-evidence.js";

/**
 * Result of selectCorrectiveResumeTarget — structurally compatible with the runtime
 * helper's return shape (declared locally so this module needs no runtime.js import).
 */
interface CorrectiveResumeTarget {
  relativePath: string;
  filename: string;
  truncationReason: string;
}

/**
 * Explicit dependency carrier for the two corrective bodies. Read-only fields are
 * stable for the lifetime of the turn; getter callbacks read live mutable/late-bound
 * turn state; the function callbacks are runtime-private helpers/closures that cannot
 * be imported here.
 */
export interface CorrectiveContext {
  // --- read-only, stable for the turn ---
  readonly signal: AbortSignal;
  readonly session: AgentSession;
  readonly userMessage: string;
  readonly deliverableIntent: DeliverableIntent;
  readonly toolContext: ToolContext;
  readonly onStatus?: (status: { phase: string; message: string; iteration?: number }) => void;

  // --- live reads of mutable / late-bound enclosing state ---
  getIterationCount: () => number;
  getProvider: () => ChatProvider;
  getStashedBuilderTaskSpec: () => string | null;

  // --- shared qaCorrectiveBuildUsed latch (read in guard, set on entry); the call
  //     site reads it back after the call exactly as the original closure left it ---
  getQaCorrectiveBuildUsed: () => boolean;
  setQaCorrectiveBuildUsed: (v: boolean) => void;

  // --- per-turn delegation counter mutation ---
  incrementDelegationCount: () => void;

  // --- runtime-private helpers / closures (passed as callbacks, never imported) ---
  forceSynthesis: (session: AgentSession, provider: ChatProvider, signal: AbortSignal, instruction: string) => Promise<string | null>;
  selectCorrectiveResumeTarget: (
    attachments: Array<Record<string, unknown>>,
    truncationProbe: (relativePath: string) => string | null,
  ) => CorrectiveResumeTarget | null;
  collectTurnArtifactAttachments: (session: AgentSession) => Array<Record<string, unknown>>;
  extractArtifactsFromMetadata: (
    metadata: Record<string, unknown>,
    out: Array<Record<string, unknown>>,
    seen: Set<string>,
  ) => void;
  logWarn: (obj: Record<string, unknown>, msg: string) => void;
}

// One bounded corrective build for the completion QA gate: when the user asked to BUILD an
// artifact and none was produced, delegate to the right builder, record the assistant+tool
// pair so the artifact surfaces as a download, and synthesize a confirmation. Returns the
// confirmation message if a real artifact was produced, else null (caller keeps its draft).
export const runCorrectiveBuild = async (buildContext: string, ctx: CorrectiveContext): Promise<string | null> => {
  const { signal, session, userMessage, deliverableIntent, toolContext } = ctx;
  if (ctx.getQaCorrectiveBuildUsed() || signal.aborted) return null;
  ctx.setQaCorrectiveBuildUsed(true);
  const builderAgent = deliverableIntent.builder;
  logAudit("guardrail_flagged", {
    type: "final_qa_corrective_build_delegated",
    builderAgent,
    contextChars: buildContext.length,
  }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  ctx.onStatus?.({ phase: "guardrail", message: "Der QA-Check verlangt das angeforderte Artefakt — ich lasse es jetzt vom passenden Spezialisten erstellen.", iteration: ctx.getIterationCount() });
  // Resume-over-regenerate: if an earlier attempt this turn left a partial deliverable
  // that looks cut off mid-document, finish THAT file in place instead of re-emitting the
  // whole thing — saves the tokens/latency of regeneration and avoids hitting the same
  // cut-off (the user's write_file/resume idea). Gated + structural (file-incompleteness,
  // not topic); a complete-but-wrong file probes null and falls through to a fresh build.
  const resumeTarget = effectiveOrchestration().resumePartialOnCorrectiveBuild
    ? ctx.selectCorrectiveResumeTarget(
        ctx.collectTurnArtifactAttachments(session),
        (rel) => {
          const wsRoot = typeof toolContext.workspacePath === "string" ? toolContext.workspacePath : "";
          return wsRoot ? artifactFileLooksTruncated({ path: join(wsRoot, rel), filename: rel }) : null;
        },
      )
    : null;
  if (resumeTarget) {
    logAudit("guardrail_flagged", {
      type: "final_qa_corrective_build_resume_partial",
      builderAgent,
      relativePath: resumeTarget.relativePath,
      truncationReason: resumeTarget.truncationReason,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  }
  const buildTask = resumeTarget
    ? ("RESUME TASK — finish the partial deliverable that is ALREADY on disk; do NOT regenerate it. "
      + `The file \`${resumeTarget.relativePath}\` was started by an earlier attempt this turn but is INCOMPLETE (${resumeTarget.truncationReason}). `
      + `FIRST read_file \`${resumeTarget.relativePath}\` to see exactly how far it got, THEN continue it IN PLACE: append the missing remainder with write_file mode:"append" (same path) in SMALL bounded chunks until the document terminates correctly (close every open tag / make the JSON parse), or use edit_file to repair one specific broken region. `
      + "Do NOT rewrite the file from the top, do NOT create a new file, and do NOT call generate_website/generate_presentation — regenerating discards the work already on disk and risks the same cut-off. "
      + "Use ONLY facts present in the context or shared findings; do NOT re-research. "
      + `NEVER paste the file's code into your reply — it is attached. Final reply = a SHORT summary plus the file path (${resumeTarget.relativePath}).\n\nOriginal request:\n`
      + userMessage)
    : builderAgent === "content_writer"
    ? ("BUILD TASK — produce the requested deliverable NOW from the verified findings/context. "
      + "Do NOT re-research. Use ONLY facts present in the context or shared findings; cite source URLs where relevant. "
      + "If it is an HTML page / reveal.js presentation, author compact content and let generate_presentation/generate_website assemble it, or build the file incrementally with write_file mode:\"append\" — never one giant write.\n\nOriginal request:\n"
      + userMessage)
    // The app task mandates ONE self-contained FILE but INCREMENTAL writes: telling the
    // slow model to fit the whole app in one write_file call made it emit the entire app
    // as a single giant tool-call argument, blow the completion cap mid-arguments, and
    // fail with "path is required" — it then fell back to generate_website and shipped a
    // 4KB static welcome page instead of the app (audit c2f76a00). generate_website is
    // explicitly forbidden here: it renders markdown into static pages, never an app.
    : ("BUILD TASK — build the requested app NOW as ONE REAL FILE in the workspace, not as a prose answer. "
      + "Use ONLY facts/content present in the context or shared findings; do NOT re-research. "
      + "Build a SINGLE self-contained index.html: ALL CSS in an inline <style>, ALL JavaScript in an inline <script>, data (questions, items, etc.) embedded INLINE so it runs from the file with no server, and every control functional. Do NOT create or reference separate ./app.js or ./styles.css files — a multi-file build that runs out of time leaves a BROKEN app, whereas one self-contained file always runs. "
      + "WRITE THE FILE IN BOUNDED CHUNKS: first write_file with mode:\"create\" for the head + styles + the opening of the body, then 2-4 write_file calls with mode:\"append\" (same path) for the markup, the data, and the script — each call SMALL enough to finish well within your output budget. NEVER try to emit the entire app in ONE write_file call (the arguments get cut off mid-generation and the write fails), and do NOT use generate_website — it produces a static markdown page, not an interactive app. "
      + "START WRITING IMMEDIATELY: your FIRST tool call is the write_file mode:\"create\" for index.html — no exploratory reads first. If the context above has no usable facts or data, generate representative sample content from your own knowledge of the topic and build with that. "
      + "NEVER paste the app's code into your reply — that is a failure. Your final reply is a SHORT summary plus the entry file path (index.html).\n\nOriginal request:\n"
      + userMessage);
  // Blueprint first (the model's own rescued spec — features, data shape, UI), then the
  // gathered facts. Without the spec the builder only knows the one-line user request.
  const stashedBuilderTaskSpec = ctx.getStashedBuilderTaskSpec();
  const buildContextWithSpec = [
    stashedBuilderTaskSpec ? `BUILD SPEC (written by the orchestrator earlier this turn — implement THIS):\n${stashedBuilderTaskSpec.slice(0, 2_500)}` : "",
    buildContext.trim(),
  ].filter(Boolean).join("\n\n");
  let buildResultMetadata: Record<string, unknown> | undefined;
  let buildResultOutput = "";
  try {
    const buildResult = await executeTool("delegate_to_agent", {
      agentName: builderAgent,
      task: buildTask,
      ...(buildContextWithSpec ? { context: buildContextWithSpec.slice(0, 10_000) } : {}),
      // Operator Stop means "build now from what we gathered," so this one bounded
      // build delegation runs even when the stop latch is set (audit 453a263e).
    }, { ...toolContext, allowDelegationAfterOperatorStop: true });
    ctx.incrementDelegationCount();
    buildResultMetadata = buildResult.metadata;
    buildResultOutput = buildResult.success ? buildResult.output : "";
    // executeTool here runs OUTSIDE the main tool loop; record a well-formed assistant+tool
    // pair so the built artifact surfaces as a clickable attachment (collectTurnArtifactAttachments
    // only reads tool-role history) and history stays valid (audit 65f46046).
    const buildCallId = `qabuild_${Date.now().toString(36)}`;
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: buildCallId, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ agentName: builderAgent, task: "BUILD TASK (final-QA corrective build)" }) } }],
    });
    session.addMessage({
      role: "tool",
      content: (buildResult.success ? buildResult.output : (buildResult.error?.trim() ? `Error: ${buildResult.error}` : buildResult.output)).slice(0, 4_000),
      tool_call_id: buildCallId,
      metadata: buildResult.metadata,
    });
  } catch (err) {
    ctx.logWarn({ err, sessionId: session.id }, "Final-QA corrective build delegation failed");
  }
  const builtArtifacts: Array<Record<string, unknown>> = [];
  if (buildResultMetadata) ctx.extractArtifactsFromMetadata(buildResultMetadata, builtArtifacts, new Set<string>());
  if (builtArtifacts.length === 0) {
    for (const a of ctx.collectTurnArtifactAttachments(session)) builtArtifacts.push(a);
  }
  let harvestedIncomplete = false;
  if (builtArtifacts.length === 0) {
    // HARVEST (audit 0ac7d3fc): the builder "succeeded" but wrote no file — its timeout
    // synthesis pasted the complete app (15KB <!DOCTYPE html>) into its RESULT text
    // instead. The content exists; writing it to a file is deterministic work the
    // runtime does itself rather than failing the whole turn over a missed tool call.
    const inlineDoc = extractInlineHtmlDocument(buildResultOutput);
    if (inlineDoc) {
      harvestedIncomplete = !looksLikeCompleteHtmlDocument(inlineDoc);
      try {
        const harvestWrite = await executeTool("write_file", { path: "app/index.html", content: inlineDoc }, toolContext);
        if (harvestWrite.success) {
          const harvestCallId = `qaharvest_${Date.now().toString(36)}`;
          session.addMessage({
            role: "assistant",
            content: "",
            tool_calls: [{ id: harvestCallId, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "app/index.html", note: "harvested from builder's inline draft" }) } }],
          });
          session.addMessage({
            role: "tool",
            content: harvestWrite.output.slice(0, 1_000),
            tool_call_id: harvestCallId,
            metadata: harvestWrite.metadata,
          });
          if (harvestWrite.metadata) ctx.extractArtifactsFromMetadata(harvestWrite.metadata, builtArtifacts, new Set<string>());
          logAudit("guardrail_flagged", {
            type: "final_qa_corrective_build_harvested_inline",
            chars: inlineDoc.length,
            complete: !harvestedIncomplete,
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        }
      } catch (err) {
        ctx.logWarn({ err, sessionId: session.id }, "Harvest write of builder's inline document failed");
      }
    }
  }
  if (builtArtifacts.length === 0) return null;
  const paths = builtArtifacts
    .map((a) => (typeof a["relativePath"] === "string" && a["relativePath"] ? a["relativePath"] : (typeof a["filename"] === "string" ? a["filename"] : "")))
    .filter((p): p is string => Boolean(p));
  // Ground the confirmation in the ARTIFACT FACTS so it cannot advertise features the
  // build never produced (audit c2f76a00: the actual artifact was a 4KB single static
  // page, but the confirmation promised an exam simulator, flashcards, and progress
  // tracking — a false-completion one level down: the file exists but isn't the app).
  const artifactFacts = builtArtifacts
    .map((a) => {
      const name = (typeof a["relativePath"] === "string" && a["relativePath"]) ? a["relativePath"] : (typeof a["filename"] === "string" ? a["filename"] : "artifact");
      const size = typeof a["size"] === "number" ? ` (${Math.max(1, Math.round(Number(a["size"]) / 1024))} KB)` : "";
      return `${String(name)}${String(size)}`;
    })
    .join(", ");
  const synth = await ctx.forceSynthesis(
    session, ctx.getProvider(), signal,
    "The requested artifact has just been BUILT by the build specialist and is ALREADY attached to this message as a downloadable file. "
    + `ARTIFACT FACTS (the only ground truth about what was built): ${artifactFacts}. `
    + (harvestedIncomplete ? "IMPORTANT: the file was recovered from a draft that was CUT OFF before the end — tell the user plainly that the app file is incomplete (it may not run yet) and offer to finish it. " : "")
    + "Confirm to the user in the SAME language as their request: state that the file was created, give its path(s) and size, and summarize ONLY what the builder's own report explicitly says it implemented — do NOT advertise features (quiz, simulator, flashcards, tracking, …) that the report does not state were built, and if the artifact is small or minimal, say so plainly and offer to extend it. "
    + "Do NOT dump raw evidence and do NOT paste the file's HTML/CSS/JS code or any fenced code block — the file is attached, so inlining its code is redundant and confusing.",
  );
  // Belt-and-suspenders: the slow model sometimes ignores the no-code instruction and
  // pastes a large (often fabricated, non-matching) code block — see audit ce8e2128 where
  // the chat dumped a different inline HTML than the built file. The artifact is already a
  // download, so a big fenced block in the confirmation is always noise; strip it.
  const synthDeFenced = synth ? stripLargeCodeFences(synth) : null;
  const candidate = synthDeFenced ? sanitizeUserFacingAssistantResponse(synthDeFenced, ctx.getIterationCount()) : null;
  logAudit("guardrail_flagged", {
    type: "final_qa_corrective_build_synthesized",
    artifacts: paths.length,
    synthesized: Boolean(candidate && candidate.trim().length >= 80),
  }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  return candidate && candidate.trim().length >= 80
    ? candidate
    : `Die angeforderte Datei wurde erstellt: ${paths.join(", ")}.\n\n(The requested file was built: ${paths.join(", ")}.)`;
};

// One bounded corrective RE-ROUTE for the zero-work fabrication guard on NON-artifact
// requests: the model fabricated a tool-minted deliverable for a question that never
// asked for an artifact (e.g. a mail/lookup request answered with an invented link).
// A BUILD TASK would compound the fabrication with a deliverable nobody wanted
// (session 24826c33: "Schau mal ob ich neue Emails habe" → BUILD TASK → researcher →
// canned "Der Bau ist fehlgeschlagen"). Instead, re-dispatch the ORIGINAL request once
// through autonomous delegation (no agentName — bidding/semantic routing picks the
// specialist, the same path the user's manual follow-up would take) and ship the
// specialist's answer. Returns the deliverable text, or null when the delegation
// failed or returned nothing shippable (the caller then sends an honest denial).
export const runCorrectiveReroute = async (ctx: CorrectiveContext): Promise<string | null> => {
  const { signal, session, userMessage, toolContext } = ctx;
  if (signal.aborted) return null;
  logAudit("guardrail_flagged", {
    type: "fabricated_zero_work_reroute_delegated",
    userMessageChars: userMessage.length,
  }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  ctx.onStatus?.({ phase: "guardrail", message: "Die vorherige Antwort war nicht durch ausgeführte Arbeit gedeckt — ich leite die Anfrage an den passenden Spezialisten weiter.", iteration: ctx.getIterationCount() });
  try {
    const rerouteResult = await executeTool("delegate_to_agent", {
      task: userMessage,
    }, { ...toolContext, allowDelegationAfterOperatorStop: true });
    ctx.incrementDelegationCount();
    // Record a well-formed assistant+tool pair (same as the corrective build) so the
    // delegated evidence is in history and any artifacts surface as attachments.
    const rerouteCallId = `qareroute_${Date.now().toString(36)}`;
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: rerouteCallId, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ task: "REROUTE (zero-work fabrication guard)" }) } }],
    });
    session.addMessage({
      role: "tool",
      content: (rerouteResult.success ? rerouteResult.output : (rerouteResult.error?.trim() ? `Error: ${rerouteResult.error}` : rerouteResult.output)).slice(0, 4_000),
      tool_call_id: rerouteCallId,
      metadata: rerouteResult.metadata,
    });
    if (!rerouteResult.success) return null;
    const rerouteOutput = rerouteResult.output;
    if (/TASK FAILED|PARTIAL PROGRESS|TASK COMPLETED \(PARTIAL/i.test(rerouteOutput)) return null;
    const evidenceMatch = EVIDENCE_SECTION_RE.exec(rerouteOutput);
    const body = stripLeadingReasoningPreamble(
      (evidenceMatch ? rerouteOutput.slice(evidenceMatch.index + evidenceMatch[0].length) : rerouteOutput).trim(),
    );
    if (!body || looksLikeDegenerateRepetition(body) || looksLikeTruncatedCodeDeliverable(body)) return null;
    return body;
  } catch (err) {
    ctx.logWarn({ err, sessionId: session.id }, "Zero-work fabrication reroute delegation failed");
    return null;
  }
};
