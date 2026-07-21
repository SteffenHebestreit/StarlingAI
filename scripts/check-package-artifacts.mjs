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

    const tarballPath = path.join(tempDir, tarball);
    const listing = await runCommand("tar", ["-tzf", tarballPath], packageDir);
    if (listing.code !== 0) {
      throw new Error(listing.stderr || listing.stdout || `tar listing failed with exit code ${listing.code}`);
    }

    const blockedFiles = listing.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => blockedPatterns.some(pattern => pattern.test(line)));

    if (blockedFiles.length > 0) {
      console.error(`Blocked files found in packed artifact for ${packageName}:`);
      for (const file of blockedFiles) {
        console.error(` - ${file}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Packed artifact for ${packageName} passed security check.`);
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