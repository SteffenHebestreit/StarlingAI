import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OidcRoleMappingSchema, SubAgentConfigSchema } from "../config/schema.js";
import { EffortSchema } from "../config/schemas/effort.js";
import { partialWithoutDefaults } from "../config/partial-schema.js";
import { mergeOrchestrationConfigUpdate } from "../gateway/orchestration-config-merge.js";

/**
 * Where zod 4 reads a schema differently from zod 3, and the config must not change with it. Found by
 * parsing the schemas' defaults and the deployment's compiled config under both majors: zod 4 runs a
 * default inside .partial() and inside .optional(), and reads a record keyed by an enum as holding
 * every key. Each case below is a value zod 3 produced and the code depends on.
 */
describe("an overlay names only what it changes", () => {
  it("a sub-agent's model block keeps the keys it sets, so agents.defaults.model fills the rest", () => {
    // Under a bare .partial() it came back with primary, contextWindow and enableThinking defaults,
    // which overrode the deployment's own default model for every agent that set one key.
    const agent = SubAgentConfigSchema.parse({ description: "d", systemPrompt: "s", model: { primary: "lmstudio/qwen" } });
    expect(agent.model).toEqual({ primary: "lmstudio/qwen" });
  });

  it("an orchestration update stores what it sent over what was stored, and no defaults", () => {
    const update = mergeOrchestrationConfigUpdate({ planFirst: false }, { maxParallelSlices: 4 });
    expect(update.ok).toBe(true);
    if (update.ok) expect(update.stored).toEqual({ planFirst: false, maxParallelSlices: 4 });
  });

  it("partialWithoutDefaults still reads a key it is sent through that key's schema", () => {
    const schema = z.object({ count: z.number().int().min(1).default(3), label: z.string().prefault("x") }).strict();
    const partial = partialWithoutDefaults(schema);
    expect(partial.parse({})).toEqual({});
    expect(partial.parse({ count: 2 })).toEqual({ count: 2 });
    expect(partial.safeParse({ count: 0 }).success).toBe(false);
    // The object's unknown-key policy holds.
    expect(partial.safeParse({ other: 1 }).success).toBe(false);
  });
});

describe("an optional field whose schema has a default stays unset", () => {
  it("an OIDC role mapping without defaultRole leaves it to the gateway's fallback", () => {
    expect(OidcRoleMappingSchema.parse({}).defaultRole).toBeUndefined();
    expect(OidcRoleMappingSchema.parse({ defaultRole: "viewer" }).defaultRole).toBe("viewer");
  });
});

describe("a record keyed by an enum holds the keys it is given", () => {
  it("effort profiles may override one tier", () => {
    const effort = EffortSchema.parse({ profiles: { high: {} } });
    expect(Object.keys(effort.profiles)).toEqual(["high"]);
    expect(EffortSchema.parse({}).profiles).toEqual({});
  });
});
