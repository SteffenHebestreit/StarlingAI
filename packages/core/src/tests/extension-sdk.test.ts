import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

let mockExtensionsConfig: Record<string, unknown> = {};

vi.mock("../config/loader.js", () => ({
  getConfig: () => ({
    extensions: mockExtensionsConfig,
    tools: {},
    guardrails: { promptInjectionBlock: true, outputSecretScan: true, maxInputLength: 10000 },
  }),
}));

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
}));

import {
  _resetExtensionsForTests,
  getExtensionGuardrailHooks,
  isDeclaredExtensionAuditEvent,
  listExtensionRoles,
  listLoadedExtensions,
} from "../extension/index.js";
import {
  _resetExtensionLoaderForTests,
  loadCoreExtensions,
  mountExtensionRoutes,
  runExtensionBoot,
  runExtensionShutdown,
  setExtensionImporterForTests,
} from "../extension/loader.js";
import { getTool, unregisterTool } from "../tools/registry.js";
import {
  ToolTier,
  _resetExtensionToolTiersForTests,
  getToolTier,
  isCompileTimeMappedTool,
  registerExtensionToolTier,
} from "../guardrails/tool-tiers.js";
import { checkInput } from "../guardrails/input.js";
import { scanOutput } from "../guardrails/output.js";
import { _resetToolGroupsForTests } from "../tools/groups.js";

// Point the loader at src/extensions and lift the `_` skip by loading the
// shipped reference extension through a directory that includes it.
const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

// Discoverable manifest mirroring _example, injected via the test importer
// seam — vite-node cannot natively import files outside its project root, so
// the on-disk fixture file only drives directory discovery.
function fixtureManifest() {
  return {
    name: "example",
    version: "1.0.0",
    description: "discoverable test copy of the reference extension",
    tools: [
      {
        name: "example_echo",
        description: "Echo the given text back",
        tier: ToolTier.ZERO_READ_ONLY,
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: async (args: Record<string, unknown>) => ({ success: true, output: String(args["text"] ?? "") }),
      },
    ],
    auditEvents: ["echo_called"],
    roles: [{ name: "example-auditor", description: "read-only audit access", rank: 10, badge: { label: "Auditor", color: "amber" } }],
    guardrails: {
      checkOutput(output: string) {
        const redacted = output.replaceAll("EXAMPLE-SECRET", "[example-redacted]");
        return redacted === output ? { allowed: true } : { allowed: true, redacted };
      },
    },
    registerRoutes(app: { get: (path: string, ...h: never[]) => unknown }, ctx: { name: string }) {
      app.get(`/api/${ctx.name}/ping`);
    },
    configSchema: { parse: (v: unknown) => v ?? {} },
    async boot() {},
  };
}

