/**
 * ComfyUI workflows as data: checking an API-format graph against the server's node catalogue,
 * changing it by small operations, describing it in a few lines, and turning it into the
 * editor's format. Nothing here talks to a server (comfyui-client.ts does).
 *
 * Two formats exist. The API format is what /prompt runs: `{ "<id>": { class_type, inputs } }`,
 * a link written as `["<source id>", <output index>]`. The editor (UI) format is what the
 * ComfyUI page saves: `{ nodes: [...], links: [...] }`, with positions and widget values in
 * display order. The workspace keeps the API format; the editor format is made on export.
 */
import { randomUUID } from "node:crypto";

export type InputSpec = [unknown, Record<string, unknown>?];

export interface NodeDef {
  name?: string;
  display_name?: string;
  description?: string;
  category?: string;
  input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec>; hidden?: Record<string, unknown> };
  input_order?: { required?: string[]; optional?: string[] };
  output?: unknown[];
  output_name?: string[];
  output_is_list?: boolean[];
  output_node?: boolean;
  deprecated?: boolean;
}

export type NodeCatalog = Record<string, NodeDef>;
export type Link = [string, number];

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ApiGraph = Record<string, ApiNode>;

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

export function isLink(value: unknown): value is Link {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
}

export interface InputInfo {
  name: string;
  required: boolean;
  type: string;
  options?: string[];
  config: Record<string, unknown>;
  /** Shown as a widget (a value on the node) rather than a socket that takes a link. */
  widget: boolean;
  /** One slot of a growing list (COMFY_AUTOGROW_V3): exists in the editor only while used. */
  grown?: boolean;
  /** Inputs ComfyUI accepts under this prefix without declaring them (COMFY_DYNAMICGROUP_V3). */
  openPrefix?: string;
  /** Drawn by the editor, never linked (a colour picker, ImageCompare's view). */
  socketless?: boolean;
}

/** A spec's type, with a combo's choices, whichever of ComfyUI's two spellings it uses. */
function readSpec(name: string, spec: InputSpec, required: boolean): InputInfo {
  const [head, rawConfig] = Array.isArray(spec) ? spec : [spec, undefined];
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  if (Array.isArray(head)) {
    return { name, required, type: "COMBO", options: head.map(String), config, widget: true };
  }
  const type = typeof head === "string" ? head : "*";
  const options = type === "COMBO" && Array.isArray(config["options"]) ? (config["options"] as unknown[]).map(String) : undefined;
  const widget = WIDGET_TYPES.has(type) && config["forceInput"] !== true;
  const socketless = config["socketless"] === true && !widget;
  return { name, required, type, ...(options ? { options } : {}), config, widget, ...(socketless ? { socketless } : {}) };
}

type SpecGroup = { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> };

/**
 * One declared input as the inputs it really stands for. ComfyUI's V3 nodes declare some
 * inputs that are not one value: a combo whose choice brings its own sub-inputs, written
 * "<name>.<sub>" (COMFY_DYNAMICCOMBO_V3); a growing list of sockets, "<name>.<slot>"
 * (COMFY_AUTOGROW_V3); a socket of whatever type is linked (COMFY_MATCHTYPE_V3).
 */
function expandSpec(name: string, spec: InputSpec, required: boolean, values: Record<string, unknown> | undefined, out: InputInfo[], depth = 0): void {
  const [head, rawConfig] = Array.isArray(spec) ? spec : [spec, undefined];
  const config = (rawConfig && typeof rawConfig === "object" ? rawConfig : {}) as Record<string, unknown>;
  if (head === "COMFY_DYNAMICCOMBO_V3" && depth < 4) {
    const choices = (Array.isArray(config["options"]) ? config["options"] : []) as Array<{ key?: unknown; inputs?: SpecGroup }>;
    const keys = choices.map((c) => String(c.key));
    out.push({ name, required, type: "COMBO", options: keys, config: { ...config, default: config["default"] ?? keys[0] }, widget: true });
    const chosen = String(values?.[name] ?? config["default"] ?? keys[0] ?? "");
    const sub = choices.find((c) => String(c.key) === chosen)?.inputs;
    for (const subRequired of [true, false]) {
      for (const [subName, subSpec] of Object.entries((subRequired ? sub?.required : sub?.optional) ?? {})) {
        expandSpec(`${name}.${subName}`, subSpec, required && subRequired, values, out, depth + 1);
      }
    }
    return;
  }
  if (head === "COMFY_AUTOGROW_V3") {
    const template = (config["template"] ?? {}) as { input?: SpecGroup; names?: unknown[]; prefix?: unknown; min?: unknown; max?: unknown };
    // The slot's spec sits under required or optional; the other is often an empty object.
    const [slotSpec] = [...Object.values(template.input?.required ?? {}), ...Object.values(template.input?.optional ?? {})];
    // Slots are listed by name, or numbered from 0 after a prefix ("image" -> image0, image1, ...).
    const names = Array.isArray(template.names)
      ? template.names.map(String)
      : typeof template.prefix === "string"
        ? Array.from({ length: typeof template.max === "number" ? Math.min(template.max, 100) : 50 }, (_, i) => `${String(template.prefix)}${i}`)
        : [];
    const min = typeof template.min === "number" ? template.min : 0;
    names.forEach((slot, index) => {
      if (slotSpec) out.push({ ...readSpec(`${name}.${slot}`, slotSpec, required && index < min), grown: true });
    });
    return;
  }
  if (head === "COMFY_MATCHTYPE_V3") {
    out.push({ name, required, type: "*", config, widget: false });
    return;
  }
  if (typeof head === "string" && head.startsWith("COMFY_") && head.endsWith("_V3")) {
    out.push({ name, required: false, type: "*", config, widget: false, openPrefix: `${name}.` });
    return;
  }
  out.push(readSpec(name, spec, required));
}

