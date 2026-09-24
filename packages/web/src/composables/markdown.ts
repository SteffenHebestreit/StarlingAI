/**
 * Markdown for chat messages: marked with the chat's code and image renderers, highlight.js with
 * the languages chat sees, and a cache of finished messages' HTML.
 *
 * All of it is set up ONCE, here, at module load. It used to sit at the top of MessageBubble's
 * `<script setup>`, which runs per bubble: every mount added another layer of renderer overrides
 * to marked's global instance (marked stacks them, so an image walked one layer per bubble ever
 * mounted, each holding that bubble's setup scope alive), re-registered every language, and gave
 * each bubble a cache of its own that died with it — so the cache never served a remount, which
 * is the only case it was for.
 *
 * The overrides stay on marked's global instance on purpose: the other pages that parse markdown
 * (session transcripts, the swarm panel) have always rendered with them once a chat was open.
 */
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { renderInlineImage } from "./inlineImages";

// ── highlight.js: register only the languages we expect to see in chat to keep
// the bundle small. Aliases (sh, ts, js, html, etc.) come from the language
// modules themselves. Unknown languages fall through to plaintext.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightCode(code: string, lang: string): string {
  const trimmed = (lang ?? "").trim().toLowerCase();
  if (trimmed && hljs.getLanguage(trimmed)) {
    try {
      return hljs.highlight(code, { language: trimmed, ignoreIllegals: true }).value;
    } catch {
      // fall through to escapeHtml below
    }
  }
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeSvgMarkup(raw: string): string | null {
  const normalized = raw.replace(/^﻿/, "").replace(/^<\?xml[^>]*>\s*/i, "").trim();
  const match = normalized.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  const sanitized = DOMPurify.sanitize(match[0], {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  }).trim();
  return /<svg[\s\S]*?<\/svg>/i.test(sanitized) ? sanitized : null;
}

function renderSvgPreviewBlock(code: string, lang: string): string | null {
  const normalizedLang = (lang ?? "").trim().toLowerCase();
  if (normalizedLang && !["svg", "xml", "html"].includes(normalizedLang)) {
    return null;
  }
  const svg = sanitizeSvgMarkup(code);
  if (!svg) return null;
  return svg;
}

// Every <pre><code> in the chat gets a header bar with an optional language label and a copy
// button. The button has data-copy-code so a single click handler on the message wrapper can
// find the matching <code> and copy its text.
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").trim();
      if (language === "mermaid") {
        // Leave mermaid blocks untouched so the existing inline mermaid
        // renderer / artifact preview can handle them downstream.
        return `<pre><code class="language-mermaid">${escapeHtml(text)}</code></pre>`;
      }
      const highlighted = highlightCode(text, language);
      const svgPreview = renderSvgPreviewBlock(text, language);
      const langLabel = language
        ? `<span class="code-block__lang">${escapeHtml(language)}</span>`
        : "<span class=\"code-block__lang code-block__lang--unknown\">code</span>";
      const actions = svgPreview
        ? `<div class="code-block__actions">
    <div class="code-block__toggle-group" role="tablist" aria-label="SVG block display mode">
      <button class="code-block__toggle code-block__toggle--active" data-svg-mode-button="preview" type="button" aria-pressed="true">Preview</button>
      <button class="code-block__toggle" data-svg-mode-button="code" type="button" aria-pressed="false">Code</button>
    </div>
    <button class="code-block__copy" data-copy-code="1" type="button" aria-label="Copy code to clipboard">Copy</button>
  </div>`
        : `<button class="code-block__copy" data-copy-code="1" type="button" aria-label="Copy code to clipboard">Copy</button>`;
      return `<div class="code-block${svgPreview ? " code-block--svg" : ""}"${svgPreview ? ' data-svg-mode="preview"' : ""}>
  <div class="code-block__header">
    ${langLabel}
    ${actions}
  </div>
  ${svgPreview ? `<div class="code-block__svg-preview" data-svg-panel="preview" aria-label="SVG preview">${svgPreview}</div>` : ""}
  <pre${svgPreview ? ' data-svg-panel="code"' : ""}><code class="language-${escapeHtml(language || "plaintext")} hljs">${highlighted}</code></pre>
</div>`;
    },
    // An inline image of a workspace file becomes a short reference: as a relative URL it only
    // ever reached the SPA's index.html, and the attachment card shows the picture itself.
    // Remote and data: images fall through to marked's own renderer (see inlineImages).
    image({ href, text }: Tokens.Image): string | false {
      return renderInlineImage({ href, text });
    },
  },
});

// breaks=true: single \n in source becomes <br> so multi-line user messages
//   don't get collapsed into one wrapped paragraph by CommonMark rules.
// gfm=true:    GitHub-flavored extras (tables, autolinks, ~~strikethrough~~)
//   that match the conventions assistant messages already use.
export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false, breaks: true, gfm: true }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}

/**
 * Stabilize a stream-in-progress so marked doesn't render half-open structures
 * as ugly artifacts that then snap into place when the closer arrives.
 *  - Unclosed fenced code block: append a closing ``` so the partial code is
 *    still rendered as a code block (with the right language class) instead of
 *    cascading into the rest of the message as paragraph text.
 *  - Half-typed inline code (``foo``) is a non-issue — a single ` rolls back
 *    to a literal backtick at render time.
 */
function stabilizePartialMarkdown(raw: string): string {
  const fenceCount = (raw.match(/^(```+)/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    const trailing = raw.endsWith("\n") ? "" : "\n";
    return `${raw}${trailing}\`\`\``;
  }
  return raw;
}

export function renderStreamingMarkdown(raw: string): string {
  return renderMarkdown(stabilizePartialMarkdown(raw));
}

// A bounded FIFO cache of finished messages' HTML, shared by every bubble. Expanding a long
// transcript remounts every MessageBubble, which would otherwise re-run marked.parse + DOMPurify
// over each message again. The live bubble is never cached (its text changes every frame).
//
// Keyed by id, length AND a hash of the text: shared across bubbles and sessions, an id alone
// can come back with other words — a transcript id names a position in the history, and a
// rewind puts a different message at the same position.
const renderedMarkdownCache = new Map<string, string>();
const RENDERED_MARKDOWN_CACHE_MAX = 500;

function textHash(value: string): string {
  // FNV-1a, 32 bit: cheap next to a markdown parse, and only has to tell versions of one message apart.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function memoizedRenderMarkdown(id: string, raw: string): string {
  if (id === "streaming") return renderMarkdown(raw);
  const key = `${id}:${raw.length}:${textHash(raw)}`;
  const cached = renderedMarkdownCache.get(key);
  if (cached !== undefined) return cached;
  const html = renderMarkdown(raw);
  renderedMarkdownCache.set(key, html);
  if (renderedMarkdownCache.size > RENDERED_MARKDOWN_CACHE_MAX) {
    const oldest = renderedMarkdownCache.keys().next().value;
    if (oldest !== undefined) renderedMarkdownCache.delete(oldest);
  }
  return html;
}
