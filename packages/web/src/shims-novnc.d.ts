// Type shim for @novnc/novnc, which ships no @types package. Its `exports` is the
// string form "./core/rfb.js", so the only importable specifier is the bare
// module name, resolving to the default-exported RFB client class. We declare
// just the surface BrowserSessionPanel uses.
declare module "@novnc/novnc" {
  export interface RFBOptions {
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrDataChannel: string, options?: RFBOptions);
    /** Scale the remote framebuffer to fit the container. */
    scaleViewport: boolean;
    /** Ask the server to resize its session to match the container. */
    resizeSession: boolean;
    /** Block local input — keep false so the human can click the CAPTCHA. */
    viewOnly: boolean;
    /** CSS background behind the framebuffer. */
    background: string;
    /** Quality/compression hints (0-9). */
    qualityLevel: number;
    compressionLevel: number;
    /** Tear down the connection and remove the canvas. */
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}
