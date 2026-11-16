/**
 * The address the gateway's HTTP + WebSocket server binds (gateway.host, SAI_GATEWAY_HOST).
 *
 * Shared by the gateway (gateway/index.ts) and the maintenance boot (gateway/maintenance-gateway.ts)
 * so the two cannot drift apart again: both used to hardcode 0.0.0.0.
 */

/** The configured host, or loopback. A config object built without the schema (a test's
 *  hand-made one) has no host; it falls back to 127.0.0.1, never to Node's all-interfaces
 *  default that an undefined host would give. */
export function gatewayListenHost(gateway: { host?: string | undefined }): string {
  return gateway.host?.trim() || "127.0.0.1";
}

/** `host:port` for a log line or a URL, with an IPv6 literal in brackets. */
export function formatListenAddress(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}
