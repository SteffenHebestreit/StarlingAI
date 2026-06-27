// Single source of truth (build side) for workspace zones that hold WORKING
// DATA, not configuration. Mirrors NON_CONFIG_WORKSPACE_ZONES in
// packages/core/src/tools/workspace-path.ts — keep the two in sync.
//
// SECURITY: both the runtime config-shard loader and `sai config build` must
// skip these top-level zones when sweeping the workspace for .json/.jsonc
// shards. Otherwise an agent-written generated/data.json (or a malicious upload,
// or a dynamic-tool bundle) with a top-level key like "agents" would merge
// straight into the live/compiled config. The loader already skips them; the
// build script must too, so it can never emit a starlingai.json the loader would
// then refuse to load.
export const NON_CONFIG_WORKSPACE_ZONES = Object.freeze(["generated", "uploads", "tools"]);
