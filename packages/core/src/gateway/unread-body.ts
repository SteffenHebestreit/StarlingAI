/**
 * What the Node→Hono bridge does with a request body a handler answered without reading (a 401
 * from an auth check, the 413 of the Content-Length limit).
 *
 * The bridge hands Hono `Readable.toWeb(req)`. Node discards an unread body itself once the reply
 * is out, but not one a web stream holds: that stream had paused the request once its queue was
 * full, so the rest of the body stayed on the socket, the connection was kept alive, and the
 * client's next request on it was never parsed. It failed with ECONNRESET some seconds later,
 * when the server timed the socket out.
 *
 * After the reply, the rest of the body is now read and dropped, so the connection can carry the
 * next request, within the bounds @hono/node-server's listener uses for the same case: at most
 * 64 MiB and 500 ms, after which the socket is closed. That holds for a body declared larger than
 * the bounds too. Closing such a connection with the reply (`Connection: close`) instead would
 * cost the reply itself: Node closes the socket right after the reply, a socket closed with unread
 * bytes in it is reset, and the client then often never sees the 401 or 413 that went out just
 * before. The drain gives the reply that time to arrive and still reads no more than the bounds.
 */
import type { IncomingMessage } from "node:http";

export interface UnreadBodyLimits {
  /** The most body bytes read and dropped after the reply before the socket is closed. */
  maxBytes: number;
  /** How long after the reply the rest of the body may take to arrive before the socket is closed. */
  timeoutMs: number;
}

export const UNREAD_BODY_LIMITS: UnreadBodyLimits = { maxBytes: 64 * 1024 * 1024, timeoutMs: 500 };

/**
 * Reads the rest of `req`'s body and drops it, once the reply has gone out. A body that ends
 * within the limits leaves the connection usable for the next request; otherwise the socket is
 * closed. Nothing is done for a body that was read to the end.
 */
export function discardUnreadBody(req: IncomingMessage, limits: UnreadBodyLimits = UNREAD_BODY_LIMITS): void {
  if (req.readableEnded || req.destroyed) return;
  // The web stream handed to Hono reads through a 'data' listener and pauses the request when its
  // queue is full. Nothing reads that stream any more: without the listener, resume() drops each
  // chunk as it arrives.
  req.removeAllListeners("data");
  let bytes = 0;
  const stop = () => {
    clearTimeout(timer);
    req.off("data", onData);
    req.off("end", stop);
    req.off("error", stop);
    req.off("close", stop);
  };
  const giveUp = () => {
    stop();
    req.socket.destroySoon();
  };
  const onData = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > limits.maxBytes) giveUp();
  };
  const timer = setTimeout(giveUp, limits.timeoutMs);
  timer.unref();
  req.on("data", onData);
  req.once("end", stop);
  req.once("error", stop);
  req.once("close", stop);
  req.resume();
}
