/**
 * Minimal RFB (Remote Frame Buffer) Protocol Client — VNC wire protocol.
 *
 * Implements the subset of RFB 3.8 needed for headless computer-use:
 *   • Version / security / init handshake
 *   • VNC Authentication (DES challenge-response)
 *   • FramebufferUpdateRequest → raw-pixel framebuffer capture
 *   • PointerEvent (click, drag, scroll)
 *   • KeyEvent (type, hotkey)
 *   • ClientCutText (clipboard write)
 *
 * Does NOT require any native dependencies — uses only Node built-ins
 * (net, crypto, zlib).
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6143
 */

import { Socket } from "node:net";
import { createCipheriv } from "node:crypto";
import { deflate, deflateSync } from "node:zlib";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";

// Async deflate runs on the libuv threadpool (C++), off the JS main thread.
const deflateAsync = promisify(deflate);
import { EventEmitter } from "node:events";
import { childLogger } from "../../logger.js";

const log = childLogger("agent:vnc-protocol");

// ── Constants ─────────────────────────────────────────────────────────────────

const RFB_VERSION = "RFB 003.008\n"; // 12 bytes

const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;

const ENCODING_RAW = 0;
const ENCODING_COPY_RECT = 1;
const ENCODING_DESKTOP_SIZE = -223;

// ── X11 Keysym Table ──────────────────────────────────────────────────────────

const KEYSYM: Record<string, number> = {
  backspace: 0xff08, tab: 0xff09, return: 0xff0d, enter: 0xff0d,
  escape: 0xff1b, space: 0x0020, delete: 0xffff, insert: 0xff63,
  home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  f1: 0xffbe, f2: 0xffbf, f3: 0xffc0, f4: 0xffc1, f5: 0xffc2,
  f6: 0xffc3, f7: 0xffc4, f8: 0xffc5, f9: 0xffc6, f10: 0xffc7,
  f11: 0xffc8, f12: 0xffc9,
  shift: 0xffe1, shift_l: 0xffe1, shift_r: 0xffe2,
  ctrl: 0xffe3, control: 0xffe3, control_l: 0xffe3, control_r: 0xffe4,
  alt: 0xffe9, alt_l: 0xffe9, alt_r: 0xffea,
  super: 0xffeb, super_l: 0xffeb, super_r: 0xffec, win: 0xffeb, meta: 0xffeb,
  capslock: 0xffe5, numlock: 0xff7f, scrolllock: 0xff14,
  printscreen: 0xff61, pause: 0xff13, break: 0xff6b,
  // Punctuation / common chars (ASCII range — keysym == char code)
  "!": 0x0021, "@": 0x0040, "#": 0x0023, "$": 0x0024, "%": 0x0025,
  "^": 0x005e, "&": 0x0026, "*": 0x002a, "(": 0x0028, ")": 0x0029,
  "-": 0x002d, _: 0x005f, "=": 0x003d, "+": 0x002b,
  "[": 0x005b, "]": 0x005d, "{": 0x007b, "}": 0x007d,
  "\\": 0x005c, "|": 0x007c, ";": 0x003b, ":": 0x003a,
  "'": 0x0027, '"': 0x0022, ",": 0x002c, ".": 0x002e,
  "/": 0x002f, "?": 0x003f, "`": 0x0060, "~": 0x007e,
  "<": 0x003c, ">": 0x003e,
};

/** Resolve a key name or character to an X11 keysym. */
export function resolveKeysym(key: string): number {
  if (key.length === 1) {
    const code = key.charCodeAt(0);
    // ASCII printable range → keysym == code point
    if (code >= 0x20 && code <= 0x7e) return code;
    // Latin-1 supplement (e.g. accented chars) → keysym = code point + 0 offset
    if (code >= 0xa0 && code <= 0xff) return code;
  }
  const sym = KEYSYM[key.toLowerCase()];
  if (sym !== undefined) return sym;
  throw new Error(`Unknown keysym for key '${key}'`);
}

// ── CRC-32 for PNG encoding ──────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crcBuf]);
}

