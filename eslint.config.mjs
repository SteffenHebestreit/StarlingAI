// Flat ESLint config for the StarlingAI workspace.
//
// Scope (v1): production TypeScript in @starlingai/core and @starlingai/mail-service.
// The point of this gate is to catch the BUG classes that have repeatedly caused
// runtime regressions — unhandled/floating promises, promise misuse, and
// dead/leaked bindings — NOT to enforce style. Type-aware rules are enabled via
// typescript-eslint's project service. Tests and the Vue web package are
// intentionally out of scope for now (follow-ups); style/`any` churn is off.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "packages/web/**", // .vue needs vue-eslint-parser — separate follow-up
      "packages/core/src/tests/**", // prod code first; test lint is a follow-up
      "packages/mail-service/src/**/*.test.ts",
      "scripts/**",
      "**/*.cjs",
      "**/*.mjs",
      "**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/src/**/*.ts", "packages/mail-service/src/**/*.ts"],
    plugins: { "unused-imports": unusedImports },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── High-value BUG rules (the regression classes) → error ──
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],

      // Dead code: auto-remove unused imports (safe, mechanical via --fix); flag
      // unused locals/args as warnings (manual judgement, ^_ opt-out).
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["warn", {
        vars: "all",
        varsIgnorePattern: "^_",
        args: "after-used",
        argsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],

      // ── Warnings, and the gate runs at --max-warnings 0 ──────────────────
      // These were carried as non-blocking noise while the backlog stood at 53. It is
      // zero now, so a warning here fails the build exactly like an error; they stay
      // "warn" only because that is the severity their messages are written for.
      "preserve-caught-error": "off",       // adding { cause } everywhere — separate effort
      // Every one of the 17 was a defensive initializer the next statement always
      // overwrote. Each was removed by DELETING the initializer and letting TypeScript's
      // definite-assignment analysis prove the variable is written before it is read —
      // if tsc accepts it, the store really was dead.
      "no-useless-assignment": "warn",
      // Cleared via ESLint's own `removeEscape` suggestion, which is documented to
      // maintain current functionality — applied by exact source range rather than by
      // hand, so a backslash that matters in a regex was never at risk.
      "no-useless-escape": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "prefer-const": "warn",
    },
  },
);
