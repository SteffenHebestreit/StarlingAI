import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { childLogger } from "../../logger.js";
import { computeScreenshotHash } from "../computer-vision.js";
import type { ActionResult, ComputerAction, WindowInfo } from "../computer-adapters/base.js";
import type { ComputerSessionSnapshot, DisplayTopology } from "../computer-session.js";
import type {
  ComputerNodeActionRequest,
  ComputerNodeActionResponse,
  ComputerNodeHealthResponse,
  ComputerNodeSnapshotResponse,
  ComputerNodeTopologyResponse,
  ComputerNodeWindowsResponse,
} from "./protocol.js";

const log = childLogger("computer-node");
const execFileAsync = promisify(execFile);

type NutJsModule = {
  screen: {
    width(): Promise<number>;
    height(): Promise<number>;
  };
  mouse: {
    setPosition(point: unknown): Promise<void>;
    click(button: unknown): Promise<void>;
    doubleClick(button: unknown): Promise<void>;
    scrollUp(amount: number): Promise<void>;
    scrollDown(amount: number): Promise<void>;
    scrollLeft(amount: number): Promise<void>;
    scrollRight(amount: number): Promise<void>;
    pressButton(button: unknown): Promise<void>;
    releaseButton(button: unknown): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    pressKey(key: unknown): Promise<void>;
    releaseKey(key: unknown): Promise<void>;
  };
  Button: Record<string, number>;
  Key: Record<string, number>;
  Point: new (x: number, y: number) => unknown;
};

let nutModulePromise: Promise<NutJsModule> | null = null;
let screenshotModulePromise: Promise<(options?: Record<string, unknown>) => Promise<Buffer>> | null = null;

async function loadNutJs(): Promise<NutJsModule> {
  if (!nutModulePromise) {
    nutModulePromise = import("@nut-tree-fork/nut-js" as string) as Promise<NutJsModule>;
  }
  return nutModulePromise;
}

async function loadScreenshotDesktop(): Promise<(options?: Record<string, unknown>) => Promise<Buffer>> {
  if (!screenshotModulePromise) {
    screenshotModulePromise = import("screenshot-desktop" as string).then((mod) => {
      const candidate = mod.default ?? mod;
      return candidate as (options?: Record<string, unknown>) => Promise<Buffer>;
    });
  }
  return screenshotModulePromise;
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Expected PNG screenshot data");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function toDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function buildSnapshot(buffer: Buffer): ComputerNodeSnapshotResponse {
  const { width, height } = parsePngDimensions(buffer);
  return {
    screenshotHash: computeScreenshotHash(buffer),
    timestamp: Date.now(),
    frameId: randomUUID(),
    width,
    height,
    dataUrl: toDataUrl(buffer),
  };
}

async function captureDesktopSnapshot(): Promise<ComputerNodeSnapshotResponse> {
  const capture = await loadScreenshotDesktop();
  const png = await capture({ format: "png" });
  return buildSnapshot(png);
}

async function getDisplayTopology(): Promise<DisplayTopology> {
  if (process.platform === "win32") {
    try {
      const script = [
        ...getWindowsInteropPreamble(),
        "Add-Type -AssemblyName System.Windows.Forms",
        "$index = 0",
        "$monitors = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {",
        "  $item = [pscustomobject]@{",
        "    id = $index;",
        "    x = $_.Bounds.X;",
        "    y = $_.Bounds.Y;",
        "    width = $_.Bounds.Width;",
        "    height = $_.Bounds.Height;",
        "    dpiScale = 1;",
        "    primary = $_.Primary",
        "  }",
        "  $index += 1",
        "  $item",
        "}",
        "$primary = ($monitors | Where-Object { $_.primary } | Select-Object -First 1).id",
        "if ($null -eq $primary) { $primary = 0 }",
        "[pscustomobject]@{",
        "  monitors = @($monitors | ForEach-Object { [pscustomobject]@{ id = $_.id; x = $_.x; y = $_.y; width = $_.width; height = $_.height; dpiScale = $_.dpiScale } });",
        "  primary = $primary",
        "} | ConvertTo-Json -Compress",
      ].join(";");

      const { stdout } = await runPowerShell(script);
      const parsed = decodePowerShellJson<DisplayTopology | null>(stdout, null);
      if (parsed && Array.isArray(parsed.monitors) && parsed.monitors.length > 0) {
        return parsed;
      }
    } catch {
      // Fall back to nut.js / screenshot dimensions below.
    }
  }

  try {
    const nut = await loadNutJs();
    const width = await nut.screen.width();
    const height = await nut.screen.height();
    return {
      monitors: [{ id: 0, x: 0, y: 0, width, height, dpiScale: 1 }],
      primary: 0,
    };
  } catch {
    const snapshot = await captureDesktopSnapshot();
    return {
      monitors: [{ id: 0, x: 0, y: 0, width: snapshot.width, height: snapshot.height, dpiScale: 1 }],
      primary: 0,
    };
  }
}

