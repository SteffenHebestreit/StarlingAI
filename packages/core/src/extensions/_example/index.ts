/**
 * Reference extension — the smallest useful manifest exercising every SDK
 * surface. Dormant in production (the loader skips `_`-prefixed directories);
 * the extension-sdk test suite loads it explicitly to keep it green.
 *
 * To start a real extension: copy this directory to `../<your-name>/`, set
 * `name` to match the directory, and delete what you don't need.
 */
import { defineCoreExtension, ToolTier } from "../../extension/index.js";

export default defineCoreExtension({
  name: "example",
  version: "1.0.0",
  description: "Reference extension demonstrating the Core Extension SDK",

  tools: [
    {
      name: "example_echo",
      description: "Echo the given text back (reference extension tool)",
      tier: ToolTier.ZERO_READ_ONLY,
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
      async execute(args) {
        return { success: true, output: String(args["text"] ?? "") };
      },
    },
  ],

  auditEvents: ["echo_called"],

  roles: [
    {
      name: "example-auditor",
      description: "Reference role — read-only audit access",
      rank: 10,
      badge: { label: "Auditor", color: "amber" },
    },
  ],

  guardrails: {
    checkOutput(output) {
      // Demonstrates a rewriting output hook: pseudonymize a fake marker.
      const redacted = output.replaceAll("EXAMPLE-SECRET", "[example-redacted]");
      return { allowed: true, ...(redacted !== output ? { redacted } : {}) };
    },
  },

  registerRoutes(app, ctx) {
    app.get(`/api/${ctx.name}/ping`, ((c: { json: (v: unknown) => unknown }) => c.json({ pong: true })) as never);
  },

  configSchema: {
    // Zod-compatible by duck-type; a real extension would use z.object({...}).
    parse(value: unknown) {
      return value ?? {};
    },
  },

  async boot(ctx) {
    ctx.log.debug({ config: ctx.config }, "example extension booted");
  },
});
