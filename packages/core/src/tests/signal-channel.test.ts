import { describe, expect, it } from "vitest";
import { parseSignalAccountsOutput, parseSignalReceiveOutput } from "../channels/signal.js";

describe("signal channel helpers", () => {
  it("parses registered accounts from signal-cli json output", () => {
    const accounts = parseSignalAccountsOutput(JSON.stringify([
      { number: "+49111111111" },
      { number: "+49222222222" },
    ]));

    expect(accounts).toEqual(["+49111111111", "+49222222222"]);
  });

  it("extracts direct text messages and ignores sync or group payloads", () => {
    const output = [
      JSON.stringify({
        account: "+49111111111",
        envelope: {
          source: "+49333333333",
          sourceNumber: "+49333333333",
          timestamp: 1710000000000,
          dataMessage: {
            timestamp: 1710000000000,
            message: "hello from signal",
          },
        },
      }),
      JSON.stringify({
        account: "+49111111111",
        envelope: {
          source: "+49444444444",
          timestamp: 1710000001000,
          syncMessage: {
            sentMessage: {
              destination: "+49555555555",
              message: "ignore this sync message",
            },
          },
        },
      }),
      JSON.stringify({
        account: "+49111111111",
        envelope: {
          source: "+49666666666",
          timestamp: 1710000002000,
          dataMessage: {
            message: "ignore this group message",
            groupInfo: { groupId: "abc" },
          },
        },
      }),
    ].join("\n");

    expect(parseSignalReceiveOutput(output)).toEqual([
      {
        senderId: "+49333333333",
        text: "hello from signal",
        timestamp: 1710000000000,
      },
    ]);
  });
});