function decodePowerShellJson<T>(stdout: string, fallback: T): T {
  const trimmed = stdout.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed) as T;
}

function escapePowerShellSingleQuoted(text: string): string {
  return text.replace(/'/g, "''");
}

function getWindowsInteropPreamble(): string[] {
  return [
    "$signature = @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "public static class Win32Interop {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
    "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null",
    "[Win32Interop]::SetProcessDPIAware() | Out-Null",
  ];
}

async function runPowerShell(command: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function listWindows(): Promise<WindowInfo[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const script = [
    ...getWindowsInteropPreamble(),
    "$foreground = [Win32Interop]::GetForegroundWindow()",
    "$wins = New-Object System.Collections.ArrayList",
    "$callback = [Win32Interop+EnumWindowsProc]{",
    "  param([IntPtr]$hWnd, [IntPtr]$lParam)",
    "  if (-not [Win32Interop]::IsWindowVisible($hWnd)) { return $true }",
    "  $sb = New-Object System.Text.StringBuilder 1024",
    "  [void][Win32Interop]::GetWindowText($hWnd, $sb, $sb.Capacity)",
    "  $title = $sb.ToString()",
    "  if ([string]::IsNullOrWhiteSpace($title)) { return $true }",
    "  $rect = [RECT]::new()",
    "  if (-not [Win32Interop]::GetWindowRect($hWnd, [ref]$rect)) { return $true }",
    "  $pid = [uint32]0",
    "  [void][Win32Interop]::GetWindowThreadProcessId($hWnd, [ref]$pid)",
    "  $processName = ''",
    "  if ($pid -ne 0) {",
    "    try { $processName = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { $processName = '' }",
    "  }",
    "  [void]$wins.Add([pscustomobject]@{",
    "    title = $title;",
    "    processName = $processName;",
    "    bounds = [pscustomobject]@{",
    "      x = $rect.Left;",
    "      y = $rect.Top;",
    "      width = [Math]::Max(0, $rect.Right - $rect.Left);",
    "      height = [Math]::Max(0, $rect.Bottom - $rect.Top)",
    "    };",
    "    isFocused = ($hWnd -eq $foreground)",
    "  })",
    "  return $true",
    "}",
    "[void][Win32Interop]::EnumWindows($callback, [IntPtr]::Zero)",
    "$wins | Sort-Object -Property @{ Expression = { if ($_.isFocused) { 0 } else { 1 } } }, title | ConvertTo-Json -Compress",
  ].join(" ");

  const { stdout } = await runPowerShell(script);
  const parsed = decodePowerShellJson<WindowInfo[] | WindowInfo>(stdout, []);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function focusWindow(titlePattern: string): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const escaped = escapePowerShellSingleQuoted(titlePattern);
  // NOTE: The here-string (@'…'@) MUST have @' as the last token on its line
  // and '@ as the first token on its line.  Joining with "\n" preserves that.
  const script = [
    "$signature = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class Win32Focus {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null",
    `$process = Get-Process | Where-Object { $_.MainWindowTitle -match '${escaped}' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    "if (-not $process) { Write-Output 'false'; exit 0 }",
    "[Win32Focus]::ShowWindowAsync($process.MainWindowHandle, 5) | Out-Null",
    "[Win32Focus]::SetForegroundWindow($process.MainWindowHandle) | Out-Null",
    "Write-Output 'true'",
  ].join("\n");

  const { stdout } = await runPowerShell(script);
  return stdout.trim().toLowerCase() === "true";
}

async function readClipboard(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Clipboard read is currently implemented for Windows nodes only");
  }
  const { stdout } = await runPowerShell("Get-Clipboard -Raw");
  return stdout;
}

async function writeClipboard(text: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Clipboard write is currently implemented for Windows nodes only");
  }
  const encoded = Buffer.from(text, "utf8").toString("base64");
  await runPowerShell(`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | Set-Clipboard`);
}

async function executeDesktopAction(action: ComputerAction): Promise<ComputerNodeActionResponse> {
  const start = Date.now();
  try {
    const nut = await loadNutJs();
    const Point = (nut as unknown as { Point: new (x: number, y: number) => unknown }).Point;

    switch (action.type) {
      case "click": {
        const buttonMap = { left: nut.Button.LEFT, right: nut.Button.RIGHT, middle: nut.Button.MIDDLE };
        await nut.mouse.setPosition(new Point(action.x, action.y));
        if (action.doubleClick) {
          await nut.mouse.doubleClick(buttonMap[action.button ?? "left"]);
        } else {
          await nut.mouse.click(buttonMap[action.button ?? "left"]);
        }
        break;
      }
      case "type": {
        await nut.keyboard.type(action.text);
        if (action.pressEnter) {
          await nut.keyboard.pressKey(nut.Key.Enter);
          await nut.keyboard.releaseKey(nut.Key.Enter);
        }
        break;
      }
      case "hotkey": {
        // Normalise: the tool layer should send "ctrl+shift+i" but guard against
        // a JSON-array string like '["ctrl","shift","i"]' arriving here.
        let rawKeys: string = action.keys;
        if (rawKeys.startsWith("[")) {
          try {
            const arr = JSON.parse(rawKeys);
            if (Array.isArray(arr)) rawKeys = arr.join("+");
          } catch { /* leave as-is */ }
        }
        const parts = rawKeys.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
        const keyMap: Record<string, number | undefined> = {
          ctrl: nut.Key.LeftControl,
          control: nut.Key.LeftControl,
          alt: nut.Key.LeftAlt,
          shift: nut.Key.LeftShift,
          meta: nut.Key.LeftSuper,
          win: nut.Key.LeftSuper,
          super: nut.Key.LeftSuper,
          enter: nut.Key.Enter,
          return: nut.Key.Enter,
          esc: nut.Key.Escape,
          escape: nut.Key.Escape,
          tab: nut.Key.Tab,
          space: nut.Key.Space,
          backspace: nut.Key.Backspace,
          delete: nut.Key.Delete,
          up: nut.Key.Up,
          down: nut.Key.Down,
          left: nut.Key.Left,
          right: nut.Key.Right,
          f1: nut.Key.F1,
          f2: nut.Key.F2,
          f3: nut.Key.F3,
          f4: nut.Key.F4,
          f5: nut.Key.F5,
          f6: nut.Key.F6,
          f7: nut.Key.F7,
          f8: nut.Key.F8,
          f9: nut.Key.F9,
          f10: nut.Key.F10,
          f11: nut.Key.F11,
          f12: nut.Key.F12,
        };
        const keys: number[] = [];
        for (const part of parts) {
          if (keyMap[part] !== undefined) {
            keys.push(keyMap[part]!);
            continue;
          }
          if (part.length === 1) {
            const keyName = part.toUpperCase() as keyof typeof nut.Key;
            if (nut.Key[keyName] !== undefined) {
              keys.push(nut.Key[keyName] as number);
            }
          }
        }
        if (keys.length === 0) {
          throw new Error(`Unsupported hotkey: ${action.keys}`);
        }
        for (const key of keys) await nut.keyboard.pressKey(key);
        for (const key of [...keys].reverse()) await nut.keyboard.releaseKey(key);
        break;
      }
      case "scroll": {
        await nut.mouse.setPosition(new Point(action.x, action.y));
        const amount = action.amount ?? 3;
        if (action.direction === "up") {
          await nut.mouse.scrollUp(amount);
        } else if (action.direction === "down") {
          await nut.mouse.scrollDown(amount);
        } else if (action.direction === "left") {
          await nut.mouse.scrollLeft(amount);
        } else {
          await nut.mouse.scrollRight(amount);
        }
        break;
      }
      case "drag": {
        await nut.mouse.setPosition(new Point(action.startX, action.startY));
        await nut.mouse.pressButton(nut.Button.LEFT);
        await nut.mouse.setPosition(new Point(action.endX, action.endY));
        await nut.mouse.releaseButton(nut.Button.LEFT);
        break;
      }
      case "focus_window": {
        const focused = await focusWindow(action.titlePattern);
        if (!focused) {
          throw new Error(`No window matched pattern: ${action.titlePattern}`);
        }
        break;
      }
      case "clipboard_read": {
        const contents = await readClipboard();
        return {
          success: true,
          output: contents,
          durationMs: Date.now() - start,
        };
      }
      case "clipboard_write": {
        await writeClipboard(action.text);
        break;
      }
      case "list_windows": {
        const windows = await listWindows();
        return {
          success: true,
          output: JSON.stringify(windows),
          durationMs: Date.now() - start,
        };
      }
      case "capture_region":
      case "wait_for":
      case "upload_file":
      case "download_file":
        throw new Error(`Action '${action.type}' is not implemented on the node host yet`);
      default:
        throw new Error(`Unsupported action type: ${(action as { type: string }).type}`);
    }

    const snapshot = await captureDesktopSnapshot();
    return {
      success: true,
      output: `Executed ${action.type}`,
      durationMs: Date.now() - start,
      screenshotAfter: snapshot.dataUrl,
      screenshotHash: snapshot.screenshotHash,
      screenshotDataUrl: snapshot.dataUrl,
      screenshotWidth: snapshot.width,
      screenshotHeight: snapshot.height,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
}

export interface ComputerNodeServerOptions {
  host: string;
  port: number;
  authToken?: string;
  label?: string;
}

export interface ComputerNodeServerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createComputerNodeServer(options: ComputerNodeServerOptions): ComputerNodeServerHandle {
  const app = new Hono();
  let server: Server | null = null;

  app.use("*", async (c, next) => {
    if (!options.authToken) {
      await next();
      return;
    }

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (token !== options.authToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", async (c) => {
    let healthy = true;
    try {
      await getDisplayTopology();
    } catch (error) {
      healthy = false;
      log.warn({ error }, "Computer node health check failed");
    }
    const body: ComputerNodeHealthResponse = {
      ok: true,
      healthy,
      label: options.label ?? "Remote desktop node",
      platform: process.platform,
    };
    return c.json(body);
  });

  app.get("/display-topology", async (c) => {
    const body: ComputerNodeTopologyResponse = { topology: await getDisplayTopology() };
    return c.json(body);
  });

  app.get("/snapshot", async (c) => {
    const snapshot = await captureDesktopSnapshot();
    return c.json(snapshot);
  });

  app.get("/windows", async (c) => {
    let windows: WindowInfo[] = [];
    try {
      windows = await listWindows();
    } catch (error) {
      log.warn({ error }, "Computer node window enumeration failed; returning empty window list");
    }
    const body: ComputerNodeWindowsResponse = { windows };
    return c.json(body);
  });

  app.post("/action", async (c) => {
    const { sessionId, action } = await c.req.json<ComputerNodeActionRequest>();
    log.info({ sessionId, actionType: action.type }, "Executing computer-node action");
    const result: ComputerNodeActionResponse = await executeDesktopAction(action);
    return c.json(result, result.success ? 200 : 400);
  });

  return {
    async start() {
      if (server) return;
      server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
        const honoReq = new Request(requestUrl, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
          duplex: "half",
        } as RequestInit & { duplex: "half" });

        void Promise.resolve(app.fetch(honoReq)).then(async (response) => {
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
          res.writeHead(response.status, responseHeaders);
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        }).catch((error) => {
          log.error({ error }, "Computer node request failed");
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(options.port, options.host, () => {
          server!.off("error", reject);
          resolve();
        });
      });

      log.info({ host: options.host, port: options.port }, "Computer node server started");
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server = null;
    },
  };
}