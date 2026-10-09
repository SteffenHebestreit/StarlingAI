import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const packageDir = path.resolve(process.argv[2] ?? ".");
const blockedPatterns = [
  /\.map$/i,
  /(^|\/)maps?\//i,
  // Match dedicated debug artifacts, not legitimate production modules whose
  // names happen to contain "debug" (for example debug-session-export). The
  // `$` alternative also catches a bare, extensionless `debug` file/dir dump.
  /(^|\/)(?:debug|debugging)(?:$|\/|\.[^/]+$)/i,
  /(^|\/)[^/]+\.debug(\.[^/]+)?$/i,
];

async function main() {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageName = packageJson.name ?? packageDir;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "starlingai-pack-"));

  try {
    const result = await runCommand("pnpm", ["pack", "--pack-destination", tempDir], packageDir);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `pnpm pack failed with exit code ${result.code}`);
    }

    const packedFiles = await readdir(tempDir);
    const tarball = packedFiles.find(name => name.endsWith(".tgz"));
    if (!tarball) {
      throw new Error("pnpm pack did not produce a tarball");
    }

    // LIST IT FROM ITS OWN DIRECTORY, BY BARE NAME. Handing tar an absolute Windows path
    // makes GNU tar read the drive letter as a remote host — "tar (child): Cannot connect to
    // C: resolve failed" — because `host:path` is its remote syntax. `--force-local` fixes
    // that for GNU tar and is rejected by the bsdtar Windows itself ships, so which tar is
    // first on PATH would decide whether the check runs at all. A relative name has no colon
    // in it and both accept it, with no platform branch here.
    const listing = await runCommand("tar", ["-tzf", tarball], tempDir);
    if (listing.code !== 0) {
      throw new Error(listing.stderr || listing.stdout || `tar listing failed with exit code ${listing.code}`);
    }

    const entries = listing.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    // A PASS HAS TO BE BACKED BY A LISTING. tar exiting 0 with nothing on stdout would fall
    // through every filter below and print "passed security check" having examined no files
    // at all — which is how this gate would report success on a tarball it could not read.
    if (entries.length === 0) {
      throw new Error(`tar listed no entries in ${tarball} — the artifact could not be inspected, so nothing was checked`);
    }

    const blockedFiles = entries.filter(line => blockedPatterns.some(pattern => pattern.test(line)));

    if (blockedFiles.length > 0) {
      console.error(`Blocked files found in packed artifact for ${packageName}:`);
      for (const file of blockedFiles) {
        console.error(` - ${file}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Packed artifact for ${packageName} passed security check (${entries.length} files inspected).`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const { executable, resolvedArgs } = resolveCommand(command, args);
    const child = spawn(executable, resolvedArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function resolveCommand(command, args) {
  if (process.platform !== "win32") {
    return { executable: command, resolvedArgs: args };
  }

  if (command === "pnpm") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      resolvedArgs: ["/d", "/c", "pnpm", ...args],
    };
  }
  if (command === "tar") {
    return { executable: "tar.exe", resolvedArgs: args };
  }
  return { executable: command, resolvedArgs: args };
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});