import { getConfig } from "../config/loader.js";
import { markRuntimeComponentAttempt, markRuntimeComponentSuccess } from "../runtime/status.js";

export function syncApprovalRuntimeStatus(): void {
  markRuntimeComponentAttempt("approvals");

  const config = getConfig();
  const approvalChannels = config.approvalChannels ?? {};
  const issues: string[] = [];
  const referencedChannels = new Set<string>();

  for (const [sceneName, scene] of Object.entries(config.scenes ?? {})) {
    if (!scene.approvalChannel) continue;
    referencedChannels.add(scene.approvalChannel);
    if (!approvalChannels[scene.approvalChannel]) {
      issues.push(`Scene '${sceneName}' references missing approval channel '${scene.approvalChannel}'`);
    }
  }

  for (const [channelName, channel] of Object.entries(approvalChannels)) {
    if ((channel.type === "slack" || channel.type === "outbound_webhook") && !config.gateway.publicUrl) {
      issues.push(`Approval channel '${channelName}' requires gateway.publicUrl`);
    }

    if (channel.type === "outbound_webhook" && channel.secret.startsWith("$") && !process.env[channel.secret.slice(1)]) {
      issues.push(`Approval channel '${channelName}' references missing env secret '${channel.secret}'`);
    }

    const headerValues = "headers" in channel ? Object.values(channel.headers ?? {}) : [];
    for (const value of headerValues) {
      if (value.startsWith("$") && !process.env[value.slice(1)]) {
        issues.push(`Approval channel '${channelName}' references missing env header '${value}'`);
      }
    }
  }

  markRuntimeComponentSuccess("approvals", {
    configured: Object.keys(approvalChannels).length,
    referenced: referencedChannels.size,
    issues,
  }, issues.length > 0 ? {
    healthy: false,
    error: `${issues.length} approval configuration issue(s)`,
  } : undefined);
}