/**
 * Shared safety guard for every `docker run` the GATEWAY issues.
 *
 * The gateway process holds the docker socket (root-equivalent on the host), so
 * a container it spawns with the wrong flags is a host escape: a bind of the
 * docker socket or host root, --privileged, host namespaces, or an unconfined
 * security profile all break the container boundary. The concrete run-args at
 * our call sites (container-runner, shell, serve_app, run_test_suite, git, the
 * docker-transport MCP client) are built by trusted code from mostly-fixed
 * values — but this is the choke point that keeps it that way: a bug, an
 * injected config value, or a future careless call site cannot slip an
 * escape-shaped container past it. Fail CLOSED (throw) — a docker run we can't
 * prove safe does not run.
 *
 * This is defense-in-depth at the argument layer; it does NOT replace
 * daemon-level containment (a scoped docker-socket-proxy + non-root gateway),
 * which remains the recommended structural fix for a gateway-process RCE.
 */

const SENSITIVE_MOUNT_SOURCE =
  /(docker\.sock|(^|[/\\])\.env(\.|$)|(^|[/\\])\.starlingai([/\\]|$)|credential)/i;

/**
 * A mount source path that must never be bound into a gateway-spawned container.
 * Deliberately NARROW: the legitimate workspace mount can live anywhere (often
 * under /home or a data dir), so we reject only host root, system/socket dirs,
 * and direct secret-file mounts — NOT /home or /var broadly (that would
 * false-positive on the workspace itself). A directory that merely *contains*
 * .env is fine to mount; a mount whose source *is* a .env / credentials path is
 * not.
 */
function isSensitiveMountSource(source: string): boolean {
  const s = source.trim().toLowerCase().replace(/\\/g, "/");
  if (!s) return true;
  if (s === "/") return true;                                    // whole host FS
  if (/^\/(etc|root|proc|sys|boot|dev)(\/|$)/.test(s)) return true; // system dirs
  if (s === "/var/run" || s.startsWith("/var/run/")) return true;   // sockets (docker/podman)
  return SENSITIVE_MOUNT_SOURCE.test(s);                          // docker.sock, .env, .starlingai, credential
}

function hostNamespaceValue(v: string): boolean {
  return /^host$/i.test(v.trim());
}

/**
 * Validate a `docker run` (or `docker create`) argument vector, throwing on any
 * flag that would break container isolation. Only inspects flags BEFORE the
 * image name — everything after the image is the container's own argv (e.g. a
 * `sh -lc <agent command>`) and cannot reconfigure the host.
 */
export function assertSafeDockerRunArgs(args: readonly string[], source: string): void {
  // Find where docker flags end and the image (+ container argv) begin: the
  // first non-flag token that isn't a value consumed by a preceding value-flag.
  const VALUE_FLAGS = new Set([
    "-v", "--volume", "--mount", "-e", "--env", "--network", "--net", "-w", "--workdir",
    "--name", "--label", "-l", "--memory", "-m", "--memory-swap", "--cpus", "--pids-limit",
    "--security-opt", "--tmpfs", "--add-host", "--user", "-u", "--cap-add", "--cap-drop",
    "--device", "--entrypoint", "-p", "--publish", "--restart", "--pid", "--ipc", "--uts",
    "--userns", "--dns", "--hostname", "-h",
  ]);

  const reject = (why: string): never => {
    throw new Error(`Refusing a docker run from "${source}": ${why}. This would break the container boundary.`);
  };

  // Skip the leading subcommand ("run"/"create") if present.
  let i = 0;
  if (args[i] === "run" || args[i] === "create") i++;

  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) break; // reached the image name → stop flag scanning

    // Support both "--flag value" and "--flag=value".
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : "";
    if (eq < 0 && VALUE_FLAGS.has(flag)) {
      value = args[i + 1] ?? "";
      i++; // consume the value token
    }

    switch (flag) {
      case "--privileged":
        reject("--privileged");
        break;
      case "--pid": case "--ipc": case "--uts": case "--userns":
        if (hostNamespaceValue(value)) reject(`${flag}=host`);
        break;
      case "--network": case "--net":
        if (hostNamespaceValue(value)) reject("host networking (--network=host)");
        break;
      case "--security-opt":
        if (/(apparmor|seccomp)\s*[:=]?\s*unconfined/i.test(value) || /systempaths\s*=\s*unconfined/i.test(value)) {
          reject(`--security-opt ${value}`);
        }
        break;
      case "--cap-add":
        if (/^(all|sys_admin|sys_ptrace|sys_module|dac_read_search|dac_override)$/i.test(value.trim())) {
          reject(`--cap-add ${value}`);
        }
        break;
      case "--device":
        reject("--device (host device passthrough)");
        break;
      case "-v": case "--volume": {
        const src = value.split(":")[0] ?? "";
        // A named volume (no path separator, not absolute) is fine; a host path is checked.
        if (src.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(src)) {
          if (isSensitiveMountSource(src)) reject(`bind mount of a sensitive host path (${src})`);
        } else if (isSensitiveMountSource(src)) {
          reject(`bind mount of a sensitive host path (${src})`);
        }
        break;
      }
      case "--mount": {
        if (/src=([^,]+)/i.test(value)) {
          const src = /src=([^,]+)/i.exec(value)?.[1] ?? "";
          if (isSensitiveMountSource(src)) reject(`--mount of a sensitive host path (${src})`);
        }
        break;
      }
      default:
        break;
    }
  }
}