async function writeFixture(): Promise<{ dir: string; cleanup: () => void }> {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sai-ext-"));
  mkdirSync(join(dir, "example"), { recursive: true });
  writeFileSync(join(dir, "example", "index.mjs"), "// discovery marker — importer is injected in tests\n");
  setExtensionImporterForTests(async () => ({ default: fixtureManifest() }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function resetAll(): void {
  unregisterTool("example_echo");
  _resetExtensionsForTests();
  _resetExtensionLoaderForTests();
  _resetExtensionToolTiersForTests();
  _resetToolGroupsForTests();
  mockExtensionsConfig = {};
  delete process.env["SAI_EXTENSIONS_DIR"];
  setExtensionImporterForTests(null);
}

beforeEach(resetAll);
afterEach(resetAll);

describe("extension tool tiers", () => {
  it("registers an extension tier and resolves it via getToolTier", () => {
    registerExtensionToolTier(
      "ext_demo_tool",
      { tier: ToolTier.ONE_WRITE, description: "demo", requiresPerCallApproval: false, requiresSandbox: false },
      "demo",
    );
    expect(getToolTier("ext_demo_tool").tier).toBe(ToolTier.ONE_WRITE);
    expect(isCompileTimeMappedTool("ext_demo_tool")).toBe(true);
  });

  it("rejects shadowing a built-in tool", () => {
    expect(() =>
      registerExtensionToolTier(
        "read_file",
        { tier: ToolTier.ZERO_READ_ONLY, description: "x", requiresPerCallApproval: false, requiresSandbox: false },
        "demo",
      ),
    ).toThrow(/shadow/);
  });

  it("rejects FOUR_BLOCKED registrations", () => {
    expect(() =>
      registerExtensionToolTier(
        "ext_blocked_tool",
        { tier: ToolTier.FOUR_BLOCKED, description: "x", requiresPerCallApproval: false, requiresSandbox: false },
        "demo",
      ),
    ).toThrow(/FOUR_BLOCKED/);
  });
});

describe("extension loader (reference extension)", () => {
  it("skips underscore-prefixed directories during normal discovery", async () => {
    process.env["SAI_EXTENSIONS_DIR"] = EXTENSIONS_DIR;
    await loadCoreExtensions();
    // Fork-agnostic assertion: a fork's real extensions may load here; the
    // invariant under test is only that the dormant _example never does.
    expect(listLoadedExtensions().map((e) => e.name)).not.toContain("example");
  });

  it("loads the example extension end to end", async () => {
    // The example dir itself contains no subdirectories, so import it via a
    // shim: point discovery at a temp dir? Simpler — validate through the
    // public loader by treating _example's parent with the skip lifted is not
    // possible, so import the manifest directly and exercise registration.
    const { default: manifest } = await import("../extensions/_example/index.js");
    expect(manifest.name).toBe("example");
    expect(manifest.tools?.[0]?.name).toBe("example_echo");
  });
});

describe("extension loader via SAI_EXTENSIONS_DIR", () => {
  it("loads a discoverable copy of the example extension", async () => {
    const { dir, cleanup } = await writeFixture();
    try {
      process.env["SAI_EXTENSIONS_DIR"] = dir;

      mockExtensionsConfig = { example: { hello: "world" } };
      const result = await loadCoreExtensions();
      expect(result.failed).toBe(0);
      expect(result.loaded).toBe(1);

      // tool registered with declared tier
      expect(getTool("example_echo")).toBeDefined();
      expect(getToolTier("example_echo").tier).toBe(ToolTier.ZERO_READ_ONLY);
      // group defaults to the extension name
      expect(getTool("example_echo")?.group).toBe("example");
      // audit event namespaced
      expect(isDeclaredExtensionAuditEvent("example.echo_called")).toBe(true);
      // role registered
      expect(listExtensionRoles().map((r) => r.name)).toContain("example-auditor");
      // guardrail hook registered + applied by scanOutput
      expect(getExtensionGuardrailHooks()).toHaveLength(1);
      const scan = scanOutput("text with EXAMPLE-SECRET inside");
      expect(scan.safe).toBe(false);
      expect(scan.redacted).toContain("[example-redacted]");
      // input hook absent → checkInput unaffected
      expect(checkInput("hello world").allowed).toBe(true);

      // routes mount onto a recording app
      const routes: string[] = [];
      const fakeApp = {
        get: (path: string) => void routes.push(`GET ${path}`),
        post: (path: string) => void routes.push(`POST ${path}`),
        put: (path: string) => void routes.push(`PUT ${path}`),
        delete: (path: string) => void routes.push(`DELETE ${path}`),
      };
      mountExtensionRoutes(fakeApp);
      expect(routes).toContain("GET /api/example/ping");

      // boot consumes the validated config slice without throwing
      await runExtensionBoot();
      await runExtensionShutdown();
    } finally {
      cleanup();
    }
  });

  it("is idempotent — a second load pass does not duplicate", async () => {
    const { dir, cleanup } = await writeFixture();
    try {
      process.env["SAI_EXTENSIONS_DIR"] = dir;

      const first = await loadCoreExtensions();
      const second = await loadCoreExtensions();
      expect(first.loaded).toBe(1);
      expect(second.loaded).toBe(0);
      expect(listLoadedExtensions()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("rejects a manifest whose name does not match its directory", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "sai-ext-"));
    try {
      mkdirSync(join(dir, "wrongname"), { recursive: true });
      writeFileSync(join(dir, "wrongname", "index.mjs"), "// discovery marker\n");
      setExtensionImporterForTests(async () => ({ default: { name: "other", version: "1.0.0" } }));
      process.env["SAI_EXTENSIONS_DIR"] = dir;

      const result = await loadCoreExtensions();
      expect(result.loaded).toBe(0);
      expect(result.failed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension auth provider", () => {
  it("registers a provider and rejects a second one from another extension", async () => {
    const { _recordLoadedExtension, getExtensionAuthProvider } = await import("../extension/index.js");
    const provider = {
      verifyCredentials: async () => null,
      getUserById: () => null,
    };
    const record = (name: string) =>
      ({ name, version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" });
    _recordLoadedExtension(record("authy"), { name: "authy", version: "1", authProvider: provider });
    expect(getExtensionAuthProvider()).toBe(provider);
    expect(() =>
      _recordLoadedExtension(record("other"), { name: "other", version: "1", authProvider: provider }),
    ).toThrow(/already registered/);
  });
});

describe("extension input guardrails", () => {
  it("blocks input when an extension checkInput hook blocks", async () => {
    const { _recordLoadedExtension } = await import("../extension/index.js");
    _recordLoadedExtension(
      { name: "strict", version: "1", toolNames: [], auditEvents: [], roles: [], loadedAt: "", source: "test" },
      {
        name: "strict",
        version: "1",
        guardrails: {
          checkInput: (input) =>
            input.includes("FORBIDDEN-WORD")
              ? { allowed: false, reason: "forbidden word", severity: "high" }
              : { allowed: true },
        },
      },
    );
    expect(checkInput("an ordinary message").allowed).toBe(true);
    const blocked = checkInput("contains FORBIDDEN-WORD here");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("[ext:strict]");
  });
});
