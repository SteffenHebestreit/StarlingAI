# StarlingAI Plugin SDK

Third-party tool packages loaded from a directory at gateway startup. Each
plugin exposes one or more tools that join the live registry under a
`plugin__<plugin-name>__<tool-name>` namespace.

## Author a plugin

```js
// ~/.starlingai/plugins/csv-utilities/index.mjs
import { definePlugin, defineTool } from "@starlingai/core/plugin";

export default definePlugin({
  name: "csv-utilities",
  version: "1.0.0",
  description: "CSV parse + transform helpers",
  author: "ACME Corp",
  tools: [
    defineTool({
      name: "parse_csv",
      description: "Parse a CSV string into JSON rows",
      parameters: {
        type: "object",
        properties: { csv: { type: "string" } },
        required: ["csv"],
      },
      async execute(args) {
        const rows = (args.csv ?? "").split(/\r?\n/).filter(Boolean);
        return { success: true, output: JSON.stringify(rows) };
      },
    }),
  ],
});
```

The `defineTool` and `definePlugin` helpers are identity functions — they
exist for IDE completion + type-checking and don't add runtime behavior.

## Naming rules

- **Plugin name**: `^[a-z][a-z0-9_-]{1,32}$`. Used as the registry namespace.
- **Tool name**: `^[a-z][a-z0-9_]{1,48}$`. Bare names that match a built-in
  tool (e.g. `read_file`, `web_search`) are rejected at load time and emit a
  `tier_escalation_attempt` audit event.
- **Name must match the basename**: the plugin `name` must exactly equal its
  directory name (or single-file basename). A mismatch is rejected at load with
  a `plugin_tool_rejected` audit event.

## Tier policy

All plugin tools register at **Tier 2** — per-call approval. Plugin code runs
**in-process** with no sandbox isolation (`requiresSandbox` is false); the
per-call operator approval is the containment, not process/container isolation.
The plugin author can't override this. If a tool needs higher privileges, it
cannot be a plugin: it must ship as a first-party tool with explicit tier
mapping in `tool-tiers.ts`.

## Where do plugins live?

The loader looks in (first match wins):

1. `STARLINGAI_PLUGINS_DIR` env var (absolute or cwd-relative)
2. `plugins.dir` in `starlingai.json`
3. `~/.starlingai/plugins/`

Each plugin is either:

- A directory `<plugin-name>/` containing `index.js`, `index.mjs`, or
  `plugin.js`, or
- A single file `<plugin-name>.js` / `<plugin-name>.mjs`

A broken plugin's load failure is logged + audited as
`plugin_tool_rejected` and does **not** abort the gateway; the next plugin
is tried.

## Hot-reload

The loader watches the plugins directory (500ms debounce). New plugin files are
picked up live (tools registered) and removed files are unregistered (emitting a
`plugin_unloaded` audit event) — no gateway restart needed. Editing an existing
file's code **in place** does require a gateway restart, because ESM modules are
cached once imported; adding a new file (e.g. bumping the directory name) is the
supported workflow for a live code change.

## Disabling plugins

```jsonc
// starlingai.json
{
  "plugins": { "enabled": false }
}
```

When disabled the loader is skipped entirely.

## Inspecting loaded plugins at runtime

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8765/api/plugins
```

Returns `{ enabled, directory, plugins: [{ name, version, toolNames, ... }] }`.
