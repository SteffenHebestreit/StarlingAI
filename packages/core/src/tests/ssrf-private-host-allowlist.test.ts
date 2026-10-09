import { afterEach, describe, expect, it, vi } from "vitest";
import * as loaderModule from "../config/loader.js";
import { GuardrailsSchema } from "../config/schema.js";
import { hostIsBlocked, isNeverAllowedAddress, resolvedHostIsBlocked } from "../tools/web.js";

/**
 * guardrails.allowedPrivateHosts: the one exemption from the SSRF guard, for a local fixture
 * service such as the e2e test site. It must open exactly the listed names on a LAN or
 * container network, and never the gateway itself, a cloud-metadata endpoint or a name the
 * guard refuses literally.
 */
const SITE = "www.nordlicht-werkzeuge.test";

describe("resolvedHostIsBlocked — the allowlist decision", () => {
  it("refuses a host that resolves to a private address when it is not listed", () => {
    expect(resolvedHostIsBlocked(SITE, ["172.22.0.14"], [])).toBe(true);
    expect(resolvedHostIsBlocked("engram", ["172.22.0.5"], [SITE])).toBe(true);
  });

  it("lets a listed host through to a private LAN or container address, in any case and FQDN form", () => {
    expect(resolvedHostIsBlocked(SITE, ["172.22.0.14"], [SITE])).toBe(false);
    expect(resolvedHostIsBlocked(SITE.toUpperCase(), ["10.0.0.7"], [SITE])).toBe(false);
    expect(resolvedHostIsBlocked(`${SITE}.`, ["192.168.1.20"], [SITE.toUpperCase()])).toBe(false);
    expect(resolvedHostIsBlocked(SITE, ["fd00::14"], [SITE])).toBe(false);
  });

  it("matches the exact name only — no suffix, prefix or parent-domain match", () => {
    for (const host of [`evil.${SITE}`, "nordlicht-werkzeuge.test", `${SITE}.evil.example`, `x${SITE}`]) {
      expect(resolvedHostIsBlocked(host, ["172.22.0.14"], [SITE]), host).toBe(true);
    }
  });

  it("still refuses a listed host that resolves to loopback, link-local/metadata or the unspecified address", () => {
    for (const address of ["127.0.0.1", "127.3.2.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(resolvedHostIsBlocked(SITE, [address], [SITE]), address).toBe(true);
    }
    // One bad record among good ones is enough.
    expect(resolvedHostIsBlocked(SITE, ["172.22.0.14", "127.0.0.1"], [SITE])).toBe(true);
  });

  it("leaves public hosts alone, listed or not", () => {
    expect(resolvedHostIsBlocked("example.com", ["93.184.215.14"], [])).toBe(false);
    expect(resolvedHostIsBlocked("example.com", ["93.184.215.14"], ["example.com"])).toBe(false);
  });

  // A name answering with the metadata or unspecified address in an IPv6 form was let through:
  // never-allowed addresses were only consulted for a listed name, and the first check did not
  // know these forms as private.
  it("refuses a loopback, link-local or unspecified address in any IPv6 form, listed or not", () => {
    for (const address of ["::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:0.0.0.0", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "::a9fe:a9fe"]) {
      expect(resolvedHostIsBlocked(SITE, [address], []), address).toBe(true);
      expect(resolvedHostIsBlocked(SITE, [address], [SITE]), `${address} (listed)`).toBe(true);
    }
  });

  it("treats a LAN address in an IPv6 form like the LAN address: refused unless listed", () => {
    for (const address of ["::ffff:172.22.0.14", "::ffff:ac16:e", "64:ff9b::ac16:e"]) {
      expect(resolvedHostIsBlocked(SITE, [address], []), address).toBe(true);
      expect(resolvedHostIsBlocked(SITE, [address], [SITE]), `${address} (listed)`).toBe(false);
    }
  });

  it("leaves a public IPv4 address in an IPv6 form alone", () => {
    for (const address of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808"]) {
      expect(resolvedHostIsBlocked("example.com", [address], []), address).toBe(false);
    }
  });
});

describe("isNeverAllowedAddress", () => {
  it("covers loopback, link-local and unspecified in every form, and nothing on a LAN", () => {
    for (const a of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "febf::1", "[::1]", "::ffff:169.254.169.254", "::ffff:0:1"]) {
      expect(isNeverAllowedAddress(a), a).toBe(true);
    }
    for (const a of ["172.22.0.14", "10.0.0.7", "192.168.1.20", "fd00::14", "93.184.215.14"]) {
      expect(isNeverAllowedAddress(a), a).toBe(false);
    }
  });

  it("reads the IPv4 address inside mapped, compatible and NAT64 IPv6 forms", () => {
    for (const a of ["::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "::a9fe:a9fe", "::ffff:0:a9fe:a9fe", "::ffff:7f00:1"]) {
      expect(isNeverAllowedAddress(a), a).toBe(true);
    }
    for (const a of ["::ffff:8.8.8.8", "::ffff:808:808", "::ffff:ac16:e", "64:ff9b::808:808"]) {
      expect(isNeverAllowedAddress(a), a).toBe(false);
    }
  });
});

describe("hostIsBlocked — literal refusals ignore the allowlist", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function allow(hosts: string[]) {
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
    } as typeof realConfig);
  }

  it("refuses a literal private name even when it is listed", async () => {
    allow(["localhost", "metadata.google.internal", "host.docker.internal"]);
    for (const host of ["localhost", "localhost.", "LOCALHOST", "metadata.google.internal", "metadata.google.internal.", "host.docker.internal"]) {
      expect(await hostIsBlocked(host), host).toBe(true);
    }
  });

  it("refuses IP literals, which can never be listed", async () => {
    allow([SITE]);
    for (const host of ["127.0.0.1", "10.0.0.7", "169.254.169.254", "::1"]) {
      expect(await hostIsBlocked(host), host).toBe(true);
    }
  });
});

describe("guardrails.allowedPrivateHosts schema", () => {
  it("accepts exact DNS host names and defaults to none", () => {
    expect(GuardrailsSchema.parse({}).allowedPrivateHosts).toEqual([]);
    expect(GuardrailsSchema.parse({ allowedPrivateHosts: [SITE, "e2e-site", "Wiki.Lan.Example"] }).allowedPrivateHosts)
      .toEqual([SITE, "e2e-site", "Wiki.Lan.Example"]);
  });

  it("rejects IP literals, wildcards, ports, schemes and paths", () => {
    for (const bad of ["10.0.0.7", "127.0.0.1", "::1", "*.nordlicht-werkzeuge.test", `${SITE}:8080`, `http://${SITE}`, `${SITE}/x`, "", "-bad.test", "a..b"]) {
      expect(GuardrailsSchema.safeParse({ allowedPrivateHosts: [bad] }).success, bad).toBe(false);
    }
  });
});
