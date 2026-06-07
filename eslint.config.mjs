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

      // ── Out of scope for this gate (tracked as follow-ups, not blocking) ──
      // eslint-10 added these to "recommended"; they are best-practice/style, not
      // the bug classes this gate targets, and fixing them en masse is churn.
      "preserve-caught-error": "off",       // adding { cause } everywhere — separate effort
      "no-useless-assignment": "warn",      // some real dead-stores; clean incrementally
      // Style-adjacent, not a runtime bug class. The autofixer declines these
      // (they sit in regex/string contexts where removing a backslash could
      // change matching), so hand-editing is risky — keep visible as warnings.
      "no-useless-escape": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "prefer-const": "warn",
    },
  },
);
