/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { SignJWT } from "jose";

import { PRODUCT } from "../product/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../..");

interface RuntimeGuidanceEvalCase {
  name: string;
  message: string;
  expectToolIncludes?: string[];
  expectToolExcludes?: string[];
  expectTextIncludes?: string[];
  expectTextExcludes?: string[];
  maxDurationMs?: number;
}

interface RuntimeGuidanceEvalPlan {
  gatewayBaseUrl?: string;
  outputPath?: string;
  cases: RuntimeGuidanceEvalCase[];
}

interface RuntimeGuidanceCaseResult {
  name: string;
  passed: boolean;
  durationMs: number;
  failures: string[];
  toolCalls: string[];
  eventTypes: string[];
  responsePreview: string;
  sessionId?: string;
  guidanceApplied?: boolean;
  runError?: string;
}

interface RuntimeGuidanceEvalReport {
  generatedAt: string;
  gatewayBaseUrl: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  results: RuntimeGuidanceCaseResult[];
}

interface StreamEvent {
  type?: string;
  toolCallName?: string;
  delta?: string;
  message?: string;
  threadId?: string;
}

interface AuditEvent {
  sessionId?: string;
  type?: string;
  data?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const planArg = process.argv[2];
  const outputArg = process.argv[3];
  const planPath = planArg
    ? resolve(planArg)
    : resolve(repoRoot, "runtime-guidance-eval.example.jsonc");
  const rawPlan = await readFile(planPath, "utf8");
  const plan = JSON5.parse(rawPlan) as RuntimeGuidanceEvalPlan;

  if (!Array.isArray(plan.cases) || plan.cases.length === 0) {
    throw new Error("The runtime-guidance eval plan must contain a non-empty cases array.");
  }

  const gatewayBaseUrl = (plan.gatewayBaseUrl ?? process.env["SAI_GATEWAY_URL"] ?? "http://127.0.0.1:8765").replace(/\/$/, "");
  const token = await resolveGatewayToken();
  const results: RuntimeGuidanceCaseResult[] = [];

  for (const testCase of plan.cases) {
    process.stdout.write(`Running ${testCase.name}... `);
    const startedAt = Date.now();
    const streamResult = await runCase(gatewayBaseUrl, token, testCase);
    const durationMs = Date.now() - startedAt;
    const failures = collectFailures(testCase, streamResult.toolCalls, streamResult.responseText, streamResult.runError, durationMs);

    results.push({
      name: testCase.name,
      passed: failures.length === 0,
      durationMs,
      failures,
      toolCalls: streamResult.toolCalls,
      eventTypes: streamResult.eventTypes,
      responsePreview: preview(streamResult.responseText),
      ...(streamResult.sessionId ? { sessionId: streamResult.sessionId } : {}),
      ...(streamResult.guidanceApplied !== undefined ? { guidanceApplied: streamResult.guidanceApplied } : {}),
      ...(streamResult.runError ? { runError: streamResult.runError } : {}),
    });

    process.stdout.write(`${failures.length === 0 ? "PASS" : "FAIL"}\n`);
  }

  const report: RuntimeGuidanceEvalReport = {
    generatedAt: new Date().toISOString(),
    gatewayBaseUrl,
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    results,
  };

  console.log(formatReport(report));

  const outputPath = resolveFromRepo(outputArg ?? plan.outputPath ?? `./${PRODUCT.stateDirName}/live-check/runtime-guidance-eval-report.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nReport written to ${outputPath}`);

  if (report.failedCases > 0) process.exit(1);
}

