/**
 * comfyui_catalog / comfyui_workflow / comfyui_run: building, changing, running and exporting
 * ComfyUI node workflows on the server at multimodal.comfyui.baseUrl.
 *
 * A workflow lives in the workspace as an API-format JSON file, the format /prompt runs and the
 * one a model edits best. It can start from one of ComfyUI's official templates, from a
 * workflow a person saved in the ComfyUI editor, or from a PNG ComfyUI made (each carries the
 * workflow behind it). It goes back to the person as an editor workflow: into the editor's
 * library, or as a file to drag onto the ComfyUI page.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { childLogger } from "../logger.js";
import {
  COMFYUI_NOT_CONFIGURED,
  ComfyUiError,
  ComfyUiRejectedError,
  comfyUiEndpoint,
  convertToApi,
  fetchOutput,
  forgetNodeCatalog,
  getNodeCatalog,
  listLibrary,
  listModelFolders,
  listModels,
  listTemplates,
  readLibrary,
  readTemplate,
  submitGraph,
  templateReadiness,
  uploadInputImage,
  waitForRun,
  writeLibrary,
  type ComfyUiEndpoint,
  type OutputRef,
} from "../multimodal/comfyui-client.js";
import {
  GraphOperationError,
  applyOperations,
  applySubgraphWidgetValues,
  checkGraph,
  danglingNodes,
  describeGraph,
  describeNodeDef,
  graphDifferences,
  isApiGraph,
  isEditorWorkflow,
  keyInputs,
  markSamplePrompts,
  readPngWorkflow,
  resolveInputRef,
  runnableGraph,
  searchNodes,
  seedInputs,
  toEditorWorkflow,
  unchangedSamplePrompts,
  unknownInput,
  type ApiGraph,
  type GraphOperation,
  type NodeCatalog,
} from "../multimodal/comfyui-graph.js";
import { segmentFor } from "../runtime/user-scope.js";
import { publishImageArtifact, readWorkspaceBinaryFile } from "./multimodal.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath } from "./workspace-path.js";

const log = childLogger("comfyui-tools");

function fail(error: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { success: false, output: "", error, ...extra };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function endpointOrFail(): ComfyUiEndpoint | ToolResult {
  return comfyUiEndpoint() ?? fail(COMFYUI_NOT_CONFIGURED, { rejectedBeforeEffect: true });
}

function isResult(value: unknown): value is ToolResult {
  return !!value && typeof value === "object" && "success" in value;
}

function failFrom(error: unknown, what: string): ToolResult {
  if (error instanceof GraphOperationError) return fail(error.message, { rejectedBeforeEffect: true });
  if (error instanceof ComfyUiError) return fail(error.message);
  log.error({ err: error }, `${what} failed`);
  return fail(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** The editor library folder this caller's exports go into: one per account under auth. */
function libraryFolder(ctx: ToolContext): string {
  const segment = segmentFor(ctx.identity);
  return segment ? `starlingai/${segment}` : "starlingai";
}

const LIBRARY_NAME = /^[\w][\w .-]{0,79}$/;

// ── loading a workflow from wherever it is ───────────────────────────────

interface LoadedWorkflow {
  graph: ApiGraph;
  from: string;
}

async function asApiGraph(endpoint: ComfyUiEndpoint, value: unknown, from: string): Promise<LoadedWorkflow> {
  if (isApiGraph(value)) return { graph: value, from };
  if (isEditorWorkflow(value)) {
    const graph = await convertToApi(endpoint, value);
    applySubgraphWidgetValues(value, graph);
    return { graph, from: `${from} (converted from the editor format)` };
  }
  throw new ComfyUiError(`${from} holds no ComfyUI workflow`);
}

