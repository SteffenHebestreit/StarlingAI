import { serve } from "@hono/node-server";
import { loadMailServiceConfig } from "./config.js";
import { DraftStore } from "./draft-store.js";
import { createApp } from "./app.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const config = await loadMailServiceConfig();
  const store = new DraftStore(config.dataPath);
  const app = createApp({
    accounts: config.accounts,
    store,
    authToken: config.authToken,
  });

  serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  log.info({ host: config.host, port: config.port, accounts: config.accounts.map((account) => account.id) }, "mail service started");
}

main().catch((err) => {
  log.error({ err }, "mail service failed to start");
  process.exitCode = 1;
});