async function runCase(gatewayBaseUrl: string, token: string, testCase: RuntimeGuidanceEvalCase): Promise<{
  toolCalls: string[];
  eventTypes: string[];
  responseText: string;
  sessionId?: string;
  guidanceApplied?: boolean;
  runError?: string;
}> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), testCase.maxDurationMs ?? 45_000);
  let responseText = "";
  let runError: string | undefined;
  const eventTypes: string[] = [];
  const toolCalls: string[] = [];
  let sessionId: string | undefined;
  let guidanceApplied = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null | undefined;

  try {
    const response = await fetch(`${gatewayBaseUrl}/api/chat/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connection": "close",
      },
      body: JSON.stringify({ message: testCase.message }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gateway returned HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
    }

    const decoder = new TextDecoder();
    responseBody = response.body;
    reader = response.body.getReader();
    let buffer = "";

    const cancelReaderOnAbort = () => {
      void reader?.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancelReaderOnAbort, { once: true });

    while (true) {
      const { done, value } = await readStreamChunk(reader, controller.signal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const parsed = parseSseEvent(part);
        if (!parsed) continue;
        eventTypes.push(parsed.type ?? "unknown");
        if (parsed.type === "RUN_STARTED" && typeof parsed.threadId === "string") {
          sessionId = parsed.threadId;
        }
        if (parsed.type === "TEXT_MESSAGE_CONTENT" && typeof parsed.delta === "string") {
          responseText += parsed.delta;
        }
        if (parsed.type === "TOOL_CALL_STARTED" && typeof parsed.toolCallName === "string") {
          toolCalls.push(parsed.toolCallName);
        }
        if (parsed.type === "RUN_ERROR" && typeof parsed.message === "string") {
          runError = parsed.message;
        }
      }
    }

    controller.signal.removeEventListener("abort", cancelReaderOnAbort);

    if (buffer.trim()) {
      const parsed = parseSseEvent(buffer);
      if (parsed) {
        eventTypes.push(parsed.type ?? "unknown");
        if (parsed.type === "RUN_STARTED" && typeof parsed.threadId === "string") {
          sessionId = parsed.threadId;
        }
        if (parsed.type === "TEXT_MESSAGE_CONTENT" && typeof parsed.delta === "string") {
          responseText += parsed.delta;
        }
        if (parsed.type === "TOOL_CALL_STARTED" && typeof parsed.toolCallName === "string") {
          toolCalls.push(parsed.toolCallName);
        }
        if (parsed.type === "RUN_ERROR" && typeof parsed.message === "string") {
          runError = parsed.message;
        }
      }
    }

    if (sessionId) {
      const auditSummary = await summarizeAuditForSession(sessionId);
      for (const toolName of auditSummary.toolCalls) toolCalls.push(toolName);
      if (auditSummary.guidanceApplied) guidanceApplied = true;
    }

    return {
      toolCalls: [...new Set(toolCalls)],
      eventTypes: [...new Set(eventTypes)],
      responseText,
      ...(sessionId ? { sessionId } : {}),
      guidanceApplied,
      ...(runError ? { runError } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      if (sessionId) {
        const auditSummary = await summarizeAuditForSession(sessionId);
        for (const toolName of auditSummary.toolCalls) toolCalls.push(toolName);
        if (auditSummary.guidanceApplied) guidanceApplied = true;
        eventTypes.push(...auditSummary.eventTypes);
      }
      return {
        toolCalls: [...new Set(toolCalls)],
        eventTypes: [...new Set(eventTypes)],
        responseText,
        ...(sessionId ? { sessionId } : {}),
        guidanceApplied,
        runError: `Timed out after ${testCase.maxDurationMs ?? 45_000}ms`,
      };
    }
    throw error;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Ignore reader shutdown errors on completion/abort.
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore release failures if the stream is already closed.
      }
    }
    if (responseBody) {
      try {
        await responseBody.cancel();
      } catch {
        // Ignore body cancellation failures after normal completion.
      }
    }
    clearTimeout(timeoutHandle);
  }
}

function parseSseEvent(chunk: string): StreamEvent | null {
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join("\n")) as StreamEvent;
  } catch {
    return null;
  }
}

function collectFailures(
  testCase: RuntimeGuidanceEvalCase,
  toolCalls: string[],
  responseText: string,
  runError: string | undefined,
  durationMs: number,
): string[] {
  const failures: string[] = [];
  const response = responseText.trim();
  const normalizedResponse = response.toLowerCase();
  const normalizedRunError = runError?.toLowerCase();

  if (runError) failures.push(`run error: ${runError}`);

  for (const expectedTool of testCase.expectToolIncludes ?? []) {
    if (!toolCalls.includes(expectedTool)) {
      failures.push(`missing expected tool call: ${expectedTool}`);
    }
  }

  for (const forbiddenTool of testCase.expectToolExcludes ?? []) {
    if (toolCalls.includes(forbiddenTool)) {
      failures.push(`contained forbidden tool call: ${forbiddenTool}`);
    }
  }

  for (const expectedText of testCase.expectTextIncludes ?? []) {
    if (!normalizedResponse.includes(expectedText.toLowerCase())) {
      failures.push(`missing expected text: ${expectedText}`);
    }
  }

  for (const forbiddenText of testCase.expectTextExcludes ?? []) {
    const normalizedForbidden = forbiddenText.toLowerCase();
    if (normalizedResponse.includes(normalizedForbidden) || normalizedRunError?.includes(normalizedForbidden)) {
      failures.push(`contained forbidden text: ${forbiddenText}`);
    }
  }

  if (testCase.maxDurationMs !== undefined && durationMs > testCase.maxDurationMs) {
    failures.push(`duration ${durationMs}ms exceeded limit ${testCase.maxDurationMs}ms`);
  }

  return failures;
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return { done: true, value: undefined };

  return await Promise.race([
    reader.read(),
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
      signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
    }),
  ]);
}

async function summarizeAuditForSession(sessionId: string): Promise<{
  toolCalls: string[];
  eventTypes: string[];
  guidanceApplied: boolean;
}> {
  const events = await readAuditEventsForSession(sessionId);
  const toolCalls: string[] = [];
  const eventTypes = new Set<string>();
  let guidanceApplied = false;

  for (const event of events) {
    if (typeof event.type === "string") eventTypes.add(`AUDIT:${event.type}`);
    if (event.type === "turn_guidance_applied") guidanceApplied = true;

    const requestedTool = event.type === "tool_call_requested"
      ? event.data?.["tool"]
      : undefined;
    const completedTool = event.type === "tool_call_completed"
      ? event.data?.["tool"]
      : undefined;

    if (typeof requestedTool === "string") toolCalls.push(requestedTool);
    if (typeof completedTool === "string") toolCalls.push(completedTool);
  }

  return {
    toolCalls: [...new Set(toolCalls)],
    eventTypes: [...eventTypes],
    guidanceApplied,
  };
}

async function readAuditEventsForSession(sessionId: string): Promise<AuditEvent[]> {
  const localEvents = await readLocalAuditEventsForSession(sessionId);
  if (localEvents.length > 0) return localEvents;
  return readDockerAuditEventsForSession(sessionId);
}

async function readLocalAuditEventsForSession(sessionId: string): Promise<AuditEvent[]> {
  const candidates = [
    process.env["SAI_AUDIT_LOG"]?.trim(),
    resolve(repoRoot, PRODUCT.stateDirName, "audit.jsonl"),
    resolve(homedir(), PRODUCT.stateDirName, "audit.jsonl"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = await readFile(candidate, "utf8");
      const events = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => safeParseJson(line))
        .filter((event): event is AuditEvent => Boolean(event && event.sessionId === sessionId));
      if (events.length > 0) return events;
    } catch {
      continue;
    }
  }

  return [];
}

function readDockerAuditEventsForSession(sessionId: string): AuditEvent[] {
  try {
    const escapedSessionId = sessionId.replace(/'/g, "'\\''");
    const output = execFileSync("docker", [
      "compose",
      "exec",
      "gateway",
      "sh",
      "-lc",
      `grep '${escapedSessionId}' /data/audit.jsonl || true`,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.replace(/^\d+:/, ""))
      .map((line) => safeParseJson(line))
      .filter((event): event is AuditEvent => Boolean(event && event.sessionId === sessionId));
  } catch {
    return [];
  }
}

function safeParseJson(value: string): AuditEvent | null {
  try {
    return JSON.parse(value) as AuditEvent;
  } catch {
    return null;
  }
}

function resolveFromRepo(value: string): string {
  return resolve(repoRoot, value);
}

function formatReport(report: RuntimeGuidanceEvalReport): string {
  const lines = [
    `Runtime guidance live eval`,
    `Gateway: ${report.gatewayBaseUrl}`,
    `Passed ${report.passedCases}/${report.totalCases} cases`,
    "",
  ];

  for (const result of report.results) {
    lines.push(`- ${result.name} ${result.passed ? "PASS" : "FAIL"} in ${result.durationMs}ms`);
    lines.push(`  Tools: ${result.toolCalls.length > 0 ? result.toolCalls.join(", ") : "none"}`);
    lines.push(`  Events: ${result.eventTypes.join(", ")}`);
    if (result.sessionId) lines.push(`  Session: ${result.sessionId}`);
    if (result.guidanceApplied !== undefined) lines.push(`  Guidance: ${result.guidanceApplied ? "applied" : "not observed"}`);
    if (result.failures.length > 0) lines.push(`  Failures: ${result.failures.join("; ")}`);
    lines.push(`  Preview: ${result.responsePreview}`);
  }

  return lines.join("\n");
}

async function resolveGatewayToken(): Promise<string> {
  const envToken = process.env["SAI_TOKEN"]?.trim();
  if (envToken) return envToken;

  const secret = await resolveGatewaySecret();
  return await new SignJWT({ sub: "admin", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(new TextEncoder().encode(secret));
}

async function resolveGatewaySecret(): Promise<string> {
  const envSecret = process.env["SAI_JWT_SECRET"]?.trim();
  if (envSecret && envSecret.length >= 32) return envSecret;

  const configSecret = await readConfigJwtSecret();
  if (configSecret && configSecret.length >= 32) return configSecret;

  const userSecretPath = join(homedir(), PRODUCT.stateDirName, ".jwt_secret");
  if (existsSync(userSecretPath)) {
    const stored = (await readFile(userSecretPath, "utf8")).trim();
    if (stored.length >= 32) return stored;
  }

  const dockerSecret = readGatewaySecretFromDocker();
  if (dockerSecret && dockerSecret.length >= 32) return dockerSecret;

  throw new Error("Could not resolve the active gateway JWT secret. Set SAI_TOKEN or SAI_JWT_SECRET and retry.");
}

async function readConfigJwtSecret(): Promise<string | undefined> {
  const explicitConfigPath = process.env["SAI_CONFIG_PATH"]?.trim();
  const configPath = explicitConfigPath ? resolve(explicitConfigPath) : resolve(repoRoot, "starlingai.json");

  try {
    const parsed = JSON5.parse(await readFile(configPath, "utf8")) as { gateway?: { jwtSecret?: unknown } };
    const jwtSecret = parsed.gateway?.jwtSecret;
    return typeof jwtSecret === "string" ? jwtSecret.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readGatewaySecretFromDocker(): string | undefined {
  try {
    const composeOutput = execFileSync("docker", ["compose", "ps", "--format", "json", "gateway"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (!composeOutput) return undefined;

    const composeEntry = JSON.parse(composeOutput) as { Name?: string };
    const containerName = typeof composeEntry.Name === "string" ? composeEntry.Name.trim() : "";
    if (!containerName) return undefined;

    const envOutput = execFileSync("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerName], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const secretLine = envOutput.split(/\r?\n/).find((line) => line.startsWith("SAI_JWT_SECRET="));
    const secret = secretLine?.slice("SAI_JWT_SECRET=".length).trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});