/**
 * Encode raw BGRA/RGBA pixel data to PNG using only node:zlib.
 * The VNC framebuffer uses the pixel format we negotiate (RGBA 32bpp).
 */
/** Build the PNG IHDR chunk header bytes. */
function pngIhdr(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  return ihdr;
}

/** Prepend filter byte 0 (None) to each scanline — the pre-compression IDAT bytes. */
function pngRawScanlines(width: number, height: number, rgba: Buffer): Buffer {
  const rowBytes = width * 4;
  const rawData = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const dstOffset = y * (1 + rowBytes);
    rawData[dstOffset] = 0; // filter: None
    rgba.copy(rawData, dstOffset + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return rawData;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assemblePng(width: number, height: number, compressedIdat: Buffer): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", pngIhdr(width, height)),
    pngChunk("IDAT", compressedIdat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function encodeRgbaToPng(width: number, height: number, rgba: Buffer): Buffer {
  const compressed = deflateSync(pngRawScanlines(width, height, rgba), { level: 1 }); // fast compression
  return assemblePng(width, height, compressed);
}

/**
 * Async variant of {@link encodeRgbaToPng}: the dominant cost — deflate of a full
 * framebuffer (a 1080p frame is ~8 MB) — runs on the libuv threadpool instead of
 * blocking the gateway's JS event loop. Used by the per-screenshot capture path
 * so repeated VNC screenshots during a computer-use session don't stall the loop.
 */
export async function encodeRgbaToPngAsync(width: number, height: number, rgba: Buffer): Promise<Buffer> {
  const compressed = await deflateAsync(pngRawScanlines(width, height, rgba), { level: 1 });
  return assemblePng(width, height, compressed);
}

// ── VNC DES Authentication ────────────────────────────────────────────────────

/**
 * RFB DES key derivation — first 8 bytes of password, padded with zeros,
 * each byte bit-reversed (RFB quirk).
 */
function deriveVncDesKey(password: string): Buffer {
  const padded = Buffer.alloc(8);
  const pw = Buffer.from(password, "ascii");
  pw.copy(padded, 0, 0, Math.min(8, pw.length));

  // Reverse bits in each byte
  for (let i = 0; i < 8; i++) {
    let byte = padded[i]!;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) {
      reversed = (reversed << 1) | (byte & 1);
      byte >>= 1;
    }
    padded[i] = reversed;
  }
  return padded;
}

function vncDesEncrypt(challenge: Buffer, password: string): Buffer {
  const key = deriveVncDesKey(password);
  // ECB mode, encrypt two 8-byte blocks
  const result = Buffer.alloc(16);
  const cipher1 = createCipheriv("des-ecb", key, null);
  cipher1.setAutoPadding(false);
  cipher1.update(challenge.subarray(0, 8)).copy(result, 0);
  cipher1.final(); // discard

  const cipher2 = createCipheriv("des-ecb", key, null);
  cipher2.setAutoPadding(false);
  cipher2.update(challenge.subarray(8, 16)).copy(result, 8);
  cipher2.final(); // discard

  return result;
}

// ── Stream Reader ─────────────────────────────────────────────────────────────

/**
 * Buffered reader for a TCP socket — accumulates data and provides
 * promise-based "read exactly N bytes" semantics on top of the stream.
 */
class StreamReader {
  private buffer = Buffer.alloc(0);
  private waitResolve: ((chunk: Buffer) => void) | null = null;
  private waitBytes = 0;
  private error: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err) => { this.error = err; this.reject(err); });
    socket.on("close", () => { this.reject(new Error("VNC socket closed")); });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.tryFlush();
  }

  private tryFlush(): void {
    if (this.waitResolve && this.buffer.length >= this.waitBytes) {
      const resolve = this.waitResolve;
      const n = this.waitBytes;
      this.waitResolve = null;
      this.waitBytes = 0;
      const data = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      resolve(Buffer.from(data));
    }
  }

  private reject(err: Error): void {
    if (this.waitResolve) {
      // Using a local to avoid calling a stale resolve
      const oldResolve = this.waitResolve;
      this.waitResolve = null;
      // We can't reject a resolve, so we store the error for the next read
      this.error = err;
    }
  }

  async read(n: number): Promise<Buffer> {
    if (this.error) throw this.error;
    if (this.buffer.length >= n) {
      const data = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return Buffer.from(data);
    }
    return new Promise<Buffer>((resolve, reject) => {
      if (this.error) { reject(this.error); return; }
      this.waitResolve = resolve;
      this.waitBytes = n;
      // Check again in case data arrived between the check above and now
      this.tryFlush();
    });
  }

  async readUint8(): Promise<number> { return (await this.read(1)).readUInt8(0); }
  async readUint16BE(): Promise<number> { return (await this.read(2)).readUInt16BE(0); }
  async readUint32BE(): Promise<number> { return (await this.read(4)).readUInt32BE(0); }
  async readInt32BE(): Promise<number> { return (await this.read(4)).readInt32BE(0); }
}

