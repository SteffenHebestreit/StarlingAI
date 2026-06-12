/**
 * Product identity — the single source of truth for every branding /
 * filesystem-identity string in the platform: product name, state-directory
 * name (`.starlingai`), config file name (`starlingai.json`), env-var prefix
 * (`STARLINGAI`), and web theme hints.
 *
 * Forks specialize by committing a `product.json` at the repo root — a file
 * upstream deliberately does NOT ship, so it never conflicts on rebase:
 *
 *   // product.json
 *   {
 *     "name": "MFA-AI",
 *     "slug": "mfa-ai",
 *     "tagline": "Medizinische Fachangestellte",
 *     "stateDirName": ".mfa-ai",
 *     "configFileName": "mfa-ai.json",
 *     "envPrefix": "MFA_AI",
 *     "legacyStateDirNames": [".starlingai"],
 *     "legacyEnvPrefixes": ["STARLINGAI"]
 *   }
 *
 * Resolution order for the file: `SAI_PRODUCT_FILE` env var → `<cwd>/product.json`
 * → `<repo root>/product.json` (located relative to this module). Missing file
 * or missing fields fall back to the StarlingAI defaults, so upstream behaves
 * exactly as before this module existed.
 *
 * IMPORTANT: this module must stay dependency-free (no logger/config imports) —
 * it is imported by the config loader and the logger themselves.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProductTheme {
  /** Tailwind-ish accent color family used by the web shell (e.g. "cyan", "sky"). */
  accent?: string;
  /** Optional logo path served by the web app (defaults to the bundled logo). */
  logo?: string;
}

export interface ProductIdentity {
  /** Display name ("StarlingAI"). */
  name: string;
  /** Lowercase machine id ("starlingai") — used in package-ish contexts. */
  slug: string;
  /** Short subtitle shown under the name in the web shell. */
  tagline: string;
  /** Dot-directory for per-user / per-workspace state (".starlingai"). */
  stateDirName: string;
  /** Root config file name ("starlingai.json"). */
  configFileName: string;
  /** Example config file name shipped in the repo ("starlingai.example.json"). */
  exampleConfigFileName: string;
  /** Env-var prefix for product-scoped variables ("STARLINGAI" → STARLINGAI_PLUGINS_DIR). */
  envPrefix: string;
  /** Previous state-dir names honored as read fallbacks after a fork rename. */
  legacyStateDirNames: string[];
  /** Previous env prefixes honored as fallbacks after a fork rename. */
  legacyEnvPrefixes: string[];
  /** Web shell theme hints (served via GET /api/product). */
  theme: ProductTheme;
}

const STARLINGAI_DEFAULTS: ProductIdentity = Object.freeze({
  name: "StarlingAI",
  slug: "starlingai",
  tagline: "Guarded Agent Swarm",
  stateDirName: ".starlingai",
  configFileName: "starlingai.json",
  exampleConfigFileName: "starlingai.example.json",
  envPrefix: "STARLINGAI",
  legacyStateDirNames: [],
  legacyEnvPrefixes: [],
  theme: Object.freeze({ accent: "cyan" }),
});

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;
const STATE_DIR_RE = /^\.[a-z][a-z0-9._-]{1,40}$/;
const ENV_PREFIX_RE = /^[A-Z][A-Z0-9_]{1,30}$/;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && Boolean(v.trim()));
  return out.length === value.length ? out : undefined;
}

/** Locate product.json. Exported for diagnostics (`/api/product` reports the source). */
export function resolveProductFile(): string | null {
  const fromEnv = process.env["SAI_PRODUCT_FILE"];
  if (fromEnv?.trim()) {
    const p = isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
    if (existsSync(p)) return p;
    // An explicitly configured file that doesn't exist is a setup error worth surfacing.
    console.warn(`[product] SAI_PRODUCT_FILE points at missing file: ${p} — using defaults`);
    return null;
  }
  const cwdFile = resolve(process.cwd(), "product.json");
  if (existsSync(cwdFile)) return cwdFile;
  // <repo>/packages/core/{src|dist}/product/index → four levels up is the repo root.
  const repoRootFile = fileURLToPath(new URL("../../../../product.json", import.meta.url));
  if (existsSync(repoRootFile)) return repoRootFile;
  return null;
}

