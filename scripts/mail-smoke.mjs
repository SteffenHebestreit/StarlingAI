import { appendFile, writeFile } from "node:fs/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(`http://localhost:5020${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${text}`);
  }

  return data;
}

async function findMessage(accountId, subject, mailboxes, maxAttempts = 24, delayMs = 5000) {
  const query = `subject:"${subject}"`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages = await call("/api/messages/search", {
      method: "POST",
      body: {
        accountIds: [accountId],
        mailboxes,
        query,
        limit: 10,
      },
    });

    if (Array.isArray(messages) && messages.length > 0) {
      return messages[0];
    }

    const recentMessages = await call("/api/messages/search", {
      method: "POST",
      body: {
        accountIds: [accountId],
        mailboxes,
        query: "",
        limit: 20,
      },
    });

    const exactMatch = Array.isArray(recentMessages)
      ? recentMessages.find((message) => message?.subject === subject)
      : null;

    if (exactMatch) {
      return exactMatch;
    }

    await sleep(delayMs);
  }

  throw new Error(`Timed out waiting for ${subject} in ${mailboxes.join(", ")}`);
}

const RESULT_PATH = "/tmp/mail-smoke-result.json";
const TRACE_PATH = "/tmp/mail-smoke-trace.log";

async function trace(message) {
  await appendFile(TRACE_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
}

try {
  await writeFile(TRACE_PATH, "", "utf8");
  await trace("start");
  const accounts = await call("/api/accounts");
  await trace(`accounts:${Array.isArray(accounts) ? accounts.length : 0}`);
  const account = accounts.find((entry) => entry.id === "work") ?? accounts[0];

  if (!account) {
    throw new Error("No mail accounts configured");
  }

  const token = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const subject = `StarlingAI smoke ${token}`;
  const folder = `StarlingAI-Smoke-${token}`;
  await trace(`subject:${subject}`);

  const draft = await call("/api/drafts", {
    method: "POST",
    body: {
      accountId: account.id,
      to: [account.address],
      subject,
      textBody: `Live smoke test created at ${new Date().toISOString()}.`,
    },
  });
  await trace(`draft:${draft.id}`);

  await call(`/api/drafts/${draft.id}/send`, { method: "POST" });
  await trace("draft-sent");

  const inboxMessage = await findMessage(account.id, subject, ["INBOX", "Sent Items"]);
  await trace(`inbox:${inboxMessage.mailbox}#${inboxMessage.uid}`);

  await call("/api/mailboxes", {
    method: "POST",
    body: {
      accountId: account.id,
      path: folder,
    },
  });
  await trace(`mailbox-created:${folder}`);

  await call("/api/messages/move", {
    method: "POST",
    body: {
      items: [{ accountId: account.id, mailbox: inboxMessage.mailbox, uid: inboxMessage.uid }],
      destinationMailbox: folder,
      createDestination: false,
    },
  });
  await trace("message-moved");

  const movedMessage = await findMessage(account.id, subject, [folder], 12, 2000);
  await trace(`folder:${movedMessage.mailbox}#${movedMessage.uid}`);

  const deleteResult = await call("/api/messages/delete", {
    method: "POST",
    body: {
      items: [{ accountId: account.id, mailbox: movedMessage.mailbox, uid: movedMessage.uid }],
      permanent: false,
    },
  });
  await trace(`message-deleted:${deleteResult.count ?? 0}`);

  await sleep(2000);

  const deleteMailbox = await call("/api/mailboxes", {
    method: "DELETE",
    body: {
      accountId: account.id,
      path: folder,
    },
  });
  await trace(`mailbox-deleted:${deleteMailbox.path}`);

  const mailboxes = await call(`/api/accounts/${account.id}/mailboxes`);
  const folderStillPresent = Array.isArray(mailboxes) && mailboxes.some((entry) => entry.path === folder);
  await trace(`folder-still-present:${folderStillPresent}`);

  const result = {
    ok: true,
    accountId: account.id,
    subject,
    draftId: draft.id,
    inboxMessage: {
      mailbox: inboxMessage.mailbox,
      uid: inboxMessage.uid,
    },
    movedMessage: {
      mailbox: movedMessage.mailbox,
      uid: movedMessage.uid,
    },
    deleteResult,
    deleteMailbox,
    folderStillPresent,
  };

  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  await trace(`error:${result.error}`);
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.error(result.error);
  process.exitCode = 1;
}