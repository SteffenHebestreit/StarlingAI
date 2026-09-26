/**
 * Which prompt HEAD a model call carried: the folded system text and the tool block, as hashes.
 *
 * The head is the KV-cache key on the serving model (llama.cpp reuses the longest byte-identical
 * prefix, and on the hybrid Qwen3.6 station a change anywhere in it keeps 0% of the cache — live
 * probe E2, 2026-09-26). The audit could not say whether two calls shared one:
 *
 * - `promptChars` on a sub-agent's stats is cumulative over the run, so two dispatches of the
 *   same agent never compare equal even when their heads were byte-identical;
 * - `effectiveTools` on sub_agent_started is the list BEFORE the rerank reorders it, and a
 *   reorder alone is a full cold prefill (47 s against 0.43 s, sub-agent.ts rerank comment);
 * - the orchestrator's forced subset (record_plan while no plan exists, execute_plan once one
 *   does) is chosen per call and left no trace but a toolCount.
 *
 * c297c5ea (the 81-minute turn) is the case this exists for: all 13 sub-agent first calls were
 * cold, and whether content_writer's dispatches 3 and 4 had byte-identical heads could only be
 * argued, not read off a row. With these hashes on every call, "the head changed" and "the head
 * was the same and still cold" are two different rows.
 *
 * `toolsHash` covers the whole wire tool array in order — names, descriptions and parameter
 * schemas — because the server renders all of it into the prompt: a reworded description moves
 * the cache key exactly as a reorder does. `headHash` combines it with the system text; two
 * calls with the same headHash sent the same head bytes. Hashes, never the text: the system
 * prompt of a sub-agent carries the workspace path and the staged-build directive's file names.
 */
import { createHash } from "node:crypto";

/** Sixteen hex digits: 64 bits, far past any collision a few thousand heads a day could hit. */
const HASH_HEX_CHARS = 16;

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_HEX_CHARS);
}

/** The same short hash for a bare text, for rows that record a head's system part on its own. */
export function hashText(text: string): string {
  return shortHash(text);
}

/** A tool as it goes on the wire: the fields the chat template renders. */
export interface HeadTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface PromptHeadSignature {
  /** The system text and the tool block together: equal means the same head bytes were sent. */
  headHash: string;
  /** The tool block alone, in wire order: tells a forced subset from the full block. */
  toolsHash: string;
  /** The folded system text alone. */
  systemHash: string;
  systemChars: number;
  toolCount: number;
}

/** Hash of the tool array in the order it is sent. Order matters: the server renders it as given. */
export function hashToolBlock(tools: readonly HeadTool[]): string {
  return shortHash(JSON.stringify(tools.map((tool) => [tool.name, tool.description ?? "", tool.parameters ?? null])));
}

export function promptHeadSignature(system: string, tools: readonly HeadTool[]): PromptHeadSignature {
  const toolsHash = hashToolBlock(tools);
  const systemHash = shortHash(system);
  return {
    headHash: shortHash(`${toolsHash}\n${systemHash}`),
    toolsHash,
    systemHash,
    systemChars: system.length,
    toolCount: tools.length,
  };
}

/**
 * The head of a request as the provider sends it: its leading run of system messages and its
 * tools. The provider folds the turn's own run into one message, so that is usually one, and it
 * hashes exactly as that text alone does (what sub_agent_head and prompt_section_sizes hash). On
 * gpt-oss, withReasoningSystemLine then puts the `Reasoning: <level>` line AHEAD of it as a message
 * of its own; the run is joined as the fold joins it, so the prompt behind that line still moves
 * the hash (hashing only the first message made every call at one level the same "system"). A
 * request with no system message (a Gemma template folds it into the first user turn) hashes the
 * empty string for its system part.
 */
export function wireHeadSignature(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  tools: readonly HeadTool[],
): PromptHeadSignature {
  const run: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") break;
    run.push(typeof message.content === "string" ? message.content : "");
  }
  return promptHeadSignature(run.join("\n\n"), tools);
}
