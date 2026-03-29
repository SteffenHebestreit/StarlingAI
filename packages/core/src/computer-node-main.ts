import "dotenv/config";
import { childLogger } from "./logger.js";
import { createComputerNodeServer } from "./agent/computer-node/server.js";

const log = childLogger("computer-node-main");

async function main() {
  const host = process.env["SAI_COMPUTER_NODE_HOST"] ?? "0.0.0.0";
  const port = Number(process.env["SAI_COMPUTER_NODE_PORT"] ?? 8877);
  const authToken = process.env["SAI_COMPUTER_NODE_TOKEN"] ?? "";
  const label = process.env["SAI_COMPUTER_NODE_LABEL"] ?? "Windows desktop node";

  const server = createComputerNodeServer({ host, port, authToken, label });
  await server.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Stopping computer node server");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info({ host, port, authEnabled: Boolean(authToken) }, "StarlingAI computer node ready");
}

main().catch((error) => {
  console.error("Fatal computer-node startup error:", error);
  process.exit(1);
});