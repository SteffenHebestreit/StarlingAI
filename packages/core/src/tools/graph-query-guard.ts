/**
 * graph_query under multi-user auth (found 2026-10-08).
 *
 * MemGraph is one instance for every account, and graph_query ran the model's Cypher with no tenant
 * filter: the researcher, which holds it and reads untrusted pages, could return any account's
 * memory text from any account's turn. A value a query projects cannot be traced back to the node it
 * came from, so the guard works on both ends of the query:
 *
 *   - before it runs, memoryReadRefusal refuses a query that could read memory text other than as a
 *     whole node: one that names a text property (m.content, {content: ...}), reads every property
 *     ({.*}, properties(), values()), indexes a value by a key computed at run time (m[k]), calls a
 *     procedure or a query-module function, or is anything but one read query;
 *   - after it runs, withholdForeignMemory reduces every MemoryRecord node the reader may not see to
 *     its id, kind and scope, wherever it sits in the result: a column, a list, a map, a path.
 *
 * The checks read the query the way Memgraph lexes it (strings, quoted names, comments) and refuse
 * what they cannot read with certainty. Memgraph takes most keywords as variable names too, so a
 * keyword is never trusted to mean the clause it names.
 */
import {
  isNode,
  isPath,
  isPathSegment,
  Node,
  Path,
  PathSegment,
  Record as GraphRecord,
  type QueryResult,
} from "neo4j-driver";
import { isGraphMemoryReadable, type GraphMemoryReader } from "../memory/graph-service.js";

/** MemoryRecord properties that hold its text, a vector of the text, or its owner. */
const MEMORY_TEXT_PROPERTIES = new Set(["content", "previousContent", "embedding", "tenant"]);

/** What a memory node another account owns still shows. */
const SHOWN_PROPERTIES = ["id", "kind", "scope"] as const;

/**
 * Built-in functions that turn a node or a map into its values, or into a string of them (Memgraph
 * 3.11; function names are case-insensitive). A query-module function such as json_util.to_json is
 * refused by its dotted name.
 */
const VALUE_FUNCTIONS = new Set([
  "properties", "values", "propertysize", "tostring", "tostringornull", "tostringlist", "project", "derive",
]);

/** The clauses a read query starts with. */
const READ_CLAUSES = new Set(["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN"]);

/** Clauses that run something other than the read itself: a procedure or a subquery, a file load. */
const OTHER_CLAUSES = new Set(["CALL", "LOAD"]);

/**
 * Punctuation after which "[" opens a list or a relationship pattern. After anything else, a name, a
 * keyword, a literal or a closing bracket, it may index the value before it: `WITH m AS in RETURN
 * in['content']` reads a property, because `in` is a variable there.
 */
const LIST_OPENS_AFTER = new Set(["(", "[", "{", ",", ":", "|", "=", "<", ">", "+", "-", "*", "/", "%", "^", "..", "!", "~"]);

interface Token {
  kind: "word" | "quoted" | "string" | "number" | "param" | "punct";
  /** A quoted name unescaped; a string literal as written. */
  text: string;
}

