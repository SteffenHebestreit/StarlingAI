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
import { createHash, randomUUID } from "node:crypto";

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
  /**
   * `added`: put there by an operation, not by whoever made the workflow (see danglingNodes).
   * `sample`: per input, the mark of the prompt text a template arrived with (see markSamplePrompts).
   */
  _meta?: { title?: string; added?: boolean; sample?: Record<string, string> };
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

/**
 * A node's outputs. An output that takes the type of what is linked in (a V3 switch gives
 * whichever branch it picks) is declared COMFY_MATCHTYPE_V3 and read as "*", as an input of that
 * kind is: taken as a type of its own it matched nothing, and the official Qwen-Image template,
 * whose prompt passes through such a switch, looked as if it had no prompt at all.
 */
export function nodeOutputs(def: NodeDef): Array<{ name: string; type: string }> {
  const types = (def.output ?? []).map((t) => (Array.isArray(t) ? "COMBO" : t === "COMFY_MATCHTYPE_V3" ? "*" : String(t)));
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

/** A node type in one line: what it needs and what it gives, enough to wire it without looking it up. */
function nodeSignature(def: NodeDef): string {
  const inputs = nodeInputs(def);
  const needed = inputs.filter((input) => input.required && !input.grown).map((input) => {
    if (!input.options) return `${input.name}: ${input.type}`;
    return `${input.name}: ${input.options.length > 0 && input.options.length <= 4 ? input.options.join(" | ") : `${input.options.length} choices`}`;
  });
  const optional = inputs.filter((input) => !input.required).length;
  const outputs = nodeOutputs(def).map((output) => output.type).join(", ") || "nothing";
  return `(${[...needed, ...(optional ? [`+${optional} optional`] : [])].join(", ")}) -> ${outputs}`;
}

/** How many search hits carry their signature: the best ones, without a page of every near match. */
const SIGNATURES_SHOWN = 12;

/**
 * Node types matching a search, best first. Every word has to match if any type has them all;
 * otherwise the types matching the most words. A name written the way node types are
 * ("UpscaleImage") counts as its words: the lab's image_creator guessed that name and got
 * "no match" although ComfyUI has an "Upscale Image" node.
 */
export function searchNodes(catalog: NodeCatalog, query: string, limit = 30): string[] {
  const words = [...new Set(query.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_-]+/).filter(Boolean))];
  const scan = (fits: (matched: number) => boolean, rank: (matched: number) => number): Array<{ name: string; score: number; def: NodeDef }> => {
    const hits: Array<{ name: string; score: number; def: NodeDef }> = [];
    for (const [name, def] of Object.entries(catalog)) {
      const title = `${name} ${def.display_name ?? ""}`.toLowerCase();
      const haystack = `${title} ${def.category ?? ""} ${def.description ?? ""}`.toLowerCase();
      const matched = words.filter((word) => haystack.includes(word)).length;
      if (!fits(matched)) continue;
      const inTitle = words.every((word) => title.includes(word));
      hits.push({ name, def, score: rank(matched) + (inTitle ? 0 : 1) + (def.deprecated ? 2 : 0) });
    }
    return hits;
  };
  let hits = scan((matched) => matched === words.length, () => 0);
  if (hits.length === 0 && words.length > 1) hits = scan((matched) => matched > 0, (matched) => words.length - matched);
  return hits
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, def }, index) => {
      const line = `${name}${def.display_name && def.display_name !== name ? ` ("${def.display_name}")` : ""} — ${def.category ?? "?"}`;
      return index < SIGNATURES_SHOWN ? `${line} ${nodeSignature(def)}` : line;
    });
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
        errors.push(`node ${id} (${node.class_type}): required input "${input.name}" is missing${input.widget ? "" : supplierHint(input.type, id, graph, catalog)}`);
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

