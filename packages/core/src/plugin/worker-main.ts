/**
 * SEC-105 (ADR-007): plugin worker entry — runs INSIDE the isolated child.
 *
 * Launched by worker-host.ts with a MINIMAL environment (no gateway secrets,
 * no backend URLs). Speaks newline-delimited JSON on stdio:
 *
 *   host → worker:  {type:"init", entryPath}
 *                   {type:"invoke", id, tool, args, context:{sessionId, workspacePath}}
 *   worker → host:  {type:"ready", name, version, description?, author?,
 *                    tools:[{name, description, parameters, timeoutMs?}]}
 *                   {type:"result", id, result}
 *                   {type:"invoke_error", id, error}
 *                   {type:"fatal", error}
 *
 * Deliberately dependency-free (no config, no audit, no logger imports): the
 * worker must not pull gateway modules whose import side effects assume
 * gateway state. Anything the plugin throws is contained here and reported as
 * a message — the host decides what it means.
 */
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

interface WorkerPluginTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
}

interface WorkerPlugin {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tools: WorkerPluginTool[];
}

let plugin: WorkerPlugin | null = null;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleInit(entryPath: string): Promise<void> {
  try {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(entryPath).href)) as { default?: WorkerPlugin };
    const candidate = mod?.default;
    if (!candidate || typeof candidate !== "object" || typeof candidate.name !== "string" || !Array.isArray(candidate.tools)) {
      send({ type: "fatal", error: "plugin default export is not a { name, version, tools } object" });
      process.exit(1);
    }
    plugin = candidate;
    send({
      type: "ready",
      name: candidate.name,
      version: String(candidate.version ?? "0.0.0"),
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.author ? { author: candidate.author } : {}),
      tools: candidate.tools.map((tool) => ({
        name: String(tool.name ?? ""),
        description: String(tool.description ?? ""),
        parameters: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {},
        ...(typeof tool.timeoutMs === "number" ? { timeoutMs: tool.timeoutMs } : {}),
      })),
    });
  } catch (err) {
    send({ type: "fatal", error: `plugin import failed: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }
}

async function handleInvoke(id: string, toolName: string, args: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
  const tool = plugin?.tools.find((t) => t.name === toolName);
  if (!tool || typeof tool.execute !== "function") {
    send({ type: "invoke_error", id, error: `tool '${toolName}' not found in plugin` });
    return;
  }
  try {
    const result = await tool.execute(args ?? {}, context ?? {});
    send({ type: "result", id, result });
  } catch (err) {
    send({ type: "invoke_error", id, error: err instanceof Error ? err.message : String(err) });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message: Record<string, unknown>;
  try { message = JSON.parse(line); } catch { return; }
  if (message["type"] === "init" && typeof message["entryPath"] === "string") {
    void handleInit(message["entryPath"]);
  } else if (message["type"] === "invoke" && typeof message["id"] === "string" && typeof message["tool"] === "string") {
    void handleInvoke(
      message["id"],
      message["tool"],
      (message["args"] ?? {}) as Record<string, unknown>,
      (message["context"] ?? {}) as Record<string, unknown>,
    );
  }
});
rl.on("close", () => process.exit(0));
