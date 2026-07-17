import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sendSlackMessageMock = vi.fn();
const sendDiscordMessageMock = vi.fn();
const sendEmailMessageMock = vi.fn();

vi.mock("../channels/slack.js", () => ({
  sendSlackMessage: sendSlackMessageMock,
}));

vi.mock("../channels/discord.js", () => ({
  sendDiscordMessage: sendDiscordMessageMock,
}));

vi.mock("../channels/email.js", () => ({
  sendEmailMessage: sendEmailMessageMock,
}));

describe("messaging tools", () => {
  beforeAll(async () => {
    await import("../tools/messaging.js");
  });

  afterEach(() => {
    sendSlackMessageMock.mockReset();
    sendDiscordMessageMock.mockReset();
    sendEmailMessageMock.mockReset();
    vi.restoreAllMocks();
  });

  it("sends Slack messages through the channel adapter", async () => {
    sendSlackMessageMock.mockResolvedValue({ ok: true });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("send_slack");

    const result = await tool!.execute({
      channelId: "#ops",
      text: "deploy finished",
    }, {
      sessionId: "session-slack",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Message sent to Slack channel #ops");
    expect(sendSlackMessageMock).toHaveBeenCalledWith("#ops", "deploy finished");
  });

  it("validates Discord snowflake IDs before sending", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("send_discord");

    const result = await tool!.execute({
      channelId: "general",
      text: "hello",
    }, {
      sessionId: "session-discord-invalid",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/numeric Discord snowflake/i);
    expect(sendDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("surfaces Discord adapter failures", async () => {
    sendDiscordMessageMock.mockResolvedValue({ ok: false, error: "permission denied" });

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("send_discord");

    const result = await tool!.execute({
      channelId: "1234567890",
      text: "status update",
    }, {
      sessionId: "session-discord",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("permission denied");
  });

  it("validates email addresses and sends email via the channel adapter", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("send_email");

    const invalid = await tool!.execute({
      to: "not-an-email",
      subject: "Hello",
      body: "World",
    }, {
      sessionId: "session-email-invalid",
      workspacePath: "/workspace",
    });

    expect(invalid.success).toBe(false);
    expect(invalid.error).toMatch(/Invalid email address format/);

    sendEmailMessageMock.mockResolvedValue({ ok: true });
    const valid = await tool!.execute({
      to: "ops@example.com",
      subject: "Deploy finished",
      body: "Everything is green.",
    }, {
      sessionId: "session-email-valid",
      workspacePath: "/workspace",
    });

    expect(valid.success).toBe(true);
    expect(valid.output).toContain('Email sent to ops@example.com with subject "Deploy finished"');
    expect(sendEmailMessageMock).toHaveBeenCalledWith("ops@example.com", "Deploy finished", "Everything is green.");
  });

  it("SEC-106: threads dispatchUncertain from a timeout-ish SMTP failure into the tool result", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("send_email");
    sendEmailMessageMock.mockResolvedValue({
      ok: false,
      error: "Connection timeout (message dead-lettered after 1 attempt)",
      dispatchUncertain: true,
    });
    const result = await tool!.execute({
      to: "ops@example.com",
      subject: "s",
      body: "b",
    }, { sessionId: "session-email-uncertain", workspacePath: "/workspace" });
    expect(result.success).toBe(false);
    expect(result.dispatchUncertain).toBe(true);

    // A definitive failure (auth rejected — provably never sent) must NOT carry the flag.
    sendEmailMessageMock.mockResolvedValue({ ok: false, error: "Invalid login: 535 Authentication failed" });
    const definitive = await tool!.execute({
      to: "ops@example.com",
      subject: "s",
      body: "b",
    }, { sessionId: "session-email-definitive", workspacePath: "/workspace" });
    expect(definitive.success).toBe(false);
    expect(definitive.dispatchUncertain).toBeUndefined();
  });
});