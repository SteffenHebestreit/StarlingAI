import { execFile } from "node:child_process";
import { lookup, resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises";
import net from "node:net";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  formatCliExecutionError,
  isSafeConnectionTarget,
  normalizeExecutionTimeout,
} from "./infrastructure-shared.js";

const log = childLogger("tool:service-check");
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_ATTEMPTS = 1;

registerTool({
  name: "service_check",
  description: "Check whether an infrastructure endpoint is ready over HTTP, TCP, SSH, or DNS, optionally retrying until it becomes reachable.",
  parameters: {
    type: "object",
    properties: {
      protocol: {
        type: "string",
        enum: ["http", "tcp", "ssh", "dns"],
        description: "The protocol or check type to use.",
      },
      url: { type: "string", description: "Required for HTTP checks. Full URL to request." },
      host: { type: "string", description: "Required for TCP, SSH, and DNS checks." },
      port: { type: "number", description: "Optional port for TCP or SSH checks. Defaults to 22 for SSH." },
      method: { type: "string", description: "Optional HTTP method. Defaults to GET." },
      expectedStatus: {
        description: "Optional expected HTTP status code or array of status codes. Defaults to any 2xx response.",
        anyOf: [
          { type: "number" },
          { type: "array", items: { type: "number" } },
        ],
      },
      bodyContains: {
        type: "string",
        description: "Optional substring that must appear in the HTTP response body for the check to pass.",
      },
      username: { type: "string", description: "Optional SSH username. Defaults to root." },
      privateKeyPath: { type: "string", description: "Optional SSH private key path for SSH checks." },
      command: { type: "string", description: "Optional SSH command to run after connecting. Defaults to true." },
      recordType: {
        type: "string",
        enum: ["A", "AAAA", "CNAME", "TXT", "LOOKUP"],
        description: "Optional DNS record type. Defaults to LOOKUP.",
      },
      maxAttempts: { type: "number", description: "Optional number of attempts before failing. Defaults to 1." },
      intervalMs: { type: "number", description: "Optional wait time between attempts. Defaults to 5000." },
      timeoutMs: {
        type: "number",
        description: "Optional per-attempt timeout in milliseconds. Defaults to 10000 and is capped at 900000.",
      },
    },
    required: ["protocol"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const protocol = String(args["protocol"] ?? "").trim().toLowerCase();
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"], DEFAULT_TIMEOUT_MS);
    const intervalMs = Math.max(250, Math.min(60_000, Number(args["intervalMs"] ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS));
    const maxAttempts = Math.max(1, Math.min(120, Math.trunc(Number(args["maxAttempts"] ?? DEFAULT_ATTEMPTS) || DEFAULT_ATTEMPTS)));

    try {
      const validationError = validateArgs(protocol, args);
      if (validationError) {
        return { success: false, output: "", error: validationError };
      }

      const startedAt = Date.now();
      let lastError = "Check did not complete";

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const outcome = await runCheck(protocol, args, timeoutMs);
        if (outcome.success) {
          const elapsedMs = Date.now() - startedAt;
          return {
            success: true,
            output: `${protocol.toUpperCase()} check passed on attempt ${attempt}/${maxAttempts}: ${outcome.summary}`,
            metadata: {
              protocol,
              attempts: attempt,
              maxAttempts,
              elapsedMs,
              ...outcome.metadata,
            },
          };
        }

        lastError = outcome.error;
        if (attempt < maxAttempts) {
          await delay(intervalMs);
        }
      }

      return {
        success: false,
        output: "",
        error: `${protocol.toUpperCase()} check failed after ${maxAttempts} attempt(s): ${lastError}`,
        metadata: {
          protocol,
          attempts: maxAttempts,
          maxAttempts,
          elapsedMs: Date.now() - startedAt,
          lastError,
        },
      };
    } catch (error) {
      log.error({ error, protocol }, "service_check failed");
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

type CheckOutcome = {
  success: boolean;
  summary?: string;
  error: string;
  metadata?: Record<string, unknown>;
};

async function runCheck(protocol: string, args: Record<string, unknown>, timeoutMs: number): Promise<CheckOutcome> {
  switch (protocol) {
    case "http":
      return runHttpCheck(args, timeoutMs);
    case "tcp":
      return runTcpCheck(args, timeoutMs);
    case "ssh":
      return runSshCheck(args, timeoutMs);
    case "dns":
      return runDnsCheck(args, timeoutMs);
    default:
      return { success: false, error: `Unsupported protocol: ${protocol}` };
  }
}

function validateArgs(protocol: string, args: Record<string, unknown>): string | undefined {
  if (!["http", "tcp", "ssh", "dns"].includes(protocol)) {
    return "protocol must be one of http, tcp, ssh, or dns";
  }

  if (protocol === "http") {
    const url = String(args["url"] ?? "").trim();
    if (!url) return "url is required for HTTP checks";
  }

  if (["tcp", "ssh", "dns"].includes(protocol)) {
    const host = String(args["host"] ?? "").trim();
    if (!host) return "host is required for TCP, SSH, and DNS checks";
    if (!isSafeConnectionTarget(host)) {
      return "host must not contain whitespace or shell control characters";
    }
  }

  if (protocol === "ssh") {
    const username = String(args["username"] ?? "root");
    if (!isSafeConnectionTarget(username)) {
      return "username must not contain whitespace or shell control characters";
    }
  }

  return undefined;
}

async function runHttpCheck(args: Record<string, unknown>, timeoutMs: number): Promise<CheckOutcome> {
  const url = String(args["url"] ?? "").trim();
  const method = String(args["method"] ?? "GET").trim().toUpperCase() || "GET";
  const bodyContains = typeof args["bodyContains"] === "string" ? args["bodyContains"] : undefined;
  const expectedStatuses = normalizeExpectedStatuses(args["expectedStatus"]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method, signal: controller.signal });
    const responseText = bodyContains ? await response.text() : undefined;
    const statusMatches = expectedStatuses.length > 0
      ? expectedStatuses.includes(response.status)
      : response.status >= 200 && response.status < 300;

    if (!statusMatches) {
      return { success: false, error: `HTTP ${response.status} from ${url}` };
    }

    if (bodyContains && !responseText?.includes(bodyContains)) {
      return { success: false, error: `HTTP response from ${url} did not contain the expected text` };
    }

    return {
      success: true,
      summary: `${method} ${url} returned HTTP ${response.status}`,
      error: "",
      metadata: {
        url,
        method,
        status: response.status,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runTcpCheck(args: Record<string, unknown>, timeoutMs: number): Promise<CheckOutcome> {
  const host = String(args["host"] ?? "").trim();
  const port = normalizePort(args["port"], 80);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (outcome: CheckOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({
      success: true,
      summary: `${host}:${port} accepted a TCP connection`,
      error: "",
      metadata: { host, port },
    }));
    socket.once("timeout", () => finish({ success: false, error: `Timed out connecting to ${host}:${port}` }));
    socket.once("error", (error) => finish({ success: false, error: error.message }));
    socket.connect(port, host);
  });
}

async function runSshCheck(args: Record<string, unknown>, timeoutMs: number): Promise<CheckOutcome> {
  const host = String(args["host"] ?? "").trim();
  const username = String(args["username"] ?? "root").trim() || "root";
  const port = normalizePort(args["port"], 22);
  const privateKeyPath = args["privateKeyPath"] ? String(args["privateKeyPath"]) : undefined;
  const command = String(args["command"] ?? "true").trim() || "true";
  const sshArgs = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-T",
  ];

  if (privateKeyPath) {
    sshArgs.push("-i", privateKeyPath);
  }

  sshArgs.push("-p", String(port), `${username}@${host}`, command);

  try {
    await execFileAsync("ssh", sshArgs, { timeout: timeoutMs });
    return {
      success: true,
      summary: `SSH to ${username}@${host}:${port} succeeded`,
      error: "",
      metadata: { host, port, username },
    };
  } catch (error: any) {
    return {
      success: false,
      error: formatCliExecutionError(
        error,
        "ssh",
        `SSH check timed out connecting to ${username}@${host}:${port}`,
      ),
    };
  }
}

async function runDnsCheck(args: Record<string, unknown>, timeoutMs: number): Promise<CheckOutcome> {
  const host = String(args["host"] ?? "").trim();
  const recordType = String(args["recordType"] ?? "LOOKUP").trim().toUpperCase();
  const withTimeout = <T>(promise: Promise<T>) => Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out resolving DNS for ${host}`)), timeoutMs);
      timer.unref();
    }),
  ]);

  try {
    if (recordType === "LOOKUP") {
      const result = await withTimeout(lookup(host));
      return {
        success: true,
        summary: `${host} resolved to ${result.address}`,
        error: "",
        metadata: { host, recordType, address: result.address, family: result.family },
      };
    }

    const records = await withTimeout(resolveDnsRecords(host, recordType));
    return {
      success: true,
      summary: `${host} returned ${records.length} ${recordType} record(s)`,
      error: "",
      metadata: { host, recordType, records },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveDnsRecords(host: string, recordType: string): Promise<string[]> {
  switch (recordType) {
    case "A":
      return resolve4(host);
    case "AAAA":
      return resolve6(host);
    case "CNAME":
      return resolveCname(host);
    case "TXT": {
      const records = await resolveTxt(host);
      return records.map((entry) => entry.join(""));
    }
    default:
      throw new Error(`Unsupported DNS record type: ${recordType}`);
  }
}

function normalizeExpectedStatuses(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    return [Math.trunc(value)];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "number" && Number.isFinite(item))
      .map((item) => Math.trunc(item));
  }
  return [];
}

function normalizePort(value: unknown, defaultPort: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultPort;
  }

  const port = Math.trunc(value);
  if (port < 1 || port > 65_535) {
    return defaultPort;
  }

  return port;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}