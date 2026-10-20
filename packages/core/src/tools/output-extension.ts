/**
 * The output path an artifact emitter writes, carrying the extension its format requires.
 *
 * Every emitter writes exactly one format, so a requested name with another extension can only be
 * a slip in the name: the file is that format either way. Refusing it cost the whole artifact
 * (harness-lab validation 2026-10-19: diagram_designer asked generate_mermaid_diagram for a .md
 * file, the tool refused, the agent did not retry, and its report said the file was saved). A
 * missing extension is added, another one is replaced, and the tool's result says which name it
 * wrote, so the agent and the person get the real path.
 */
import { extname } from "node:path";

export interface OutputName {
  path: string;
  /** The extension the request carried, when it was replaced. */
  replacedExtension?: string;
}

/** `requested` with `extension` (".mmd", ".svg", …) as its extension. */
export function withRequiredExtension(requested: string, extension: string): OutputName {
  const current = extname(requested);
  if (!current) return { path: `${requested}${extension}` };
  if (current.toLowerCase() === extension.toLowerCase()) return { path: requested };
  return { path: `${requested.slice(0, -current.length)}${extension}`, replacedExtension: current };
}

/** The sentence a tool's result adds when it replaced the requested extension, else "". */
export function extensionNote(name: OutputName, extension: string): string {
  return name.replacedExtension
    ? ` The requested name ended in ${name.replacedExtension}; this output is always ${extension}, so that is the file's name.`
    : "";
}