const NUMBER = /0[xX][0-9A-Fa-f]+|[0-9]*\.[0-9]+(?:[eE]-?[0-9]+)?|[0-9]+(?:[eE]-?[0-9]+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const PARAM_NAME = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+/y;

/** A backtick-quoted name from the backtick at `start`; a doubled backtick stands for one. */
function quotedName(cypher: string, start: number): { name: string; end: number } | null {
  let name = "";
  let at = start;
  for (;;) {
    const close = cypher.indexOf("`", at + 1);
    if (close < 0) return null;
    name += cypher.slice(at + 1, close);
    if (cypher[close + 1] !== "`") return { name, end: close + 1 };
    name += "`";
    at = close + 1;
  }
}

function sticky(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
}

/**
 * The query's tokens as Memgraph lexes them, as far as the checks need: strings and quoted names
 * whole, comments and whitespace dropped. A reason instead when the text cannot be read with
 * certainty.
 */
function lex(cypher: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < cypher.length) {
    const ch = cypher[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\v" || ch === "\f") {
      i += 1;
      continue;
    }
    if (cypher.startsWith("//", i)) {
      // A carriage return ends the comment here as well: reading less as a comment than Memgraph
      // does only means checking more.
      while (i < cypher.length && cypher[i] !== "\n" && cypher[i] !== "\r") i += 1;
      continue;
    }
    if (cypher.startsWith("/*", i)) {
      const end = cypher.indexOf("*/", i + 2);
      if (end < 0) return "a comment is never closed";
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      let j = i + 1;
      while (j < cypher.length && cypher[j] !== ch) j += cypher[j] === "\\" ? 2 : 1;
      if (j >= cypher.length) return "a string is never closed";
      tokens.push({ kind: "string", text: cypher.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && cypher[i + 1] === "`")) {
      const quoted = quotedName(cypher, ch === "$" ? i + 1 : i);
      if (!quoted) return "a quoted name is never closed";
      tokens.push({ kind: ch === "$" ? "param" : "quoted", text: quoted.name });
      i = quoted.end;
      continue;
    }
    if (ch === "$") {
      const name = sticky(PARAM_NAME, cypher, i + 1);
      if (!name) return "a $ names no parameter";
      tokens.push({ kind: "param", text: name });
      i += 1 + name.length;
      continue;
    }
    const number = /[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(cypher[i + 1] ?? "")) ? sticky(NUMBER, cypher, i) : null;
    if (number) {
      tokens.push({ kind: "number", text: number });
      i += number.length;
      continue;
    }
    const word = sticky(WORD, cypher, i);
    if (word) {
      tokens.push({ kind: "word", text: word });
      i += word.length;
      continue;
    }
    if (cypher.startsWith("..", i)) {
      tokens.push({ kind: "punct", text: ".." });
      i += 2;
      continue;
    }
    // Memgraph takes more characters as whitespace and as parts of names than these checks know, and
    // such a character is refused rather than guessed at.
    if (ch < "!" || ch > "~") return "it has a character outside printable ASCII outside a string or a quoted name";
    tokens.push({ kind: "punct", text: ch });
    i += 1;
  }
  return tokens;
}

const CLOSES: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** The index of the "]" that closes the "[" at `open`, or -1 when the brackets do not pair up. */
function closingBracket(tokens: Token[], open: number): number {
  const stack: string[] = [];
  for (let k = open; k < tokens.length; k += 1) {
    const token = tokens[k]!;
    if (token.kind !== "punct") continue;
    if (token.text === "(" || token.text === "[" || token.text === "{") stack.push(token.text);
    const opener = CLOSES[token.text];
    if (opener === undefined) continue;
    if (stack.pop() !== opener) return -1;
    if (stack.length === 0) return k;
  }
  return -1;
}

/**
 * Whether a bracket after a value reads no property whichever way Memgraph parses it: an integer
 * index or slice, or a list literal or comprehension, which an index can never be.
 */
function readsNoProperty(inner: Token[]): boolean {
  const integerIndex = inner.every((token) => (token.kind === "number" && /^[0-9]+$/.test(token.text))
    || (token.kind === "punct" && (token.text === "-" || token.text === "..")));
  if (integerIndex) return true;
  // A comma outside any inner bracket: an index is one expression.
  let depth = 0;
  for (const token of inner) {
    if (token.kind !== "punct") continue;
    if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
    else if (CLOSES[token.text] !== undefined) depth -= 1;
    else if (token.text === "," && depth === 0) return true;
  }
  // [x IN list ...]: as an index it would be a boolean, and a boolean names no property. Not when the
  // first word is CASE: `m[CASE in WHEN true THEN 'content' END]` is a CASE on a variable named in.
  const [head, next] = inner;
  const variable = head?.kind === "quoted" || (head?.kind === "word" && head.text.toUpperCase() !== "CASE");
  return variable && next?.kind === "word" && next.text.toUpperCase() === "IN";
}

/** Whether a parameter value carries a map with a memory text property, e.g. as a pattern's property map. */
function namesMemoryText(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => namesMemoryText(item, seen));
  return Object.entries(value).some(([key, item]) => MEMORY_TEXT_PROPERTIES.has(key) || namesMemoryText(item, seen));
}