function loadProduct(): ProductIdentity {
  const file = resolveProductFile();
  if (!file) return { ...STARLINGAI_DEFAULTS, theme: { ...STARLINGAI_DEFAULTS.theme } };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[product] Failed to parse ${file}: ${String(err)} — using defaults`);
    return { ...STARLINGAI_DEFAULTS, theme: { ...STARLINGAI_DEFAULTS.theme } };
  }

  const slug = str(raw["slug"]);
  const stateDirName = str(raw["stateDirName"]);
  const envPrefix = str(raw["envPrefix"]);
  const reject = (field: string, value: string, re: RegExp) => {
    console.warn(`[product] ${file}: invalid ${field} ${JSON.stringify(value)} (must match ${re}) — field ignored`);
    return undefined;
  };

  const theme = (typeof raw["theme"] === "object" && raw["theme"] !== null ? raw["theme"] : {}) as Record<string, unknown>;

  return {
    name: str(raw["name"]) ?? STARLINGAI_DEFAULTS.name,
    slug: (slug && (SLUG_RE.test(slug) ? slug : reject("slug", slug, SLUG_RE))) ?? STARLINGAI_DEFAULTS.slug,
    tagline: str(raw["tagline"]) ?? STARLINGAI_DEFAULTS.tagline,
    stateDirName:
      (stateDirName && (STATE_DIR_RE.test(stateDirName) ? stateDirName : reject("stateDirName", stateDirName, STATE_DIR_RE))) ??
      STARLINGAI_DEFAULTS.stateDirName,
    configFileName: str(raw["configFileName"]) ?? STARLINGAI_DEFAULTS.configFileName,
    exampleConfigFileName:
      str(raw["exampleConfigFileName"]) ??
      (str(raw["configFileName"])?.replace(/\.json$/, ".example.json") ?? STARLINGAI_DEFAULTS.exampleConfigFileName),
    envPrefix:
      (envPrefix && (ENV_PREFIX_RE.test(envPrefix) ? envPrefix : reject("envPrefix", envPrefix, ENV_PREFIX_RE))) ??
      STARLINGAI_DEFAULTS.envPrefix,
    legacyStateDirNames: strArray(raw["legacyStateDirNames"]) ?? STARLINGAI_DEFAULTS.legacyStateDirNames,
    legacyEnvPrefixes: strArray(raw["legacyEnvPrefixes"]) ?? STARLINGAI_DEFAULTS.legacyEnvPrefixes,
    theme: { accent: str(theme["accent"]) ?? STARLINGAI_DEFAULTS.theme.accent, logo: str(theme["logo"]) },
  };
}

/**
 * The resolved product identity. A live object: `reloadProduct()` (tests only)
 * mutates it in place so existing importers observe the change.
 */
export const PRODUCT: ProductIdentity = loadProduct();

/** Re-resolve product.json (after changing SAI_PRODUCT_FILE / cwd). Test hook. */
export function reloadProduct(): ProductIdentity {
  return Object.assign(PRODUCT, loadProduct());
}

/**
 * Read a product-prefixed env var: `productEnv("PLUGINS_DIR")` checks
 * `<PREFIX>_PLUGINS_DIR`, then each legacy prefix (so renamed forks keep
 * honoring `STARLINGAI_*` until users migrate).
 */
export function productEnv(suffix: string): string | undefined {
  for (const prefix of [PRODUCT.envPrefix, ...PRODUCT.legacyEnvPrefixes]) {
    const value = process.env[`${prefix}_${suffix}`];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** `~/.starlingai[/segments…]` under the current product's state-dir name. */
export function homeStateDir(...segments: string[]): string {
  return join(homedir(), PRODUCT.stateDirName, ...segments);
}

/** `<cwd>/.starlingai[/segments…]`. */
export function cwdStateDir(...segments: string[]): string {
  return resolve(process.cwd(), PRODUCT.stateDirName, ...segments);
}

/** `<base>/.starlingai[/segments…]` — for workspace- or repo-rooted state. */
export function stateDirUnder(base: string, ...segments: string[]): string {
  return resolve(base, PRODUCT.stateDirName, ...segments);
}

/**
 * Existing-path helper honoring legacy names: returns the first of
 * `<base>/<stateDirName>/<rel>`, then each `<base>/<legacyName>/<rel>` that
 * exists, else the canonical (non-legacy) path. Lets renamed forks keep
 * reading state written before the rename without migration scripts.
 */
export function existingStateFile(base: string, ...segments: string[]): string {
  const canonical = resolve(base, PRODUCT.stateDirName, ...segments);
  if (existsSync(canonical)) return canonical;
  for (const legacy of PRODUCT.legacyStateDirNames) {
    const candidate = resolve(base, legacy, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return canonical;
}
