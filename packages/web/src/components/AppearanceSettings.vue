<template>
  <div class="space-y-5">
    <!-- ── Presets (curated palette × typeface designs) ───────────────────── -->
    <div>
      <div class="eyebrow mb-2">Presets</div>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <button
          v-for="preset in theme.presets"
          :key="preset.id"
          type="button"
          class="flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition"
          :class="preset.id === activePresetId
            ? 'border-purple-400/40 bg-purple-500/12'
            : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'"
          @click="theme.applyPreset(preset.id)"
        >
          <span
            class="h-5 w-5 shrink-0 rounded-full ring-1 ring-white/20"
            :style="{ background: `linear-gradient(135deg, ${presetSwatch(preset.palette)[0]}, ${presetSwatch(preset.palette)[1]})` }"
            aria-hidden="true"
          />
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium text-gray-100">{{ preset.label }}</span>
            <span class="block truncate text-[10px] uppercase tracking-wide text-gray-500">{{ preset.description }}</span>
          </span>
        </button>
      </div>
    </div>

    <!-- ── Palette ────────────────────────────────────────────────────────── -->
    <div>
      <div class="eyebrow mb-2">Palette</div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="p in theme.palettes"
          :key="p.id"
          type="button"
          :title="p.description"
          class="flex items-center gap-2 rounded-full border px-3 py-1.5 transition"
          :class="p.id === theme.palette
            ? 'border-purple-400/40 bg-purple-500/12 text-gray-100'
            : 'border-white/10 bg-white/[0.03] text-gray-300 hover:border-white/20 hover:bg-white/[0.06]'"
          @click="theme.applyPalette(p.id)"
        >
          <span
            class="h-4 w-4 rounded-full ring-1 ring-white/25"
            :style="{ background: `linear-gradient(135deg, ${p.swatch[0]}, ${p.swatch[1]})` }"
            aria-hidden="true"
          />
          <span class="text-sm">{{ p.label }}</span>
        </button>
      </div>
    </div>

    <!-- ── Typeface (display · body · mono systems) ───────────────────────── -->
    <div>
      <div class="eyebrow mb-2">Typeface</div>
      <div class="grid gap-2 sm:grid-cols-2">
        <button
          v-for="t in theme.typefaces"
          :key="t.id"
          type="button"
          class="flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition"
          :class="t.id === theme.typeface
            ? 'border-purple-400/40 bg-purple-500/12'
            : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'"
          @click="theme.applyTypeface(t.id)"
        >
          <span
            class="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-xl leading-none text-gray-100"
            :style="{ fontFamily: t.display }"
            aria-hidden="true"
          >Ag</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="text-sm font-semibold text-gray-100" :style="{ fontFamily: t.display }">{{ t.label }}</span>
              <svg v-if="t.id === theme.typeface" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5 text-purple-300">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <span class="mt-0.5 flex items-baseline gap-2" aria-hidden="true">
              <span class="text-[12px] text-gray-300" :style="{ fontFamily: t.body }">The quick brown fox</span>
              <span class="text-[10px] text-gray-500" :style="{ fontFamily: t.mono }">0x9f3</span>
            </span>
            <span class="block truncate text-[10px] text-gray-600">{{ t.description }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();

// A preset is "active" only while both axes still match it.
const activePresetId = computed(() =>
  theme.presets.find((p) => p.palette === theme.palette && p.typeface === theme.typeface)?.id ?? null);

function presetSwatch(paletteId: string): [string, string] {
  return theme.palettes.find((p) => p.id === paletteId)?.swatch ?? ["#a855f7", "#ec4899"];
}

// Load every typeface's fonts so the specimens render in their real faces.
onMounted(() => theme.ensureAllFonts());
</script>
