#!/usr/bin/env node
/**
 * The harness lab's nightly run, for a timer on the host (Windows Task Scheduler, cron, a systemd
 * timer), never the gateway's own cron: the lab runs real turns and must stay a process of its own.
 * The stack has its own timer, which needs neither of these nor anybody logged on: the `harness-lab`
 * service (`sai start --harness-lab`, docs/harness-lab.md). This wrapper is for a host without it.
 *
 *   node scripts/harness-lab-nightly.mjs [--container starlingai-gateway-1] [--budget 4h] [--quiet 10m] [--no-harvest]
 *
 * Inside the gateway container it runs one night of the lab's timer (`harness-lab-timer --once`): a
 * harvest of the turns that failed live since the last night into the review inbox, then
 * `harness-lab nightly`, which gives way to live use, stops once its budget is spent and goes on
 * with that run the next night. It files at most one pending proposal; nothing is applied without a
 * person. The timer's lock keeps it from running while the service's night still runs.
 *
 * Exit code: the night's (0 a verdict, 3 no verdict, 4 paused on the budget, 5 another night still
 * runs); 1 when the container is not running.
 *
 * Windows, every night at 02:30 (run once in an elevated shell, from the repo root):
 *   schtasks /Create /TN "StarlingAI harness lab" /SC DAILY /ST 02:30 /TR "node %CD%\scripts\harness-lab-nightly.mjs"
 * cron:
 *   30 2 * * * cd /path/to/StarlingAI && node scripts/harness-lab-nightly.mjs >> .starlingai/harness-lab/nightly.log 2>&1
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const container = option("container", "starlingai-gateway-1");
const budget = option("budget", "4h");
const quiet = option("quiet", "10m");
const harvest = !args.includes("--no-harvest");

// The container sees the deployment's workspace at /workspace, the timer's default.
const TIMER = "packages/core/dist/scripts/harness-lab-timer.js";

const stamp = () => new Date().toISOString();
// Git Bash on Windows rewrites "/workspace/..." arguments into Windows paths unless told not to.
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };

const running = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8", env });
if (running.status !== 0 || running.stdout.trim() !== "true") {
  process.stderr.write(`[${stamp()}] ${container} is not running: no nightly lab run.\n`);
  process.exit(1);
}

const flags = ["--once", "--budget", budget, "--quiet", quiet, ...(harvest ? [] : ["--no-harvest"])];
const result = spawnSync("docker", ["exec", container, "node", TIMER, ...flags], { stdio: "inherit", env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
