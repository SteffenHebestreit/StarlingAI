/**
 * The HTML pages of the approval link (`/api/approval/:id`, gateway/index.ts), and how the
 * callback reads what is posted to it.
 *
 * The link a channel sends (Slack, an outbound webhook's approveUrl / denyUrl) opens a page that
 * shows the request and asks; it does not decide. Link previewers, mail scanners and chat
 * unfurlers fetch a link with nobody behind it, so a GET that resolved the request approved or
 * denied it by itself. The page's buttons POST the secret back to the same path.
 */

/**
 * A POST to the approval callback, read from its body:
 * - "form": a button of the confirmation page, `approved=true|false&secret=…` as
 *   application/x-www-form-urlencoded. Answered with a page.
 * - "json": a programmatic callback (a channel receiver, the dashboard), `{ approved, secret? }`,
 *   read as it always was. Answered with JSON.
 * - "invalid-form": a form without exactly one `approved` of "true" or "false". It decides
 *   nothing: the buttons always send one, so this is not a person's choice (a scanner that submits
 *   the form without pressing a button).
 * - "invalid-json": neither a form nor a JSON object.
 */
export type ApprovalCallbackBody =
  | { kind: "form" | "json"; approved: boolean; secret: string }
  | { kind: "invalid-form" }
  | { kind: "invalid-json" };

export function readApprovalCallbackBody(raw: string, contentType: string | undefined): ApprovalCallbackBody {
  // A body that is JSON is read as JSON whatever its Content-Type says: `curl -d`,
  // `wget --post-data` and PowerShell's Invoke-RestMethod send one as
  // application/x-www-form-urlencoded unless they are told otherwise, and such callbacks worked
  // before the page posted a form. Read as a form, `{"approved":true,…}` has no `approved`.
  if (/^application\/x-www-form-urlencoded\b/i.test(contentType ?? "") && !raw.trimStart().startsWith("{")) {
    const fields = new URLSearchParams(raw);
    const approved = fields.getAll("approved");
    if (approved.length !== 1 || (approved[0] !== "true" && approved[0] !== "false")) return { kind: "invalid-form" };
    return { kind: "form", approved: approved[0] === "true", secret: fields.get("secret") ?? "" };
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    return { kind: "invalid-json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "invalid-json" };
  const fields = body as Record<string, unknown>;
  return { kind: "json", approved: Boolean(fields["approved"]), secret: fields["secret"] ? String(fields["secret"]) : "" };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = "font-family:sans-serif;padding:2rem;max-width:40rem";
const BUTTON_STYLE = "font-size:1rem;padding:.5rem 1.25rem;margin-right:.75rem;cursor:pointer";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title></head><body style="${PAGE_STYLE}">${body}</body></html>`;
}

/**
 * The page a valid approval link opens: the tool (and scene) the request is for, and an Approve and
 * a Deny button. Both post `approved` and the link's `secret` as a form to `./<approvalId>`, the
 * path the page was served from, so it works behind a proxy that mounts the gateway under a prefix.
 * The button of the link that was followed (`suggested`) has the focus.
 */
export function approvalConfirmationPage(request: {
  approvalId: string;
  toolName: string;
  sceneName?: string;
  secret: string;
  suggested: boolean;
}): string {
  const scene = request.sceneName ? `<p>Scene: <strong>${escapeHtml(request.sceneName)}</strong></p>` : "";
  return page("Approval request", [
    "<h2>Approval required</h2>",
    `<p>The agent wants to call <strong>${escapeHtml(request.toolName)}</strong>.</p>`,
    scene,
    `<form method="post" action="./${escapeHtml(encodeURIComponent(request.approvalId))}">`,
    `<input type="hidden" name="secret" value="${escapeHtml(request.secret)}">`,
    `<button type="submit" name="approved" value="true" style="${BUTTON_STYLE}"${request.suggested ? " autofocus" : ""}>Approve</button>`,
    `<button type="submit" name="approved" value="false" style="${BUTTON_STYLE}"${request.suggested ? "" : " autofocus"}>Deny</button>`,
    "</form>",
  ].join(""));
}

/** The page the buttons of approvalConfirmationPage land on once the request is resolved. */
export function approvalResultPage(toolName: string, approved: boolean): string {
  const action = approved ? "✅ Approved" : "❌ Denied";
  return page(action, `<h2>${action}</h2><p>Tool: <strong>${escapeHtml(toolName)}</strong></p><p>You can close this tab.</p>`);
}

/** The page a form post that carries no decision gets ("invalid-form"); the request stays pending. */
export function approvalNoDecisionPage(): string {
  return page("Nothing decided", "<h2>Nothing was decided</h2><p>Open the approval link again and press Approve or Deny.</p>");
}
