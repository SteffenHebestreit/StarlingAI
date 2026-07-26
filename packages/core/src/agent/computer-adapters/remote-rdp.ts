/**
 * RDP Remote Computer Adapter — connects via FreeRDP to Windows machines.
 *
 * Uses `xfreerdp3` (FreeRDP 3.x) CLI to establish an RDP session, then
 * controls it via:
 *   • xdotool for mouse/keyboard input to the FreeRDP window
 *   • Screenshot of the FreeRDP X11 window via import/scrot
 *
 * This adapter requires a graphical environment (X11) on the gateway host.
 * For headless deployments, use the Docker computer-desktop image which
 * provides Xvfb + VNC.
 *
 * Prerequisites:
 *   - xfreerdp3 (FreeRDP 3.x) installed
 *   - xdotool installed
 *   - X11 display available (DISPLAY env var set)
 *
 * For a simpler setup, use the VNC adapter instead — it works purely over
 * TCP with no X11 dependency on the gateway side.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { Socket } from "node:net";
import { childLogger } from "../../logger.js";
import { computeScreenshotHash } from "../computer-vision.js";
import type { RemoteAdapterConfig } from "../../config/computer-use-schema.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerAdapter,
  WindowInfo,
} from "./base.js";
import type {
  ComputerSession,
  ComputerSessionSnapshot,
  DisplayTopology,
} from "../computer-session.js";

const log = childLogger("agent:computer-adapter:rdp");
const execFileAsync = promisify(execFile);
const DEFAULT_RDP_RESOLUTION = { width: 1920, height: 1080 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDisplayResolution(value: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/u.exec(value?.trim() ?? "");
  if (!match) return DEFAULT_RDP_RESOLUTION;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 640 || height < 480) {
    return DEFAULT_RDP_RESOLUTION;
  }
  return { width, height };
}

/** Xvfb display tracker — shared across all RDP sessions in this process. */
let xvfbDisplay: string | null = null;

/**
 * Ensure an X11 display is available. If DISPLAY is already set (e.g. inside
 * the computer-desktop container), use it. Otherwise start Xvfb on a random
 * display number so FreeRDP has a headless framebuffer to render into.
 */
async function ensureDisplay(): Promise<string> {
  if (xvfbDisplay) return xvfbDisplay;
  if (process.env.DISPLAY) {
    xvfbDisplay = process.env.DISPLAY;
    return xvfbDisplay;
  }

  // Pick a display number unlikely to collide
  const displayNum = 50 + Math.floor(Math.random() * 50);
  const display = `:${displayNum}`;

  // Deliberately detached + unref'd: the framebuffer is shared by every RDP
  // session and must outlive any single one, so we intentionally keep no
  // handle and never kill it — the container lifecycle reaps it.
  const { spawn } = await import("node:child_process");
  spawn("Xvfb", [display, "-screen", "0", "1920x1080x24", "-ac"], {
    detached: true,
    stdio: "ignore",
  }).unref();

  // Wait for the display to become usable
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await execFileAsync("xdpyinfo", ["-display", display]);
      break;
    } catch {
      await sleep(200);
    }
  }

  xvfbDisplay = display;
  process.env.DISPLAY = display;
  log.info({ display }, "Started Xvfb for headless RDP");
  return display;
}

export class RdpComputerAdapter implements ComputerAdapter {
  readonly name = "remote_rdp";

  private session: ComputerSession | null = null;
  private xfreerdpPid: number | null = null;
  private windowId: string | null = null;
  private width = DEFAULT_RDP_RESOLUTION.width;
  private height = DEFAULT_RDP_RESOLUTION.height;

  constructor(private readonly config: RemoteAdapterConfig) {}

