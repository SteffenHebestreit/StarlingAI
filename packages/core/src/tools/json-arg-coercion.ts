/**
 * Lenient parsing of an array or object argument that a model sent as a JSON string. Moved
 * unchanged from tools/website.ts, so that web_table can share it without importing a module that
 * registers tools; website.ts imports it from here and behaves as before.
 */

// Escape stray, unescaped double-quotes that appear INSIDE a JSON string value — the
// dominant way the slow local model corrupts a serialized slides/bullets string (audit
// 39953ed9: a notes value `… „Elbflorenz" rührt …` left the closing typographic quote as a
// raw " that terminated the string early and broke JSON.parse, so coercion failed and the
// build fell back to hand-written HTML). Single left-to-right pass that tracks both string
// state AND structural position (object key vs value), because the delimiter rule differs:
//   - a KEY string closes only before ':'   (e.g. `"content":`)
//   - a VALUE string closes only before ',' '}' ']' or EOF — a value is NEVER followed by
//     a colon, so a `"` inside a value that precedes ':' is a stray inner quote and must be
//     escaped. The earlier version treated ':' as a delimiter regardless of position, so a
//     German quotation like `**Begriff „Zwinger":**` inside a notes value was read as a key
//     terminator → the repaired JSON was still broken → JSON.parse failed again → every deck
//     retry bounced on "slides must be an array" (audit 3c46a4d4: presentation + speaker
//     notes never built, the step burned its whole budget on identical rejections).
// Used ONLY as a fallback after a normal JSON.parse fails, so valid JSON is never touched.
export function repairUnescapedInnerQuotes(s: string): string {
  let out = "";
  let inStr = false;
  let curStringIsKey = false;
  const stack: Array<"obj" | "arr"> = [];
  let expectKey = false; // meaningful when top of stack is "obj": next opened string is a key
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!inStr) {
      out += c;
      if (c === '"') {
        inStr = true;
        curStringIsKey = stack[stack.length - 1] === "obj" && expectKey;
      } else if (c === "{") {
        stack.push("obj");
        expectKey = true;
      } else if (c === "[") {
        stack.push("arr");
        expectKey = false;
      } else if (c === "}" || c === "]") {
        stack.pop();
      } else if (c === ":") {
        expectKey = false; // the value of the current key follows
      } else if (c === ",") {
        expectKey = stack[stack.length - 1] === "obj"; // next object entry starts with a key
      }
      continue;
    }
    if (c === "\\") { // copy an escape sequence verbatim (e.g. \" \\ \n)
      out += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
      const next = j < s.length ? s[j]! : "";
      const isDelimiter = curStringIsKey
        ? next === ":"
        : next === "" || next === "," || next === "}" || next === "]";
      if (isDelimiter) {
        out += '"'; // genuine closing delimiter
        inStr = false;
      } else {
        out += '\\"'; // stray inner quote → escape it so JSON.parse survives
      }
      continue;
    }
    out += c;
  }
  return out;
}

// The slow local model frequently serializes an ARRAY argument as a JSON STRING
// (`"slides": "[{…}]"`, `"bullets": "[\"…\"]"`) instead of a real array — a tool-calling
// quirk of small models, not a user error. Parsing it leniently lets the deck build on the
// FIRST call instead of bouncing on "slides must be an array" and burning the per-tool cap,
// which collapsed every build into hand-written-HTML timeouts (audit 2daf5f54: 5 turns /
// ~100 min before one call happened to pass a real array).
export function coerceJsonArrayArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try { return JSON.parse(trimmed); } catch {
    // Fallback: repair the dominant defect (unescaped inner quotes) and retry once.
    try { return JSON.parse(repairUnescapedInnerQuotes(trimmed)); } catch { return value; }
  }
}

