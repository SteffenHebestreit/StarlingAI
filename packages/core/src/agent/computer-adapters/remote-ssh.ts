/**
 * SSH Remote Computer Adapter — command-line control via SSH.
 *
 * This adapter provides two modes of operation:
 *
 * 1. **Standalone** — For servers / headless targets where GUI interaction
 *    isn't needed. Executes commands, reads output, manages files.
 *
 * 2. **Companion** — Paired with a VNC adapter to provide enhanced
 *    capabilities (window listing via wmctrl, file transfer via scp/sftp,
 *    process management, etc.) that the RFB protocol alone can't do.
 *
 * Uses the system's `ssh` command (no native dependency) with key-based or
 * password authentication via sshpass.
 *
 * Architecture:
 *   ┌─────────────────┐     SSH (TCP:22)   ┌──────────────────┐
 *   │  StarlingAI      │ ───────────────► │  Target Machine   │
 *   │  Gateway          │                  │  Any Unix/Windows │
 *   │  SshAdapter      │ ◄──── stdout     │  (OpenSSH server) │
 *   └─────────────────┘                   └──────────────────┘
 */

import { execFile, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { childLogger } from "../../logger.js";
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

const log = childLogger("agent:computer-adapter:ssh");
const execFileAsync = promisify(execFile);
const execAsync = promisify(execCb);

export interface SshAdapterConfig {
  host: string;
  port: number;
  username: string;
  /** Path to SSH private key, or password (requires sshpass). */
  credentials?: string;
  /** "key" | "password" — defaults to "key". */
  authMethod?: "key" | "password";
  /** Connection timeout (ms). */
  connectTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCredentials(cred?: string): string | undefined {
  if (!cred) return undefined;
  if (cred.startsWith("$") && !cred.startsWith("$$")) {
    const val = process.env[cred.slice(1)];
    if (!val) log.warn({ envKey: cred.slice(1) }, "Env var for SSH credentials is not set");
    return val;
  }
  return cred.replace(/^\$\$/, "$");
}

export class SshComputerAdapter implements ComputerAdapter {
  readonly name = "remote_ssh";

  private session: ComputerSession | null = null;
  private sshAvailable = false;

  constructor(private readonly config: SshAdapterConfig) {}

  private get credentials(): string | undefined {
    return resolveCredentials(this.config.credentials);
  }

  async initialize(session: ComputerSession): Promise<void> {
    this.session = session;

    // Verify ssh is available
    try {
      await execFileAsync("ssh", ["-V"]);
      this.sshAvailable = true;
    } catch {
      throw new Error("OpenSSH client is not installed — required for SSH adapter");
    }

    // Verify connectivity
    const result = await this.exec("echo starlingai-ssh-ready");
    if (!result.includes("starlingai-ssh-ready")) {
      throw new Error(`SSH connection to ${this.config.host}:${this.config.port} failed: ${result}`);
    }

    log.info({
      sessionId: session.id,
      host: this.config.host,
      port: this.config.port,
    }, "SSH adapter initialized");
  }

  async captureSnapshot(): Promise<ComputerSessionSnapshot> {
    // SSH is text-only — no screenshot capability.
    // When paired with VNC, use the VNC adapter for screenshots.
    return {
      screenshotHash: "",
      timestamp: Date.now(),
      frameId: `ssh-${randomUUID()}`,
    };
  }

  async executeAction(action: ComputerAction): Promise<ActionResult> {
    this.assertInitialized();
    const start = Date.now();

    try {
      let output: string;
      switch (action.type) {
        case "type": {
          // "Type" in SSH context = execute as a shell command
          output = await this.exec(action.text);
          break;
        }
        case "clipboard_read": {
          // Try xclip on remote if X11 is available
          try {
            output = await this.exec("xclip -selection clipboard -o 2>/dev/null || echo '(no clipboard)'");
          } catch {
            output = "(clipboard not available via SSH)";
          }
          break;
        }
        case "clipboard_write": {
          const safeText = action.text.replace(/'/g, "'\\''");
          await this.exec(`echo '${safeText}' | xclip -selection clipboard 2>/dev/null || true`);
          output = `Clipboard set (${action.text.length} chars)`;
          break;
        }
        case "list_windows": {
          // Use wmctrl if available on remote
          try {
            const raw = await this.exec("wmctrl -l -G -p 2>/dev/null || echo 'wmctrl not available'");
            output = raw;
          } catch {
            output = "Window listing not available via SSH";
          }
          break;
        }
        case "focus_window": {
          const titleSafe = action.titlePattern.replace(/'/g, "'\\''");
          try {
            await this.exec(`wmctrl -a '${titleSafe}' 2>/dev/null`);
            output = `Focused window matching: ${action.titlePattern}`;
          } catch {
            output = `Could not focus window — wmctrl may not be available`;
          }
          break;
        }
        case "upload_file": {
          output = await this.scpUpload(action.localPath, action.targetPath);
          break;
        }
        case "download_file": {
          output = await this.scpDownload(action.remotePath, action.localPath);
          break;
        }
        case "hotkey": {
          // Use xdotool on remote for hotkeys (requires X11)
          try {
            await this.exec(`DISPLAY=:1 xdotool key '${action.keys}' 2>/dev/null`);
            output = `Hotkey sent via xdotool: ${action.keys}`;
          } catch {
            output = `Hotkey '${action.keys}' — xdotool not available on remote`;
          }
          break;
        }
        case "click": {
          // Use xdotool on remote for clicks
          try {
            const btn = action.button === "right" ? "3" : action.button === "middle" ? "2" : "1";
            await this.exec(`DISPLAY=:1 xdotool mousemove ${action.x} ${action.y} click ${btn} 2>/dev/null`);
            output = `Clicked at (${action.x}, ${action.y}) via xdotool`;
          } catch {
            output = `Click at (${action.x}, ${action.y}) — xdotool not available on remote`;
          }
          break;
        }
        default:
          output = `SSH adapter does not natively support '${(action as {type: string}).type}' — use VNC adapter for GUI actions.`;
      }

      return { success: true, output, durationMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async getDisplayTopology(): Promise<DisplayTopology> {
    // Try to detect from X11 on remote
    try {
      const raw = await this.exec("DISPLAY=:1 xdpyinfo 2>/dev/null | grep 'dimensions:' | awk '{print $2}'");
      const match = /(\d+)x(\d+)/.exec(raw);
      if (match) {
        return {
          monitors: [{ id: 0, x: 0, y: 0, width: Number(match[1]), height: Number(match[2]), dpiScale: 1 }],
          primary: 0,
        };
      }
    } catch { /* fallback below */ }

    return {
      monitors: [{ id: 0, x: 0, y: 0, width: 1920, height: 1080, dpiScale: 1 }],
      primary: 0,
    };
  }

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const raw = await this.exec("wmctrl -l -G -p 2>/dev/null");
      return this.parseWmctrlOutput(raw);
    } catch {
      return [];
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.exec("echo ok");
      return result.trim() === "ok";
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.session = null;
  }

  // ── Public API for Companion Mode ───────────────────────────────────────────

  /** Execute a command on the remote machine via SSH. */
  async exec(command: string): Promise<string> {
    const sshArgs = this.buildSshArgs();
    // Use -- to prevent command injection through SSH args
    const fullCmd = this.buildAuthPrefix() + `ssh ${sshArgs.join(" ")} -- ${this.shellQuote(command)}`;
    try {
      const { stdout, stderr } = await execAsync(fullCmd, {
        timeout: this.config.connectTimeoutMs ?? 30_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      if (stderr.trim()) {
        log.debug({ stderr: stderr.substring(0, 200) }, "SSH stderr output");
      }
      return stdout;
    } catch (err) {
      // Scrub credential values from error messages to prevent password leaks
      // in audit logs and agent responses.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(this.scrubCredentials(msg));
    }
  }

  /** Upload a file to the remote machine via SCP. */
  private async scpUpload(localPath: string, remotePath?: string): Promise<string> {
    const target = remotePath ?? `/tmp/${localPath.split("/").pop() ?? "upload"}`;
    const sshPortArgs = ["-P", String(this.config.port)];
    const authArgs = this.config.authMethod === "key" && this.credentials
      ? ["-i", this.credentials] : [];
    const args = [...authArgs, ...sshPortArgs,
      "-o", "StrictHostKeyChecking=accept-new",
      localPath,
      `${this.config.username}@${this.config.host}:${target}`,
    ];
    await execFileAsync("scp", args, { timeout: 60_000 });
    return `Uploaded ${localPath} → ${target}`;
  }

  /** Download a file from the remote machine via SCP. */
  private async scpDownload(remotePath: string, localPath?: string): Promise<string> {
    const target = localPath ?? `/tmp/${remotePath.split("/").pop() ?? "download"}`;
    const sshPortArgs = ["-P", String(this.config.port)];
    const authArgs = this.config.authMethod === "key" && this.credentials
      ? ["-i", this.credentials] : [];
    const args = [...authArgs, ...sshPortArgs,
      "-o", "StrictHostKeyChecking=accept-new",
      `${this.config.username}@${this.config.host}:${remotePath}`,
      target,
    ];
    await execFileAsync("scp", args, { timeout: 60_000 });
    return `Downloaded ${remotePath} → ${target}`;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private buildSshArgs(): string[] {
    const args = [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "BatchMode=yes",
      "-p", String(this.config.port),
    ];
    if (this.config.authMethod === "key" && this.credentials) {
      args.push("-i", this.credentials);
    }
    args.push(`${this.config.username}@${this.config.host}`);
    return args;
  }

  private buildAuthPrefix(): string {
    if (this.config.authMethod === "password" && this.credentials) {
      // Use sshpass for password auth
      const safePw = this.credentials.replace(/'/g, "'\\''");
      return `sshpass -p '${safePw}' `;
    }
    return "";
  }

  private shellQuote(cmd: string): string {
    // Use bash -c with single-quoted string (escape single quotes)
    return `bash -c '${cmd.replace(/'/g, "'\\''")}'`;
  }

  /** Strip credential values from error messages so they don't leak into logs / agent output. */
  private scrubCredentials(message: string): string {
    if (this.credentials) {
      // Replace literal password value (possibly shell-escaped) with a redaction marker
      const escaped = this.credentials.replace(/'/g, "'\\''");
      let scrubbed = message.replaceAll(this.credentials, "[REDACTED]");
      if (escaped !== this.credentials) {
        scrubbed = scrubbed.replaceAll(escaped, "[REDACTED]");
      }
      // Also catch sshpass -p '...' pattern in case of partial matches
      scrubbed = scrubbed.replace(/sshpass\s+-p\s+'[^']*'/g, "sshpass -p '[REDACTED]'");
      return scrubbed;
    }
    return message;
  }

  private parseWmctrlOutput(raw: string): WindowInfo[] {
    const lines = raw.trim().split("\n").filter((l) => l.trim());
    const windows: WindowInfo[] = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      // Format: WID DESKTOP PID X Y W H HOSTNAME TITLE...
      const x = parseInt(parts[3]!, 10);
      const y = parseInt(parts[4]!, 10);
      const w = parseInt(parts[5]!, 10);
      const h = parseInt(parts[6]!, 10);
      const title = parts.slice(8).join(" ");
      if (isNaN(x) || isNaN(y)) continue;
      windows.push({
        title,
        processName: "",
        bounds: { x, y, width: w, height: h },
        isFocused: false,
      });
    }
    return windows;
  }

  private assertInitialized(): void {
    if (!this.session) {
      throw new Error("SSH adapter is not initialized");
    }
  }
}
