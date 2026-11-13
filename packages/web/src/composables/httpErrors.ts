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