/** The nodes of the workflow that give this type, as the links to them. */
function suppliersOf(type: string, graph: ApiGraph, catalog: NodeCatalog, exclude?: string): Link[] {
  if (type === "*") return [];
  const found: Link[] = [];
  for (const id of orderedIds(graph)) {
    if (id === exclude) continue;
    const def = catalog[graph[id]!.class_type];
    const index = def ? nodeOutputs(def).findIndex((output) => output.type === type) : -1;
    if (index >= 0) found.push([id, index]);
  }
  return found;
}

/**
 * What can fill an empty socket of this type: a node already in the workflow that gives it, else
 * the few loaders that do. Nothing for a type many nodes give (IMAGE), where a list would not help.
 */
function supplierHint(type: string, forNode: string, graph: ApiGraph, catalog: NodeCatalog): string {
  if (type === "*") return "";
  const inGraph = suppliersOf(type, graph, catalog, forNode).map(([id, index]) => `["${id}", ${index}]`);
  if (inGraph.length) return ` (${type}; in this workflow ${inGraph.slice(0, 3).join(" or ")} gives one)`;
  const loaders = Object.entries(catalog)
    .filter(([, def]) => nodeOutputs(def).some((output) => output.type === type) && !nodeInputs(def).some((input) => input.required && !input.widget))
    .map(([name]) => name);
  return loaders.length >= 1 && loaders.length <= 3 ? ` (${type}; ${loaders.join(" or ")} gives one)` : ` (${type})`;
}

/**
 * Added nodes whose output nothing takes and that save nothing themselves: ComfyUI never runs
 * them. Such a node looks finished in the file; the lab's image_creator added an upscaler nothing
 * read from, was told the workflow checked out, and would have got the old size. Only added
 * ones: 22 of ComfyUI's 265 official templates carry an unused node of their own.
 */
export function danglingNodes(graph: ApiGraph, catalog: NodeCatalog): string[] {
  const read = new Set<string>();
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs ?? {})) if (isLink(value)) read.add(value[0]);
  }
  return orderedIds(graph).filter((id) => {
    const def = catalog[graph[id]!.class_type];
    return !!def && graph[id]!._meta?.added === true && !def.output_node && !read.has(id) && nodeOutputs(def).length > 0;
  });
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
  | { op: "insert"; before?: string; node?: string; class_type: string; inputs?: Record<string, unknown>; title?: string }
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
  const listed = listedNode(graph, ref);
  if (listed) return listed;
  const matches = nodesNamed(graph, ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new GraphOperationError(`${where}: "${ref}" fits ${matches.length} nodes (${matches.join(", ")}); use the id`);
  throw new GraphOperationError(`${where}: there is no node ${ref}`);
}

/**
 * A node written the way this tool lists one: `5 SaveImage`, or `5 SaveImage "Save Image"` with its
 * title. The lab's image_creator copied that from a refusal into `before` and was told there was
 * no node "5 SaveImage". Taken only when the id is there and the rest names that very node.
 */
function listedNode(graph: ApiGraph, ref: string): string | undefined {
  const match = /^(\S+)\s+(.+)$/.exec(ref.trim());
  const node = match ? graph[match[1]!] : undefined;
  if (!match || !node) return undefined;
  const rest = match[2]!.trim().toLowerCase();
  const type = node.class_type.toLowerCase();
  const title = (node._meta?.title ?? "").toLowerCase();
  const names = [type, ...(title ? [title, `"${title}"`, `${type} "${title}"`] : [])];
  return names.includes(rest) ? match[1] : undefined;
}

/**
 * Nodes with this type or title, else (a word of four letters or more) with it inside their type
 * or title: a model writes "SaveImage", and the official Qwen-Image template saves with
 * SaveImageAdvanced. A wrong guess is no risk: more than one match is refused.
 */
function nodesNamed(graph: ApiGraph, ref: string): string[] {
  const lower = ref.toLowerCase();
  const entries = Object.entries(graph).map(([id, node]) => ({ id, type: node.class_type.toLowerCase(), title: (node._meta?.title ?? "").toLowerCase() }));
  const exact = entries.filter((node) => node.type === lower || node.title === lower);
  const found = exact.length || lower.length < 4 || /^\d+$/.test(lower) ? exact : entries.filter((node) => node.type.includes(lower) || node.title.includes(lower));
  return found.map((node) => node.id);
}