async function loadWorkflow(endpoint: ComfyUiEndpoint, source: string, ctx: ToolContext): Promise<LoadedWorkflow> {
  if (source.startsWith("template:")) {
    const name = source.slice("template:".length).trim();
    const loaded = await asApiGraph(endpoint, await readTemplate(endpoint, name), `template ${name}`);
    markSamplePrompts(loaded.graph, await getNodeCatalog(endpoint));
    return loaded;
  }
  if (source.startsWith("editor:")) {
    const name = source.slice("editor:".length).trim().replace(/^workflows\//, "");
    return asApiGraph(endpoint, await readLibrary(endpoint, name.endsWith(".json") ? name : `${name}.json`), `editor workflow ${name}`);
  }
  if (extname(source).toLowerCase() === ".png") {
    const file = await readWorkspaceBinaryFile(source, ctx.workspacePath);
    const embedded = readPngWorkflow(Buffer.from(file.bytes));
    if (embedded.prompt !== undefined && isApiGraph(embedded.prompt)) return { graph: embedded.prompt, from: `the workflow inside ${file.relativePath}` };
    if (embedded.workflow !== undefined) return asApiGraph(endpoint, embedded.workflow, `the workflow inside ${file.relativePath}`);
    throw new ComfyUiError(`${file.relativePath} carries no ComfyUI workflow (only PNGs ComfyUI saved do)`);
  }
  // Where comfyui_workflow wrote it first: a write is rooted under generated/, and outside a
  // scope-confined agent a read of the same name is not, so "comfyui/x.json" written is
  // "generated/comfyui/x.json" on disk.
  const candidates = [resolveWorkspaceWritePath(source, ctx.workspacePath), resolvePathWithinWorkspace(source, ctx.workspacePath)];
  for (const { resolved, relativePath } of candidates) {
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ComfyUiError(`${relativePath} is not valid JSON`);
    }
    return asApiGraph(endpoint, parsed, relativePath);
  }
  throw new ComfyUiError(`There is no workflow file ${candidates[0]!.relativePath}`);
}

/**
 * Why a template cannot run here, null when it can: what is missing and what runs here instead.
 * Starting from such a template is refused unless asked for: said as a note, the lab's
 * image_creator went on with FLUX 3 Klein in 6 of 8 runs and then swapped Qwen model files into
 * the FLUX graph.
 */
async function unreadyTemplate(endpoint: ComfyUiEndpoint, startFrom: string | undefined, catalog: NodeCatalog): Promise<string | null> {
  if (!startFrom?.startsWith("template:")) return null;
  const name = startFrom.slice("template:".length).trim();
  const templates = await listTemplates(endpoint);
  const readiness = await templateReadiness(endpoint, templates, catalog);
  const own = readiness.get(name);
  if (!own || (own.missingModels.length === 0 && own.missingNodes.length === 0)) return null;
  const ready = templates
    .filter((t) => {
      const r = readiness.get(t.name);
      return r && r.missingModels.length === 0 && r.missingNodes.length === 0;
    })
    .slice(0, 5)
    .map((t) => `template:${t.name}`);
  const missing = [...own.missingModels, ...own.missingNodes.map((n) => `node ${n}`)];
  return `template ${name} cannot run here: it needs ${missing.slice(0, 4).join(", ")}, not installed.`
    + (ready.length ? ` Templates that run here: ${ready.join(", ")}.` : "");
}

/**
 * Said when the prompt is still the one the template came with. Worded as what is the case, not
 * as a fault: for a text-to-image template that text is its authors' example picture, for an
 * editing template ("Remove the background") it is what the template is for.
 */
function samplePromptNotice(graph: ApiGraph, catalog: NodeCatalog): { where: string; text: string } | null {
  const [first, ...more] = unchangedSamplePrompts(graph, catalog);
  if (!first) return null;
  const text = first.text.replace(/\s+/g, " ").trim();
  return { where: [first, ...more].map((sample) => sample.address).join(", "), text: text.length > 80 ? `${text.slice(0, 79)}…` : text };
}

function danglingNotice(graph: ApiGraph, catalog: NodeCatalog): string | null {
  const ids = danglingNodes(graph, catalog);
  if (ids.length === 0) return null;
  const named = ids.slice(0, 6).map((id) => `${id} ${graph[id]!.class_type}`).join(", ");
  return `NOT CONNECTED, will not run: nothing takes the output of ${named}. Link it to the input that should use it, or put it in place with insert.`;
}

function problemsText(problems: { errors: string[]; warnings: string[] }): string {
  const lines: string[] = [];
  if (problems.errors.length) lines.push(`Problems ComfyUI would refuse:\n- ${problems.errors.join("\n- ")}`);
  if (problems.warnings.length) lines.push(`Warnings:\n- ${problems.warnings.join("\n- ")}`);
  return lines.join("\n");
}

// ── comfyui_catalog ──────────────────────────────────────────────────────

const LOOKUPS = ["nodes", "node", "models", "templates", "workflows"] as const;

