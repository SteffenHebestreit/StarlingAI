import { describe, expect, it } from "vitest";
import { summarizeToolAuditMetadata } from "../agent/sub-agent.js";

/**
 * A sub-agent's tool audit row keeps a whitelist of the result's metadata. web_fetch reports how
 * many of the page's links it listed (linkCount); without it in the row, an agent that guessed URLs
 * could not be told apart from one that was never shown the real ones (E2E run, 2026-10-07).
 */
describe("summarizeToolAuditMetadata", () => {
  it("keeps web_fetch's linkCount next to its fetch method", () => {
    expect(summarizeToolAuditMetadata({ url: "http://93.184.215.14/", fetchMethod: "native", linkCount: 9, contentLength: 1836 }))
      .toEqual({ url: "http://93.184.215.14/", fetchMethod: "native", linkCount: 9, contentLength: 1836 });
  });
});