/**
 * "<node>" or "<node>.<input>", the node by id, type or title. Node ids may hold a colon (a
 * flattened subgraph, "459:458") and inputs a dot (a V3 sub-input, "format.bit_depth"), so the
 * split is after the longest node id the graph has, and failing that at the first dot that
 * leaves a type or title.
 */
export function resolveInputRef(graph: ApiGraph, ref: string, where: string): { id: string; input?: string } {
  if (graph[ref]) return { id: ref };
  const owner = Object.keys(graph).sort((a, b) => b.length - a.length).find((id) => ref.startsWith(`${id}.`) && ref.length > id.length + 1);
  if (owner) {
    const input = ref.slice(owner.length + 1);
    // "5.SaveImage": the node's own type or title after the dot, not one of its inputs.
    const node = graph[owner]!;
    const lower = input.toLowerCase();
    if (!(input in node.inputs) && (lower === node.class_type.toLowerCase() || lower === (node._meta?.title ?? "").toLowerCase())) return { id: owner };
    return { id: owner, input };
  }
  for (let dot = ref.indexOf("."); dot > 0; dot = ref.indexOf(".", dot + 1)) {
    const prefix = ref.slice(0, dot);
    if (listedNode(graph, prefix) || nodesNamed(graph, prefix).length > 0) return { id: resolveNodeRef(graph, prefix, where), input: ref.slice(dot + 1) };
  }
  return { id: resolveNodeRef(graph, ref, where) };
}

/**
 * A link as a model writes it after reading this tool's own node listing, which prints links as
 * `<-459:457.0`: ["459:457.0"] anywhere, and "459:457.0" on an input that takes a link. On a text
 * input the same string stays text. A set with such a value used to replace the save node's
 * connection with junk, and every later insert found nothing to sit on.
 */
function asLink(value: unknown, isSocket: boolean): unknown {
  const written = Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : isSocket && typeof value === "string" ? value : undefined;
  if (written === undefined) return value;
  const match = /^(?:<-)?(.+)\.(\d+)$/.exec(written.trim());
  return match ? [match[1]!, Number(match[2])] : value;
}

interface LinkContext {
  /** The node type the inputs belong to: it says which of them take a link, and of what type. */
  def?: NodeDef | undefined;
  catalog?: NodeCatalog;
  /** The node being changed: it cannot feed its own input. */
  self?: string;
  /**
   * For a node being put on a connection: a link that cannot be made out is left to that
   * connection, which is what feeds the node, instead of stopping the operation.
   */
  spliced?: boolean;
  notes?: string[];
}

function resolveLinks(graph: ApiGraph, inputs: Record<string, unknown>, where: string, context: LinkContext = {}): Record<string, unknown> {
  const sockets = new Map((context.def ? nodeInputs(context.def) : []).filter((input) => !input.widget && !input.socketless).map((input) => [input.name, input]));
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(inputs)) {
    const value = asLink(raw, sockets.has(name));
    if (!(Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]))) {
      out[name] = value;
      continue;
    }
    try {
      out[name] = [resolveNodeRef(graph, value[0], `${where}, input ${name}`), value[1]];
    } catch (error) {
      const socket = sockets.get(name);
      if (!(error instanceof GraphOperationError) || !socket || !context.catalog) throw error;
      // A link to a node that is not there, on an input one node of the workflow can feed: that
      // node is the only thing the link can mean. The lab's image_creator wrote ["459:801", 0]
      // for the loader it had just added and ["KSampler.outputs", 0] for the decoded picture.
      const suppliers = suppliersOf(socket.type, graph, context.catalog, context.self);
      const [only] = suppliers;
      if (suppliers.length !== 1 || !only) {
        if (!context.spliced) throw new GraphOperationError(`${error.message}${supplierHint(socket.type, context.self ?? "", graph, context.catalog)}`);
        // Several nodes give a picture (the official template's save node passes its own on), and
        // for a stage being inserted the one meant is the connection it goes on.
        context.notes?.push(`${name}: there is no node ${String(value[0])}; left to the connection the node is put on`);
        continue;
      }
      out[name] = only;
      context.notes?.push(`${name}<-${only[0]}.${only[1]} (there is no node ${String(value[0])}; ${only[0]} is the one node giving ${socket.type})`);
    }
  }
  return out;
}

