/**
 * The artifact text preview, alone in a module with no side effects.
 *
 * Two callers need it and they must produce byte-identical previews: `write_file` snapshots
 * one into its metadata at write time, and the sub-agent runner refreshes that snapshot from
 * disk when a run ends (a staged build fills its skeleton with edit_file, which records no
 * artifact at all, so the write-time snapshot otherwise describes scaffolding forever).
 *
 * It lives here rather than in tools/filesystem.ts because that module REGISTERS tools as an
 * import side effect. Importing it from the runner would pull the real read_file/write_file
 * registrations into every graph that loads the runner, silently replacing any fake a caller
 * had registered first.
 */
export function buildArtifactTextPreview(content: string): string | undefined {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 1_200 ? `${compact.slice(0, 1_197)}...` : compact;
}
