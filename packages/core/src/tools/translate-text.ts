/**
 * Tier 0 (read-only) — Inline text translation via the configured LLM.
 *
 * For short strings and snippets only.  Spawning the `translator` sub-agent
 * is still preferred for multi-paragraph documents, quality-review workflows,
 * or when human QA spot-checks are required.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { getChatProviderWithOverride } from "../providers/index.js";
import { childLogger } from "../logger.js";
import type { LLMMessage } from "../providers/lmstudio.js";

const log = childLogger("tool:translate-text");

const MAX_INPUT_CHARS = 4_000;

registerTool({
  name: "translate_text",
  description:
    "Translate a short text string into a target language using the configured LLM. " +
    "Returns only the translated text — no commentary, no explanations. " +
    "Best for single sentences, UI labels, short paragraphs, and inline snippets (up to ~4 000 characters). " +
    "For multi-page documents or when a QA review pass is required, use the `translator` sub-agent instead. " +
    "This tool is read-only and does not require per-call approval.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to translate (max ~4 000 characters).",
      },
      targetLanguage: {
        type: "string",
        description: "Target language name or BCP-47 code (e.g. 'German', 'fr', 'Japanese', 'pt-BR').",
      },
      sourceLanguage: {
        type: "string",
        description:
          "Source language name or BCP-47 code. " +
          "Omit to let the model auto-detect the source language.",
      },
      preserveFormatting: {
        type: "boolean",
        description:
          "When true (default), preserve Markdown, HTML, or code block formatting in the output.",
        default: true,
      },
    },
    required: ["text", "targetLanguage"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = String(args["text"] ?? "").trim();
    const targetLanguage = String(args["targetLanguage"] ?? "").trim();
    const sourceLanguage = args["sourceLanguage"] != null
      ? String(args["sourceLanguage"]).trim()
      : "";
    const preserveFormatting = args["preserveFormatting"] !== false;

    if (!text) {
      return { success: false, output: "", error: "text must not be empty." };
    }
    if (!targetLanguage) {
      return { success: false, output: "", error: "targetLanguage must not be empty." };
    }
    if (text.length > MAX_INPUT_CHARS) {
      return {
        success: false,
        output: "",
        error: `Input text exceeds ${MAX_INPUT_CHARS} character limit. Use the translator sub-agent for long documents.`,
      };
    }

    const fromClause = sourceLanguage
      ? `from ${sourceLanguage} `
      : "";
    const formatNote = preserveFormatting
      ? " Preserve all Markdown, HTML tags, and code blocks exactly — translate only the natural-language content."
      : "";

    const systemPrompt =
      `You are a professional translator. ` +
      `Translate the user-provided text ${fromClause}into ${targetLanguage}. ` +
      `Output ONLY the translated text — no preamble, no explanation, no alternatives, no quotation marks wrapping the result.` +
      formatNote;

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    log.info(
      { targetLanguage, sourceLanguage, chars: text.length, sessionId: ctx.sessionId },
      "translate_text",
    );

    try {
      const provider = getChatProviderWithOverride({
        temperature: 0.1,
        maxTokens: Math.max(512, text.length * 3),
      });
      const response = await provider.complete(messages, [], ctx.signal);
      const translated = (response.content ?? "").trim();

      if (!translated) {
        return { success: false, output: "", error: "The model returned an empty translation." };
      }

      return {
        success: true,
        output: translated,
        metadata: {
          targetLanguage,
          sourceLanguage: sourceLanguage || "auto-detected",
          inputChars: text.length,
          outputChars: translated.length,
          usage: response.usage,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId: ctx.sessionId }, "translate_text failed");
      return { success: false, output: "", error: `Translation failed: ${message}` };
    }
  },
});
