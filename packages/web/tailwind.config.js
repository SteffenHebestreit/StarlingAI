/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,ts,tsx}"],
  theme: {
    extend: {
      // The app's two accent families are remapped onto per-theme shade ramps
      // (--acc1-*/--acc2-* in style.css), so every existing purple/pink utility
      // (text-purple-400, bg-pink-500/12, border-purple-400/40, gradients …)
      // repaints when the palette changes — no template sweep required.
      colors: {
        purple: {
          50: "rgb(var(--acc1-50) / <alpha-value>)",
          100: "rgb(var(--acc1-100) / <alpha-value>)",
          200: "rgb(var(--acc1-200) / <alpha-value>)",
          300: "rgb(var(--acc1-300) / <alpha-value>)",
          400: "rgb(var(--acc1-400) / <alpha-value>)",
          500: "rgb(var(--acc1-500) / <alpha-value>)",
          600: "rgb(var(--acc1-600) / <alpha-value>)",
          700: "rgb(var(--acc1-700) / <alpha-value>)",
          800: "rgb(var(--acc1-800) / <alpha-value>)",
          900: "rgb(var(--acc1-900) / <alpha-value>)",
          950: "rgb(var(--acc1-950) / <alpha-value>)",
        },
        pink: {
          50: "rgb(var(--acc2-50) / <alpha-value>)",
          100: "rgb(var(--acc2-100) / <alpha-value>)",
          200: "rgb(var(--acc2-200) / <alpha-value>)",
          300: "rgb(var(--acc2-300) / <alpha-value>)",
          400: "rgb(var(--acc2-400) / <alpha-value>)",
          500: "rgb(var(--acc2-500) / <alpha-value>)",
          600: "rgb(var(--acc2-600) / <alpha-value>)",
          700: "rgb(var(--acc2-700) / <alpha-value>)",
          800: "rgb(var(--acc2-800) / <alpha-value>)",
          900: "rgb(var(--acc2-900) / <alpha-value>)",
          950: "rgb(var(--acc2-950) / <alpha-value>)",
        },
      },
      // Design-system tokens surfaced as utilities so pages can adopt the
      // refined-glass language incrementally (font-mono, shadow-glass,
      // rounded-card, …) instead of hand-rolling values. The source of truth
      // for the raw values lives in style.css `:root`.
      // Driven by the role tokens in style.css so the typeface picker repaints
      // every font-sans / font-mono / font-display utility app-wide.
      fontFamily: {
        sans: ["var(--font-body)"],
        display: ["var(--font-display)"],
        mono: ["var(--font-mono)"],
        label: ["var(--font-label)"],
      },
      borderRadius: {
        card: "var(--radius-md)",
        "card-lg": "var(--radius-lg)",
        xl2: "var(--radius-xl)",
      },
      boxShadow: {
        "glass-sm": "var(--shadow-1)",
        glass: "var(--shadow-2)",
        "glass-lg": "var(--shadow-3)",
        glow: "var(--glow-accent)",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
