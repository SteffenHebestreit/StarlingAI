import { describe, it, expect } from "vitest";
import { assertSafeDockerRunArgs } from "../tools/docker-safety.js";

const ok = (args: string[]) => expect(() => assertSafeDockerRunArgs(args, "test")).not.toThrow();
const bad = (args: string[], re: RegExp) => expect(() => assertSafeDockerRunArgs(args, "test")).toThrow(re);

describe("assertSafeDockerRunArgs — real gateway run shapes pass", () => {
  it("shell_exec sandbox (named volume + read-only config overlays + network none)", () => {
    ok(["run","--rm","--network=none","--memory=512m","--cpus=0.5","--pids-limit=64","--read-only",
      "--tmpfs=/tmp:size=64m","--cap-drop=ALL","--security-opt=no-new-privileges",
      "-v","gc-workspace:/workspace",
      "-v","/home/dev/StarlingAI/workspace/agents:/workspace/agents:ro",
      "-v","/home/dev/StarlingAI/workspace/scenes:/workspace/scenes:ro",
      "-w","/workspace","node:22-alpine","sh","-lc","rm -rf / ; cat /etc/passwd"]);
  });
  it("shell with a host-path workspace under /home (workspace can live anywhere)", () => {
    ok(["run","--rm","--network=none","-v","/home/user/proj/workspace:/workspace","alpine","sh","-lc","echo hi"]);
  });
  it("sub-agent container (bridge network + cap-drop)", () => {
    ok(["run","--rm","--read-only","--security-opt","no-new-privileges","--cap-drop","ALL",
      "--pids-limit","64","--memory","512m","--network","bridge","-v","gc-workspace:/workspace","starlingai/agent-worker:dev"]);
  });
  it("serve_app (public network, tmpfs, app dir mount)", () => {
    ok(["run","-d","--rm","--init","--network","starlingai-public","--cap-drop","ALL","--read-only",
      "--tmpfs","/tmp:size=256m,exec","-v","/home/dev/StarlingAI/workspace/generated/demo:/app","node:22-alpine","sh","-lc","npm start"]);
  });
  it("MCP docker transport (named network + benign data mount)", () => {
    ok(["run","--rm","-i","--network=starlingai-public","-v","/srv/mcp-data:/data:ro","mcp/playwright:latest","--cdp-endpoint","http://browser-vnc:9222"]);
  });
});

describe("assertSafeDockerRunArgs — escape shapes are refused", () => {
  it("docker socket bind", () => bad(["run","-v","/var/run/docker.sock:/var/run/docker.sock","alpine"], /sensitive host path/));
  it("host root bind", () => bad(["run","-v","/:/host","alpine"], /sensitive host path/));
  it("/etc and /root binds", () => { bad(["run","-v","/etc:/etc","alpine"], /sensitive/); bad(["run","-v","/root/.ssh:/k","alpine"], /sensitive/); });
  it("direct .env / credentials bind", () => { bad(["run","-v","/app/.env:/app/.env","alpine"], /sensitive/); bad(["run","-v","/x/.starlingai:/s","alpine"], /sensitive/); bad(["run","-v","/d/credentials.enc:/c","alpine"], /sensitive/); });
  it("--privileged", () => bad(["run","--privileged","alpine"], /privileged/));
  it("host networking and host namespaces", () => { bad(["run","--network=host","alpine"], /host network/); bad(["run","--pid","host","alpine"], /host/); bad(["run","--userns=host","alpine"], /host/); });
  it("unconfined security profile", () => bad(["run","--security-opt","seccomp=unconfined","alpine"], /security-opt/));
  it("dangerous cap-add and device passthrough", () => { bad(["run","--cap-add","SYS_ADMIN","alpine"], /cap-add/); bad(["run","--device","/dev/sda","alpine"], /device/); });
  it("does NOT inspect the container's own argv after the image", () => {
    // '-v /:/host' appearing as an ARGUMENT TO THE CONTAINER PROGRAM (after image) is not a docker flag
    ok(["run","--network=none","alpine","sh","-lc","echo -v /:/host --privileged"]);
  });
});
