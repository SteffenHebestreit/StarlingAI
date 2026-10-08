import { describe, it, expect } from "vitest";
import { isPrivateHost } from "../tools/web.js";
import { redactChannelSecrets } from "../credentials/channels.js";

/**
 * Round 8 (July 2026 review): SSRF guard missed IPv6 private ranges (WEB-3) and the
 * channel-config redactor leaked the WhatsApp verifyToken (CRED-2).
 */
describe("isPrivateHost — IPv6 private ranges (WEB-3)", () => {
  it("blocks IPv6 unique-local (fc00::/7) and link-local (fe80::/10)", () => {
    for (const h of ["fc00::1", "fd12:3456:789a::1", "fe80::1", "febf::1", "[fd00::1]", "FD00::1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  it("still blocks the existing loopback / RFC1918 / metadata cases", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::ffff:127.0.0.1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  it("does NOT over-block public hostnames that merely start with fc/fd/fe", () => {
    for (const h of ["fcbarcelona.com", "fd.example.com", "feedly.com", "example.com", "8.8.8.8", "fe80.example.com"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });

  it("blocks IPv6 addresses that carry a private IPv4 address, in dotted and hex form", () => {
    for (const h of [
      "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:0.0.0.0", "::ffff:0:0", "::ffff:a00:5", "::ffff:7f00:1",
      "::ffff:c0a8:114", "::ffff:ac16:e", "[::ffff:a9fe:a9fe]", "64:ff9b::a9fe:a9fe", "64:ff9b::127.0.0.1",
      "::169.254.169.254", "::a00:5", "::ffff:0:a9fe:a9fe",
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "::808:808"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });

  it("blocks 0.0.0.0/8, not just 0.0.0.0", () => {
    for (const h of ["0.1.2.3", "0.255.255.255"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    expect(isPrivateHost("0.example.com")).toBe(false);
  });

  it("blocks the whole loopback 127.0.0.0/8, not just 127.0.0.1", () => {
    for (const h of ["127.0.0.2", "127.1.2.3", "127.255.255.254"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    // A public hostname that merely starts with "127" (not a dotted-quad) is fine.
    expect(isPrivateHost("127apps.com")).toBe(false);
  });
});

describe("redactChannelSecrets — masks the WhatsApp verifyToken (CRED-2)", () => {
  it("redacts verifyToken alongside the other channel secrets", () => {
    const cfg = { verifyToken: "super-secret-verify", accessToken: "at-123", phoneNumberId: "15551234567" };
    const out = redactChannelSecrets(cfg) as Record<string, unknown>;
    expect(out["verifyToken"]).not.toBe("super-secret-verify");
    expect(out["accessToken"]).not.toBe("at-123");
    // phoneNumberId is an identifier, not a secret — must stay readable for operators.
    expect(out["phoneNumberId"]).toBe("15551234567");
  });
});

import { checkUrlSsrf } from "../tools/web.js";

describe("checkUrlSsrf — shared URL guard for browser/out-of-process fetchers", () => {
  it("blocks non-http(s) schemes and invalid URLs", async () => {
    expect(await checkUrlSsrf("file:///etc/passwd")).toMatch(/http/);
    expect(await checkUrlSsrf("ftp://example.com")).toMatch(/http/);
    expect(await checkUrlSsrf("not a url")).toMatch(/invalid/);
  });

  it("blocks internal/private hosts (literal)", async () => {
    for (const u of [
      "http://localhost:9222",
      "http://127.0.0.1/",
      "http://10.0.0.5/admin",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://engram.internal/",
    ]) {
      expect(await checkUrlSsrf(u)).toMatch(/private|internal/);
    }
  });

  it("allows a normal public https URL", async () => {
    expect(await checkUrlSsrf("https://example.com/page")).toBeNull();
  });

  // An IPv6 address that carries an IPv4 address reaches the IPv4 address. Only the dotted
  // ::ffff: forms of 127/8 and RFC 1918 were refused, so the metadata endpoint written as
  // ::ffff:169.254.169.254 (which URL parsing turns into ::ffff:a9fe:a9fe) was allowed.
  it.each([
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::ffff:a00:5]/",
    "http://[::ffff:0.0.0.0]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b::10.0.0.5]/",
    "http://[::169.254.169.254]/",
    "http://[::a00:5]/",
    "http://[::ffff:0:a9fe:a9fe]/",
  ])("blocks %s, an IPv6 address carrying a private IPv4 address", async (u) => {
    expect(await checkUrlSsrf(u)).toMatch(/private|internal/);
  });

  it("allows an IPv6 address carrying a public IPv4 address", async () => {
    expect(await checkUrlSsrf("http://[::ffff:8.8.8.8]/")).toBeNull();
    expect(await checkUrlSsrf("http://[64:ff9b::808:808]/")).toBeNull();
  });
});