  async initialize(session: ComputerSession): Promise<void> {
    this.session = session;
    const requestedResolution = parseDisplayResolution(this.config.displayResolution);
    this.width = requestedResolution.width;
    this.height = requestedResolution.height;

    // Ensure an X11 display is available (starts Xvfb if headless)
    await ensureDisplay();

    // Verify xfreerdp3/xfreerdp is available
    try {
      await execFileAsync("which", ["xfreerdp3"]);
    } catch {
      try {
        await execFileAsync("which", ["xfreerdp"]);
      } catch {
        throw new Error(
          "FreeRDP is not installed. The gateway image should include freerdp2-x11 or freerdp3-x11.\n" +
          "Rebuild with: start.bat --build",
        );
      }
    }

    function resolveCredentials(cred?: string): string | undefined {
      if (!cred) return undefined;
      const stripped = cred.trim();
      if (stripped.startsWith("$") && !stripped.startsWith("$$")) {
        const val = process.env[stripped.slice(1)];
        if (!val) log.warn({ envKey: stripped.slice(1) }, "Env var for RDP credentials is not set");
        return val;
      }
      return stripped.replace(/^\$\$/, "$");
    }
    const rawCredentials = resolveCredentials(this.config.credentials);
    if (!rawCredentials) {
      throw new Error("RDP adapter requires credentials in 'username:password' format.");
    }

    const [username, password] = rawCredentials.split(":", 2) as [string, string | undefined];
    if (!username || !password) {
      throw new Error(
        "RDP adapter credentials must be in 'username:password' format. " +
        `Received '${rawCredentials}'.`,
      );
    }

    // Build xfreerdp command — flags differ between v2 and v3
    const { cmd, isV3 } = this.findFreeRdp();
    const args = [
      `/v:${this.config.host}:${this.config.port}`,
      `/u:${username}`,
      ...(password ? [`/p:${password}`] : []),
      `/size:${this.width}x${this.height}`,
      isV3 ? "/cert:tofu" : "/cert-ignore",
      "/dynamic-resolution",
      "/gfx",
      "+clipboard",
    ];

    log.info({ host: this.config.host, port: this.config.port, width: this.width, height: this.height }, "Starting RDP session");

    // Fast TCP pre-check — fail in seconds, not wait for xfreerdp's long timeout
    await new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`RDP host ${this.config.host}:${this.config.port} is not reachable (TCP connect timed out after 8s)`)); }, 8_000);
      timer.unref();
      sock.connect(this.config.port, this.config.host, () => { clearTimeout(timer); sock.destroy(); resolve(); });
      sock.on("error", (err) => { clearTimeout(timer); reject(new Error(`RDP host ${this.config.host}:${this.config.port} is not reachable: ${err.message}`)); });
    });

    // Launch xfreerdp in background
    const { spawn } = await import("node:child_process");
    const display = xvfbDisplay ?? process.env.DISPLAY ?? ":0";
    const proc = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DISPLAY: display },
    });
    proc.unref();
    this.xfreerdpPid = proc.pid ?? null;

    // Wait for the FreeRDP window to appear
    await this.waitForRdpWindow(20_000);

    log.info({ sessionId: session.id, windowId: this.windowId }, "RDP adapter initialized");
  }

  async captureSnapshot(): Promise<ComputerSessionSnapshot> {
    this.assertInitialized();

    const screenshotPath = join(tmpdir(), `starlingai-rdp-${randomUUID()}.png`);
    try {
      // Capture the FreeRDP window using import (ImageMagick)
      if (this.windowId) {
        await execFileAsync("import", ["-window", this.windowId, screenshotPath]);
      } else {
        // Fallback: capture full screen
        await execFileAsync("import", ["-window", "root", screenshotPath]);
      }

      const pngBuffer = await readFile(screenshotPath);
      const hash = computeScreenshotHash(pngBuffer);

      // Parse PNG dimensions
      const width = pngBuffer.readUInt32BE(16);
      const height = pngBuffer.readUInt32BE(20);

      return {
        screenshotHash: hash,
        timestamp: Date.now(),
        frameId: `rdp-${randomUUID()}`,
        dataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`,
        width,
        height,
      };
    } finally {
      await unlink(screenshotPath).catch(() => {});
    }
  }

  async executeAction(action: ComputerAction): Promise<ActionResult> {
    this.assertInitialized();
    const start = Date.now();

    try {
      let output: string;

      // Focus the RDP window before sending input
      if (this.windowId) {
        await execFileAsync("xdotool", ["windowfocus", "--sync", this.windowId]).catch(() => {});
      }

      switch (action.type) {
        case "click":
          output = await this.handleClick(action);
          break;
        case "type":
          output = await this.handleType(action);
          break;
        case "hotkey":
          output = await this.handleHotkey(action);
          break;
        case "scroll":
          output = await this.handleScroll(action);
          break;
        default:
          output = `RDP action '${action.type}' — use xdotool for basic input or VNC adapter for full support.`;
      }

      // Auto-screenshot after action — give the display time to render
      const { POST_ACTION_SETTLE_MS: settleMs } = await import("./constants.js");
      await sleep(settleMs);
      let snapshot: ComputerSessionSnapshot | undefined;
      try {
        snapshot = await this.captureSnapshot();
      } catch {
        // best effort
      }

      return {
        success: true,
        output,
        screenshotAfter: snapshot?.dataUrl,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async getDisplayTopology(): Promise<DisplayTopology> {
    return {
      monitors: [{ id: 0, x: 0, y: 0, width: this.width, height: this.height, dpiScale: 1 }],
      primary: 0,
    };
  }

  async listWindows(): Promise<WindowInfo[]> {
    // RDP window contents aren't individually addressable via xdotool
    return [];
  }

  async isHealthy(): Promise<boolean> {
    if (!this.xfreerdpPid) return false;
    try {
      process.kill(this.xfreerdpPid, 0); // signal 0 = check if process exists
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.session = null;
    if (this.xfreerdpPid) {
      try {
        process.kill(this.xfreerdpPid, "SIGTERM");
      } catch { /* already exited */ }
      this.xfreerdpPid = null;
    }
    this.windowId = null;
  }

  // ── Input Handlers ──────────────────────────────────────────────────────────

  private async handleClick(action: { x: number; y: number; button?: string; doubleClick?: boolean }): Promise<string> {
    if (!this.windowId) throw new Error("No RDP window found");
    const btn = action.button === "right" ? "3" : action.button === "middle" ? "2" : "1";

    // Move mouse relative to the RDP window, then click
    await execFileAsync("xdotool", [
      "mousemove", "--window", this.windowId,
      String(action.x), String(action.y),
    ]);
    const clickCmd = action.doubleClick ? "click --repeat 2 --delay 100" : "click";
    await execFileAsync("xdotool", [...clickCmd.split(" "), btn]);
    return `${action.button ?? "left"} ${action.doubleClick ? "double-" : ""}click at (${action.x}, ${action.y})`;
  }

  private async handleType(action: { text: string; pressEnter?: boolean }): Promise<string> {
    await execFileAsync("xdotool", ["type", "--delay", "20", action.text]);
    if (action.pressEnter) {
      await execFileAsync("xdotool", ["key", "Return"]);
    }
    return `Typed ${action.text.length} chars${action.pressEnter ? " + Enter" : ""}`;
  }

  private async handleHotkey(action: { keys: string }): Promise<string> {
    // xdotool uses + separator, same as our format
    await execFileAsync("xdotool", ["key", action.keys]);
    return `Hotkey: ${action.keys}`;
  }

  private async handleScroll(action: { x: number; y: number; direction: string; amount?: number }): Promise<string> {
    if (this.windowId) {
      await execFileAsync("xdotool", [
        "mousemove", "--window", this.windowId,
        String(action.x), String(action.y),
      ]);
    }
    const steps = Math.max(1, Math.round((action.amount ?? 100) / 30));
    const btn = action.direction === "up" ? "4" : "5";
    await execFileAsync("xdotool", ["click", "--repeat", String(steps), "--delay", "50", btn]);
    return `Scrolled ${action.direction} ${steps} steps`;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private findFreeRdp(): { cmd: string; isV3: boolean } {
    // Prefer xfreerdp3 (FreeRDP 3.x), fall back to xfreerdp (FreeRDP 2.x)
    try {
      execFileSync("which", ["xfreerdp3"], { stdio: "ignore" });
      return { cmd: "xfreerdp3", isV3: true };
    } catch {
      return { cmd: "xfreerdp", isV3: false };
    }
  }

  private async waitForRdpWindow(timeoutMs: number): Promise<void> {
    if (!this.xfreerdpPid) throw new Error("xfreerdp process not started");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        // Search by PID — works regardless of FreeRDP version or window title
        const { stdout } = await execFileAsync("xdotool", ["search", "--pid", String(this.xfreerdpPid)]);
        const wid = stdout.trim().split("\n")[0];
        if (wid) {
          this.windowId = wid;
          return;
        }
      } catch { /* not yet */ }
      await sleep(500);
    }
    throw new Error(`RDP window did not appear within ${timeoutMs}ms — check xfreerdp connection to ${this.config.host}:${this.config.port}`);
  }

  private assertInitialized(): void {
    if (!this.session) {
      throw new Error("RDP adapter is not initialized");
    }
  }
}
