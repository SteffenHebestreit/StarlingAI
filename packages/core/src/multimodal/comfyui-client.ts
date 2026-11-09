/**
 * The HTTP side of the comfyui_* tools: one ComfyUI server, reached at
 * `multimodal.comfyui.baseUrl`. Graph logic lives in comfyui-graph.ts; this file only moves
 * requests and turns ComfyUI's answers into errors a model can act on.
 */
import { randomUUID } from "node:crypto";
import { Agent as UndiciAgent } from "undici";
import { getConfig } from "../config/loader.js";
import type { MultimodalComfyUiConfig } from "../config/schemas/multimodal.js";
import { applySubgraphWidgetValues, runnableGraph, type ApiGraph, type NodeCatalog } from "./comfyui-graph.js";

/** Undici's own timeouts off: a ComfyUI answer can take long, and our timer is the fuse. */
const comfyDispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 30_000 });

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export class ComfyUiError extends Error {
  constructor(message: string, readonly status?: number, readonly unreachable = false) {
    super(message);
    this.name = "ComfyUiError";
  }
}

/** ComfyUI refused the graph before running it; `problems` names each node and input. */
export class ComfyUiRejectedError extends ComfyUiError {
  constructor(message: string, readonly problems: string[]) {
    super(message, 400);
    this.name = "ComfyUiRejectedError";
  }
}

export interface ComfyUiEndpoint {
  baseUrl: string;
  editorUrl: string;
  runTimeoutMs: number;
}

export function comfyUiEndpoint(config: MultimodalComfyUiConfig | undefined = getConfig().multimodal?.comfyui): ComfyUiEndpoint | null {
  const baseUrl = config?.baseUrl?.trim();
  if (!baseUrl) return null;
  return { baseUrl, editorUrl: config?.editorUrl?.trim() ?? "", runTimeoutMs: config?.runTimeoutMs ?? 900_000 };
}

export const COMFYUI_NOT_CONFIGURED =
  "ComfyUI is not set up here (multimodal.comfyui.baseUrl is empty). Tell the user; do not try another way.";