/**
 * A choice written as part of exactly one of the input's choices is that choice. "3:2" for
 * "3:2 (Photo)" cost the lab's image_creator a refused run each of the three times it wrote it,
 * "y-axis" for "y-axis: horizontally" a hand edit of the workflow file. The whole value first,
 * then its start, then anywhere in a choice; where more than one choice fits, nothing is guessed.
 */
export function completeChoices(id: string, node: ApiNode, def: NodeDef | undefined, names: readonly string[]): string[] {
  if (!def) return [];
  const inputs = new Map(nodeInputs(def, node.inputs).map((input) => [input.name, input]));
  const notes: string[] = [];
  for (const name of names) {
    const options = inputs.get(name)?.options;
    const value = node.inputs[name];
    if (!options || typeof value !== "string" || !value.trim() || options.includes(value)) continue;
    const written = value.trim().toLowerCase();
    const tiers = [
      options.filter((option) => option.toLowerCase() === written),
      options.filter((option) => option.toLowerCase().startsWith(written)),
      written.length >= 3 ? options.filter((option) => option.toLowerCase().includes(written)) : [],
    ];
    const fitting = tiers.find((tier) => tier.length > 0);
    const [choice] = fitting ?? [];
    if (fitting?.length !== 1 || choice === undefined) continue;
    node.inputs[name] = choice;
    notes.push(`${id}.${name}: "${value}" taken as "${choice}"`);
  }
  return notes;
}

function addNode(graph: ApiGraph, operation: { node?: string; class_type: string; inputs?: Record<string, unknown>; title?: string }, def: NodeDef, where: string, catalog: NodeCatalog, notes: string[]): void {
  const id = operation.node ? String(operation.node) : nextId(graph);
  if (graph[id]) throw new GraphOperationError(`${where}: node ${id} already exists`);
  const filled = defaultsFor(def);
  const given = resolveLinks(graph, operation.inputs ?? {}, where, { def, catalog, notes });
  const defaulted = Object.keys(filled).filter((name) => !(name in given));
  const node: ApiNode = { class_type: operation.class_type, inputs: { ...filled, ...given }, _meta: { ...(operation.title ? { title: operation.title } : {}), added: true } };
  graph[id] = node;
  notes.push(`added ${id} ${operation.class_type}${defaulted.length ? ` (defaults for ${defaulted.join(", ")})` : ""}`, ...completeChoices(id, node, def, Object.keys(given)));
}

/**
 * Why a value just written to `name` goes nowhere, null when the node takes it. ComfyUI ignores an
 * input a node type does not have, so such a set changes nothing and nothing says so: the lab's
 * image_creator wrote the prompt to `text` on a node whose input is `prompt`, was told the set
 * was done, and got the template's sample picture. Checked against the node as it is after the
 * change, so a choice and the sub-inputs it brings can be set together.
 */
export function unknownInput(id: string, node: ApiNode, def: NodeDef | undefined, name: string): string | null {
  if (!def || !(name in node.inputs)) return null;
  const inputs = nodeInputs(def, node.inputs);
  if (inputs.some((input) => input.name === name || (input.openPrefix !== undefined && name.startsWith(input.openPrefix)))) return null;
  const listed = inputs.filter((input) => !input.grown).map((input) => (input.widget ? input.name : `${input.name} (link)`));
  return `${id} (${node.class_type}) has no input "${name}". Its inputs: ${listed.slice(0, 16).join(", ")}${listed.length > 16 ? ", …" : ""}`;
}

