import { defineStore } from "pinia";
import { ref } from "vue";

export interface PaletteDef {
  id: string;
  label: string;
  description: string;
  /** Two CSS colors used to render the picker's swatch preview. */
  swatch: [string, string];
}

export interface TypefaceDef {
  id: string;
  label: string;
  description: string;
  /** Font stacks for the live in-menu preview (display / body / mono). */
  display: string;
  body: string;
  mono: string;
  /** Stylesheet URLs to inject on demand (empty = already loaded upfront). */
  hrefs: string[];
}

/**
 * Palettes correspond to the `[data-theme="…"]` blocks in style.css (each
 * overrides only the seed accent/orb/bg tokens). Default "nebula" is the
 * :root baseline. Add one by appending here + adding the CSS block.
 */
export const PALETTES: PaletteDef[] = [
  { id: "nebula",   label: "Nebula",   description: "Purple & pink — the signature look", swatch: ["#a855f7", "#ec4899"] },
  { id: "midnight", label: "Midnight", description: "Cool indigo & sky blue",             swatch: ["#6366f1", "#38bdf8"] },
  { id: "aurora",   label: "Aurora",   description: "Teal & violet, northern-lights",     swatch: ["#14b8a6", "#8b5cf6"] },
  { id: "ember",    label: "Ember",    description: "Warm crimson & amber",               swatch: ["#f43f5e", "#fb923c"] },
  { id: "graphite", label: "Graphite", description: "Muted slate, minimal glow",          swatch: ["#64748b", "#475569"] },
];

const GF = "https://fonts.googleapis.com/css2";

/**
 * Typeface SYSTEMS — each a curated display · body · mono trio (see the
 * `[data-typeface="…"]` blocks in style.css). `hrefs` are loaded lazily by the
 * store so only the default "clean" trio ships on first paint. Add one by
 * appending here + adding the CSS block.
 */
export const TYPEFACES: TypefaceDef[] = [
  {
    id: "clean", label: "Clean", description: "Inter · Inter · JetBrains Mono",
    display: '"Inter", sans-serif', body: '"Inter", sans-serif', mono: '"JetBrains Mono", monospace',
    hrefs: [], // bundled in the base @import
  },
  {
    id: "editorial", label: "Editorial", description: "Fraunces · Inter · IBM Plex Mono",
    display: '"Fraunces", Georgia, serif', body: '"Inter", sans-serif', mono: '"IBM Plex Mono", monospace',
    hrefs: [`${GF}?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap`],
  },
  {
    id: "geometric", label: "Geometric", description: "Space Grotesk · Inter · Space Mono",
    display: '"Space Grotesk", sans-serif', body: '"Inter", sans-serif', mono: '"Space Mono", monospace',
    hrefs: [`${GF}?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap`],
  },
  {
    id: "studio", label: "Studio", description: "Clash Display · Satoshi · JetBrains Mono",
    display: '"Clash Display", sans-serif', body: '"Satoshi", sans-serif', mono: '"JetBrains Mono", monospace',
    hrefs: ["https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=satoshi@400,500,700&display=swap"],
  },
  {
    id: "technical", label: "Technical", description: "Geist · Geist · Geist Mono",
    display: '"Geist", sans-serif', body: '"Geist", sans-serif', mono: '"Geist Mono", monospace',
    hrefs: [`${GF}?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap`],
  },
  {
    id: "plex", label: "Plex", description: "IBM Plex Serif · Sans · Mono",
    display: '"IBM Plex Serif", serif', body: '"IBM Plex Sans", sans-serif', mono: '"IBM Plex Mono", monospace',
    hrefs: [`${GF}?family=IBM+Plex+Serif:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap`],
  },
];

export interface PresetDef {
  id: string;
  label: string;
  description: string;
  palette: string;
  typeface: string;
}

/**
 * Presets are curated palette × typeface combinations — one-tap "designs" over
 * the two independent axes, so the menu offers finished looks as well as fine
 * control. Each references a palette id + a typeface id defined above.
 */
export const PRESETS: PresetDef[] = [
  { id: "signature", label: "Signature", description: "Nebula · Clean",        palette: "nebula",   typeface: "clean" },
  { id: "magazine",  label: "Magazine",  description: "Ember · Editorial",     palette: "ember",    typeface: "editorial" },
  { id: "terminal",  label: "Terminal",  description: "Graphite · Technical",  palette: "graphite", typeface: "technical" },
  { id: "blueprint", label: "Blueprint", description: "Midnight · Geometric",  palette: "midnight", typeface: "geometric" },
  { id: "lab",       label: "Lab",       description: "Midnight · Plex",       palette: "midnight", typeface: "plex" },
  { id: "studio",    label: "Studio",    description: "Aurora · Studio",       palette: "aurora",   typeface: "studio" },
];

const PALETTE_KEY = "starlingai.theme";
const TYPEFACE_KEY = "starlingai.typeface";
const DEFAULT_PALETTE = "nebula";
const DEFAULT_TYPEFACE = "clean";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / blocked storage */ }
}

// Inject a <link rel="stylesheet"> for a font CSS once (idempotent).
const loadedHrefs = new Set<string>();
function loadHref(href: string): void {
  if (loadedHrefs.has(href)) return;
  loadedHrefs.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export const useThemeStore = defineStore("theme", () => {
  const palette = ref<string>(DEFAULT_PALETTE);
  const typeface = ref<string>(DEFAULT_TYPEFACE);

  function applyPalette(id: string): void {
    const valid = PALETTES.some((p) => p.id === id) ? id : DEFAULT_PALETTE;
    palette.value = valid;
    document.documentElement.dataset.theme = valid;
    write(PALETTE_KEY, valid);
  }

  /** Ensure the fonts for one typeface are loaded (no-op for "clean"). */
  function ensureFonts(id: string): void {
    TYPEFACES.find((t) => t.id === id)?.hrefs.forEach(loadHref);
  }
  /** Preload every typeface's fonts — called when the picker opens so the
      in-menu previews render in their real faces. */
  function ensureAllFonts(): void {
    TYPEFACES.forEach((t) => t.hrefs.forEach(loadHref));
  }

  function applyTypeface(id: string): void {
    const valid = TYPEFACES.some((t) => t.id === id) ? id : DEFAULT_TYPEFACE;
    ensureFonts(valid);
    typeface.value = valid;
    document.documentElement.dataset.typeface = valid;
    write(TYPEFACE_KEY, valid);
  }

  /** Apply a curated preset (sets both palette and typeface at once). */
  function applyPreset(id: string): void {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    applyPalette(preset.palette);
    applyTypeface(preset.typeface);
  }

  /** Apply both persisted choices. Call once at app start (before mount). */
  function init(): void {
    applyPalette(read(PALETTE_KEY) ?? DEFAULT_PALETTE);
    applyTypeface(read(TYPEFACE_KEY) ?? DEFAULT_TYPEFACE);
  }

  return {
    palette, typeface, palettes: PALETTES, typefaces: TYPEFACES, presets: PRESETS,
    applyPalette, applyTypeface, applyPreset, ensureAllFonts, init,
  };
});