/**
 * Why graph_query must not run `cypher` under multi-user auth, or null when it may: the query could
 * read memory text other than as a whole node, or cannot be read with certainty.
 */
export function memoryReadRefusal(cypher: string, params: Record<string, unknown> = {}): string | null {
  const tokens = lex(cypher);
  if (typeof tokens === "string") return tokens;
  const first = tokens[0];
  if (first?.kind !== "word" || !READ_CLAUSES.has(first.text.toUpperCase())) {
    return `it starts with ${first ? first.text : "nothing"}, not with MATCH, OPTIONAL MATCH, WITH, UNWIND or RETURN`;
  }
  const punct = (token: Token | undefined, text: string): boolean => token?.kind === "punct" && token.text === text;
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k]!;
    const before = tokens[k - 1];
    const after = tokens[k + 1];
    const named = token.kind === "word" || token.kind === "quoted";
    if (named && MEMORY_TEXT_PROPERTIES.has(token.text)) return `it names the memory property ${token.text}`;
    // After a dot or a colon the word is a property key, a label or a relationship type, never a clause.
    if (token.kind === "word" && !punct(before, ".") && !punct(before, ":") && OTHER_CLAUSES.has(token.text.toUpperCase())) {
      return `it uses ${token.text.toUpperCase()}`;
    }
    if (named && punct(after, "(")) {
      if (token.kind === "quoted") return "it calls a function by a quoted name";
      if (punct(before, ".")) return `it calls the query-module function ${tokens[k - 2]?.text ?? ""}.${token.text}`;
      if (VALUE_FUNCTIONS.has(token.text.toLowerCase())) return `it calls ${token.text}()`;
    }
    if (punct(token, ".") && after?.kind !== "word" && after?.kind !== "quoted") {
      return punct(after, "*") ? "it reads every property of a value ({.*})" : "a dot is not followed by a property name";
    }
    if (punct(token, ";") && k < tokens.length - 1) return "it holds more than one statement";
    if (punct(token, "[") && !(before?.kind === "punct" && LIST_OPENS_AFTER.has(before.text))) {
      const close = closingBracket(tokens, k);
      if (close < 0) return "its brackets do not pair up";
      if (!readsNoProperty(tokens.slice(k + 1, close))) return "it indexes a value by something other than an integer (x[key] reads a property)";
    }
  }
  if (Object.values(params).some((value) => namesMemoryText(value))) return "a parameter holds a map with a memory property";
  return null;
}

/**
 * The result with every MemoryRecord node the reader may not see reduced to its id, kind and scope,
 * wherever it sits: a column, a list, a map, a path. `withheld` counts the distinct nodes reduced.
 */
export function withholdForeignMemory(result: QueryResult, reader: GraphMemoryReader): { result: QueryResult; withheld: number } {
  const withheld = new Set<string>();
  const reduce = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reduce);
    if (value === null || typeof value !== "object") return value;
    if (isNode(value)) {
      if (isGraphMemoryReadable(value.labels, value.properties, reader)) return value;
      withheld.add(String(value.elementId ?? value.identity));
      const shown: Record<string, unknown> = {};
      for (const key of SHOWN_PROPERTIES) if (key in value.properties) shown[key] = value.properties[key];
      return new Node(value.identity, value.labels, shown, value.elementId);
    }
    if (isPathSegment(value)) return new PathSegment(reduce(value.start) as Node, value.relationship, reduce(value.end) as Node);
    if (isPath(value)) {
      return new Path(reduce(value.start) as Node, reduce(value.end) as Node, value.segments.map((segment) => reduce(segment) as PathSegment));
    }
    // A map. Anything else (a relationship, an integer, a temporal or spatial value) holds no node.
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reduce(item)]));
    }
    return value;
  };
  const records = result.records.map((record) => new GraphRecord(record.keys, record.keys.map((key) => reduce(record.get(key)))));
  return { result: { ...result, records }, withheld: withheld.size };
}
