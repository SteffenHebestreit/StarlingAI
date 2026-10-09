import { serve } from "@hono/node-server";
import { loadMailServiceConfig } from "./config.js";
import { DraftStore } from "./draft-store.js";
import { createApp } from "./app.js";
import { LiveAccounts } from "./live-accounts.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const config = await loadMailServiceConfig();
  const store = new DraftStore(config.dataPath);
  const accounts = new LiveAccounts(config, config.accountsDir);
  await accounts.refresh();
  const app = createApp({
    accounts: accounts.list,
    store,
    authToken: config.authToken,
    refreshAccounts: () => accounts.refresh(),
  });

  serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  log.info({ host: config.host, port: config.port, accounts: accounts.list.map((account) => account.id), accountsDir: config.accountsDir }, "mail service started");
}

main().catch((err) => {
  log.error({ err }, "mail service failed to start");
  process.exitCode = 1;
});
