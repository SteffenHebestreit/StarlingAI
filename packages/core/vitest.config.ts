import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Redirects the default audit-log destination to a temp dir so unisolated
    // tests stop appending to the repo's own .starlingai/audit.jsonl.
    setupFiles: ["src/tests/vitest.setup.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    minWorkers: 1,
    maxWorkers: 1,
    // Keep tests in-process by default. Many tests mock the LLM provider and
    // expect runSubAgent to execute in the same process so the mock intercepts
    // the call. Production runs without this env var and gets the new
    // agents.defaultContainerized=true behavior.
    env: {
      STARLINGAI_DEFAULT_CONTAINERIZED: "false",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      include: ["src/**/*.ts"],
      // Excluded from the metric so the % reflects TESTABLE logic, not process
      // glue: tests; type decls; process entry points (bootstrap wiring, no
      // branching logic); CLI/eval scripts; and external-system adapters that
      // can't be exercised without the live remote (VNC/RDP/SSH/remote bridge).
      exclude: [
        "src/tests/**",
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/index.ts",
        "src/mcp-stdio.ts",
        "src/scene-worker-main.ts",
        "src/computer-remote-main.ts",
        "src/scripts/**",
        "src/agent/computer-adapters/**",
        "src/agent/computer-remote/**",
      ],
      // Regression ratchet: fail `test:coverage` if coverage drops below these
      // floors. Set a hair under the current actuals (lines/branches ~68.8%,
      // functions ~78.7%) so normal variation doesn't flake the gate, but a real
      // drop does. Raise these as coverage improves — never lower them.
      thresholds: {
        lines: 68,
        statements: 68,
        branches: 68,
        functions: 78,
      },
    },
  },
});
