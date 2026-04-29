# StarlingAI Example Plugins

Drop any of these into your configured plugins directory (default
`~/.starlingai/plugins/`) and the gateway will auto-load them on startup.
With `plugins.enabled` true (the default), a file watcher also picks up
new plugins added at runtime — no gateway restart needed.

| Plugin | Tools | What it does |
|--------|-------|--------------|
| [`csv-utilities`](./csv-utilities/) | `parse_csv`, `csv_summary` | Parse CSV strings into JSON rows; summarize row count + per-column non-empty cell counts. |
| [`word-stats`](./word-stats/) | `readability` | Word/sentence counts + Flesch reading-ease score for a prose passage. |

After loading, tools register at the namespaced name
`plugin__<plugin-name>__<tool-name>` and run at Tier 2 (sandboxed,
per-call approval).  Plugins cannot self-elevate — see
`packages/core/src/plugin/README.md` in the StarlingAI repo for the
full author guide.

## Try them

```bash
# 1. Resolve where the gateway looks for plugins
curl -H "Authorization: Bearer $TOKEN" http://localhost:8765/api/plugins | jq -r .directory

# 2. Copy an example into that directory
cp -r examples/plugins/csv-utilities ~/.starlingai/plugins/

# 3. Refresh the dashboard's /plugins page (or restart the gateway).
#    The hot-reload watcher should also pick it up within a second.
```

Once loaded, a sub-agent that has the matching tool name in its
allowlist can call it like any built-in tool — for example:

```
parse_csv({ csv: "name,score\\nalice,42\\nbob,99" })
```

## Authoring your own

A plugin is a single ESM module that default-exports a `Plugin` object:

```js
export default {
  name: "your-plugin-name",       // ^[a-z][a-z0-9_-]{1,32}$
  version: "1.0.0",
  description: "What this plugin does.",
  author: "Your Name",
  tools: [
    {
      name: "your_tool",          // ^[a-z][a-z0-9_]{1,48}$
      description: "Used by the orchestrator to decide when to call your tool.",
      parameters: { type: "object", properties: { /* JSON Schema */ } },
      async execute(args, ctx) {
        return { success: true, output: "..." };
      },
    },
  ],
};
```

Optional helpers `defineTool` and `definePlugin` from
`@starlingai/core/plugin` are pure typing aids — they make IDE
completion + type-checking work but add no runtime behavior.

### Naming guard

Plugin tool names that match a built-in (e.g. `read_file`, `web_search`)
are rejected at load time with a `tier_escalation_attempt` audit event.
Pick names that don't collide.
