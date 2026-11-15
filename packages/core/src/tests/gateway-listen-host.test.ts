/**
 * gateway.host: the address the gateway and the maintenance boot bind.
 *
 * Both used to call listen(port, "0.0.0.0"), so a run outside Docker (`pnpm sai dev gateway`, and
 * every gateway test) was reachable from the whole network. The default is loopback now; the
 * gateway image sets SAI_GATEWAY_HOST=0.0.0.0, where the port publish and the web container need
 * it. What a server asks listen() for is read off a spy: the suite's listen guard
 * (vitest.setup.ts) moves a bind to every interface onto loopback before it reaches the network,
 * so the requested address is the thing to assert, not the bound one.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewaySchema } from "../config/schema.js";
import { formatListenAddress, gatewayListenHost } from "../gateway/listen-address.js";
import { PRODUCT } from "../product/index.js";

const ENV_KEYS = ["SAI_CONFIG_PATH", "SAI_JWT_SECRET", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_AUDIT_LOG", "SAI_GATEWAY_HOST"];
const tempDirs: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A config file with this gateway block, loaded fresh. */
async function configure(gateway: Record<string, unknown>) {
  const tempDir = mkdtempSync(join(tmpdir(), "sai-listen-host-"));
  tempDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "h".repeat(40), ...gateway } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, PRODUCT.stateDirName, "audit.jsonl");
  vi.resetModules();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  return loader;
}

/** The host each listen() call asked for, while the guard still binds it to loopback. */
function recordListenHosts(): string[] {
  const hosts: string[] = [];
  const original = net.Server.prototype.listen;
  vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
    if (typeof args[0] === "number") hosts.push(typeof args[1] === "string" ? args[1] : "<none>");
    return (original as (...listenArgs: unknown[]) => net.Server).apply(this, args);
  } as typeof net.Server.prototype.listen);
  return hosts;
}

describe("gateway.host", () => {
  it("defaults to loopback, never to every interface", () => {
    expect(GatewaySchema.parse({}).host).toBe("127.0.0.1");
    expect(gatewayListenHost({})).toBe("127.0.0.1");
    expect(gatewayListenHost({ host: "  " })).toBe("127.0.0.1");
    expect(gatewayListenHost({ host: "192.168.1.20" })).toBe("192.168.1.20");
  });

  it("brackets an IPv6 literal in the address it logs", () => {
    expect(formatListenAddress("127.0.0.1", 8765)).toBe("127.0.0.1:8765");
    expect(formatListenAddress("::1", 8765)).toBe("[::1]:8765");
  });

  it("is overridden by SAI_GATEWAY_HOST, as the gateway image sets it", async () => {
    const loader = await configure({ host: "127.0.0.1" });
    process.env["SAI_GATEWAY_HOST"] = " 0.0.0.0 ";
    expect(loader.loadConfig({ skipCompiledWrite: true }).gateway.host).toBe("0.0.0.0");
  });

  it("is what the gateway binds by default: loopback", async () => {
    const port = await freePort();
    await configure({ port });
    const hosts = recordListenHosts();
    const { createGateway } = await import("../gateway/index.js");
    const gateway = createGateway();
    await gateway.start();
    try {
      expect(hosts).toEqual(["127.0.0.1"]);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it("is what the gateway binds when the image sets it", async () => {
    const port = await freePort();
    await configure({ port });
    process.env["SAI_GATEWAY_HOST"] = "0.0.0.0";
    const hosts = recordListenHosts();
    const { createGateway } = await import("../gateway/index.js");
    const gateway = createGateway();
    await gateway.start();
    try {
      // Asked for every interface; the suite's listen guard bound it to loopback.
      expect(hosts).toEqual(["0.0.0.0"]);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it("is what the maintenance boot binds by default: loopback", async () => {
    const port = await freePort();
    await configure({ port });
    const hosts = recordListenHosts();
    const { createMaintenanceGateway } = await import("../gateway/maintenance-gateway.js");
    const gateway = createMaintenanceGateway();
    await gateway.start();
    try {
      expect(hosts).toEqual(["127.0.0.1"]);
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it("is what the maintenance boot binds when the image sets it", async () => {
    // Under Docker the maintenance boot is the gateway container restarted with
    // SAI_MAINTENANCE=account-migration: bound to the container's loopback, it would be out of
    // reach of the port publish, and `sai migrate-account-ids --apply` could not connect.
    const port = await freePort();
    await configure({ port });
    process.env["SAI_GATEWAY_HOST"] = "0.0.0.0";
    const hosts = recordListenHosts();
    const { createMaintenanceGateway } = await import("../gateway/maintenance-gateway.js");
    const gateway = createMaintenanceGateway();
    await gateway.start();
    try {
      // Asked for every interface; the suite's listen guard bound it to loopback.
      expect(hosts).toEqual(["0.0.0.0"]);
    } finally {
      await gateway.stop();
    }
  }, 60_000);
});