async function lookUp(endpoint: ComfyUiEndpoint, what: (typeof LOOKUPS)[number], query: string | undefined): Promise<string> {
  switch (what) {
    case "nodes": {
      const catalog = await getNodeCatalog(endpoint);
      if (!query) {
        const categories = new Map<string, number>();
        for (const def of Object.values(catalog)) {
          const top = (def.category ?? "other").split("/")[0]!;
          categories.set(top, (categories.get(top) ?? 0) + 1);
        }
        return `${Object.keys(catalog).length} node types. Categories: ${[...categories].map(([c, n]) => `${c} (${n})`).join(", ")}. Search with query.`;
      }
      const hits = searchNodes(catalog, query);
      return hits.length ? hits.join("\n") : `No node type matches "${query}".`;
    }
    case "node": {
      if (!query) throw new ComfyUiError("Name the node type in query, e.g. KSampler");
      const catalog = await getNodeCatalog(endpoint);
      const def = catalog[query] ?? Object.entries(catalog).find(([name]) => name.toLowerCase() === query.toLowerCase())?.[1];
      if (!def) {
        const hits = searchNodes(catalog, query, 8);
        throw new ComfyUiError(`No node type "${query}".${hits.length ? ` Close: ${hits.join("; ")}` : ""}`);
      }
      return describeNodeDef(def.name ?? query, def);
    }
    case "models": {
      // Every file at once while that is short: one folder per call spent the lab's
      // image_creator four of its twelve steps before it built anything.
      const folders = await listModelFolders(endpoint);
      const listed = (await Promise.all(folders.map(async (folder) => [folder, await listModels(endpoint, folder).catch(() => [] as string[])] as const)))
        .filter(([folder, files]) => files.length > 0 && folder !== "custom_nodes" && folder !== "configs");
      const total = listed.reduce((n, [, files]) => n + files.length, 0);
      const everything = (): string => {
        if (listed.length === 0) return "ComfyUI has no model files yet.";
        return total <= 60
          ? listed.map(([folder, files]) => `${folder}: ${files.join(", ")}`).join("\n")
          : `Model folders with files: ${listed.map(([f, files]) => `${f} (${files.length})`).join(", ")}. List one with query.`;
      };
      if (!query) return everything();
      const folder = folders.find((name) => name.toLowerCase() === query.toLowerCase());
      if (folder) {
        const files = listed.find(([name]) => name === folder)?.[1] ?? [];
        const others = listed.filter(([name]) => name !== folder);
        if (files.length === 0) return `No files in ${folder}.\nInstalled:\n${everything()}`;
        return files.join("\n") + (others.length ? `\n(Other folders with files: ${others.map(([f, n]) => `${f} (${n.length})`).join(", ")}.)` : "");
      }
      // Not a folder: a word out of a file or folder name ("upscale", "qwen").
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = listed.flatMap(([name, files]) => files.filter((file) => words.every((word) => `${name}/${file}`.toLowerCase().includes(word))).map((file) => `${name}: ${file}`));
      return hits.length ? hits.slice(0, 60).join("\n") : `No model file matches "${query}".\nInstalled:\n${everything()}`;
    }
    case "templates": {
      const templates = await listTemplates(endpoint);
      const readiness = await templateReadiness(endpoint, templates, await getNodeCatalog(endpoint));
      const ready = (name: string): boolean => {
        const r = readiness.get(name);
        return !!r && r.missingModels.length === 0 && r.missingNodes.length === 0;
      };
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matching = templates.filter((t) => words.every((w) => `${t.name} ${t.title} ${t.description} ${t.category} ${t.models.join(" ")}`.toLowerCase().includes(w)));
      // Without a query, only what runs here: the whole list is several hundred, and the first
      // thirty of it held no template for any installed model.
      const hits = (query ? matching : matching.filter((t) => ready(t.name))).sort((a, b) => Number(ready(b.name)) - Number(ready(a.name)));
      if (hits.length === 0) return query ? `No template matches "${query}".` : "No template runs here with the installed models.";
      const line = (t: (typeof templates)[number]): string => {
        const r = readiness.get(t.name);
        const state = ready(t.name)
          ? "ready, its models are installed"
          : r
            ? `needs ${[...r.missingModels, ...r.missingNodes.map((n) => `node ${n}`)].slice(0, 3).join(", ")}${r.missingModels.length + r.missingNodes.length > 3 ? ", …" : ""}`
            : "not checked";
        return `template:${t.name} — ${t.title} [${state}]${t.description ? `: ${t.description.slice(0, 120)}` : ""}`;
      };
      const more = hits.length > 30 ? `\n… ${hits.length - 30} more; narrow the query.` : "";
      const others = query ? "" : `\n(${templates.length - hits.length} more templates need models that are not installed; search with query to see them.)`;
      return hits.slice(0, 30).map(line).join("\n") + more + others;
    }
    case "workflows": {
      const files = await listLibrary(endpoint);
      return files.length ? files.map((f) => `editor:${f.replace(/\.json$/, "")}`).join("\n") : "The ComfyUI editor has no saved workflows.";
    }
  }
}