interface Splice {
  input: string;
  link: Link;
  /** The new node's socket that takes the old connection; none when `inputs` already wires it. */
  receive?: string;
  output: number;
  /** What the link carries is known and the new node's socket takes exactly that. */
  typed: boolean;
}

/**
 * The links into `target` a new node of type `def` can sit on: it has to take what the link
 * carries and give what the input wants. Exact types win over a socket that takes anything.
 */
function spliceCandidates(graph: ApiGraph, target: ApiNode, def: NodeDef, given: Record<string, unknown>, catalog: NodeCatalog, only: string | undefined): Splice[] {
  const targetDef = catalog[target.class_type];
  const declared = targetDef ? nodeInputs(targetDef, target.inputs) : [];
  const sockets = nodeInputs(def).filter((input) => !input.widget && !input.socketless && !input.grown);
  const free = sockets.filter((socket) => !(socket.name in given));
  const outputs = nodeOutputs(def).map((output, index) => ({ ...output, index }));
  const found: Splice[] = [];
  for (const [name, value] of Object.entries(target.inputs)) {
    if (!isLink(value) || (only !== undefined && name !== only)) continue;
    const wanted = declared.find((input) => input.name === name)?.type ?? "*";
    const sourceDef = catalog[graph[value[0]]?.class_type ?? ""];
    const carried = sourceDef ? nodeOutputs(sourceDef)[value[1]]?.type ?? wanted : wanted;
    // An output of any type (a V3 switch's) says nothing: what the input wants is what it carries.
    const type = carried === "*" ? wanted : carried;
    // Where neither side says, nothing is known of what flows there, and anything would "fit". The
    // official Qwen-Image template passes its prompt text through a switch into a preview of any
    // type; a VAEDecode the lab's image_creator inserted without a place landed there, cut the
    // prompt off from its encoder, and the next stage found two outputs to go before.
    if (type === "*") continue;
    const receive = free.find((socket) => socket.type === type) ?? free.find((socket) => typesFit(type, socket.type));
    // Nothing free for it, but the caller wired that socket itself ({image: ["VAEDecode", 0]}): the
    // new node is fed already and only the output has to be moved. The lab's image_creator wrote
    // it this way in most insert calls and was told the node fitted nowhere.
    const wired = receive ? undefined : sockets.find((socket) => isLink(given[socket.name]) && typesFit(type, socket.type));
    const output = outputs.find((candidate) => candidate.type === wanted) ?? outputs.find((candidate) => typesFit(candidate.type, wanted));
    const taking = receive ?? wired;
    if (taking && output) found.push({ input: name, link: value, ...(receive ? { receive: receive.name } : {}), output: output.index, typed: type !== "*" && taking.type === type });
  }
  return found.some((splice) => splice.typed) ? found.filter((splice) => splice.typed) : found;
}

/**
 * The output node a stage goes in front of when the operation names none. The lab's
 * image_creator left `before` out in most insert calls and fell back to editing the JSON by hand;
 * "in front of the output" is what it meant, and only a single fitting output settles it.
 */
function outputNodeFor(graph: ApiGraph, classType: string, def: NodeDef, given: Record<string, unknown>, catalog: NodeCatalog, where: string): string {
  const fitting = Object.keys(graph)
    .filter((id) => catalog[graph[id]!.class_type]?.output_node)
    .map((id) => ({ id, splices: spliceCandidates(graph, graph[id]!, def, given, catalog, undefined) }))
    .filter((candidate) => candidate.splices.length > 0);
  const typed = fitting.filter((candidate) => candidate.splices.some((splice) => splice.typed));
  const chosen = typed.length ? typed : fitting;
  if (chosen.length === 1) return chosen[0]!.id;
  // A stage the workflow has already (the lab's image_creator inserted a VAEDecode into a template that decodes).
  const present = orderedIds(graph).filter((id) => graph[id]!.class_type === classType);
  throw new GraphOperationError(
    chosen.length > 1
      ? `${where}: ${classType} could go before several outputs: ${chosen.map((candidate) => `before: "${candidate.id}" (${graph[candidate.id]!.class_type})`).join(" or ")}`
      : `${where}: ${classType} fits in front of no output of this workflow${present.length ? `, which has ${classType} ${present.slice(0, 3).join(", ")} already` : ""}: before must name the node that should receive its output, or "<node>.<input>"`,
  );
}

