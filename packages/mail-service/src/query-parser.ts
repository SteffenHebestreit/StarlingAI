export interface ParsedQuery {
  imapQueries: Array<Record<string, unknown>>;
  mailboxHints: string[];
}

interface TermToken {
  type: "term";
  kind: "body" | "op";
  value: string;
  negated?: boolean;
  op?: string;
}

interface OrToken {
  type: "or";
}

interface ParenToken {
  type: "paren";
  value: "(" | ")";
}

type Token = TermToken | OrToken | ParenToken;
type AstNode = TermToken | { type: "or"; children: AstNode[] } | { type: "and"; children: AstNode[] } | null;

export class GmailQueryParser {
  static parse(query: string): ParsedQuery {
    if (!query.trim()) {
      return { imapQueries: [{ all: true }], mailboxHints: [] };
    }

    const lines = query
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.toUpperCase() !== "OR");
    const mailboxHints: string[] = [];
    const imapQueries: Array<Record<string, unknown>> = [];

    for (const line of lines) {
      const tokens = this.tokenize(line);
      const ast = this.buildAst(tokens);
      const imapQuery = this.astToImap(ast, mailboxHints);
      if (imapQuery && !imapQuery["all"]) {
        imapQueries.push(imapQuery);
      }
    }

    if (imapQueries.length === 0) {
      imapQueries.push({ all: true });
    }