/**
 * A node's inputs in the order the editor shows them: required, then optional. `values` (the
 * node's current inputs) decides which sub-inputs a V3 combo's choice brings.
 */
export function nodeInputs(def: NodeDef, values?: Record<string, unknown>): InputInfo[] {
  const out: InputInfo[] = [];
  for (const required of [true, false]) {
    const specs = (required ? def.input?.required : def.input?.optional) ?? {};
    const order = (required ? def.input_order?.required : def.input_order?.optional) ?? Object.keys(specs);
    for (const name of order) {
      const spec = specs[name];
      // A hidden input (SaveVideo's old top-level codec) gets no widget in the editor.
      const hidden = Array.isArray(spec) && (spec[1] as Record<string, unknown> | undefined)?.["hidden"] === true;
      if (spec !== undefined && !hidden) expandSpec(name, spec, required, values, out);
    }
  }
  return out;
}

export function nodeOutputs(def: NodeDef): Array<{ name: string; type: string }> {
  const types = (def.output ?? []).map((t) => (Array.isArray(t) ? "COMBO" : String(t)));
  return types.map((type, index) => ({ name: def.output_name?.[index] ?? type, type }));
}

// ── describing ─────────────────────────────────────────────────────────────

function short(value: unknown, max = 60): string {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One node type as a model reads it: what goes in, what comes out, what the values may be. */
export function describeNodeDef(className: string, def: NodeDef): string {
  const lines = [`${className}${def.display_name && def.display_name !== className ? ` ("${def.display_name}")` : ""} — ${def.category ?? "?"}${def.output_node ? ", output node" : ""}${def.deprecated ? ", DEPRECATED" : ""}`];
  if (def.description) lines.push(def.description.trim().slice(0, 300));
  for (const input of nodeInputs(def)) {
    const parts: string[] = [];
    if (input.options) {
      const shown = input.options.slice(0, 25).map((o) => JSON.stringify(o)).join(", ");
      parts.push(`one of ${shown}${input.options.length > 25 ? ` … (${input.options.length} in all)` : ""}`);
    }
    for (const key of ["default", "min", "max", "step"]) {
      if (input.config[key] !== undefined && !(key === "default" && input.options)) parts.push(`${key} ${short(input.config[key], 40)}`);
    }
    if (input.config["multiline"]) parts.push("multiline text");
    lines.push(`  in  ${input.name}: ${input.type}${input.required ? "" : " (optional)"}${input.widget ? "" : " ← link"}${parts.length ? ` — ${parts.join("; ")}` : ""}`);
  }
  nodeOutputs(def).forEach((output, index) => lines.push(`  out ${index}: ${output.type}${output.name !== output.type ? ` (${output.name})` : ""}`));
  return lines.join("\n");
}

/** Node types whose name, title, category or description contain every word asked for. */
export function searchNodes(catalog: NodeCatalog, query: string, limit = 30): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Array<{ name: string; score: number; line: string }> = [];
  for (const [name, def] of Object.entries(catalog)) {
    const haystack = `${name} ${def.display_name ?? ""} ${def.category ?? ""} ${def.description ?? ""}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const exactName = words.every((w) => name.toLowerCase().includes(w) || (def.display_name ?? "").toLowerCase().includes(w));
    hits.push({
      name,
      score: (exactName ? 0 : 1) + (def.deprecated ? 2 : 0),
      line: `${name}${def.display_name && def.display_name !== name ? ` ("${def.display_name}")` : ""} — ${def.category ?? "?"}`,
    });
  }
  return hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, limit).map((h) => h.line);
}

/** The graph in one line per node, links written as `<-id.output`. */
export function describeGraph(graph: ApiGraph): string {
  return orderedIds(graph)
    .map((id) => {
      const node = graph[id]!;
      const title = node._meta?.title && node._meta.title !== node.class_type ? ` "${node._meta.title}"` : "";
      const inputs = Object.entries(node.inputs ?? {})
        .map(([name, value]) => (isLink(value) ? `${name}<-${value[0]}.${value[1]}` : `${name}=${short(value)}`))
        .join(", ");
      return `${id} ${node.class_type}${title}: ${inputs}`;
    })
    .join("\n");
}

function orderedIds(graph: ApiGraph): string[] {
  return Object.keys(graph).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
  });
}

// ── checking ──────────────────────────────────────────────────────────────

export interface GraphProblems {
  errors: string[];
  warnings: string[];
}

function closest(options: string[], value: string, limit = 5): string[] {
  const lower = value.toLowerCase();
  const stem = lower.replace(/\.[a-z0-9]+$/, "");
  const scored = options
    .map((option) => {
      const o = option.toLowerCase();
      const score = o === lower ? 0 : o.includes(stem) || stem.includes(o.replace(/\.[a-z0-9]+$/, "")) ? 1 : sharedPrefix(o, lower) >= 4 ? 2 : 9;
      return { option, score };
    })
    .filter((s) => s.score < 9)
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.option);
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function typesFit(source: string, target: string): boolean {
  if (source === "*" || target === "*" || source === target) return true;
  const accepted = target.split(",").map((t) => t.trim());
  return accepted.includes(source) || source.split(",").map((t) => t.trim()).some((t) => accepted.includes(t));
}

/**
 * What ComfyUI would refuse (errors) and what looks wrong but may run (warnings). ComfyUI's own
 * check at submission stays the final word; this one runs before anything is sent or saved, and
 * names the fix (the closest model file, the node an id points at).
 */
export function checkGraph(graph: ApiGraph, catalog: NodeCatalog): GraphProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  let outputNodes = 0;
  for (const id of orderedIds(graph)) {
    const node = graph[id]!;
    if (!node || typeof node.class_type !== "string") {
      errors.push(`node ${id}: no class_type`);
      continue;
    }
    const def = catalog[node.class_type];
    if (!def) {
      const near = closest(Object.keys(catalog), node.class_type, 3);
      errors.push(`node ${id}: this ComfyUI has no node type "${node.class_type}"${near.length ? ` (closest: ${near.join(", ")})` : ""}`);
      continue;
    }
    if (def.output_node) outputNodes += 1;
    const inputs = nodeInputs(def, node.inputs);
    const byName = new Map(inputs.map((input) => [input.name, input]));
    for (const input of inputs) {
      if (input.required && !(input.name in (node.inputs ?? {}))) {
        errors.push(`node ${id} (${node.class_type}): required input "${input.name}" is missing`);
      }
    }
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      const input = byName.get(name);
      if (!input) {
        if (inputs.some((i) => i.openPrefix && name.startsWith(i.openPrefix))) continue;
        warnings.push(`node ${id} (${node.class_type}): "${name}" is not an input of this node type; ComfyUI ignores it`);
        continue;
      }
      if (isLink(value)) {
        const source = graph[value[0]];
        if (!source) {
          errors.push(`node ${id}.${name} links to node ${value[0]}, which is not in the workflow`);
          continue;
        }
        const sourceDef = catalog[source.class_type];
        if (!sourceDef) continue;
        const outputs = nodeOutputs(sourceDef);
        const output = outputs[value[1]];
        if (!output) {
          errors.push(`node ${id}.${name} links to output ${value[1]} of node ${value[0]} (${source.class_type}), which has ${outputs.length} output(s): ${outputs.map((o, i) => `${i} ${o.type}`).join(", ")}`);
        } else if (!typesFit(output.type, input.type)) {
          errors.push(`node ${id}.${name} takes ${input.type} but output ${value[1]} of node ${value[0]} (${source.class_type}) gives ${output.type}`);
        }
        continue;
      }
      if (!input.widget) {
        // A socket of any type (a V3 switch's branch) takes a plain value as well as a link, and
        // an editor-drawn input (ImageCompare's view) only ever holds a value.
        if (input.type === "*" || input.socketless) continue;
        errors.push(`node ${id}.${name} takes a ${input.type} link like ["<node id>", <output index>], not a value`);
        continue;
      }
      checkValue(id, node.class_type, input, value, errors, catalog);
    }
  }
  if (Object.keys(graph).length > 0 && outputNodes === 0) {
    errors.push("the workflow has no output node (e.g. SaveImage), so ComfyUI would run nothing");
  }
  return { errors, warnings };
}

const choiceIndexes = new WeakMap<NodeCatalog, Map<string, string[]>>();

/** For a value: every "<NodeType>.<input>" that lists it as a choice. */
function choiceOwners(catalog: NodeCatalog, value: string): string[] {
  let index = choiceIndexes.get(catalog);
  if (!index) {
    index = new Map();
    for (const [className, def] of Object.entries(catalog)) {
      for (const input of nodeInputs(def)) {
        for (const option of input.options ?? []) {
          if (!/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i.test(option)) continue;
          const owners = index.get(option) ?? [];
          owners.push(`${className}.${input.name}`);
          index.set(option, owners);
        }
      }
    }
    choiceIndexes.set(catalog, index);
  }
  return index.get(value) ?? [];
}

function checkValue(id: string, classType: string, input: InputInfo, value: unknown, errors: string[], catalog: NodeCatalog): void {
  const where = `node ${id} (${classType}).${input.name}`;
  if (input.options) {
    if (!input.options.includes(String(value))) {
      // A model file this server has, given to the wrong loader: the lab's image_creator wrote
      // CheckpointLoaderSimple for the Qwen-Image DiT (a UNETLoader file), was refused with
      // "not in []" and told the user the model was not installed.
      const owners = choiceOwners(catalog, String(value)).filter((owner) => !owner.startsWith(`${classType}.`));
      if (owners.length) {
        errors.push(`${where}: "${String(value)}" is installed, but as a choice of ${owners.slice(0, 3).join(", ")}: load it with ${owners[0]!.split(".")[0]} instead (a template for the model shows the loaders it needs)`);
        return;
      }
      // LoadImage and its kin list ComfyUI's input folder: a picture gets there by upload.
      const upload = input.config["image_upload"] ? "; send a workspace picture to it with comfyui_run's images" : "";
      if (input.options.length === 0) {
        errors.push(`${where}: "${String(value)}" is not there: ComfyUI has no files for this input${upload}`);
        return;
      }
      const near = closest(input.options, String(value));
      const listing = input.options.length <= 12 ? input.options.join(", ") : `${input.options.length} choices`;
      errors.push(`${where}: "${String(value)}" is not one of its choices (${near.length ? `closest: ${near.join(", ")}` : listing})${upload}`);
    }
    return;
  }
  if (input.type === "INT" || input.type === "FLOAT") {
    if (typeof value !== "number" || !Number.isFinite(value) || (input.type === "INT" && !Number.isInteger(value))) {
      errors.push(`${where}: takes ${input.type === "INT" ? "a whole number" : "a number"}, got ${short(value, 30)}`);
      return;
    }
    const min = input.config["min"];
    const max = input.config["max"];
    if (typeof min === "number" && value < min) errors.push(`${where}: ${value} is below its minimum ${min}`);
    if (typeof max === "number" && value > max) errors.push(`${where}: ${value} is above its maximum ${max}`);
    return;
  }
  if (input.type === "BOOLEAN" && typeof value !== "boolean") errors.push(`${where}: takes true or false`);
  if (input.type === "STRING" && typeof value !== "string") errors.push(`${where}: takes text`);
}

// ── changing ──────────────────────────────────────────────────────────────

export type GraphOperation =
  | { op: "add"; node?: string; class_type: string; inputs?: Record<string, unknown>; title?: string }
  | { op: "set"; node: string; inputs: Record<string, unknown> }
  | { op: "remove"; node: string }
  | { op: "title"; node: string; title: string };

export class GraphOperationError extends Error {}

function nextId(graph: ApiGraph): string {
  const numeric = Object.keys(graph).map(Number).filter(Number.isFinite);
  return String((numeric.length ? Math.max(...numeric) : 0) + 1);
}

/** Values a new node needs and has a default for, so an "add" is runnable without listing them. */
function defaultsFor(def: NodeDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of nodeInputs(def)) {
    if (!input.required || !input.widget) continue;
    if (input.config["default"] !== undefined) out[input.name] = input.config["default"];
    else if (input.options?.length) out[input.name] = input.options[0];
    else if (input.type === "STRING") out[input.name] = "";
  }
  return out;
}

/**
 * A node named by id, or by its type or title when exactly one node has it. A model cannot know
 * a template's ids before loading it: the lab's image_creator wrote "5" and "13" against a
 * template whose nodes are "459:452" and the like, and every operation failed.
 */
export function resolveNodeRef(graph: ApiGraph, ref: string, where: string): string {
  if (graph[ref]) return ref;
  const lower = ref.toLowerCase();
  const matches = Object.entries(graph).filter(([, node]) => node.class_type.toLowerCase() === lower || (node._meta?.title ?? "").toLowerCase() === lower);
  if (matches.length === 1) return matches[0]![0];
  if (matches.length > 1) {
    throw new GraphOperationError(`${where}: "${ref}" fits ${matches.length} nodes (${matches.map(([id]) => id).join(", ")}); use the id`);
  }
  throw new GraphOperationError(`${where}: there is no node ${ref}`);
}

function resolveLinks(graph: ApiGraph, inputs: Record<string, unknown>, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(inputs)) {
    out[name] = Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])
      ? [resolveNodeRef(graph, value[0], `${where}, input ${name}`), value[1]]
      : value;
  }
  return out;
}

/**
 * Applies operations in order to a copy. An operation naming a node that does not exist, or a
 * node type this ComfyUI lacks, stops everything: half an edit is worse than none. Nodes may be
 * named by id, or by a type or title only one node has (resolveNodeRef), links included.
 */
export function applyOperations(graph: ApiGraph, operations: GraphOperation[], catalog: NodeCatalog): { graph: ApiGraph; notes: string[] } {
  const next: ApiGraph = structuredClone(graph);
  const notes: string[] = [];
  operations.forEach((operation, index) => {
    const where = `operation ${index + 1} (${operation?.op ?? "?"})`;
    if (!operation || typeof operation !== "object") throw new GraphOperationError(`${where}: not an object`);
    switch (operation.op) {
      case "add": {
        const def = catalog[operation.class_type];
        if (!def) {
          const near = closest(Object.keys(catalog), String(operation.class_type), 3);
          throw new GraphOperationError(`${where}: this ComfyUI has no node type "${operation.class_type}"${near.length ? ` (closest: ${near.join(", ")})` : ""}`);
        }
        const id = operation.node ? String(operation.node) : nextId(next);
        if (next[id]) throw new GraphOperationError(`${where}: node ${id} already exists`);
        const filled = defaultsFor(def);
        const given = resolveLinks(next, operation.inputs ?? {}, where);
        const defaulted = Object.keys(filled).filter((name) => !(name in given));
        next[id] = { class_type: operation.class_type, inputs: { ...filled, ...given }, ...(operation.title ? { _meta: { title: operation.title } } : {}) };
        notes.push(`added ${id} ${operation.class_type}${defaulted.length ? ` (defaults for ${defaulted.join(", ")})` : ""}`);
        break;
      }
      case "set": {
        const id = resolveNodeRef(next, String(operation.node), where);
        const node = next[id]!;
        for (const [name, value] of Object.entries(resolveLinks(next, operation.inputs ?? {}, where))) {
          if (value === null) delete node.inputs[name];
          else node.inputs[name] = value;
        }
        notes.push(`set ${id}: ${Object.keys(operation.inputs ?? {}).join(", ")}`);
        break;
      }
      case "remove": {
        const removed = resolveNodeRef(next, String(operation.node), where);
        delete next[removed];
        const cut: string[] = [];
        for (const [id, node] of Object.entries(next)) {
          for (const [name, value] of Object.entries(node.inputs)) {
            if (isLink(value) && value[0] === removed) {
              delete node.inputs[name];
              cut.push(`${id}.${name}`);
            }
          }
        }
        notes.push(`removed ${removed}${cut.length ? `; now unconnected: ${cut.join(", ")}` : ""}`);
        break;
      }
      case "title": {
        const id = resolveNodeRef(next, String(operation.node), where);
        next[id]!._meta = { ...(next[id]!._meta ?? {}), title: operation.title };
        notes.push(`titled ${id} "${operation.title}"`);
        break;
      }
      default:
        throw new GraphOperationError(`${where}: unknown op; use add, set, remove or title`);
    }
  });
  return { graph: next, notes };
}

// ── formats ───────────────────────────────────────────────────────────────

export function isApiGraph(value: unknown): value is ApiGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length > 0 && entries.every((node) => !!node && typeof node === "object" && typeof (node as ApiNode).class_type === "string");
}

export function isEditorWorkflow(value: unknown): boolean {
  return !!value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)["nodes"]);
}

interface EditorNode {
  id: number;
  type: string;
  inputs?: Array<{ name: string; link?: number | null; widget?: { name: string } }>;
  widgets_values?: unknown;
}

interface EditorSubgraph {
  id: string;
  inputs?: Array<{ name: string; type?: string; linkIds?: number[] }>;
  links?: Array<{ id: number; origin_id: number; target_id: number; target_slot: number }>;
  nodes?: EditorNode[];
}

/**
 * Puts the values typed on a subgraph's own node into the API graph, where the converter
 * leaves them out.
 *
 * ComfyUI's official templates wrap their model chain in a subgraph and show the settings that
 * matter (prompt, seed, steps, model files) on the subgraph's node. In the saved file those
 * values sit in that node's widgets_values, one per WIDGET input of the subgraph (INT, FLOAT,
 * STRING, BOOLEAN, COMBO) in the subgraph's own input order — socket inputs (IMAGE, VIDEO, ...)
 * have none, so counting every input shifted a Wan template's seed into a switch — and each
 * input reaches inner nodes through its links. The workflow-to-API converter
 * flattens the subgraph (inner ids become "<outer id>:<inner id>") but takes the inner nodes'
 * stale values instead: the Qwen-Image 2.1 template came back with an empty prompt, seed 0 and
 * a switch with no input. Run like that, ComfyUI renders something nobody asked for.
 *
 * Only inputs the subgraph's node does NOT receive by link are filled here: a linked one the
 * converter already resolves. Nested subgraphs are followed with their joined ids.
 */
export function applySubgraphWidgetValues(editorWorkflow: unknown, graph: ApiGraph): string[] {
  const workflow = editorWorkflow as { nodes?: EditorNode[]; definitions?: { subgraphs?: EditorSubgraph[] } };
  const subgraphs = new Map((workflow.definitions?.subgraphs ?? []).map((sg) => [sg.id, sg]));
  const filled: string[] = [];
  const visit = (nodes: EditorNode[], prefix: string, depth: number): void => {
    if (depth > 8) return;
    for (const node of nodes) {
      const definition = subgraphs.get(node.type);
      if (!definition) continue;
      const ownId = `${prefix}${node.id}`;
      const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      let widgetIndex = -1;
      (definition.inputs ?? []).forEach((input) => {
        if (!WIDGET_TYPES.has(String(input.type))) return;
        widgetIndex += 1;
        const index = widgetIndex;
        if (index >= values.length) return;
        const outer = node.inputs?.find((i) => i.name === input.name);
        if (outer && outer.link !== null && outer.link !== undefined) return;
        for (const linkId of input.linkIds ?? []) {
          const link = definition.links?.find((l) => l.id === linkId);
          const target = link && definition.nodes?.find((n) => n.id === link.target_id);
          const slot = target && link ? target.inputs?.[link.target_slot] : undefined;
          if (!target || !slot) continue;
          // A value handed on into a nested subgraph: that subgraph's node carries its own copy.
          if (subgraphs.has(target.type)) continue;
          const apiNode = graph[`${ownId}:${target.id}`];
          if (!apiNode) continue;
          apiNode.inputs[slot.widget?.name ?? slot.name] = values[index];
          filled.push(`${ownId}:${target.id}.${slot.widget?.name ?? slot.name}`);
        }
      });
      visit(definition.nodes ?? [], `${ownId}:`, depth + 1);
    }
  };
  visit(workflow.nodes ?? [], "", 0);
  return filled;
}

/** The "prompt" (API) and "workflow" (editor) records ComfyUI writes into each PNG it saves. */
export function readPngWorkflow(bytes: Buffer): { prompt?: unknown; workflow?: unknown } {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== signature) return {};
  const found: Record<string, unknown> = {};
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt" || type === "iTXt") {
      const zero = data.indexOf(0);
      const keyword = data.subarray(0, zero).toString("latin1");
      if (keyword === "prompt" || keyword === "workflow") {
        let text: string;
        if (type === "tEXt") {
          text = data.subarray(zero + 1).toString("latin1");
        } else {
          // iTXt: keyword\0 compression-flag compression-method language\0 translated\0 text
          const compressed = data[zero + 1] === 1;
          let cursor = zero + 3;
          cursor = data.indexOf(0, cursor) + 1;
          cursor = data.indexOf(0, cursor) + 1;
          text = compressed ? "" : data.subarray(cursor).toString("utf8");
        }
        try {
          found[keyword] = JSON.parse(text);
        } catch {
          // a damaged record is no record
        }
      }
    }
    if (type === "IEND") break;
    offset += 12 + length;
  }
  return found;
}

/**
 * An API graph as an editor workflow, laid out left to right by depth, so a person can open
 * it in ComfyUI and keep working. Seeds are set to "fixed": opening the file and pressing Run
 * then makes the same picture, not a new one.
 */
export function toEditorWorkflow(apiGraph: ApiGraph, catalog: NodeCatalog): Record<string, unknown> {
  const graph = withPrimitiveNodes(apiGraph, catalog);
  const ids = orderedIds(graph);
  const numericIds = new Map<string, number>();
  let spare = Math.max(0, ...ids.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  for (const id of ids) {
    const n = Number(id);
    numericIds.set(id, Number.isInteger(n) && n > 0 ? n : (spare += 1));
  }

  // depth = longest chain of links behind a node; it is the node's column
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const value of Object.values(graph[id]?.inputs ?? {})) {
      if (isLink(value) && graph[value[0]]) d = Math.max(d, depthOf(value[0]) + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  ids.forEach(depthOf);

  const links: Array<[number, number, number, number, number, string]> = [];
  const outputLinks = new Map<string, number[][]>();
  const columns = new Map<number, number>();
  const nodes = ids.map((id, order) => {
    const node = graph[id]!;
    const def = catalog[node.class_type] ?? {};
    const inputs = nodeInputs(def, node.inputs);
    const uiInputs: Array<Record<string, unknown>> = [];
    const widgetsValues: unknown[] = [];
    for (const input of inputs) {
      const value = node.inputs?.[input.name];
      if (input.grown && !isLink(value)) continue;
      if (input.socketless) continue;
      if (input.widget) {
        widgetsValues.push(isLink(value) ? (input.config["default"] ?? input.options?.[0] ?? null) : (value ?? input.config["default"] ?? null));
        if (input.config["control_after_generate"]) widgetsValues.push("fixed");
        for (const upload of ["image_upload", "video_upload", "audio_upload"]) {
          if (input.config[upload]) widgetsValues.push(upload.replace("_upload", ""));
        }
      }
      if (!input.widget || isLink(value)) {
        uiInputs.push({ name: input.name, type: input.type, link: null, ...(input.widget ? { widget: { name: input.name } } : {}) });
      }
    }
    uiInputs.forEach((uiInput, slot) => {
      const value = node.inputs?.[String(uiInput["name"])];
      if (!isLink(value) || !graph[value[0]]) return;
      const linkId = links.length + 1;
      const sourceType = nodeOutputs(catalog[graph[value[0]]!.class_type] ?? {})[value[1]]?.type ?? String(uiInput["type"]);
      links.push([linkId, numericIds.get(value[0])!, value[1], numericIds.get(id)!, slot, sourceType]);
      uiInput["link"] = linkId;
      const perOutput = outputLinks.get(value[0]) ?? [];
      (perOutput[value[1]] ??= []).push(linkId);
      outputLinks.set(value[0], perOutput);
    });
    const column = depth.get(id) ?? 0;
    const row = columns.get(column) ?? 0;
    const height = 46 + 24 * (uiInputs.length + widgetsValues.length);
    columns.set(column, row + height + 60);
    return {
      id: numericIds.get(id)!,
      type: node.class_type,
      pos: [60 + column * 400, 60 + row],
      size: [340, height],
      flags: {},
      order,
      mode: 0,
      inputs: uiInputs,
      outputs: [] as Array<Record<string, unknown>>,
      properties: { "Node name for S&R": node.class_type },
      widgets_values: widgetsValues,
      ...(node._meta?.title && node._meta.title !== node.class_type ? { title: node._meta.title } : {}),
    };
  });
  ids.forEach((id, index) => {
    const def = catalog[graph[id]!.class_type] ?? {};
    nodes[index]!.outputs = nodeOutputs(def).map((output, slot) => ({
      name: output.name,
      type: output.type,
      links: outputLinks.get(id)?.[slot] ?? [],
      slot_index: slot,
    }));
  });

  return {
    id: randomUUID(),
    revision: 0,
    last_node_id: Math.max(0, ...nodes.map((n) => n.id)),
    last_link_id: links.length,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { ds: { scale: 0.8, offset: [0, 0] } },
    version: 0.4,
  };
}

const PRIMITIVE_FOR: Record<string, string> = {
  string: "PrimitiveStringMultiline",
  boolean: "PrimitiveBoolean",
  integer: "PrimitiveInt",
  number: "PrimitiveFloat",
};

/**
 * A plain value on a socket (a V3 switch's branch, set from a subgraph's prompt) runs in the API
 * format but has no place in the editor, which would drop it: the editor workflow then runs
 * with that branch empty. Each such value moves into a Primitive node linked to the socket.
 */
function withPrimitiveNodes(graph: ApiGraph, catalog: NodeCatalog): ApiGraph {
  let out: ApiGraph | null = null;
  for (const [id, node] of Object.entries(graph)) {
    const def = catalog[node.class_type];
    if (!def) continue;
    for (const input of nodeInputs(def, node.inputs)) {
      const value = node.inputs[input.name];
      if (input.widget || value === undefined || value === null || isLink(value)) continue;
      const kind = typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
      const primitive = PRIMITIVE_FOR[kind];
      if (!primitive || !catalog[primitive]) continue;
      out ??= structuredClone(graph);
      const primitiveId = nextId(out);
      out[primitiveId] = { class_type: primitive, inputs: { value } };
      out[id]!.inputs[input.name] = [primitiveId, 0];
    }
  }
  return out ?? graph;
}

/**
 * What differs between two API graphs that should be the same workflow, ids aside: each node is
 * compared as its type plus its inputs, a link written as the type and output it comes from, a
 * Primitive node's value in place of its link (toEditorWorkflow adds those). Inputs a node type
 * hides are left out. Empty when they match.
 */
export function graphDifferences(expected: ApiGraph, actual: ApiGraph, catalog: NodeCatalog, limit = 4): string[] {
  const signatures = (graph: ApiGraph): string[] => {
    const resolve = (value: unknown, depth = 0): unknown => {
      if (!isLink(value) || depth > 3) return value;
      const source = graph[value[0]];
      if (!source) return `<missing ${value[0]}>`;
      if (Object.values(PRIMITIVE_FOR).includes(source.class_type) && "value" in source.inputs) return resolve(source.inputs["value"], depth + 1);
      return `<${source.class_type}#${value[1]}>`;
    };
    return Object.values(graph)
      .filter((node) => !(Object.values(PRIMITIVE_FOR).includes(node.class_type) && Object.keys(node.inputs).length === 1))
      .map((node) => {
        const def = catalog[node.class_type];
        const known = def ? new Set(nodeInputs(def, node.inputs).map((i) => i.name)) : null;
        const inputs = Object.entries(node.inputs)
          .filter(([name]) => !known || known.has(name))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => [name, resolve(value)]);
        return `${node.class_type} ${JSON.stringify(Object.fromEntries(inputs))}`;
      })
      .sort();
  };
  const a = signatures(expected);
  const b = signatures(actual);
  const missing = a.filter((s) => !b.includes(s));
  const extra = b.filter((s) => !a.includes(s));
  const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
  return [
    ...missing.slice(0, limit).map((s) => `only in the workflow: ${clip(s)}`),
    ...extra.slice(0, limit).map((s) => `only in the editor copy: ${clip(s)}`),
  ];
}

