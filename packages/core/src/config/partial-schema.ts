import { z } from "zod";

type WithoutDefault<S> = S extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
  ? Inner
  : S extends z.ZodPrefault<infer Inner extends z.ZodTypeAny> ? Inner : S;
type ShapeWithoutDefaults<T extends z.ZodRawShape> = { [K in keyof T]: WithoutDefault<T[K]> };

/**
 * `schema.partial()` with the defaults taken out: a key the input leaves out stays out.
 *
 * For an input that names only what it changes and is laid over something else — a sub-agent's
 * model block over agents.defaults.model (runtime/model-endpoints.ts), a PUT body over the stored
 * orchestration section — a default must not stand in for a key it left out, or it overrides the
 * value underneath. zod 3's `.partial()` left the key out; zod 4's runs the default of an absent
 * optional field, so the same call would materialize every default. A key the input does send is
 * read through the field's own schema as before, and the object keeps its unknown-key policy.
 * A `.prefault()` (the zod 4 name for a default that is parsed, as zod 3's were) is taken out alike.
 */
export function partialWithoutDefaults<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field]),
  ) as ShapeWithoutDefaults<T>;
  return schema.extend(shape).partial();
}
