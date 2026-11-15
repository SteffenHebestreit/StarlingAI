import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAccount } from "./support/test-account.js";

/**
 * The approval link a channel sends (Slack, an outbound webhook's approveUrl / denyUrl) resolved the
 * request on GET. Link previewers, mail scanners and chat unfurlers fetch a link with nobody behind
 * it, so a posted link approved or denied the call by itself. The GET now shows a page with Approve
 * and Deny buttons, and only the form those buttons POST resolves the request.
 *
 * GET /api/approvals/pending listed every pending request, with its full arguments, to any login.
 * A viewer may not answer an approval (the mutation gate), and now does not read the list either.
 *
 * These run against the gateway's own routes in process (Hono's app.request): nothing listens.
 */

type AppLike = { request: (path: string, init?: RequestInit) => Promise<Response> };

/** Every Hono app created, so the test can reach the one createGateway builds without a listener. */
const honoApps = vi.hoisted(() => [] as AppLike[]);
vi.mock("hono", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hono")>();
  const Base = actual.Hono as unknown as new (...args: unknown[]) => AppLike;
  class RecordingHono extends Base {
    constructor(...args: unknown[]) {
      super(...args);
      honoApps.push(this);
    }
  }
  return { ...actual, Hono: RecordingHono };
});

const SECRET = "approval-secret-0123456789abcdef";
const root = testAccount("root", "admin");
const operator = testAccount("olga", "operator");
const viewer = testAccount("vic", "viewer");

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await (await import("../audit/logger.js")).flushAuditLog();
  for (const key of ["SAI_CONFIG_PATH", "SAI_CRED_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** The gateway's app under multi-user auth with an admin, an operator and a viewer. */
async function gateway() {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-approval-link-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "a".repeat(40) },
    auth: { enabled: true, users: [root.record, operator.record, viewer.record] },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  process.env["SAI_CRED_STORE"] = join(dir, "credentials.enc");
  process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
  vi.resetModules();
  // Sequential imports: these modules import each other.
  const { createGateway } = await import("../gateway/index.js");
  const auth = await import("../gateway/auth.js");
  const store = await import("../approval/store.js");
  honoApps.length = 0;
  const gw = createGateway();
  const app = honoApps[0]!;
  cleanups.push(() => gw.stop());

  /** A pending request, as the Slack and outbound-webhook channels create one; settled at the end. */
  const pending = (toolName: string, sceneName?: string) => {
    const created = store.createPendingApproval({ toolName, args: { drug: "ibuprofen", patient: "p-123" }, sceneName, secret: SECRET, timeoutMs: 60_000 });
    cleanups.push(() => { store.resolveApproval(created.id, false); });
    let settled: boolean | undefined;
    void created.promise.then((approved) => { settled = approved; });
    return { id: created.id, isPending: () => store.getPendingApproval(created.id) !== undefined, settled: async () => { await Promise.resolve(); return settled; } };
  };
  const bearer = async (username: string, claims: Record<string, unknown>) => ({ Authorization: `Bearer ${await auth.createToken(username, claims)}` });
  const form = (fields: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { app, pending, bearer, form };
}

describe("the approval link asks before it decides", () => {
  it("answers a GET with a confirmation page and leaves the request pending", async () => {
    const { app, pending } = await gateway();
    const request = pending("create_prescription", "prescribe");

    // A link previewer fetches the Approve link, and fetches it again.
    for (let i = 0; i < 2; i++) {
      const page = await app.request(`/api/approval/${request.id}?approved=true&secret=${SECRET}`);
      expect(request.isPending(), "a GET must not resolve the request").toBe(true);
      expect(page.status).toBe(200);
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      const html = await page.text();
      expect(html).toContain("<strong>create_prescription</strong>");
      expect(html).toContain(`<form method="post" action="./${request.id}">`);
      expect(html).toContain(`<input type="hidden" name="secret" value="${SECRET}">`);
      expect(html).toMatch(/<button type="submit" name="approved" value="true"[^>]* autofocus>Approve<\/button>/);
      expect(html).toContain('name="approved" value="false"');
    }

    expect(await request.settled()).toBeUndefined();
  });

  it("escapes what the page shows", async () => {
    const { app, pending } = await gateway();
    const request = pending("create_prescription", "<script>alert(1)</script>");

    const html = await (await app.request(`/api/approval/${request.id}?approved=false&secret=${SECRET}`)).text();

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toMatch(/value="false"[^>]* autofocus>Deny<\/button>/);
  });

  it.each([
    ["true", true, "Approved"],
    ["false", false, "Denied"],
  ])("resolves the request when the page's form posts approved=%s", async (value, expected, heading) => {
    const { app, pending, form } = await gateway();
    const request = pending("create_prescription");

    const reply = await app.request(`/api/approval/${request.id}`, form({ secret: SECRET, approved: value }));

    expect(reply.status).toBe(200);
    expect(reply.headers.get("Content-Type")).toContain("text/html");
    expect(await reply.text()).toContain(heading);
    expect(request.isPending()).toBe(false);
    expect(await request.settled()).toBe(expected);
  });

  it("refuses a wrong secret on the link and on the form as it refuses an unknown id, and the request stays pending", async () => {
    const { app, pending, form } = await gateway();
    const request = pending("create_prescription");
    const unknownId = "00000000-0000-4000-8000-000000000000";
    const answer = async (reply: Response) => ({ status: reply.status, type: reply.headers.get("Content-Type"), body: await reply.text() });

    const page = await answer(await app.request(`/api/approval/${request.id}?approved=true&secret=wrong-${SECRET}`));
    expect(page.status).toBe(404);
    expect(page.body).not.toContain("<form");
    expect(page).toEqual(await answer(await app.request(`/api/approval/${unknownId}?approved=true&secret=wrong-${SECRET}`)));

    // The form is answered with a page, as the link is, and a wrong secret as an unknown id.
    const posted = await answer(await app.request(`/api/approval/${request.id}`, form({ secret: `wrong-${SECRET}`, approved: "true" })));
    expect(posted.status).toBe(404);
    expect(posted.type).toContain("text/html");
    expect(posted.body).toContain("Approval request not found or already resolved");
    expect(posted).toEqual(await answer(await app.request(`/api/approval/${unknownId}`, form({ secret: `wrong-${SECRET}`, approved: "true" }))));

    expect(request.isPending()).toBe(true);
    expect(await request.settled()).toBeUndefined();
  });

  it("answers a second press of the button with the not-found page, and keeps the first decision", async () => {
    const { app, pending, form } = await gateway();
    const request = pending("create_prescription");

    expect((await app.request(`/api/approval/${request.id}`, form({ secret: SECRET, approved: "true" }))).status).toBe(200);
    const again = await app.request(`/api/approval/${request.id}`, form({ secret: SECRET, approved: "false" }));

    expect(again.status).toBe(404);
    expect(again.headers.get("Content-Type")).toContain("text/html");
    expect(await again.text()).toContain("Approval request not found or already resolved");
    expect(await request.settled()).toBe(true);
  });

  it("still resolves a JSON callback with the secret, and answers it in JSON", async () => {
    const { app, pending } = await gateway();
    const request = pending("create_prescription");

    const reply = await app.request(`/api/approval/${request.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, secret: SECRET }),
    });

    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ ok: true, approved: true });
    expect(await request.settled()).toBe(true);
  });

  // `curl -d '{…}'`, `wget --post-data` and PowerShell's Invoke-RestMethod -Body send a JSON body as
  // application/x-www-form-urlencoded unless told otherwise. Read as a form, that body has no
  // `approved`: the secret in it went unseen (404, still pending), and with the secret or an operator
  // token in the Authorization header an approve was settled as a denial behind a 200.
  it.each([
    ["the secret in the body", async () => ({}), { approved: true, secret: SECRET }],
    ["the secret as a Bearer token", async () => ({ Authorization: `Bearer ${SECRET}` }), { approved: true }],
    ["an operator token", "operator", { approved: true }],
  ] as const)("reads a JSON callback sent with the form Content-Type as JSON (%s)", async (_label, credential, payload) => {
    const { app, pending, bearer } = await gateway();
    const request = pending("create_prescription");
    const authorization = credential === "operator" ? await bearer("olga", operator.claims) : await credential();

    const reply = await app.request(`/api/approval/${request.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...authorization },
      body: JSON.stringify(payload),
    });

    expect(reply.status).toBe(200);
    expect(await request.settled(), "the approve was settled as a denial").toBe(true);
    expect(await reply.json()).toEqual({ ok: true, approved: true });
  });

  // The page's buttons always send exactly one approved=true|false. A form without one is no person's
  // choice (a scanner that submits the form without pressing a button) and must not deny the request.
  it.each([
    ["no approved field", { secret: SECRET }],
    ["an approved value that is neither true nor false", { secret: SECRET, approved: "yes" }],
    ["two approved values", `secret=${SECRET}&approved=false&approved=true`],
  ] as const)("decides nothing on a form post with %s, and the request stays pending", async (_label, fields) => {
    const { app, pending, form } = await gateway();
    const request = pending("create_prescription");
    const init = typeof fields === "string"
      ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: fields }
      : form(fields);

    const reply = await app.request(`/api/approval/${request.id}`, init);

    expect(reply.status).toBe(400);
    expect(reply.headers.get("Content-Type")).toContain("text/html");
    expect(await reply.text()).toContain("Nothing was decided");
    expect(request.isPending()).toBe(true);
    expect(await request.settled()).toBeUndefined();
  });
});

describe("the pending approvals list shows a channel request at operator rank", () => {
  it("lists none to a viewer, and the requests to an operator", async () => {
    const { app, pending, bearer } = await gateway();
    const request = pending("create_prescription", "prescribe");

    expect((await app.request("/api/approvals/pending")).status).toBe(401);

    // The list holds what the caller may decide (approver-roles-routed-approvals): a channel request
    // at operator rank. A viewer gets an empty list, not 403, as a routed approver may rank lower.
    const asViewer = await app.request("/api/approvals/pending", { headers: await bearer("vic", viewer.claims) });
    expect(asViewer.status).toBe(200);
    expect(await asViewer.json()).toEqual([]);

    for (const [username, account] of [["olga", operator], ["root", root]] as const) {
      const listed = await app.request("/api/approvals/pending", { headers: await bearer(username, account.claims) });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([expect.objectContaining({ id: request.id, toolName: "create_prescription", args: { drug: "ibuprofen", patient: "p-123" } })]);
    }
  });
});