function url(endpoint: ComfyUiEndpoint, path: string, query?: Record<string, string>): string {
  const base = endpoint.baseUrl.endsWith("/") ? endpoint.baseUrl : `${endpoint.baseUrl}/`;
  const target = new URL(path.replace(/^\//, ""), base);
  for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, value);
  return target.toString();
}

async function request(endpoint: ComfyUiEndpoint, path: string, init: RequestInit & { query?: Record<string, string> } = {}, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const target = url(endpoint, path, init.query);
  try {
    return await fetch(target, { ...init, signal: controller.signal, dispatcher: comfyDispatcher } as RequestInit);
  } catch (error) {
    if (controller.signal.aborted) throw new ComfyUiError(`ComfyUI did not answer ${path} within ${Math.round(timeoutMs / 1000)} s`);
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    const unreachable = typeof code === "string" && UNREACHABLE_CODES.has(code);
    throw new ComfyUiError(
      unreachable
        ? `ComfyUI at ${endpoint.baseUrl} cannot be reached (${String(code)}). It is not running; tell the user, do not retry.`
        : `Request to ComfyUI ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      unreachable,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function failure(response: Response, what: string): Promise<ComfyUiError> {
  const text = await response.text().catch(() => "");
  let detail = text.trim().slice(0, 400);
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body["error"];
    detail = typeof error === "string" ? error : typeof (error as Record<string, unknown>)?.["message"] === "string" ? String((error as Record<string, unknown>)["message"]) : detail;
  } catch {
    // not JSON: keep the text
  }
  return new ComfyUiError(`${what}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`, response.status);
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw await failure(response, what);
  return (await response.json()) as T;
}

// ── the node catalogue ────────────────────────────────────────────────────

/** object_info is several MB and changes only when nodes are installed: fetched once a while. */
const CATALOG_TTL_MS = 5 * 60_000;
let cachedCatalog: { baseUrl: string; at: number; catalog: NodeCatalog } | null = null;

export async function getNodeCatalog(endpoint: ComfyUiEndpoint): Promise<NodeCatalog> {
  if (cachedCatalog && cachedCatalog.baseUrl === endpoint.baseUrl && Date.now() - cachedCatalog.at < CATALOG_TTL_MS) {
    return cachedCatalog.catalog;
  }
  const catalog = await json<NodeCatalog>(await request(endpoint, "/object_info", {}, 60_000), "Reading ComfyUI's nodes failed");
  cachedCatalog = { baseUrl: endpoint.baseUrl, at: Date.now(), catalog };
  return catalog;
}

/** A model file appears in the catalogue's options only after a fresh read. */
export function forgetNodeCatalog(): void {
  cachedCatalog = null;
  cachedReadiness = null;
}

export async function listModelFolders(endpoint: ComfyUiEndpoint): Promise<string[]> {
  return json<string[]>(await request(endpoint, "/models"), "Listing ComfyUI's model folders failed");
}

export async function listModels(endpoint: ComfyUiEndpoint, folder: string): Promise<string[]> {
  const response = await request(endpoint, `/models/${encodeURIComponent(folder)}`);
  if (response.status === 404) throw new ComfyUiError(`ComfyUI has no model folder "${folder}"`, 404);
  return json<string[]>(response, `Listing ComfyUI models in ${folder} failed`);
}

// ── templates shipped with ComfyUI ───────────────────────────────────────

export interface ComfyUiTemplate {
  name: string;
  title: string;
  description: string;
  category: string;
  models: string[];
}

/** The official workflow templates the ComfyUI package serves at /templates. */
export async function listTemplates(endpoint: ComfyUiEndpoint): Promise<ComfyUiTemplate[]> {
  const index = await json<unknown>(await request(endpoint, "/templates/index.json"), "Listing ComfyUI's templates failed");
  const templates: ComfyUiTemplate[] = [];
  for (const group of Array.isArray(index) ? index : []) {
    const category = typeof group?.title === "string" ? group.title : typeof group?.category === "string" ? group.category : "";
    for (const entry of Array.isArray(group?.templates) ? group.templates : []) {
      if (typeof entry?.name !== "string") continue;
      // Not open source = built on paid partner nodes, which this server runs without (--offline).
      if (entry.openSource === false) continue;
      templates.push({
        name: entry.name,
        title: typeof entry.title === "string" ? entry.title : entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
        category,
        models: Array.isArray(entry.models) ? entry.models.filter((m: unknown): m is string => typeof m === "string") : [],
      });
    }
  }
  return templates;
}

/** Node types the editor draws but the server never runs. */
const EDITOR_ONLY_NODES = new Set(["Note", "MarkdownNote", "Reroute", "PrimitiveNode", "GroupNode"]);

export interface TemplateReadiness {
  /** Model files the template's nodes name that this server does not have. */
  missingModels: string[];
  /** Node types it uses that this server does not have. */
  missingNodes: string[];
}

/**
 * Whether each template runs here as it is: every model file its nodes name (the editor keeps
 * them in each loader's properties.models) is installed, and every node type exists. Read from
 * the templates themselves, not guessed from their model labels: "Qwen Image 2512" would match
 * an installed Qwen-Image 2.1 file by name. One read of every template, kept for a few minutes.
 */
let cachedReadiness: { baseUrl: string; at: number; readiness: Map<string, TemplateReadiness> } | null = null;

export async function templateReadiness(endpoint: ComfyUiEndpoint, templates: ComfyUiTemplate[], catalog: NodeCatalog): Promise<Map<string, TemplateReadiness>> {
  if (cachedReadiness && cachedReadiness.baseUrl === endpoint.baseUrl && Date.now() - cachedReadiness.at < CATALOG_TTL_MS) {
    return cachedReadiness.readiness;
  }
  const folders = await listModelFolders(endpoint);
  const installed = new Set((await Promise.all(folders.map((folder) => listModels(endpoint, folder).catch(() => [] as string[])))).flat());
  const readiness = new Map<string, TemplateReadiness>();
  const queue = [...templates];
  const worker = async (): Promise<void> => {
    for (let template = queue.shift(); template; template = queue.shift()) {
      try {
        const workflow = (await readTemplate(endpoint, template.name)) as { nodes?: unknown[]; definitions?: { subgraphs?: Array<{ id?: string; nodes?: unknown[] }> } };
        const subgraphIds = new Set((workflow.definitions?.subgraphs ?? []).map((sg) => sg.id));
        const nodes = [...(workflow.nodes ?? []), ...(workflow.definitions?.subgraphs ?? []).flatMap((sg) => sg.nodes ?? [])] as Array<{ type?: string; mode?: number; properties?: { models?: Array<{ name?: string }> } }>;
        let missingModels = new Set<string>();
        const missingNodes = new Set<string>();
        let anyInstalled = false;
        for (const node of nodes) {
          if (node.mode === 2 || node.mode === 4) continue; // muted or bypassed: never runs
          for (const model of node.properties?.models ?? []) {
            if (!model.name) continue;
            if (installed.has(model.name)) anyInstalled = true;
            else missingModels.add(model.name);
          }
          if (node.type && !catalog[node.type] && !subgraphIds.has(node.type) && !EDITOR_ONLY_NODES.has(node.type)) missingNodes.add(node.type);
        }
        // A template for an installed model that names a file this server lacks may need it only
        // behind a switch that is off: the Qwen-Image 2.1 templates keep a 9 GB prompt enhancer
        // there and run without it. Checked as comfyui_run would run it.
        if (missingModels.size > 0 && anyInstalled && missingNodes.size === 0) {
          const graph = await convertToApi(endpoint, workflow);
          applySubgraphWidgetValues(workflow, graph);
          const used = new Set<string>();
          for (const node of Object.values(runnableGraph(graph, catalog).graph)) {
            for (const value of Object.values(node.inputs ?? {})) if (typeof value === "string") used.add(value);
          }
          missingModels = new Set([...missingModels].filter((name) => used.has(name)));
        }
        readiness.set(template.name, { missingModels: [...missingModels], missingNodes: [...missingNodes] });
      } catch {
        // unreadable: left out, so it is never called ready
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  cachedReadiness = { baseUrl: endpoint.baseUrl, at: Date.now(), readiness };
  return readiness;
}

export async function readTemplate(endpoint: ComfyUiEndpoint, name: string): Promise<unknown> {
  if (!/^[\w.-]+$/.test(name)) throw new ComfyUiError(`"${name}" is not a template name`);
  const response = await request(endpoint, `/templates/${name}.json`);
  if (response.status === 404) throw new ComfyUiError(`ComfyUI has no template "${name}"`, 404);
  return json<unknown>(response, `Reading template ${name} failed`);
}

// ── the editor's workflow library (ComfyUI user data) ─────────────────────

const LIBRARY_DIR = "workflows";

function libraryFile(name: string): string {
  return encodeURIComponent(`${LIBRARY_DIR}/${name}`);
}

/** Every workflow file in the editor's library, as paths below workflows/. */
export async function listLibrary(endpoint: ComfyUiEndpoint): Promise<string[]> {
  const response = await request(endpoint, "/userdata", { query: { dir: LIBRARY_DIR, recurse: "true", split: "false" } });
  if (response.status === 404) return [];
  const files = await json<unknown>(response, "Listing the ComfyUI workflow library failed");
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string" && f.endsWith(".json")).sort() : [];
}

export async function readLibrary(endpoint: ComfyUiEndpoint, name: string): Promise<unknown> {
  const response = await request(endpoint, `/userdata/${libraryFile(name)}`);
  if (response.status === 404) throw new ComfyUiError(`The ComfyUI workflow library has no "${name}"`, 404);
  return json<unknown>(response, `Reading ${name} from the workflow library failed`);
}

/** False when the name is taken and overwrite was not asked for. */
export async function writeLibrary(endpoint: ComfyUiEndpoint, name: string, workflow: unknown, overwrite: boolean): Promise<boolean> {
  const response = await request(endpoint, `/userdata/${libraryFile(name)}`, {
    method: "POST",
    query: { overwrite: overwrite ? "true" : "false", full_info: "false" },
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workflow),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw await failure(response, `Saving ${name} to the workflow library failed`);
  return true;
}

/** An editor (UI-format) workflow turned into the API format /prompt runs. */
export async function convertToApi(endpoint: ComfyUiEndpoint, workflow: unknown): Promise<ApiGraph> {
  const response = await request(endpoint, "/workflow/convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workflow),
  });
  if (response.status === 404 || response.status === 405) {
    throw new ComfyUiError("This ComfyUI cannot convert an editor workflow (the workflow-to-api-converter node is missing)", response.status);
  }
  return json<ApiGraph>(response, "Converting the editor workflow failed");
}

// ── running ──────────────────────────────────────────────────────────────

export interface OutputRef {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
  kind: string;
}

/** Turns /prompt's node_errors into one line per problem, naming node, input and reason. */
export function describeRejection(body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const top = body["error"] as Record<string, unknown> | undefined;
  const nodeErrors = (body["node_errors"] ?? {}) as Record<string, { class_type?: string; errors?: Array<Record<string, unknown>> }>;
  for (const [nodeId, entry] of Object.entries(nodeErrors)) {
    for (const error of entry?.errors ?? []) {
      const info = (error["extra_info"] ?? {}) as Record<string, unknown>;
      const input = typeof info["input_name"] === "string" ? `.${info["input_name"]}` : "";
      const detail = typeof error["details"] === "string" && error["details"] ? `: ${error["details"]}` : "";
      problems.push(`node ${nodeId} (${entry?.class_type ?? "?"})${input}: ${String(error["message"] ?? "invalid")}${detail}`);
    }
  }
  if (problems.length === 0 && top) {
    const detail = typeof top["details"] === "string" && top["details"] ? `: ${top["details"]}` : "";
    problems.push(`${String(top["message"] ?? "the workflow was refused")}${detail}`);
  }
  return problems;
}

export async function submitGraph(endpoint: ComfyUiEndpoint, graph: ApiGraph, editorWorkflow?: unknown): Promise<{ promptId: string; skipped: string[] }> {
  const response = await request(endpoint, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: randomUUID(),
      prompt: graph,
      // Saved into each PNG, so dragging a result into the editor opens the workflow behind it.
      ...(editorWorkflow ? { extra_data: { extra_pnginfo: { workflow: editorWorkflow } } } : {}),
    }),
  });
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const problems = describeRejection(body);
    throw new ComfyUiRejectedError(`ComfyUI refused the workflow:\n- ${problems.join("\n- ")}`, problems);
  }
  const body = await json<Record<string, unknown>>(response, "Submitting the workflow to ComfyUI failed");
  const promptId = body["prompt_id"];
  if (typeof promptId !== "string") throw new ComfyUiError("ComfyUI accepted the workflow but returned no prompt_id");
  // ComfyUI runs the outputs that pass its check and answers 200, naming the others only here.
  // Kept for the caller: a refused preview beside a saved picture is a note, a refused SaveImage
  // (unknown model file) with nothing saved is the run's failure.
  const nodeErrors = body["node_errors"];
  const skipped = nodeErrors && typeof nodeErrors === "object" && Object.keys(nodeErrors).length > 0
    ? describeRejection({ node_errors: nodeErrors })
    : [];
  return { promptId, skipped };
}

export interface RunOutcome {
  outputs: OutputRef[];
  /** Text a node displayed (e.g. a "Preview Any"/show-text node), keyed by node id. */
  texts: Record<string, string[]>;
  cached: string[];
}

function collectOutputs(entry: Record<string, unknown>): RunOutcome {
  const outputs: OutputRef[] = [];
  const texts: Record<string, string[]> = {};
  const nodes = (entry["outputs"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [nodeId, produced] of Object.entries(nodes)) {
    for (const [kind, items] of Object.entries(produced ?? {})) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["filename"] === "string") {
          const ref = item as Record<string, unknown>;
          outputs.push({
            nodeId,
            kind,
            filename: String(ref["filename"]),
            subfolder: typeof ref["subfolder"] === "string" ? ref["subfolder"] : "",
            type: typeof ref["type"] === "string" ? ref["type"] : "output",
          });
        } else if (typeof item === "string" && kind === "text") {
          (texts[nodeId] ??= []).push(item);
        }
      }
    }
  }
  const status = (entry["status"] ?? {}) as Record<string, unknown>;
  const cached: string[] = [];
  for (const message of Array.isArray(status["messages"]) ? status["messages"] : []) {
    if (Array.isArray(message) && message[0] === "execution_cached" && Array.isArray(message[1]?.nodes)) {
      cached.push(...message[1].nodes.map(String));
    }
  }
  return { outputs, texts, cached };
}

function executionError(entry: Record<string, unknown>): string | null {
  const status = (entry["status"] ?? {}) as Record<string, unknown>;
  for (const message of Array.isArray(status["messages"]) ? status["messages"] : []) {
    if (!Array.isArray(message)) continue;
    const [kind, data] = message as [string, Record<string, unknown>];
    if (kind === "execution_error") {
      return `node ${String(data?.["node_id"] ?? "?")} (${String(data?.["node_type"] ?? "?")}) failed: ${String(data?.["exception_message"] ?? "error").trim()}`;
    }
    if (kind === "execution_interrupted") return "the run was interrupted in ComfyUI";
  }
  return status["status_str"] === "error" ? "ComfyUI reported the run as failed" : null;
}

/**
 * Waits for one submitted run. Polls /history (no websocket: the API is enough and survives
 * proxies). On our timeout the run is taken out of ComfyUI's queue, or interrupted if it is
 * the one running, so a dead request does not hold the GPU.
 */
export async function waitForRun(endpoint: ComfyUiEndpoint, promptId: string, timeoutMs = endpoint.runTimeoutMs, pollMs = 1000): Promise<RunOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await json<Record<string, unknown>>(
      await request(endpoint, `/history/${encodeURIComponent(promptId)}`, {}, 15_000),
      "Reading the run from ComfyUI failed",
    );
    const entry = history[promptId] as Record<string, unknown> | undefined;
    if (entry) {
      const error = executionError(entry);
      if (error) throw new ComfyUiError(`The workflow failed: ${error}`);
      const status = (entry["status"] ?? {}) as Record<string, unknown>;
      if (status["completed"] === true || status["status_str"] === "success" || entry["outputs"]) {
        return collectOutputs(entry);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await cancelRun(endpoint, promptId).catch(() => undefined);
  throw new ComfyUiError(`The workflow did not finish within ${Math.round(timeoutMs / 1000)} s and was cancelled in ComfyUI`);
}

export async function cancelRun(endpoint: ComfyUiEndpoint, promptId: string): Promise<void> {
  await request(endpoint, "/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
  await request(endpoint, "/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) });
}

export async function fetchOutput(endpoint: ComfyUiEndpoint, ref: OutputRef): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await request(endpoint, "/view", { query: { filename: ref.filename, subfolder: ref.subfolder, type: ref.type } }, 120_000);
  if (!response.ok) throw await failure(response, `Fetching ${ref.filename} from ComfyUI failed`);
  return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
}

/** Puts a workspace image into ComfyUI's input folder; returns the name a LoadImage node takes. */
export async function uploadInputImage(endpoint: ComfyUiEndpoint, bytes: Buffer, filename: string, subfolder: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)]), filename);
  form.append("subfolder", subfolder);
  form.append("type", "input");
  form.append("overwrite", "true");
  const body = await json<Record<string, unknown>>(
    await request(endpoint, "/upload/image", { method: "POST", body: form }, 120_000),
    `Uploading ${filename} to ComfyUI failed`,
  );
  const name = typeof body["name"] === "string" ? body["name"] : filename;
  const folder = typeof body["subfolder"] === "string" ? body["subfolder"] : "";
  return folder ? `${folder}/${name}` : name;
}
