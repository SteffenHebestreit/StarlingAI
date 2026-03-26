import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initPostgresAudit } from "./audit/postgres.js";
import { initProviders } from "./providers/index.js";
import { childLogger } from "./logger.js";
import { initMcpServers, shutdownMcpServers } from "./mcp/registry.js";
import { stopManagedChannels, syncAllChannels } from "./channels/runtime.js";
import { initSceneJobStore, shutdownSceneJobStore } from "./agent/jobs.js";
import { startSceneJobWorker, stopSceneJobWorker } from "./agent/scene-worker.js";
import { startSwarmBus, stopSwarmBus } from "./swarm/bus.js";
import { startAutonomousBidding, stopAutonomousBidding } from "./swarm/bidding.js";
import { loadConfig } from "./config/loader.js";

import "./tools/filesystem.js";
import "./tools/shell.js";
import "./tools/ssh.js";
import "./tools/ssh-upload.js";
import "./tools/ssh-download.js";
import "./tools/service-check.js";
import "./tools/ansible.js";
import "./tools/ansible-task.js";
import "./tools/proxmox.js";
import "./tools/terraform.js";
import "./tools/credentials.js";
import "./tools/sub-agent.js";
import "./tools/memory.js";
import "./tools/workspace-search.js";
import "./tools/web.js";
import "./tools/multimodal.js";
import "./tools/pentest.js";
import { syncWebhookTools } from "./tools/webhooks.js";

const log = childLogger("scene-worker:main");

export async function main() {
  const config = loadConfig();
  log.info({ model: config.agents.defaults.model.primary }, "Standalone scene worker starting");

  await initPostgresAudit();
  await initProviders();
  syncWebhookTools();
  await initMcpServers();
  await syncAllChannels();
  await startSwarmBus();
  startAutonomousBidding();
  await initSceneJobStore();
  await startSceneJobWorker();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Stopping standalone scene worker");
    await stopSceneJobWorker();
    stopAutonomousBidding();
    await stopSwarmBus();
    await stopManagedChannels();
    await shutdownMcpServers();
    await shutdownSceneJobStore();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("Standalone scene worker ready");
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch(err => {
    console.error("Fatal scene worker startup error:", err);
    process.exit(1);
  });
}