    return { imapQueries, mailboxHints };
  }

  private static tokenize(query: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < query.length) {
      if (/\s/.test(query[index] ?? "")) {
        index += 1;
        continue;
      }

      if (query[index] === "(" || query[index] === ")") {
        tokens.push({ type: "paren", value: query[index] as "(" | ")" });
        index += 1;
        continue;
      }

      if (query[index] === '"') {
        const end = query.indexOf('"', index + 1);
        const value = end === -1 ? query.slice(index + 1) : query.slice(index + 1, end);
        tokens.push({ type: "term", kind: "body", value });
        index = end === -1 ? query.length : end + 1;
        continue;
      }

      let word = "";
      while (index < query.length && !/[\s()"]/.test(query[index] ?? "")) {
        word += query[index];
        index += 1;
      }

      const upper = word.toUpperCase();
      if (upper === "OR") {
        tokens.push({ type: "or" });
        continue;
      }
      if (upper === "AND") {
        continue;
      }

      const negated = word.startsWith("-");
      const clean = negated ? word.slice(1) : word;
      const colonIndex = clean.indexOf(":");

      if (colonIndex > 0) {
        const op = clean.slice(0, colonIndex).toLowerCase();
        let value = clean.slice(colonIndex + 1);
        if (value.startsWith('"')) {
          value = value.slice(1);
          while (index < query.length && !value.endsWith('"')) {
            value += query[index];
            index += 1;
          }
          if (value.endsWith('"')) value = value.slice(0, -1);
        }
        tokens.push({ type: "term", kind: "op", op, value, negated });
        continue;
      }

      tokens.push({ type: "term", kind: "body", value: clean, negated });
    }

    return tokens;
  }

  private static buildAst(tokens: Token[]): AstNode {
    let position = 0;

    const peek = () => tokens[position];
    const advance = () => tokens[position++];

    const parseOr = (): AstNode => {
      const left = parseAnd();
      const items: AstNode[] = left ? [left] : [];

      while (position < tokens.length) {
        const token = peek();
        if (token?.type !== "or") break;
        advance();
        const right = parseAnd();
        if (right) items.push(right);
      }

      if (items.length === 0) return null;
      if (items.length === 1) return items[0] ?? null;
      return { type: "or", children: items as AstNode[] };
    };

    const parseAnd = (): AstNode => {
      const items: AstNode[] = [];
      while (position < tokens.length) {
        const token = peek();
        if (!token) break;
        if (token.type === "or") break;
        if (token.type === "paren" && token.value === ")") break;
        const atom = parseAtom();
        if (atom) items.push(atom);
      }

      if (items.length === 0) return null;
      if (items.length === 1) return items[0] ?? null;
      return { type: "and", children: items };
    };

    const parseAtom = (): AstNode => {
      const token = peek();
      if (!token) return null;
      if (token.type === "paren" && token.value === "(") {
        advance();
        const inner = parseOr();
        const nextToken = peek();
        if (nextToken?.type === "paren" && nextToken.value === ")") {
          advance();
        }
        return inner;
      }
      if (token.type === "term") {
        advance();
        return token;
      }
      advance();
      return null;
    };

    return parseOr();
  }

  private static astToImap(node: AstNode, mailboxHints: string[]): Record<string, unknown> {
    if (!node) return { all: true };
    if (node.type === "term") return this.termToImap(node, mailboxHints) ?? { all: true };
    if (node.type === "or") {
      const children = node.children.map((child) => this.astToImap(child, mailboxHints)).filter(Boolean);
      if (children.length === 0) return { all: true };
      if (children.length === 1) return children[0] ?? { all: true };
      return { or: children };
    }
    const children = node.children.map((child) => this.astToImap(child, mailboxHints)).filter(Boolean);
    if (children.length === 0) return { all: true };
    if (children.length === 1) return children[0] ?? { all: true };
    return this.mergeAndCriteria(children);
  }

  private static termToImap(term: TermToken, mailboxHints: string[]): Record<string, unknown> | null {
    if (term.kind === "body") {
      const criterion = { body: term.value };
      return term.negated ? { not: criterion } : criterion;
    }

    const op = term.op ?? "";
    const value = term.value;
    let criterion: Record<string, unknown> | null = null;

    switch (op) {
      case "from":
      case "to":
      case "cc":
      case "bcc":
      case "subject":
      case "body":
        criterion = { [op]: value };
        break;
      case "after":
      case "newer":
      case "newer_than":
        criterion = { since: this.parseDate(value) };
        break;
      case "before":
      case "older":
      case "older_than":
        criterion = { before: this.parseDate(value) };
        break;
      case "on":
        criterion = { on: this.parseDate(value) };
        break;
      case "has":
        if (value === "attachment") {
          criterion = { header: { "content-type": "multipart" } };
        }
        break;
      case "filename":
        criterion = { body: value };
        break;
      case "is":
        if (value === "unread" || value === "unseen") criterion = { seen: false };
        else if (value === "read" || value === "seen") criterion = { seen: true };
        else if (value === "starred" || value === "flagged") criterion = { flagged: true };
        break;
      case "in":
      case "label":
      case "folder":
        mailboxHints.push(value);
        return null;
      case "larger":
        criterion = { larger: this.parseSize(value) };
        break;
      case "smaller":
        criterion = { smaller: this.parseSize(value) };
        break;
      default:
        criterion = { body: `${op}:${value}` };
        break;
    }

    if (!criterion) return null;
    return term.negated ? { not: criterion } : criterion;
  }

  private static mergeAndCriteria(criteria: Record<string, unknown>[]): Record<string, unknown> {
    const keyCount: Record<string, number> = {};
    for (const criterion of criteria) {
      for (const key of Object.keys(criterion)) {
        keyCount[key] = (keyCount[key] ?? 0) + 1;
      }
    }

    const hasConflict = Object.values(keyCount).some((count) => count > 1);
    if (!hasConflict) {
      return Object.assign({}, ...criteria);
    }

    // imapflow has no AND operator and a plain object cannot carry duplicate keys,
    // so colliding same-key criteria (a multi-word body search, or two from:/subject:
    // terms) previously kept only the FIRST value per key and silently dropped the
    // rest → the search returned the wrong emails. Express A AND B AND … via
    // De Morgan — NOT( NOT A OR NOT B OR … ) — using imapflow's supported not/or.
    return { not: { or: criteria.map((criterion) => ({ not: criterion })) } };
  }

  private static parseDate(value: string): Date {
    // Gmail relative durations: newer_than:7d / older_than:1m / older_than:1y.
    // `new Date("7d")` is an Invalid Date, which corrupts the IMAP SINCE/BEFORE
    // criterion — compute now minus the duration instead.
    const relative = value.match(/^(\d+)([dmy])$/i);
    if (relative) {
      const amount = Number.parseInt(relative[1] ?? "0", 10);
      const unit = (relative[2] ?? "d").toLowerCase();
      const date = new Date();
      if (unit === "d") date.setDate(date.getDate() - amount);
      else if (unit === "m") date.setMonth(date.getMonth() - amount); // Gmail: months, not minutes
      else date.setFullYear(date.getFullYear() - amount); // "y": years
      return date;
    }
    const normalized = value.replace(/\//g, "-");
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) return date;
    return new Date(value);
  }

  private static parseSize(value: string): number {
    const match = value.match(/^(\d+(?:\.\d+)?)\s*(k|m|g)?b?$/i);
    if (!match) return Number.parseInt(value, 10) || 0;
    const numberValue = Number.parseFloat(match[1] ?? "0");
    const unit = (match[2] ?? "").toLowerCase();
    switch (unit) {
      case "k":
        return Math.round(numberValue * 1024);
      case "m":
        return Math.round(numberValue * 1024 * 1024);
      case "g":
        return Math.round(numberValue * 1024 * 1024 * 1024);
      default:
        return Math.round(numberValue);
    }
  }
}