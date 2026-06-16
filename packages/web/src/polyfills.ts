// `crypto.randomUUID()` is only exposed in a SECURE CONTEXT — HTTPS, or
// http://localhost / 127.0.0.1. When the dashboard is served over plain HTTP on
// a LAN address (e.g. http://10.10.1.11:3001), the browser leaves it undefined,
// and the chat composer throws "crypto.randomUUID is not a function" before a
// message is ever sent. `crypto.getRandomValues()` IS available in insecure
// contexts, so we polyfill an RFC 4122 v4 UUID on top of it.
//
// Imported first in main.ts so it runs before any feature code touches crypto.
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
	crypto.randomUUID = (() => {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
		bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
		const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
		return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
	}) as Crypto["randomUUID"];
}