registerTool({
  name: "comfyui_catalog",
  description:
    "What this installation's ComfyUI server has: its installed model files, its node types (search them, or read"
    + " one type's inputs, choices and outputs), its official workflow templates and the workflows saved in its editor."
    + " Use it to answer what ComfyUI has installed, which no web or file search can see, and before building or"
    + " changing a workflow. Model file names in a workflow must be ones listed here.",
  parameters: {
    type: "object",
    properties: {
      look_up: {
        type: "string",
        enum: [...LOOKUPS],
        description: "nodes: search node types, the best hits with their inputs and outputs; node: one type in full; models: the installed model files; templates: official workflows to start from; workflows: the editor's saved workflows",
      },
      query: {
        type: "string",
        description: "Search words for nodes/templates (templates without a query lists the ones that run here), the node type for node (e.g. KSampler), a model folder or a word from a file name for models",
      },
    },
    required: ["look_up"],
  },
  execute: async (args) => {
    const endpoint = endpointOrFail();
    if (isResult(endpoint)) return endpoint;
    const what = args["look_up"];
    if (!LOOKUPS.includes(what as (typeof LOOKUPS)[number])) return fail(`look_up must be one of ${LOOKUPS.join(", ")}`, { rejectedBeforeEffect: true });
    try {
      return { success: true, output: await lookUp(endpoint, what as (typeof LOOKUPS)[number], text(args["query"])) };
    } catch (error) {
      return failFrom(error, "Looking up ComfyUI");
    }
  },
});

// ── comfyui_workflow ─────────────────────────────────────────────────────

