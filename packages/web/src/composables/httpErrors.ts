import { browserLanguage, chatText } from "./chatText";
import type { TurnLanguage } from "./turnText";

/**
 * What a failed request to the gateway tells the person.
 *
 * The gateway answers its errors in JSON, and its own words are passed on. A proxy in front of it
 * answers some requests for it — too large, gateway not reachable, gateway too slow — with a page
 * of HTML; those get a sentence that says what happened. They all read "Received HTML instead of
 * JSON … check the web server API proxy" before, whatever had happened: an attached picture over
 * the proxy's size limit looked like a broken installation.
 */
export async function responseErrorMessage(response: Response, language: TurnLanguage = browserLanguage()): Promise<string> {
  const status = response.status;
  // Too large is too large, whoever says it: the gateway's "Request body too large" or a proxy's page.
  if (status === 413) return chatText.uploadTooLarge(language);

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await response.json() as Record<string, unknown>;
      const said = body["error"] ?? body["detail"];
      if (typeof said === "string" && said.trim() !== "") return said;
    } catch {
      // Not the JSON it claimed to be: fall through to the status.
    }
    return response.statusText || `HTTP ${status}`;
  }

  let text = "";
  try {
    text = (await response.text()).trim();
  } catch {
    // Nothing readable: the status is all there is.
  }
  const page = /^<(!doctype|html)/i.test(text);
  // A proxy's own answer for a gateway that is down, restarting or still working.
  if ((status === 502 || status === 503 || status === 504) && (page || text === "")) return chatText.gatewayNoAnswer(language, status);
  if (page) return chatText.serverSentPage(language, status);
  return text !== "" ? text.slice(0, 240) : response.statusText || `HTTP ${status}`;
}

/**
 * A request to the gateway that it answered with an error status. `message` is what
 * {@link responseErrorMessage} says for the answer (the text callers have always shown), `status`
 * the HTTP status, so a caller can tell a refused sign-in (401), a missing right (403) or a missing
 * thing (404) from a gateway that is down (502/503/504). `body` is the parsed answer when the
 * gateway answered in JSON, else undefined. A request that got no answer at all (network down,
 * blocked) still fails with fetch's own TypeError, not with this.
 */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    this.body = body;
  }

  /** The error for a failed `response`; reads its body, so call it once, before anything else reads it. */
  static async fromResponse(response: Response, language?: TurnLanguage): Promise<GatewayHttpError> {
    const isJson = response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
    // responseErrorMessage reads the body as it sees fit; the copy keeps it readable for `body`.
    const copy = isJson && !response.bodyUsed ? response.clone() : null;
    const message = await responseErrorMessage(response, language);
    let body: unknown;
    if (copy) {
      try {
        body = await copy.json();
      } catch {
        // Not the JSON it claimed to be: the message already says what there is to say.
      }
    }
    return new GatewayHttpError(message, response.status, body);
  }
}
