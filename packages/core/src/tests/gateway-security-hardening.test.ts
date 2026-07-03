import { describe, it, expect } from "vitest";
import { errorText } from "../providers/failover.js";
import { isPrivateOrLoopbackHost, isSafePeerUrl } from "../federation/index.js";

// Regression coverage for the July 2026 gateway/providers/federation security
// hardening round (review findings SEC-6, FED-2). Each helper closes a concrete
// leak/SSRF; these lock in the corrected behavior.

describe("errorText — API-key redaction covers modern key formats (SEC-6)", () => {
  it("redacts multi-segment modern Anthropic / OpenAI keys the old regex missed", () => {
    expect(errorText(new Error("401 from sk-ant-api03-AbCdEf012345-XyZ_more"))).not.toContain("AbCdEf012345");
    expect(errorText(new Error("bad key sk-ant-oat01-SECRETSECRETSECRET"))).not.toContain("SECRETSECRET");
    expect(errorText(new Error("openai sk-proj-ABCDEFGHIJ1234567890"))).not.toContain("ABCDEFGHIJ");
  });

  it("still redacts legacy keys and preserves the real separator", () => {
    expect(errorText(new Error("legacy sk-abcdef0123456789"))).toContain("sk-***");
    const gsk = errorText(new Error("groq gsk_abcdef0123456789"));
    expect(gsk).toContain("gsk_***"); // underscore separator preserved, not rewritten to gsk-
    expect(gsk).not.toContain("abcdef0123456789");
  });

  it("leaves non-secret error text untouched", () => {
    expect(errorText(new Error("connection timeout after 30s"))).toBe("connection timeout after 30s");
    expect(errorText("no key here, just a task-management note")).toBe("no key here, just a task-management note");
  });
});

describe("isPrivateOrLoopbackHost — SSRF host classification (FED-2)", () => {
  it("flags loopback, private, and link-local/metadata hosts", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.5.5.5", "10.0.0.1",
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1"]) {
      expect(isPrivateOrLoopbackHost(h)).toBe(true);
    }
  });

  it("does NOT flag public hosts", () => {
    for (const h of ["example.com", "peer.starling.ai", "8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "11.0.0.1"]) {
      expect(isPrivateOrLoopbackHost(h)).toBe(false);
    }
  });
});

describe("isSafePeerUrl — only follow http(s) public peer URLs (FED-2)", () => {
  it("rejects non-http(s) schemes and unparseable URLs", () => {
    expect(isSafePeerUrl("file:///etc/passwd", false)).toBe(false);
    expect(isSafePeerUrl("gopher://x", false)).toBe(false);
    expect(isSafePeerUrl("not a url", false)).toBe(false);
  });

  it("rejects private hosts by default but allows them under the opt-in", () => {
    expect(isSafePeerUrl("http://169.254.169.254/latest/meta-data/", false)).toBe(false);
    expect(isSafePeerUrl("http://10.0.0.5:8080", false)).toBe(false);
    expect(isSafePeerUrl("http://10.0.0.5:8080", true)).toBe(true); // allowPrivateHosts opt-in
  });

  it("accepts public http(s) peer URLs", () => {
    expect(isSafePeerUrl("https://peer.example.com/api/federation", false)).toBe(true);
    expect(isSafePeerUrl("http://peer.example.com:9000", false)).toBe(true);
  });
});
