import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { checkChannelIngress, resetChannelIngressForTests } from "../channels/base.js";
import { verifyWhatsappSignature } from "../channels/whatsapp.js";

describe("channel ingress guards", () => {
  afterEach(() => {
    resetChannelIngressForTests();
  });

  it("rate limits senders after the configured budget is exhausted", () => {
    const config = {
      enabled: true,
      dmPolicy: "open" as const,
      allowFrom: [],
      historyLimit: 50,
      perSenderRateLimitCount: 2,
      perSenderRateLimitWindowMs: 60_000,
    };

    expect(checkChannelIngress("slack", "U123", config).allowed).toBe(true);
    expect(checkChannelIngress("slack", "U123", config).allowed).toBe(true);

    const limited = checkChannelIngress("slack", "U123", config);
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks sender budgets independently per channel", () => {
    const config = {
      enabled: true,
      dmPolicy: "open" as const,
      allowFrom: [],
      historyLimit: 50,
      perSenderRateLimitCount: 1,
      perSenderRateLimitWindowMs: 60_000,
    };

    expect(checkChannelIngress("slack", "U123", config).allowed).toBe(true);
    expect(checkChannelIngress("discord", "U123", config).allowed).toBe(true);
    expect(checkChannelIngress("slack", "U123", config).allowed).toBe(false);
    expect(checkChannelIngress("discord", "U123", config).allowed).toBe(false);
  });
});

describe("whatsapp signature verification", () => {
  it("accepts valid signatures", () => {
    const secret = "test-secret";
    const body = JSON.stringify({ hello: "world" });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyWhatsappSignature(secret, body, signature)).toBe(true);
  });

  it("rejects invalid signatures", () => {
    expect(verifyWhatsappSignature("test-secret", "{}", "sha256=deadbeef")).toBe(false);
  });
});