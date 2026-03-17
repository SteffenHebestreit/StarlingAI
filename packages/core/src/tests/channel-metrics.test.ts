import { afterEach, describe, expect, it } from "vitest";
import { recordChannelDelivery, recordChannelIngressDenied, registerChannel, getChannelStatuses, resetChannelRegistryForTests } from "../channels/registry.js";

describe("channel metrics", () => {
  afterEach(() => {
    resetChannelRegistryForTests();
  });

  it("tracks delivery success and failure counts", () => {
    registerChannel("slack", true);

    recordChannelDelivery("slack", true, undefined, 100);
    recordChannelDelivery("slack", true, undefined, 200);
    recordChannelDelivery("slack", true, undefined, 300);
    recordChannelDelivery("slack", true, undefined, 400);
    recordChannelDelivery("slack", true, undefined, 500);
    recordChannelDelivery("slack", false, "temporary failure", 900);

    const status = getChannelStatuses().find((entry) => entry.type === "slack");
    expect(status?.metrics).toMatchObject({
      delivered: 5,
      deliveryFailures: 1,
      ingressDenied: 0,
      lastDeliveryError: "temporary failure",
    });
    expect(status?.metrics?.deliveryLatency).toMatchObject({
      sampleCount: 6,
      lastMs: 900,
      maxMs: 900,
      p50Ms: 300,
      p95Ms: 900,
      p99Ms: 900,
    });
    expect(status?.metrics?.deliverySlo).toMatchObject({
      totalDeliveries: 6,
      delivered: 5,
      failed: 1,
    });
    expect(status?.metrics?.deliverySlo?.successRatePct).toBeCloseTo(83.33, 2);
    expect(status?.metrics?.deliveryWindows?.last5m).toMatchObject({
      totalDeliveries: 6,
      delivered: 5,
      failed: 1,
      p50Ms: 300,
      p95Ms: 900,
    });
    expect(status?.metrics?.deliveryWindows?.last1h).toMatchObject({
      totalDeliveries: 6,
      delivered: 5,
      failed: 1,
    });
  });

  it("tracks ingress denial counts", () => {
    registerChannel("discord", true);

    recordChannelIngressDenied("discord");
    recordChannelIngressDenied("discord");

    const status = getChannelStatuses().find((entry) => entry.type === "discord");
    expect(status?.metrics?.ingressDenied).toBe(2);
    expect(status?.metrics?.lastIngressDeniedAt).toBeTruthy();
  });
});