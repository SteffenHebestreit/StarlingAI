import { describe, expect, it } from "vitest";
import { cdpEndpointOf, createBrowserWatchdog, HANGS_BEFORE_RECOVERY, RECOVERY_COOLDOWN_MS, type BrowserWatchdogDeps } from "../tools/browser-watchdog.js";

/**
 * E2E 2026-10-22: the browser-vnc Chrome stopped completing Playwright's CDP connections, and every
 * browser call timed out at "<ws connecting>" for half an hour until the container was restarted.
 */
const HANG = "### Error\nTimeoutError: Timeout 30000ms exceeded.\nCall log:\n  - <ws preparing> retrieving websocket url from http://browser-vnc:9222\n  - <ws connecting> ws://browser-vnc:9222/devtools/browser/826d16d9";
const PAGE_ERROR = "### Error\nTimeoutError: page.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Senden' })";

function fakes(over: Partial<BrowserWatchdogDeps> = {}) {
  const docker: string[][] = [];
  let clock = 1_000_000;
  let readyAfter = 1;
  const deps: BrowserWatchdogDeps = {
    endpoint: () => "http://browser-vnc:9222",
    docker: async (args) => { docker.push(args); return args[0] === "ps" ? "2557f5bca659\n" : ""; },
    cdpReady: async () => (readyAfter-- <= 0),
    assistPending: () => false,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...over,
  };
  return { deps, docker, advance: (ms: number) => { clock += ms; } };
}

describe("the browser watchdog", () => {
  it("restarts the browser's container after two calls in a row hang while connecting", async () => {
    const { deps, docker } = fakes();
    const watchdog = createBrowserWatchdog(deps);
    expect(watchdog.noteFailure(HANG)).toBeNull();
    const recovery = watchdog.noteFailure(HANG);
    expect(recovery).not.toBeNull();
    await recovery;
    expect(docker).toEqual([
      ["ps", "-q", "--filter", "label=com.docker.compose.service=browser-vnc"],
      ["stop", "-t", "5", "2557f5bca659"],
      ["start", "2557f5bca659"],
    ]);
    expect(HANGS_BEFORE_RECOVERY).toBe(2);
  });

  it("counts only hangs in a row: a call that went through, or another failure, starts the count again", async () => {
    const { deps, docker } = fakes();
    const watchdog = createBrowserWatchdog(deps);
    watchdog.noteFailure(HANG);
    watchdog.noteSuccess();
    expect(watchdog.noteFailure(HANG)).toBeNull();
    watchdog.noteFailure(PAGE_ERROR);
    expect(watchdog.noteFailure(HANG)).toBeNull();
    expect(watchdog.noteFailure(PAGE_ERROR)).toBeNull();
    expect(docker).toEqual([]);
  });

  it("never restarts while a person is working in the browser", () => {
    const { deps, docker } = fakes({ assistPending: () => true });
    const watchdog = createBrowserWatchdog(deps);
    watchdog.noteFailure(HANG);
    expect(watchdog.noteFailure(HANG)).toBeNull();
    expect(docker).toEqual([]);
  });

  it("restarts at most once per cooldown", async () => {
    const { deps, docker, advance } = fakes();
    const watchdog = createBrowserWatchdog(deps);
    watchdog.noteFailure(HANG);
    await watchdog.noteFailure(HANG);
    watchdog.noteFailure(HANG);
    expect(watchdog.noteFailure(HANG)).toBeNull();
    expect(docker.filter((args) => args[0] === "start")).toHaveLength(1);
    // Still hanging when the cooldown ends: the next hang restarts it at once.
    advance(RECOVERY_COOLDOWN_MS);
    await watchdog.noteFailure(HANG);
    expect(docker.filter((args) => args[0] === "start")).toHaveLength(2);
  });

  it("restarts nothing it cannot name: a browser launched by the server, or no single container for the service", async () => {
    const own = fakes({ endpoint: () => null });
    const launched = createBrowserWatchdog(own.deps);
    launched.noteFailure(HANG);
    expect(launched.noteFailure(HANG)).toBeNull();

    const two = fakes({ docker: async (args) => (args[0] === "ps" ? "aaa\nbbb\n" : "") });
    const ambiguous = createBrowserWatchdog(two.deps);
    ambiguous.noteFailure(HANG);
    await ambiguous.noteFailure(HANG);
    expect(two.docker).toEqual([]);
  });

  it("reads the CDP endpoint from the server's args", () => {
    expect(cdpEndpointOf(["--cdp-endpoint", "http://browser-vnc:9222"])).toBe("http://browser-vnc:9222");
    expect(cdpEndpointOf(["--headless"])).toBeNull();
    expect(cdpEndpointOf(undefined)).toBeNull();
  });
});