// ── VNC Client ────────────────────────────────────────────────────────────────

export interface VncConnectionOptions {
  host: string;
  port: number;
  password?: string;
  connectTimeoutMs?: number;
}

export class VncClient extends EventEmitter {
  private socket: Socket | null = null;
  private reader: StreamReader | null = null;
  private _width = 0;
  private _height = 0;
  private _name = "";
  private framebuffer: Buffer | null = null;
  private connected = false;

  get width(): number { return this._width; }
  get height(): number { return this._height; }
  get serverName(): string { return this._name; }
  get isConnected(): boolean { return this.connected; }

  /** Connect, authenticate, and complete the RFB handshake. */
  async connect(opts: VncConnectionOptions): Promise<void> {
    const timeout = opts.connectTimeoutMs ?? 10_000;

    // TCP connection
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const sock = new Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`VNC connection to ${opts.host}:${opts.port} timed out after ${timeout}ms`));
      }, timeout);
      timer.unref();
      sock.connect(opts.port, opts.host, () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.on("error", (err) => { clearTimeout(timer); reject(err); });
    });

    this.reader = new StreamReader(this.socket);

    // ── RFB Version Handshake ──
    const serverVersion = (await this.reader.read(12)).toString("ascii");
    if (!serverVersion.startsWith("RFB ")) {
      throw new Error(`Invalid RFB version string: ${serverVersion.trim()}`);
    }
    this.socket.write(RFB_VERSION);
    log.debug({ serverVersion: serverVersion.trim() }, "VNC version handshake");

    // ── Security Handshake ──
    const numSecTypes = await this.reader.readUint8();
    if (numSecTypes === 0) {
      const reasonLen = await this.reader.readUint32BE();
      const reason = (await this.reader.read(reasonLen)).toString("utf-8");
      throw new Error(`VNC connection refused: ${reason}`);
    }
    const secTypes = await this.reader.read(numSecTypes);
    const secTypeSet = new Set(secTypes);

    if (opts.password && secTypeSet.has(SECURITY_VNC_AUTH)) {
      // VNC Authentication
      this.socket.write(Buffer.from([SECURITY_VNC_AUTH]));
      const challenge = await this.reader.read(16);
      const response = vncDesEncrypt(challenge, opts.password);
      this.socket.write(response);
    } else if (secTypeSet.has(SECURITY_NONE)) {
      // No authentication
      this.socket.write(Buffer.from([SECURITY_NONE]));
    } else {
      throw new Error(`No supported VNC security type (server offers: ${[...secTypes].join(", ")})`);
    }

    // ── Security Result ──
    const authResult = await this.reader.readUint32BE();
    if (authResult !== 0) {
      // Try to read failure reason (RFB 3.8+)
      let reason = "authentication failed";
      try {
        const reasonLen = await this.reader.readUint32BE();
        if (reasonLen > 0 && reasonLen < 1024) {
          reason = (await this.reader.read(reasonLen)).toString("utf-8");
        }
      } catch { /* some servers don't send a reason */ }
      throw new Error(`VNC authentication failed: ${reason}`);
    }

    // ── Client Init (shared = 1) ──
    this.socket.write(Buffer.from([1]));

    // ── Server Init ──
    this._width = await this.reader.readUint16BE();
    this._height = await this.reader.readUint16BE();
    const pixelFormat = await this.reader.read(16); // server's default pixel format
    const nameLen = await this.reader.readUint32BE();
    this._name = (await this.reader.read(nameLen)).toString("utf-8");

    log.info({
      host: opts.host,
      port: opts.port,
      width: this._width,
      height: this._height,
      name: this._name,
    }, "VNC connected");

    // ── Set Pixel Format (32bpp RGBA) ──
    this.sendSetPixelFormat();

    // ── Set Encodings (RAW + CopyRect + DesktopSize) ──
    this.sendSetEncodings([ENCODING_RAW, ENCODING_COPY_RECT, ENCODING_DESKTOP_SIZE]);

    // Allocate initial framebuffer
    this.framebuffer = Buffer.alloc(this._width * this._height * 4);
    this.connected = true;
  }

  /** Request and wait for a full framebuffer update — returns raw RGBA pixels. */
  async captureFramebuffer(): Promise<{ width: number; height: number; data: Buffer }> {
    this.assertConnected();

    // Request full framebuffer (non-incremental)
    this.sendFramebufferUpdateRequest(false, 0, 0, this._width, this._height);

    // Read FramebufferUpdate message
    await this.readFramebufferUpdate();

    return {
      width: this._width,
      height: this._height,
      data: Buffer.from(this.framebuffer!),
    };
  }

  /** Capture framebuffer and encode as PNG. Returns base64 data URL. */
  async captureScreenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    const fb = await this.captureFramebuffer();
    const png = await encodeRgbaToPngAsync(fb.width, fb.height, fb.data);
    return {
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      width: fb.width,
      height: fb.height,
    };
  }

  /** Send a pointer (mouse) event. */
  sendPointerEvent(x: number, y: number, buttonMask: number): void {
    this.assertConnected();
    const buf = Buffer.alloc(6);
    buf[0] = 5; // PointerEvent
    buf[1] = buttonMask & 0xff;
    buf.writeUInt16BE(Math.max(0, Math.min(x, this._width - 1)), 2);
    buf.writeUInt16BE(Math.max(0, Math.min(y, this._height - 1)), 4);
    this.socket!.write(buf);
  }

  /** Send a key event. */
  sendKeyEvent(keysym: number, down: boolean): void {
    this.assertConnected();
    const buf = Buffer.alloc(8);
    buf[0] = 4; // KeyEvent
    buf[1] = down ? 1 : 0;
    buf.writeUInt16BE(0, 2); // padding
    buf.writeUInt32BE(keysym, 4);
    this.socket!.write(buf);
  }

  /** Send clipboard text to the VNC server. */
  sendClipboardText(text: string): void {
    this.assertConnected();
    const textBuf = Buffer.from(text, "latin1"); // RFB uses Latin-1
    const header = Buffer.alloc(8);
    header[0] = 6; // ClientCutText
    // 3 bytes padding
    header.writeUInt32BE(textBuf.length, 4);
    this.socket!.write(Buffer.concat([header, textBuf]));
  }

  /** Gracefully close the connection. */
  disconnect(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.reader = null;
    this.framebuffer = null;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.connected || !this.socket) {
      throw new Error("VNC client is not connected");
    }
  }

  private sendSetPixelFormat(): void {
    // type (1) + padding (3) + pixel format (16) = 20 bytes
    const buf = Buffer.alloc(20);
    buf[0] = 0; // SetPixelFormat
    // pixel format starts at offset 4
    buf[4] = 32;  // bits-per-pixel
    buf[5] = 24;  // depth
    buf[6] = 0;   // big-endian: false
    buf[7] = 1;   // true-color: true
    buf.writeUInt16BE(255, 8);  // red-max
    buf.writeUInt16BE(255, 10); // green-max
    buf.writeUInt16BE(255, 12); // blue-max
    buf[14] = 0;  // red-shift (R at byte 0)
    buf[15] = 8;  // green-shift (G at byte 1)
    buf[16] = 16; // blue-shift (B at byte 2)
    // 3 bytes padding at 17-19
    this.socket!.write(buf);
  }

  private sendSetEncodings(encodings: number[]): void {
    const buf = Buffer.alloc(4 + encodings.length * 4);
    buf[0] = 2; // SetEncodings
    // 1 byte padding
    buf.writeUInt16BE(encodings.length, 2);
    for (let i = 0; i < encodings.length; i++) {
      buf.writeInt32BE(encodings[i]!, 4 + i * 4);
    }
    this.socket!.write(buf);
  }

  private sendFramebufferUpdateRequest(
    incremental: boolean,
    x: number, y: number, width: number, height: number,
  ): void {
    const buf = Buffer.alloc(10);
    buf[0] = 3; // FramebufferUpdateRequest
    buf[1] = incremental ? 1 : 0;
    buf.writeUInt16BE(x, 2);
    buf.writeUInt16BE(y, 4);
    buf.writeUInt16BE(width, 6);
    buf.writeUInt16BE(height, 8);
    this.socket!.write(buf);
  }

  private async readFramebufferUpdate(): Promise<void> {
    // Wait for a FramebufferUpdate (type 0) message.
    // Skip non-framebuffer messages (bell, cut-text, etc.)
    const reader = this.reader!;

    while (true) {
      const msgType = await reader.readUint8();

      switch (msgType) {
        case 0: {
          // FramebufferUpdate
          await reader.read(1); // padding
          const numRects = await reader.readUint16BE();

          for (let i = 0; i < numRects; i++) {
            const rx = await reader.readUint16BE();
            const ry = await reader.readUint16BE();
            const rw = await reader.readUint16BE();
            const rh = await reader.readUint16BE();
            const encoding = await reader.readInt32BE();

            switch (encoding) {
              case ENCODING_RAW: {
                const pixelData = await reader.read(rw * rh * 4); // 32bpp
                // Copy into framebuffer at the correct position
                for (let row = 0; row < rh; row++) {
                  const srcOffset = row * rw * 4;
                  const dstOffset = ((ry + row) * this._width + rx) * 4;
                  pixelData.copy(this.framebuffer!, dstOffset, srcOffset, srcOffset + rw * 4);
                }
                break;
              }
              case ENCODING_COPY_RECT: {
                const srcX = await reader.readUint16BE();
                const srcY = await reader.readUint16BE();
                // Copy rectangle within framebuffer
                const tempBuf = Buffer.alloc(rw * rh * 4);
                for (let row = 0; row < rh; row++) {
                  const srcOff = ((srcY + row) * this._width + srcX) * 4;
                  const tmpOff = row * rw * 4;
                  this.framebuffer!.copy(tempBuf, tmpOff, srcOff, srcOff + rw * 4);
                }
                for (let row = 0; row < rh; row++) {
                  const dstOff = ((ry + row) * this._width + rx) * 4;
                  const tmpOff = row * rw * 4;
                  tempBuf.copy(this.framebuffer!, dstOff, tmpOff, tmpOff + rw * 4);
                }
                break;
              }
              case ENCODING_DESKTOP_SIZE: {
                // Server resized — update dimensions and reallocate framebuffer
                this._width = rw;
                this._height = rh;
                this.framebuffer = Buffer.alloc(rw * rh * 4);
                log.info({ width: rw, height: rh }, "VNC desktop resized");
                break;
              }
              default: {
                log.warn({ encoding }, "Unknown VNC encoding — skipping rectangle");
                // We can't skip an unknown encoding reliably, bail out
                return;
              }
            }
          }
          return; // framebuffer updated
        }
        case 2: {
          // Bell — ignore
          break;
        }
        case 3: {
          // ServerCutText
          await reader.read(3); // padding
          const textLen = await reader.readUint32BE();
          const text = (await reader.read(textLen)).toString("latin1");
          this.emit("clipboard", text);
          break;
        }
        default: {
          log.warn({ msgType }, "Unknown VNC server message — connection may desync");
          return;
        }
      }
    }
  }
}