function requireNodeType(catalog: NodeCatalog, classType: unknown, where: string): NodeDef {
  const def = catalog[String(classType)];
  if (def) return def;
  const near = closest(Object.keys(catalog), String(classType), 3);
  throw new GraphOperationError(`${where}: this ComfyUI has no node type "${String(classType)}"${near.length ? ` (closest: ${near.join(", ")})` : ""}`);
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
      case "insert": {
        const def = requireNodeType(catalog, operation.class_type, where);
        // A loader takes no connection, so there is nothing to put it on: it is an add.
        if (!nodeInputs(def).some((input) => !input.widget && !input.socketless)) {
          addNode(next, operation, def, where, catalog, notes);
          break;
        }
        const id = operation.node ? String(operation.node) : nextId(next);
        if (next[id]) throw new GraphOperationError(`${where}: node ${id} already exists`);
        const given = resolveLinks(next, operation.inputs ?? {}, where, { def, catalog, notes, spliced: true });
        const target = operation.before ? resolveInputRef(next, String(operation.before), where) : { id: outputNodeFor(next, operation.class_type, def, given, catalog, where), input: undefined };
        const node = next[target.id]!;
        const candidates = spliceCandidates(next, node, def, given, catalog, target.input);
        if (candidates.length > 1) {
          throw new GraphOperationError(`${where}: ${operation.class_type} fits several inputs of ${target.id} (${node.class_type}): ${candidates.map((c) => c.input).join(", ")}. Write before as "${target.id}.<input>"`);
        }
        const splice = candidates[0];
        if (!splice) {
          const linked = Object.entries(node.inputs).filter(([, value]) => isLink(value)).map(([name]) => name).join(", ") || "none";
          // Where it would fit, by type: a place named wrongly is a dead end without it.
          const fits = Object.keys(next).flatMap((other) => spliceCandidates(next, next[other]!, def, given, catalog, undefined).filter((candidate) => candidate.typed).map((candidate) => `${other}.${candidate.input}`));
          throw new GraphOperationError(
            `${where}: ${operation.class_type} fits no link into ${target.input ? `${target.id}.${target.input}` : target.id} (${node.class_type}). Its links: ${linked}`
              + (fits.length ? `. It fits before ${fits.slice(0, 4).join(", ")}` : ""),
          );
        }
        const filled = defaultsFor(def);
        const defaulted = Object.keys(filled).filter((name) => !(name in given));
        const inserted: ApiNode = { class_type: operation.class_type, inputs: { ...filled, ...given, ...(splice.receive ? { [splice.receive]: splice.link } : {}) }, _meta: { ...(operation.title ? { title: operation.title } : {}), added: true } };
        next[id] = inserted;
        node.inputs[splice.input] = [id, splice.output];
        notes.push(
          `inserted ${id} ${operation.class_type} before ${target.id}.${splice.input}${splice.receive ? ` (${splice.receive}<-${splice.link[0]}.${splice.link[1]})` : ""}${defaulted.length ? ` (defaults for ${defaulted.join(", ")})` : ""}`,
          ...completeChoices(id, inserted, def, Object.keys(given)),
        );
        break;
      }
      case "add": {
        addNode(next, operation, requireNodeType(catalog, operation.class_type, where), where, catalog, notes);
        break;
      }
      case "set": {
        // "459:474.on_false" is how this tool names an input ("Where to change it"), so a model
        // writes it here too; with one value given, the input named there is the one it means.
        const { id, input } = resolveInputRef(next, String(operation.node), where);
        const node = next[id]!;
        const given = Object.entries(operation.inputs ?? {});
        const values = input && given.length === 1 ? { [input]: given[0]![1] } : (operation.inputs ?? {});
        const had = new Set(Object.keys(node.inputs));
        for (const [name, value] of Object.entries(resolveLinks(next, values, where, { def: catalog[node.class_type], catalog, self: id, notes }))) {
          if (value === null) delete node.inputs[name];
          else node.inputs[name] = value;
        }
        for (const name of Object.keys(values)) {
          const problem = had.has(name) ? null : unknownInput(id, node, catalog[node.class_type], name);
          if (problem) throw new GraphOperationError(`${where}: ${problem}`);
        }
        notes.push(`set ${id}: ${Object.keys(values).join(", ")}`, ...completeChoices(id, node, catalog[node.class_type], Object.keys(values)));
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
        throw new GraphOperationError(`${where}: unknown op; use add, insert, set, remove or title`);
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
  const groups = new Map<string, string[]>();
  // Texts that become conditioning first: a template with a row of expressions and patterns
  // would otherwise fill the few places shown before its prompt comes.
  const entries = classifiedInputs(graph, catalog);
  for (const { group, id, input } of [...entries.filter((entry) => entry.conditioning), ...entries.filter((entry) => !entry.conditioning)]) {
    const list = groups.get(group) ?? [];
    if (list.length < 4) list.push(`${id}.${input}`);
    groups.set(group, list);
  }
  const order = ["prompt", "negative prompt", "seed", "settings", "model files", "pictures (comfyui_run images)"];
  return order.filter((g) => groups.has(g)).map((g) => `${g}: ${groups.get(g)!.join(", ")}`).join("; ");
}

/**
 * Where the text a node holds or passes on ends up: in conditioning at all, and if so on which
 * side. Followed along text links only, to the first node that gives CONDITIONING (a text
 * encoder). Of ComfyUI's 265 official templates 125 hold a math expression in a multiline text
 * box, others a regular expression or shader code: none of that is a prompt. And the classic
 * templates' negative prompt sits in the same `text` input as the positive one; what tells them
 * apart is the input its conditioning goes to.
 */
function conditioningSides(graph: ApiGraph, catalog: NodeCatalog): (id: string) => "prompt" | "negative" | null {
  const consumers = new Map<string, Array<{ id: string; input: string; output: number }>>();
  for (const [id, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (!isLink(value)) continue;
      const list = consumers.get(value[0]) ?? [];
      list.push({ id, input, output: value[1] });
      consumers.set(value[0], list);
    }
  }
  const outputs = (id: string): Array<{ name: string; type: string }> => {
    const def = catalog[graph[id]?.class_type ?? ""];
    return def ? nodeOutputs(def) : [];
  };
  const taken = (id: string, types: readonly string[]): Array<{ id: string; input: string }> =>
    (consumers.get(id) ?? []).filter((consumer) => types.includes(outputs(id)[consumer.output]?.type ?? ""));
  return (start) => {
    const encoders: string[] = [];
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (outputs(id).some((output) => output.type === "CONDITIONING")) encoders.push(id);
      else for (const consumer of taken(id, ["STRING", "*"])) stack.push(consumer.id);
    }
    if (encoders.length === 0) return null;
    const negative = encoders.every((id) => {
      const users = taken(id, ["CONDITIONING"]);
      return users.length > 0 && users.every((user) => /neg/i.test(user.input));
    });
    return negative ? "negative" : "prompt";
  };
}

