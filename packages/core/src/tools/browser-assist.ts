import { registerTool } from "./registry.js";
import { browserSessionManager } from "../agent/browser-session.js";
import { userInputBroker } from "../agent/user-input-broker.js";
import { MAX_USER_INPUT_TIMEOUT_MS, clampUserInputTimeoutMs } from "../agent/user-input.js";

/**
 * request_human_assist — hand the live browser to a human, then resume.
 *
 * browser_agent drives the headed browser-vnc Chrome over CDP, and that same
 * browser is embedded (clickable) in the dashboard. When the agent hits a wall
 * only a person can clear — almost always a reCAPTCHA / "verify you're human"
 * challenge — it calls this tool. The dashboard surfaces the live browser with a
 * "Your help is needed" banner; the operator solves the challenge directly in it
 * and clicks "I solved it — continue", which resolves the wait and lets the agent
 * carry on from the now-unblocked page.
 *
 * This is NOT for ordinary clarifying questions (use ask_user for those) — it is
 * specifically the browser take-over handoff.
 */
registerTool({
  name: "request_human_assist",
  description:
    "Pause and ask a human to take over the LIVE browser to clear a challenge you cannot pass yourself — " +
    "almost always a CAPTCHA / reCAPTCHA / hCaptcha / 'verify you are human' wall on a page. " +
    "The operator solves it directly in the embedded browser and clicks continue, then you resume on the " +
    "unblocked page. Use this instead of giving up on a CAPTCHA. Do NOT use it for normal questions (use ask_user).",
  embeddingDescription:
    "human handoff for captcha recaptcha hcaptcha turnstile human verification challenge in the browser; " +
    "let the operator solve the puzzle then continue; browser take over; cannot pass bot check",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Short, specific description of what the human must do, shown verbatim in the dashboard. " +
          "E.g. 'Solve the reCAPTCHA image challenge on the freelancermap.de login form.'",
      },
      page: {
        type: "string",
        description: "Human-readable page/site the browser is on (e.g. 'freelancermap.de login').",
      },
      timeoutMs: {
        type: "number",
        description: "How long to wait for the operator, in ms. Defaults to 900000 (15 minutes); held between 10000 and 900000.",
      },
    },
    required: ["reason"],
  },
  async execute(args, context) {
    if (!browserSessionManager.isEnabled()) {
      return {
        success: false,
        output: "",
        error:
          "The live browser handoff is not available (no browser-vnc backend). " +
          "A CAPTCHA here cannot be solved by a human take-over — stop and report the task as blocked.",
      };
    }

    const reason = String(args["reason"] ?? "").trim();
    if (!reason) {
      return { success: false, output: "", error: "reason must not be empty." };
    }
    const page = typeof args["page"] === "string" && args["page"].trim() ? String(args["page"]).trim() : undefined;
    // The model picks this number, and every clock of the turn holds for as long as it says: a page
    // the browser agent reads could talk it into days (review #29). Same bounds as ask_user.
    const timeoutMs = clampUserInputTimeoutMs(args["timeoutMs"], MAX_USER_INPUT_TIMEOUT_MS);

    // Find the browser session registered for this run; if the run-start hook
    // didn't create one (e.g. a non-browser_agent caller), make one now so the
    // dashboard still surfaces a live preview.
    let session = browserSessionManager.getByRunSession(context.sessionId);
    if (!session) {
      session = browserSessionManager.register({
        agentName: context.currentAgentName ?? "browser_agent",
        parentSessionId: context.sessionId,
        runSessionId: context.sessionId,
        ...(page ? { page } : {}),
      });
    }

    // A person is at the browser: the run clocks hold until they are done (agent/user-input-broker.ts),
    // or until the turn is stopped — the handoff itself waits out its own deadline.
    const endHumanWait = userInputBroker.beginHumanWait(context.sessionId);
    context.signal?.addEventListener("abort", endHumanWait, { once: true });
    let outcome: Awaited<ReturnType<typeof browserSessionManager.requestAssist>>;
    try {
      outcome = await browserSessionManager.requestAssist(session.id, reason, {
        ...(page ? { page } : {}),
        timeoutMs,
      });
    } finally {
      context.signal?.removeEventListener("abort", endHumanWait);
      endHumanWait();
    }

    if (outcome === "resolved") {
      return {
        success: true,
        output:
          "The operator took over the live browser and resolved the challenge. " +
          "The page is now past it — continue the task from the current page state (re-read the page if needed).",
      };
    }
    if (outcome === "timeout") {
      return {
        success: false,
        output: "",
        error:
          "No operator responded in time. The challenge is still blocking the page. " +
          "Stop and report that the task is blocked by a human-verification challenge.",
      };
    }
    return {
      success: false,
      output: "",
      error: "The browser session ended before the challenge was resolved.",
    };
  },
});
