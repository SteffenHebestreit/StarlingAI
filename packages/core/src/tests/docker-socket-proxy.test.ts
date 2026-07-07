/**
 * Filtering docker-socket proxy — filter + bind-policy unit tests.
 * Imports the proxy's pure logic (docker/docker-socket-proxy/*.mjs) directly.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, no types
import { isAllowedBindSource, parseAllowedPrefixes } from "../../../../docker/docker-socket-proxy/bind-policy.mjs";
import {
  normalizeApiPath, isCreateRoute, isPassRoute, isImagePullRoute, isAttachRoute,
  sanitizeCreateBody, sanitizeExecBody, splitBindEntry,
  parseRequestHead, buildRequestHead, headerValue,
  // @ts-expect-error — plain .mjs, no types
} from "../../../../docker/docker-socket-proxy/filter.mjs";

// The legit workspace source on this deployment (Docker Desktop translates F:\StarlingAI).
const PREFIXES = parseAllowedPrefixes("F:\\StarlingAI", "/run/desktop/mnt/host/f/StarlingAI");
const ok = (body: Record<string, unknown>) => sanitizeCreateBody(body, PREFIXES);
const denied = (body: Record<string, unknown>, re: RegExp) => expect(() => sanitizeCreateBody(body, PREFIXES)).toThrow(re);

describe("bind-policy.isAllowedBindSource", () => {
  it("allows named volumes and the workspace prefix (both raw + translated)", () => {
    expect(isAllowedBindSource("gc-workspace", PREFIXES)).toBe(true);
    expect(isAllowedBindSource("F:\\StarlingAI", PREFIXES)).toBe(true);
    expect(isAllowedBindSource("F:\\StarlingAI\\workspace\\agents", PREFIXES)).toBe(true);
    expect(isAllowedBindSource("/run/desktop/mnt/host/f/StarlingAI/generated/demo", PREFIXES)).toBe(true);
  });
  it("denies the socket, host root, system dirs, and out-of-workspace host paths", () => {
    for (const s of ["/var/run/docker.sock", "/", "/etc/shadow", "/root/.ssh", "/home/user/other", "/proc/1", "/dev/sda"]) {
      expect(isAllowedBindSource(s, PREFIXES)).toBe(false);
    }
  });
  it("denies secret files even under the workspace prefix (defense in depth)", () => {
    expect(isAllowedBindSource("F:\\StarlingAI\\.env", PREFIXES)).toBe(false);
    expect(isAllowedBindSource("/run/desktop/mnt/host/f/StarlingAI/.starlingai/credentials.enc", PREFIXES)).toBe(false);
  });
  it("denies traversal", () => {
    expect(isAllowedBindSource("/run/desktop/mnt/host/f/StarlingAI/../../etc", PREFIXES)).toBe(false);
  });
  it("auto-derives the Docker-Desktop daemon path from a Windows-only config prefix", () => {
    const winOnly = parseAllowedPrefixes("F:\\StarlingAI"); // no translated form supplied
    expect(isAllowedBindSource("F:\\StarlingAI\\workspace\\generated\\demo", winOnly)).toBe(true);
    expect(isAllowedBindSource("/run/desktop/mnt/host/f/StarlingAI/workspace/generated/demo", winOnly)).toBe(true);
    expect(isAllowedBindSource("/run/desktop/mnt/host/f/other", winOnly)).toBe(false);
  });
});

describe("path normalization + routing", () => {
  it("strips the /v1.NN api-version prefix", () => {
    expect(normalizeApiPath("/v1.55/containers/create")).toBe("/containers/create");
    expect(isCreateRoute("POST", normalizeApiPath("/v1.43/containers/create?name=x"))).toBe(true);
    expect(isCreateRoute("POST", normalizeApiPath("/containers/create"))).toBe(true);
  });
  it("recognizes pass-through + hijack + pull routes", () => {
    expect(isPassRoute("GET", "/version")).toBe(true);
    expect(isPassRoute("POST", "/containers/abc123/start")).toBe(true);
    expect(isPassRoute("DELETE", "/containers/abc123")).toBe(true);
    expect(isAttachRoute("POST", "/containers/abc123/attach")).toBe(true);
    expect(isImagePullRoute("POST", "/images/create")).toBe(true);
    // unknown endpoints are NOT pass-through (default deny)
    expect(isPassRoute("POST", "/build")).toBe(false);
    expect(isPassRoute("POST", "/volumes/create")).toBe(false);
    expect(isPassRoute("POST", "/containers/abc/update")).toBe(false);
  });
});

describe("splitBindEntry — drive-letter aware (no colon-split leak)", () => {
  it("POSIX src/dst/opts", () => {
    expect(splitBindEntry("/host/path:/app:ro")).toEqual({ src: "/host/path", opts: "ro" });
    expect(splitBindEntry("gc-workspace:/workspace")).toEqual({ src: "gc-workspace", opts: "" });
    expect(splitBindEntry("gc-workspace:/w:rshared")).toEqual({ src: "gc-workspace", opts: "rshared" });
  });
  it("Windows drive-letter src is NOT truncated to the drive letter", () => {
    expect(splitBindEntry("F:\\StarlingAI\\.env:/app/.env").src).toBe("F:\\StarlingAI\\.env");
    expect(splitBindEntry("C:\\Windows:/x:ro")).toEqual({ src: "C:\\Windows", opts: "ro" });
    expect(splitBindEntry("F:/StarlingAI/workspace:/app").src).toBe("F:/StarlingAI/workspace");
  });
});

describe("sanitizeCreateBody — legit runs pass, hardened", () => {
  it("allows a locked-down sub-agent run and force-injects CapDrop ALL", () => {
    const out = ok({ Image: "node:22-alpine", Cmd: ["true"], HostConfig: { Binds: ["gc-workspace:/workspace"], NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], AutoRemove: true, Memory: 536870912 } });
    expect(out.HostConfig.binds).toEqual(["gc-workspace:/workspace"]);
    expect(out.HostConfig.capdrop).toEqual(["ALL"]);
    expect(out.Image).toBe("node:22-alpine");
  });
  it("allows the workspace host-path bind + starlingai-public network (serve_app)", () => {
    const out = ok({ Image: "node:22-alpine", HostConfig: { Binds: ["F:\\StarlingAI\\workspace\\generated\\demo:/app"], NetworkMode: "starlingai-public" } });
    expect(out.HostConfig.networkmode).toBe("starlingai-public");
  });
  it("passes the docker CLI's benign default fields through untouched", () => {
    // These are exactly the fields a real `docker run` sends that a default-deny
    // model wrongly rejected (ContainerIDFile etc.). None are escape vectors.
    const out = ok({ Image: "alpine", HostConfig: {
      ContainerIDFile: "", ShmSize: 67108864, OomScoreAdj: 0, Ulimits: null,
      IpcMode: "private", CgroupnsMode: "private", Devices: [], Sysctls: {},
      CapAdd: [], NetworkMode: "bridge", ConsoleSize: [0, 0], RestartPolicy: { Name: "no" },
    } });
    expect(out.HostConfig.containeridfile).toBe("");
    expect(out.HostConfig.shmsize).toBe(67108864);
    expect(out.HostConfig.ipcmode).toBe("private");
    expect(out.HostConfig.capdrop).toEqual(["ALL"]);
    expect(out.HostConfig.capadd).toEqual([]); // empty CapAdd is fine
  });
  it("force-injects CapDrop ALL when a body omits it", () => {
    const out = ok({ Image: "alpine", HostConfig: { NetworkMode: "bridge" } });
    expect(out.HostConfig.capdrop).toEqual(["ALL"]);
  });
});

describe("sanitizeCreateBody — escapes refused", () => {
  it("host-root / socket / secret binds", () => {
    denied({ HostConfig: { Binds: ["/:/host"] } }, /source not allowed/);
    denied({ HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] } }, /source not allowed/);
    denied({ HostConfig: { Binds: ["/etc:/etc"] } }, /source not allowed/);
    denied({ HostConfig: { Binds: ["F:\\StarlingAI\\.env:/app/.env"] } }, /source not allowed/);
  });
  it("Mounts (bind + disguised local-bind volume)", () => {
    denied({ HostConfig: { Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] } }, /bind source not allowed/);
    denied({ HostConfig: { Mounts: [{ Type: "volume", Source: "x", Target: "/h", VolumeOptions: { DriverConfig: { Name: "local", Options: { type: "none", o: "bind", device: "/" } } } }] } }, /disguised host bind/);
  });
  it("Privileged / host namespaces / dangerous caps / unconfined / devices / sysctls / runtime", () => {
    denied({ HostConfig: { Privileged: true } }, /Privileged is not permitted/);
    denied({ HostConfig: { NetworkMode: "host" } }, /NetworkMode not allowed/);
    denied({ HostConfig: { NetworkMode: "container:abc" } }, /NetworkMode not allowed/);
    denied({ HostConfig: { PidMode: "host" } }, /pidmode not allowed/);
    denied({ HostConfig: { IpcMode: "host" } }, /ipcmode not allowed/);
    denied({ HostConfig: { UtsMode: "host" } }, /utsmode not allowed/);
    denied({ HostConfig: { CgroupnsMode: "host" } }, /cgroupnsmode not allowed/);
    denied({ HostConfig: { UsernsMode: "host" } }, /usernsmode not allowed/);
    denied({ HostConfig: { CapAdd: ["SYS_ADMIN"] } }, /CapAdd is not permitted/);
    denied({ HostConfig: { CapAdd: ["CAP_SYS_ADMIN"] } }, /CapAdd is not permitted/); // CLI/daemon CAP_ prefix form
    denied({ HostConfig: { CapAdd: ["NET_BIND_SERVICE"] } }, /CapAdd is not permitted/); // any cap, not just dangerous ones
    denied({ HostConfig: { SecurityOpt: ["seccomp=unconfined"] } }, /SecurityOpt not allowed/);
    denied({ HostConfig: { SecurityOpt: ["label=disable"] } }, /SecurityOpt not allowed/);
    denied({ HostConfig: { Devices: [{ PathOnHost: "/dev/sda" }] } }, /devices is not permitted/);
    denied({ HostConfig: { DeviceRequests: [{ Count: -1 }] } }, /devicerequests is not permitted/);
    denied({ HostConfig: { Sysctls: { "kernel.core_pattern": "|/x" } } }, /sysctls is not permitted/);
    denied({ HostConfig: { MaskedPaths: [] } }, /maskedpaths override is not permitted/);
    denied({ HostConfig: { ReadonlyPaths: [] } }, /readonlypaths override is not permitted/);
    denied({ HostConfig: { Runtime: "sysbox-runc" } }, /runtime not allowed/);
    denied({ HostConfig: { CgroupParent: "/evil" } }, /cgroupparent is not permitted/);
    denied({ HostConfig: { Binds: ["gc-workspace:/w:rshared"] } }, /propagation shared/);
  });
  it("parser-differential: case-folded + duplicate-key + full-set Capabilities all fail closed", () => {
    denied({ HostConfig: { privileged: true } }, /Privileged is not permitted/);
    denied({ hostconfig: { PRIVILEGED: true } }, /Privileged is not permitted/);
    denied({ HostConfig: { Privileged: false, privileged: true } }, /Privileged is not permitted/); // dup-key last-wins
    denied({ HostConfig: { Capabilities: ["CAP_SYS_ADMIN"] } }, /capabilities .* is not permitted/);
  });
});

describe("HTTP head parse/build (raw-net I/O layer)", () => {
  const head = "POST /v1.55/containers/create?name=x HTTP/1.1\r\nHost: docker\r\nContent-Length: 12\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nUser-Agent: docker/29\r\n\r\n";
  const headText = head.slice(0, head.indexOf("\r\n\r\n"));
  it("parses request line + headers", () => {
    const p = parseRequestHead(headText);
    expect(p.method).toBe("POST");
    expect(p.rawPath).toBe("/v1.55/containers/create?name=x");
    expect(headerValue(p.headers, "content-length")).toBe("12");
    expect(headerValue(p.headers, "CONTENT-type")).toBe("application/json"); // case-insensitive
  });
  it("rebuilds a canonical head: strips hop-by-hop, forces Connection: close, sets body framing", () => {
    const p = parseRequestHead(headText);
    const rebuilt = buildRequestHead(p.method, p.rawPath, p.headers, { contentLength: 34, contentType: "application/json" });
    expect(rebuilt).toMatch(/^POST \/v1\.55\/containers\/create\?name=x HTTP\/1\.1\r\n/);
    expect(rebuilt).toContain("Host: docker\r\n");            // benign header preserved
    expect(rebuilt).toContain("User-Agent: docker/29\r\n");
    expect(rebuilt).toContain("Connection: close\r\n");        // forced
    expect(rebuilt).not.toMatch(/Connection: keep-alive/);     // original dropped
    expect((rebuilt.match(/Content-Length:/gi) || []).length).toBe(1); // exactly one, ours
    expect(rebuilt).toContain("Content-Length: 34\r\n");
    expect((rebuilt.match(/Content-Type:/gi) || []).length).toBe(1);   // original dropped, ours added
    expect(rebuilt.endsWith("\r\n\r\n")).toBe(true);
  });
});

describe("sanitizeExecBody", () => {
  it("allows a benign exec, refuses Privileged / root override", () => {
    expect(() => sanitizeExecBody({ Cmd: ["true"], AttachStdin: true })).not.toThrow();
    expect(() => sanitizeExecBody({ Privileged: true, Cmd: ["sh"] })).toThrow(/Privileged not allowed/);
    expect(() => sanitizeExecBody({ User: "root", Cmd: ["sh"] })).toThrow(/User override not allowed/);
  });
});