interface ClassifiedInput {
  group: string;
  id: string;
  input: string;
  value: unknown;
  /** A text that becomes conditioning: what the picture is made from, not a pattern or an expression. */
  conditioning: boolean;
}

/** The plain-valued inputs of the nodes that run (and of the switches' chosen branches), by what they are for. */
function classifiedInputs(graph: ApiGraph, catalog: NodeCatalog): ClassifiedInput[] {
  const running = new Set(Object.keys(runnableGraph(graph, catalog).graph));
  const sideOf = conditioningSides(graph, catalog);
  const found: ClassifiedInput[] = [];
  for (const id of orderedIds(graph)) {
    const node = graph[id]!;
    const def = catalog[node.class_type];
    if (!def) continue;
    const isSwitch = typeof node.inputs["switch"] === "boolean";
    if (!running.has(id) && !isSwitch) continue;
    for (const input of nodeInputs(def, node.inputs)) {
      const value = node.inputs[input.name];
      if (value === undefined || isLink(value)) continue;
      const add = (group: string): number => found.push({ group, id, input: input.name, value, conditioning: false });
      const addText = (): void => {
        const side = sideOf(id);
        found.push({ group: /neg/i.test(input.name) || side === "negative" ? "negative prompt" : "prompt", id, input: input.name, value, conditioning: side !== null });
      };
      if (isSwitch) {
        if (input.name === (node.inputs["switch"] ? "on_true" : "on_false") && typeof value === "string") addText();
        continue;
      }
      if (input.config["control_after_generate"]) add("seed");
      else if (input.config["image_upload"]) add("pictures (comfyui_run images)");
      else if (typeof value === "string" && MODEL_FILE.test(value)) add("model files");
      else if (input.type === "STRING" && input.config["multiline"]) addText();
      else if (SETTING_NAMES.has(input.name)) add("settings");
    }
  }
  return found;
}