async function writeJson(path: string, ctx: ToolContext, value: unknown): Promise<string> {
  const { resolved, relativePath } = resolveWorkspaceWritePath(path, ctx.workspacePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return relativePath;
}

registerTool({
  name: "comfyui_workflow",
  description:
    "Create or change a ComfyUI workflow kept as a JSON file in the workspace, in ComfyUI's API format:"
    + " {\"<id>\": {\"class_type\": ..., \"inputs\": {...}}}, a link written [\"<node id>\", <output index>]."
    + " start_from begins it from an official template, a workflow saved in the ComfyUI editor, or a PNG ComfyUI made."
    + " Start a new workflow from a template that is ready here (comfyui_catalog templates): it has the loaders and"
    + " settings its model needs, which a workflow written node by node from memory usually gets wrong."
    + " operations change it; after every change it is checked against the server's nodes and model files."
    + " save_to_editor puts it into the ComfyUI editor's library, where the user can open and edit it;"
    + " editor_file writes it in the editor's format for download.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace file of the workflow, e.g. comfyui/portrait.json; created if missing" },
      start_from: {
        type: "string",
        description: "template:<name>, editor:<name>, or a workspace .json or .png; replaces what is at path",
      },
      allow_unready: { type: "boolean", description: "Start from a template whose models are not installed, which cannot run here: only when the user wants that template anyway, to keep or for later (default false)" },
      operations: {
        type: "array",
        description: "Changes, applied in order: insert {op, class_type, before?, node?, inputs?, title?} puts a new node on a connection that exists: before names the node that should receive its output (\"KSampler\", or \"<node>.<input>\" when several inputs fit; left out, the workflow's output), the old connection feeds the new node and inputs supplies only what else it needs. add {op, class_type, node?, inputs?, title?} adds a node nothing is connected to yet (missing values get defaults; give node an id of your own, e.g. \"upscale\", to link to it in later operations), set {op, node, inputs} (null removes an input), remove {op, node}, title {op, node, title}. A node is named by id, or by a type or title only one node has, in links too: [\"VAEDecode\", 0]",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["insert", "add", "set", "remove", "title"] },
            node: { type: "string", description: "Node id" },
            before: { type: "string", description: "insert only: the node, or \"<node>.<input>\", that receives the new node's output; left out, the workflow's output node" },
            class_type: { type: "string" },
            inputs: { type: "object", description: "Input name to value, or to a link [\"<node id>\", <output index>]" },
            title: { type: "string" },
          },
          required: ["op"],
        },
      },
      save_to_editor: { type: "string", description: "Name to save it under in the ComfyUI editor's library" },
      replace_in_editor: { type: "boolean", description: "Overwrite a workflow of that name in the editor (default false)" },
      editor_file: { type: "string", description: "Also write it in the editor's format to this workspace .json path" },
    },
    required: ["path"],
  },
  execute: async (args, ctx) => {
    const endpoint = endpointOrFail();
    if (isResult(endpoint)) return endpoint;
    const path = text(args["path"]);
    if (!path || extname(path).toLowerCase() !== ".json") return fail("path must name a .json file in the workspace", { rejectedBeforeEffect: true });
    const startFrom = text(args["start_from"]);
    const operations = Array.isArray(args["operations"]) ? (args["operations"] as GraphOperation[]) : [];
    const editorName = text(args["save_to_editor"])?.split(/[\\/]/).pop()?.replace(/\.json$/i, "");
    if (editorName && !LIBRARY_NAME.test(editorName)) {
      return fail("save_to_editor takes a plain name: letters, digits, spaces, dots, dashes, underscores", { rejectedBeforeEffect: true });
    }
    const editorFile = text(args["editor_file"]);
    if (editorFile && extname(editorFile).toLowerCase() !== ".json") return fail("editor_file must name a .json file", { rejectedBeforeEffect: true });

    try {
      const catalog: NodeCatalog = await getNodeCatalog(endpoint);
      const unready = await unreadyTemplate(endpoint, startFrom, catalog).catch(() => null);
      if (unready && args["allow_unready"] !== true) {
        return fail(`${unready} Start from one that runs here. Only if the user wants this one anyway, to keep or for later, repeat with allow_unready: true.`, { rejectedBeforeEffect: true });
      }
      let graph: ApiGraph;
      let origin: string;
      if (startFrom) {
        ({ graph, from: origin } = await loadWorkflow(endpoint, startFrom, ctx));
      } else {
        try {
          ({ graph, from: origin } = await loadWorkflow(endpoint, path, ctx));
        } catch (error) {
          if (!(error instanceof ComfyUiError) || !error.message.startsWith("There is no workflow file")) throw error;
          if (operations.length === 0) return fail(`There is no workflow at ${path}: give start_from or operations that build it`, { rejectedBeforeEffect: true });
          graph = {};
          origin = "a new workflow";
        }
      }
      let changed: ApiGraph;
      let notes: string[];
      try {
        ({ graph: changed, notes } = applyOperations(graph, operations, catalog));
      } catch (error) {
        if (!(error instanceof GraphOperationError)) throw error;
        // Keep what was loaded: the next call changes it instead of loading it again, and now
        // knows the ids (the lab's image_creator guessed "5" and "13" against "459:452" ids).
        const kept = startFrom ? await writeJson(path, ctx, graph) : null;
        const keys = keyInputs(graph, catalog);
        return fail(
          `${error.message}. No operation was applied.`
            + (kept ? ` ${kept} now holds ${origin} as loaded: change it with another call (operations only, no start_from).` : "")
            + (keys ? ` Where to change it: ${keys}.` : "")
            + ` Its nodes: ${nodeListing(graph)}`,
          { rejectedBeforeEffect: true },
        );
      }
      const saved = await writeJson(path, ctx, changed);
      // Checked as it would run: a branch behind a switch that is off is not run, nor checked.
      const problems = checkGraph(runnableGraph(changed, catalog).graph, catalog);
      // What happened first, the graph last: a long graph cut short must not cut the news.
      const lines = [`${saved}: ${Object.keys(changed).length} nodes, from ${origin}.${notes.length ? ` ${notes.join("; ")}.` : ""}`];
      if (unready) lines.unshift(`NOTE: ${unready}`);
      const keys = keyInputs(changed, catalog);
      if (keys) lines.push(`Where to change it: ${keys}.`);
      const sample = samplePromptNotice(changed, catalog);
      if (sample) lines.push(`PROMPT UNCHANGED: ${sample.where} still holds the template's own text ("${sample.text}"). A run renders that text: set it to what the picture should show.`);
      const report = problemsText(problems);
      if (report) lines.push(report);
      // Checked as it runs, so a node nothing reads was not checked at all: say so.
      const dangling = danglingNotice(changed, catalog);
      if (dangling) lines.push(dangling);
      if (!report && !dangling) lines.push("Checks out against this ComfyUI's nodes and model files.");

      const artifacts: Array<Record<string, unknown>> = [];
      if (editorFile || editorName) {
        // The editor gets the workflow as it runs. The editor resolves no switch: the official
        // Qwen-Image template opened with its switched-off prompt enhancer flagged red (its 9 GB
        // model is not installed), and Run there would have been refused.
        const { graph: exported, skipped: leftOut } = runnableGraph(changed, catalog);
        const editorWorkflow = toEditorWorkflow(exported, catalog);
        if (leftOut.length) lines.push(`The editor copy is the workflow as it runs: ${leftOut.join("; ")}.`);
        // Read the copy back the way ComfyUI will: a node type whose editor layout this export
        // does not know can lose an input on the way, and the user would edit a different workflow.
        const readBack = await convertToApi(endpoint, editorWorkflow).catch(() => null);
        const drift = readBack ? graphDifferences(exported, readBack, catalog) : [];
        if (drift.length) {
          lines.push(`CAUTION: the editor copy does not match the workflow exactly (${path} stays the one that runs):\n- ${drift.join("\n- ")}`);
        }
        if (editorFile) {
          const written = await writeJson(editorFile, ctx, editorWorkflow);
          artifacts.push({ outputPath: written, filename: basename(written), contentType: "application/json", title: "ComfyUI workflow (editor format)" });
          lines.push(`Editor format written to ${written}: drag it onto the ComfyUI page to open it.`);
        }
        if (editorName) {
          const file = `${libraryFolder(ctx)}/${editorName}.json`;
          const stored = await writeLibrary(endpoint, file, editorWorkflow, args["replace_in_editor"] === true);
          if (!stored) {
            lines.push(`NOT saved to the editor: "${file}" exists there. Ask the user before replacing it (replace_in_editor), or pick another name.`);
          } else {
            const where = endpoint.editorUrl ? ` at ${endpoint.editorUrl}` : "";
            lines.push(`Saved to the ComfyUI editor${where} as Workflows → ${file}. Give the user that place to open it.`);
          }
        }
      }
      const graphLines = describeGraph(changed).split("\n").map((line) => (line.length > 300 ? `${line.slice(0, 299)}…` : line));
      lines.push(`Nodes (id type: inputs, links as <-node.output):\n${graphLines.slice(0, 50).join("\n")}${graphLines.length > 50 ? `\n… ${graphLines.length - 50} more nodes` : ""}`);
      return {
        success: true,
        output: lines.join("\n"),
        metadata: {
          outputPath: saved,
          filename: basename(saved),
          contentType: "application/json",
          title: "ComfyUI workflow",
          nodes: Object.keys(changed).length,
          errors: problems.errors.length,
          ...(artifacts.length ? { artifacts } : {}),
        },
      };
    } catch (error) {
      return failFrom(error, "Changing the workflow");
    }
  },
});