/**
 * The graph as it will run: a switch set to a fixed value is replaced by the branch it picks,
 * and nodes no output depends on any more are left out.
 *
 * ComfyUI checks every node an output can reach, a switched-off branch included. The official
 * Qwen-Image 2.1 template keeps its prompt enhancer behind a switch that is off, and ComfyUI
 * refused the whole run because that enhancer's 9 GB model file was not installed. What runs is
 * the same either way; only the refusal goes. A switch is recognised by its inputs (a boolean
 * `switch` beside `on_true`/`on_false`), not by its type name.
 */
export function runnableGraph(graph: ApiGraph, catalog: NodeCatalog): { graph: ApiGraph; skipped: string[] } {
  const out: ApiGraph = structuredClone(graph);
  const skipped: string[] = [];
  for (const [id, node] of Object.entries(out)) {
    const inputs = node.inputs ?? {};
    if (typeof inputs["switch"] !== "boolean" || !("on_true" in inputs || "on_false" in inputs)) continue;
    const chosen = inputs["switch"] ? inputs["on_true"] : inputs["on_false"];
    if (chosen === undefined) continue;
    for (const other of Object.values(out)) {
      for (const [name, value] of Object.entries(other.inputs ?? {})) {
        if (isLink(value) && value[0] === id && value[1] === 0) other.inputs[name] = structuredClone(chosen);
      }
    }
    delete out[id];
    skipped.push(`switch ${id} (${inputs["switch"] ? "on" : "off"}) resolved`);
  }
  // An editor-drawn input the saved workflow carries no value for (ImageCompare's view): ComfyUI
  // still requires it, and refused the official image-edit template's compare node without it.
  for (const node of Object.values(out)) {
    const def = catalog[node.class_type];
    if (!def) continue;
    for (const input of nodeInputs(def, node.inputs)) {
      if (input.socketless && input.required && !(input.name in node.inputs)) node.inputs[input.name] = input.config["default"] ?? "";
    }
  }
  // Keep what an output node needs, following links backwards.
  const needed = new Set<string>();
  const stack = Object.keys(out).filter((id) => catalog[out[id]!.class_type]?.output_node);
  while (stack.length) {
    const id = stack.pop()!;
    if (needed.has(id) || !out[id]) continue;
    needed.add(id);
    for (const value of Object.values(out[id]!.inputs ?? {})) if (isLink(value)) stack.push(value[0]);
  }
  if (needed.size === 0) return { graph: out, skipped };
  const unused = Object.keys(out).filter((id) => !needed.has(id));
  for (const id of unused) delete out[id];
  if (unused.length) skipped.push(`${unused.length} node(s) no output uses: ${unused.map((id) => `${id} ${graph[id]?.class_type ?? ""}`.trim()).join(", ")}`);
  return { graph: out, skipped };
}

