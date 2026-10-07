/**
 * Loads and validates scenario files: eval/e2e/scenarios/**\/*.jsonc (JSON5). A file holds one
 * scenario or an array of them. Beyond ScenarioSchema, the loader checks what the schema cannot:
 * unique ids across files, regexes that compile, fixtures that exist inside eval/e2e/fixtures/,
 * min ≤ max pairs, and which fields each mail action takes. Files whose name starts with "_"
 * (the commented example) are templates: validated like any other, run only when named by --id.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSON5 from "json5";
import { ScenarioSchema, type E2EEventMatcher, type E2EScenario, type E2EStep } from "./scenario.js";
import { compileRegex } from "./assertions.js";

export interface LoadedScenario {
  scenario: E2EScenario;
  /** Path relative to the scenarios directory, "/"-separated. */
  file: string;
  /** From a "_"-prefixed file: run only when selected by id. */
  template: boolean;
}

export interface ScenarioIssue {
  file: string;
  message: string;
}

export interface LoadResult {
  scenarios: LoadedScenario[];
  issues: ScenarioIssue[];
}

function listScenarioFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonc")) files.push(path);
    }
  };
  visit(dir);
  return files.sort((a, b) => {
    const left = relative(dir, a).split(sep).join("/");
    const right = relative(dir, b).split(sep).join("/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function matcherIssues(label: string, matcher: E2EEventMatcher): string[] {
  const issues: string[] = [];
  for (const [path, field] of Object.entries(matcher.where ?? {})) {
    if (typeof field === "object" && "regex" in field) {
      const compiled = compileRegex(field.regex);
      if (compiled instanceof Error) issues.push(`${label}: where.${path} regex /${field.regex}/ does not compile (${compiled.message})`);
    }
  }
  return issues;
}

function regexIssues(label: string, sources: readonly string[] | undefined): string[] {
  const issues: string[] = [];
  for (const source of sources ?? []) {
    const compiled = compileRegex(source, "i");
    if (compiled instanceof Error) issues.push(`${label}: /${source}/ does not compile (${compiled.message})`);
  }
  return issues;
}

function fixtureIssues(label: string, attachments: readonly string[] | undefined, fixturesDir: string): string[] {
  const issues: string[] = [];
  const root = resolve(fixturesDir);
  for (const attachment of attachments ?? []) {
    const target = resolve(root, attachment);
    if (isAbsolute(attachment) || (target !== root && !target.startsWith(`${root}${sep}`))) {
      issues.push(`${label}: attachment "${attachment}" must be a path inside eval/e2e/fixtures/`);
    } else if (!existsSync(target) || !statSync(target).isFile()) {
      issues.push(`${label}: attachment "${attachment}" not found in eval/e2e/fixtures/`);
    }
  }
  return issues;
}

/** Checks the schema leaves open. Empty when the scenario is sound. */
export function semanticIssues(scenario: E2EScenario, fixturesDir: string): string[] {
  const issues: string[] = [];
  scenario.steps.forEach((step: E2EStep, index) => {
    const label = `steps[${index}] (${step.kind}${"id" in step && step.id ? ` ${step.id}` : ""})`;
    switch (step.kind) {
      case "turn": {
        issues.push(...fixtureIssues(label, step.attachments, fixturesDir));
        (step.during ?? []).forEach((action, actionIndex) => {
          if ("event" in action.when) issues.push(...matcherIssues(`${label} during[${actionIndex}]`, action.when.event));
        });
        const expect = step.expect;
        if (!expect) break;
        issues.push(...regexIssues(`${label} expect.reply.matches`, expect.reply?.matches));
        issues.push(...regexIssues(`${label} expect.artifacts.pathMatches`, expect.artifacts?.pathMatches));
        if (expect.reply?.minChars !== undefined && expect.reply.maxChars !== undefined && expect.reply.minChars > expect.reply.maxChars) {
          issues.push(`${label}: expect.reply.minChars ${expect.reply.minChars} > maxChars ${expect.reply.maxChars}`);
        }
        (expect.events?.must ?? []).forEach((matcher, matcherIndex) => {
          issues.push(...matcherIssues(`${label} expect.events.must[${matcherIndex}]`, matcher));
          if (matcher.max !== undefined && (matcher.min ?? 1) > matcher.max) {
            issues.push(`${label} expect.events.must[${matcherIndex}] ${matcher.type}: min ${matcher.min ?? 1} > max ${matcher.max}`);
          }
        });
        (expect.events?.mustNot ?? []).forEach((matcher, matcherIndex) => {
          issues.push(...matcherIssues(`${label} expect.events.mustNot[${matcherIndex}]`, matcher));
        });
        break;
      }
      case "http": {
        const placeholders = step.path.match(/\{[^}]*\}/g) ?? [];
        for (const placeholder of placeholders) {
          if (placeholder !== "{sessionId}") issues.push(`${label}: unknown placeholder ${placeholder} in path (only {sessionId})`);
        }
        break;
      }
      case "mail": {
        if (step.action === "deliver" && !step.message) issues.push(`${label}: deliver needs a message {from, subject, text}`);
        if (step.action !== "deliver" && step.message) issues.push(`${label}: message is only for deliver`);
        if (step.action !== "expect" && step.match) issues.push(`${label}: match is only for expect`);
        if (step.match && step.match.max !== undefined && (step.match.min ?? 1) > step.match.max) {
          issues.push(`${label}: match.min ${step.match.min ?? 1} > match.max ${step.match.max}`);
        }
        break;
      }
      default:
        break;
    }
  });
  return issues;
}

function formatZodIssue(issue: { path: (string | number)[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

/** Every scenario file under `scenariosDir`, parsed and validated. */
export function loadScenarios(scenariosDir: string, fixturesDir: string): LoadResult {
  const scenarios: LoadedScenario[] = [];
  const issues: ScenarioIssue[] = [];
  const byId = new Map<string, string>();
  for (const path of listScenarioFiles(scenariosDir)) {
    const file = relative(scenariosDir, path).split(sep).join("/");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(readFileSync(path, "utf8"));
    } catch (err) {
      issues.push({ file, message: `not valid JSON5: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    if (entries.length === 0) {
      issues.push({ file, message: "holds no scenario" });
      continue;
    }
    entries.forEach((entry, index) => {
      const where = Array.isArray(parsed) ? `[${index}] ` : "";
      const result = ScenarioSchema.safeParse(entry);
      if (!result.success) {
        const rawId = typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>)["id"] === "string"
          ? `${String((entry as Record<string, unknown>)["id"])}: `
          : "";
        for (const issue of result.error.issues) issues.push({ file, message: `${where}${rawId}${formatZodIssue(issue)}` });
        return;
      }
      const scenario = result.data;
      const semantic = semanticIssues(scenario, fixturesDir);
      for (const message of semantic) issues.push({ file, message: `${where}${scenario.id}: ${message}` });
      const firstFile = byId.get(scenario.id);
      if (firstFile !== undefined) {
        issues.push({ file, message: `${where}duplicate id "${scenario.id}" (first defined in ${firstFile})` });
        return;
      }
      byId.set(scenario.id, file);
      if (semantic.length === 0) scenarios.push({ scenario, file, template: basename(path).startsWith("_") });
    });
  }
  return { scenarios, issues };
}

export interface ScenarioFilter {
  groups?: readonly string[];
  tags?: readonly string[];
  ids?: readonly string[];
}

export interface FilterResult {
  selected: LoadedScenario[];
  /** Ids named by --id that no scenario has. */
  unknownIds: string[];
}

/**
 * The scenarios a run takes. --id names scenarios outright (templates included); otherwise
 * templates are left out, and --group / --tag keep scenarios in any of the listed groups AND
 * carrying any of the listed tags.
 */
export function filterScenarios(loaded: readonly LoadedScenario[], filter: ScenarioFilter): FilterResult {
  const ids = new Set(filter.ids ?? []);
  const groups = new Set(filter.groups ?? []);
  const tags = new Set(filter.tags ?? []);
  const selected = loaded.filter(({ scenario, template }) => {
    if (ids.size > 0 && !ids.has(scenario.id)) return false;
    if (ids.size === 0 && template) return false;
    if (groups.size > 0 && !groups.has(scenario.group)) return false;
    if (tags.size > 0 && !(scenario.tags ?? []).some((tag) => tags.has(tag))) return false;
    return true;
  });
  const known = new Set(loaded.map(({ scenario }) => scenario.id));
  return { selected, unknownIds: [...ids].filter((id) => !known.has(id)) };
}