// ── comfyui_run ──────────────────────────────────────────────────────────

/** "<node>.<input>" against this graph, the node by id or by a type or title only one node has. */
function splitKey(key: string, graph: ApiGraph): [string, string] | null {
  try {
    const { id, input } = resolveInputRef(graph, key, "set");
    return input ? [id, input] : null;
  } catch {
    return null;
  }
}

/** A checkGraph line that names the fix, worth adding to ComfyUI's own refusal. */
function isFixHint(hint: string): boolean {
  return hint.includes("closest") || hint.includes("load it with") || hint.includes("comfyui_run's images") || hint.includes("gives one");
}

/** "<node>.<input>" a checkGraph line is about ("node 470 (LoadImage).image: ..."). */
function hintTarget(hint: string): string {
  const match = /^node (\S+) \([^)]*\)\.([^:\s]+):/.exec(hint);
  return match ? `${match[1]}.${match[2]}` : "";
}

function nodeListing(graph: ApiGraph, limit = 40): string {
  const entries = Object.entries(graph).map(([id, node]) => `${id} ${node.class_type}${node._meta?.title && node._meta.title !== node.class_type ? ` "${node._meta.title}"` : ""}`);
  return entries.slice(0, limit).join(", ") + (entries.length > limit ? `, … ${entries.length - limit} more` : "");
}

function unknownKey(what: string, key: string, graph: ApiGraph): ToolResult {
  return fail(`${what}: "${key}" names no node of this workflow (write "<node id>.<input>"). Its nodes: ${nodeListing(graph)}`, { rejectedBeforeEffect: true });
}