const SETTING_NAMES = new Set(["steps", "cfg", "denoise", "width", "height", "megapixels", "aspect_ratio", "batch_size", "resolution", "length", "fps"]);
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i;

/**
 * Where a request's changes go, by input address: the prompt, seed, settings, model files and
 * picture inputs of the nodes that run. A template's prompt sits wherever its authors put it —
 * the Qwen-Image 2.1 one on a switch's branch inside a subgraph — and without this the lab's
 * image_creator edited the JSON by hand to find it.
 */
export function keyInputs(graph: ApiGraph, catalog: NodeCatalog): string {
  const running = new Set(Object.keys(runnableGraph(graph, catalog).graph));
  const groups = new Map<string, string[]>();
  const add = (group: string, address: string): void => {
    const list = groups.get(group) ?? [];
    if (list.length < 4) list.push(address);
    groups.set(group, list);
  };
  for (const id of orderedIds(graph)) {
    const node = graph[id]!;
    const def = catalog[node.class_type];
    if (!def) continue;
    const isSwitch = typeof node.inputs["switch"] === "boolean";
    if (!running.has(id) && !isSwitch) continue;
    for (const input of nodeInputs(def, node.inputs)) {
      const value = node.inputs[input.name];
      if (value === undefined || isLink(value)) continue;
      const address = `${id}.${input.name}`;
      if (isSwitch) {
        if (input.name === (node.inputs["switch"] ? "on_true" : "on_false") && typeof value === "string") add("prompt", address);
        continue;
      }
      if (input.config["control_after_generate"]) add("seed", address);
      else if (input.config["image_upload"]) add("pictures (comfyui_run images)", address);
      else if (typeof value === "string" && MODEL_FILE.test(value)) add("model files", address);
      else if (input.type === "STRING" && input.config["multiline"]) add(/neg/i.test(input.name) ? "negative prompt" : "prompt", address);
      else if (SETTING_NAMES.has(input.name)) add("settings", address);
    }
  }
  const order = ["prompt", "negative prompt", "seed", "settings", "model files", "pictures (comfyui_run images)"];
  return order.filter((g) => groups.has(g)).map((g) => `${g}: ${groups.get(g)!.join(", ")}`).join("; ");
}

/** Every seed-like input that the editor would re-roll on each run (control_after_generate). */
export function seedInputs(graph: ApiGraph, catalog: NodeCatalog): Array<{ node: string; input: string; max: number }> {
  const out: Array<{ node: string; input: string; max: number }> = [];
  for (const [id, node] of Object.entries(graph)) {
    const def = catalog[node.class_type];
    if (!def) continue;
    for (const input of nodeInputs(def)) {
      if (input.config["control_after_generate"] && input.type === "INT" && !isLink(node.inputs[input.name])) {
        const max = typeof input.config["max"] === "number" ? Math.min(input.config["max"], Number.MAX_SAFE_INTEGER) : 2 ** 32 - 1;
        out.push({ node: id, input: input.name, max });
      }
    }
  }
  return out;
}
