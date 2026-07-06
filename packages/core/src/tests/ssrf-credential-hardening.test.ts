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