/**
 * Writes the picture's prompt where the workflow keeps it: its one text that becomes positive
 * conditioning. A template's prompt sits wherever its authors put it, and a model that has not
 * read the template cannot know where. In 7 of 17 lab runs the image_creator went on to place
 * the prompt by editing the workflow file, guessing at the text to replace, and most of those
 * runs ended without a picture. Returns the address written.
 */
export function setPrompt(graph: ApiGraph, catalog: NodeCatalog, text: string): string {
  const places = classifiedInputs(graph, catalog).filter((entry) => entry.group === "prompt" && entry.conditioning);
  const [place] = places;
  if (!place) throw new GraphOperationError("prompt: this workflow has no prompt to set: none of its texts becomes conditioning");
  if (places.length > 1) {
    throw new GraphOperationError(`prompt: this workflow has several prompt texts (${places.map((entry) => `${entry.id}.${entry.input}`).join(", ")}): write the ones meant with set`);
  }
  graph[place.id]!.inputs[place.input] = text;
  return `${place.id}.${place.input}`;
}

function textMark(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * Marks the prompt texts a template arrives with. A template renders its authors' example until
 * its prompt is changed, and ComfyUI reports that run as a success like any other: the lab's
 * image_creator asked for a cat on a sofa, never reached the prompt, and handed over the official
 * template's fashion portrait as the result. The mark is a hash on the node, so it holds however
 * the text is changed later: by an operation, for one run, or by editing the file.
 */
export function markSamplePrompts(graph: ApiGraph, catalog: NodeCatalog): void {
  for (const { group, id, input, value, conditioning } of classifiedInputs(graph, catalog)) {
    if (group !== "prompt" || !conditioning || typeof value !== "string" || !value.trim()) continue;
    const node = graph[id]!;
    node._meta = { ...(node._meta ?? {}), sample: { ...(node._meta?.sample ?? {}), [input]: textMark(value) } };
  }
}

/**
 * The prompt inputs still holding a template's sample text, when no prompt of the workflow says
 * anything else. A prompt here is a text that becomes positive conditioning (conditioningSides).
 * One such text that is not a sample means the prompt was dealt with: a template may keep a text
 * of its own beside it (a system prompt, a style suffix), and a prompt written straight onto the
 * text encoder leaves the template's switch holding a sample nothing reads any more.
 */
export function unchangedSamplePrompts(graph: ApiGraph, catalog: NodeCatalog): Array<{ address: string; text: string }> {
  const samples: Array<{ address: string; text: string }> = [];
  for (const { group, id, input, value, conditioning } of classifiedInputs(graph, catalog)) {
    if (group !== "prompt" || !conditioning || typeof value !== "string" || !value.trim()) continue;
    if (graph[id]!._meta?.sample?.[input] !== textMark(value)) return [];
    samples.push({ address: `${id}.${input}`, text: value });
  }
  return samples;
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
