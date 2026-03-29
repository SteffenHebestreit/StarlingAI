import "dotenv/config";
import { childLogger } from "./logger.js";
import { createRemoteComputerServer } from "./agent/computer-remote/server.js";

const log = childLogger("computer-remote-main");

async function main() {
  const host = process.env["SAI_COMPUTER_REMOTE_HOST"] ?? "0.0.0.0";
  const port = Number(process.env["SAI_COMPUTER_REMOTE_PORT"] ?? 8890);
  const authToken = process.env["SAI_COMPUTER_REMOTE_TOKEN"] ?? "";
  const label = process.env["SAI_COMPUTER_REMOTE_LABEL"] ?? "Remote access sidecar";

  const server = createRemoteComputerServer({ host, port, authToken, label });
  await server.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Stopping remote access server");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info({ host, port, authEnabled: Boolean(authToken) }, "StarlingAI remote access sidecar ready");
}

main().catch((error) => {
  console.error("Fatal remote access startup error:", error);
  process.exit(1);
});