function outputName(raw: string | undefined): string {
  const cleaned = (raw ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || `comfyui-${Date.now()}`;
}

/** A PNG's pixel size from its header; null for anything else. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 24 || view.toString("latin1", 1, 4) !== "PNG" || view.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

async function saveOutputs(endpoint: ComfyUiEndpoint, outputs: OutputRef[], base: string, ctx: ToolContext): Promise<Array<Record<string, unknown>>> {
  // Saved results first; previews only when a workflow saves nothing.
  const kept = outputs.some((o) => o.type === "output") ? outputs.filter((o) => o.type === "output") : outputs;
  const saved: Array<Record<string, unknown>> = [];
  for (const [index, ref] of kept.entries()) {
    const { bytes, contentType } = await fetchOutput(endpoint, ref);
    const extension = extname(ref.filename).toLowerCase() || ".bin";
    const name = `comfyui/${base}${kept.length > 1 ? `_${index + 1}` : ""}${extension}`;
    const { resolved, relativePath } = resolveWorkspaceWritePath(name, ctx.workspacePath);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, bytes);
    saved.push({ outputPath: relativePath, filename: basename(relativePath), contentType, bytes: bytes.byteLength, node: ref.nodeId, ...(pngSize(bytes) ?? {}) });
  }
  return saved;
}

registerTool({
  name: "comfyui_run",
  description:
    "Run a ComfyUI workflow and save what it produces (images, video) into the workspace. workflow is a workspace"
    + " workflow file, editor:<name> or template:<name>. set changes inputs for this run only; images sends workspace"
    + " pictures to LoadImage inputs. The same workflow with the same seed gives the same picture again: new_seed"
    + " rolls every seed.",
  parameters: {
    type: "object",
    properties: {
      workflow: { type: "string", description: "A workspace .json/.png workflow, editor:<name>, or template:<name>" },
      set: { type: "object", description: "\"<node>.<input>\": value for this run, the node by id or by a type only one node has, e.g. {\"6.text\": \"a red fox\", \"KSampler.steps\": 30}" },
      images: { type: "object", description: "\"<node id>.<input>\": workspace image path, for LoadImage nodes" },
      new_seed: { type: "boolean", description: "Give every seed a new random value (default false)" },
      output_name: { type: "string", description: "Base name of the saved files" },
    },
    required: ["workflow"],
  },
  execute: async (args, ctx) => {
    const endpoint = endpointOrFail();
    if (isResult(endpoint)) return endpoint;
    const source = text(args["workflow"]);
    if (!source) return fail("workflow is required", { rejectedBeforeEffect: true });
    const started = Date.now();
    let catalog: NodeCatalog | undefined;
    let graph: ApiGraph | undefined;
    let runGraph: ApiGraph | undefined;
    // Inputs given a picture this call: the catalogue read before the upload does not list it yet.
    const uploaded = new Set<string>();
    try {
      catalog = await getNodeCatalog(endpoint);
      const loaded = await loadWorkflow(endpoint, source, ctx);
      graph = structuredClone(loaded.graph);
      const changes: string[] = [];

      const written: Array<[string, string]> = [];
      for (const [key, value] of Object.entries((args["set"] as Record<string, unknown> | undefined) ?? {})) {
        const target = splitKey(key, graph);
        if (!target) return unknownKey("set", key, graph);
        if (!(target[1] in graph[target[0]]!.inputs)) written.push(target);
        graph[target[0]]!.inputs[target[1]] = value;
        changes.push(key);
      }
      // Checked once every value is in, so a choice and the sub-inputs it brings can come in any order.
      for (const [id, name] of written) {
        const problem = unknownInput(id, graph[id]!, catalog[graph[id]!.class_type], name);
        if (problem) return fail(`set: ${problem}`, { rejectedBeforeEffect: true });
      }
      const uploadFolder = libraryFolder(ctx);
      for (const [key, path] of Object.entries((args["images"] as Record<string, unknown> | undefined) ?? {})) {
        const target = splitKey(key, graph);
        if (!target) return unknownKey("images", key, graph);
        if (typeof path !== "string") return fail(`images: "${key}" takes a workspace image path`, { rejectedBeforeEffect: true });
        const file = await readWorkspaceBinaryFile(path, ctx.workspacePath);
        graph[target[0]]!.inputs[target[1]] = await uploadInputImage(endpoint, Buffer.from(file.bytes), file.filename, uploadFolder);
        uploaded.add(`${target[0]}.${target[1]}`);
        changes.push(`${key}=${file.relativePath}`);
      }
      if (args["new_seed"] === true) {
        for (const seed of seedInputs(graph, catalog)) {
          graph[seed.node]!.inputs[seed.input] = Math.floor(Math.random() * Math.min(seed.max, 2 ** 32 - 1));
          changes.push(`${seed.node}.${seed.input}=${String(graph[seed.node]!.inputs[seed.input])}`);
        }
      }

      // What runs: fixed switches resolved, unused branches left out. The PNGs carry the same
      // graph, so a picture dragged into the editor runs there as it ran here.
      const runnable = runnableGraph(graph, catalog);
      runGraph = runnable.graph;
      const { promptId, skipped: refused } = await submitGraph(endpoint, runnable.graph, toEditorWorkflow(runnable.graph, catalog));
      const outcome = await waitForRun(endpoint, promptId);
      const saved = await saveOutputs(endpoint, outcome.outputs, outputName(text(args["output_name"])), ctx);
      if (refused.length && saved.length === 0) {
        // The outputs that would have saved something were the ones ComfyUI refused.
        const hints = checkGraph(runnable.graph, catalog).errors.filter((hint) => isFixHint(hint) && !uploaded.has(hintTarget(hint)));
        return fail(`ComfyUI refused part of the workflow and nothing was saved:\n- ${refused.join("\n- ")}${hints.length ? `\nHints:\n- ${hints.join("\n- ")}` : ""}`);
      }
      const firstImage = saved.find((s) => String(s["contentType"]).startsWith("image/"));
      if (firstImage) await publishImageArtifact(ctx.sessionId, String(firstImage["outputPath"]));
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const textLines = Object.entries(outcome.texts).map(([node, values]) => `node ${node} says: ${values.join(" ").slice(0, 500)}`);
      const allCached = saved.length > 0 && outcome.cached.length >= Object.keys(runnable.graph).length;
      const sample = samplePromptNotice(graph, catalog);
      const lines = [
        // First: a picture of the wrong thing is the news, and the lines below read as a success.
        ...(sample ? [`NOTE: the prompt was the template's own text, unchanged (${sample.where}: "${sample.text}"). If the picture should show something else, set that input and run again.`] : []),
        saved.length
          // The size is how a stage shows it ran: the lab's image_creator got a 4992x3328 picture
          // it had itself named "original", and reported the upscale as failed.
          ? `Ran ${loaded.from} in ${seconds} s. Saved: ${saved.map((s) => `${String(s["outputPath"])}${s["width"] ? ` (${String(s["width"])}x${String(s["height"])})` : ""}`).join(", ")}.`
          : `Ran ${loaded.from} in ${seconds} s; it saved no files (it has no SaveImage or similar output).`,
        ...(changes.length ? [`For this run: ${changes.join(", ")}.`] : []),
        ...(refused.length ? [`NOTE: ComfyUI skipped parts it refused (the files above were made without them):\n- ${refused.join("\n- ")}`] : []),
        ...(danglingNotice(graph, catalog) ? [danglingNotice(graph, catalog)!.replace("will not run", "did not run")] : []),
        ...(allCached ? ["NOTE: nothing changed since the last run, so ComfyUI returned the earlier result. For a new picture use new_seed or change an input."] : []),
        ...textLines,
        "Each saved PNG carries its workflow: dragged onto the ComfyUI page it opens the workflow behind it.",
      ];
      const [first, ...rest] = saved;
      return {
        success: true,
        output: lines.join("\n"),
        metadata: {
          ...(first ?? {}),
          ...(rest.length ? { artifacts: rest } : {}),
          promptId,
          elapsedMs: Date.now() - started,
          files: saved.length,
        },
      };
    } catch (error) {
      if (error instanceof ComfyUiRejectedError && catalog && (runGraph ?? graph)) {
        // ComfyUI names what it refused; our check adds the nearest valid choice where it can.
        const hints = checkGraph((runGraph ?? graph)!, catalog).errors
          .filter((hint) => isFixHint(hint) && !uploaded.has(hintTarget(hint)));
        return fail(`${error.message}${hints.length ? `\nHints:\n- ${hints.join("\n- ")}` : ""}`, { rejectedBeforeEffect: true });
      }
      if (error instanceof ComfyUiError && /model|ckpt|not in list/i.test(error.message)) forgetNodeCatalog();
      return failFrom(error, "Running the workflow");
    }
  },
});
