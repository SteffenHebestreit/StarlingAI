import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The web container's nginx (docker/web/nginx.conf) ran on nginx's defaults: a request body over
 * client_body_buffer_size (8 KB on x86-64) went to client_temp, and the part of a proxied response
 * that outran the client to proxy_temp, both under /var/cache/nginx on the container's disk. Uploads and
 * answers carrying personal data landed there, where a deleted temp file stays recoverable.
 * docker-compose.e2e.yml put that directory on tmpfs for its fixture site; the stack's own web
 * service did not.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (file: string): string => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");

interface Directive { name: string; args: string[]; blocks: string[] }

/** The directives of an nginx config with the blocks they sit in (comments dropped; enough for this file). */
function nginxDirectives(text: string): Directive[] {
  const source = text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")).join("\n");
  const directives: Directive[] = [];
  const blocks: string[] = [];
  let statement = "";
  let quote: string | null = null;
  for (const char of source) {
    if (quote) {
      statement += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      statement += char;
    } else if (char === "{") {
      blocks.push(statement.trim().replace(/\s+/g, " "));
      statement = "";
    } else if (char === "}") {
      blocks.pop();
      statement = "";
    } else if (char === ";") {
      const [name, ...args] = statement.trim().split(/\s+/);
      if (name) directives.push({ name, args, blocks: [...blocks] });
      statement = "";
    } else {
      statement += char;
    }
  }
  return directives;
}

/** Bytes of a size as nginx and Docker write it: 64m, 128m, 16k, 1g. */
function bytes(size: string): number {
  const match = /^(\d+)([kmg]?)b?$/i.exec(size.trim());
  if (!match) throw new Error(`not a size: ${size}`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  return Number(match[1]) * unit;
}

/** The default of a `${VAR:-default}` compose value, or the value itself. */
const composeDefault = (value: string): string => /^\$\{[A-Z0-9_]+:-([^}]+)\}$/.exec(value.trim())?.[1] ?? value.trim();

/** The lines of one service in docker-compose.yml, laid out as that file is (services at two spaces). */
function serviceBlock(compose: string, service: string): string[] {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^ {2}[\w.-]+:\s*$/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
}

/** A scalar key of a service block, or the items of a list key. */
const serviceValue = (block: string[], key: string): string | undefined =>
  block.map((line) => new RegExp(`^ {4}${key}:\\s+(.+)$`).exec(line)?.[1]).find((value) => value !== undefined)?.trim();
function serviceList(block: string[], key: string): string[] {
  const at = block.findIndex((line) => line === `    ${key}:`);
  if (at < 0) return [];
  const items: string[] = [];
  for (const line of block.slice(at + 1)) {
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) break;
    items.push(item[1]!.trim().replace(/^["']|["']$/g, ""));
  }
  return items;
}

const nginx = nginxDirectives(read("docker/web/nginx.conf"));
const web = serviceBlock(read("docker-compose.yml"), "web");
const proxiedLocations = [...new Set(nginx.filter((d) => d.name === "proxy_pass").map((d) => d.blocks.join(" > ")))];

describe("docker/web/nginx.conf keeps request and response data off disk", () => {
  it("never writes a proxied response to a temp file: proxy_max_temp_file_size 0 for the whole server", () => {
    const settings = nginx.filter((d) => d.name === "proxy_max_temp_file_size");
    expect(settings.find((d) => d.blocks.length === 1 && d.blocks[0] === "server")?.args).toEqual(["0"]);
    // No location turns it back on.
    expect(settings.every((d) => d.args.join(" ") === "0")).toBe(true);
    expect(proxiedLocations.length).toBeGreaterThanOrEqual(3); // /api/, /ws/browser-vnc, /ws
  });

  it("keeps request bodies buffered, so a chunked upload reaches the gateway's 413 check with a Content-Length", () => {
    expect(nginx.filter((d) => d.name === "proxy_request_buffering" && d.args[0] === "off")).toEqual([]);
    expect(nginx.filter((d) => d.name === "client_body_in_file_only")).toEqual([]);
  });

  it("writes nothing outside /var/cache/nginx, the directory docker-compose.yml puts on tmpfs, and caches nothing", () => {
    for (const directive of nginx.filter((d) => /_temp_path$/.test(d.name))) {
      expect(directive.args[0], directive.name).toMatch(/^\/var\/cache\/nginx(\/|$)/);
    }
    expect(nginx.filter((d) => /^proxy_cache/.test(d.name) || /^(proxy_store|client_body_in_single_buffer)$/.test(d.name))).toEqual([]);
  });
});

describe("docker-compose.yml: the web service's nginx temp directory is a tmpfs", () => {
  const tmpfs = serviceList(web, "tmpfs").find((entry) => entry.split(":")[0] === "/var/cache/nginx");

  it("mounts /var/cache/nginx as tmpfs with a size cap the operator can set", () => {
    expect(tmpfs).toBeDefined();
    const options = Object.fromEntries((tmpfs ?? "").split(":").slice(1).join(":").split(",").map((option) => option.split("=") as [string, string?]));
    expect(options["size"]).toMatch(/^\$\{SAI_WEB_TMPFS_SIZE:-\d+[kmg]\}$/);
    // nginx's workers run as an unprivileged user and must be able to reach the temp directories
    // the root master creates inside it.
    if (options["mode"] !== undefined) expect(Number.parseInt(options["mode"], 8) & 0o001).toBe(1);
  });

  it("sizes it to hold one body of the /api/ cap, inside the memory limit, which also keeps it out of swap", () => {
    const tmpfsSize = bytes(composeDefault(/size=([^,]+)/.exec(tmpfs ?? "")?.[1] ?? "0"));
    const bodyCap = nginx.find((d) => d.name === "client_max_body_size" && d.blocks.some((block) => block === "location /api/"));
    const memLimit = serviceValue(web, "mem_limit");
    expect(bodyCap).toBeDefined();
    expect(memLimit).toBeDefined();
    expect(tmpfsSize).toBeGreaterThanOrEqual(bytes(bodyCap!.args[0]!));
    expect(tmpfsSize).toBeLessThan(bytes(composeDefault(memLimit!)));
    // tmpfs pages can be swapped out to disk; with memswap_limit equal to mem_limit the container gets no swap.
    expect(serviceValue(web, "memswap_limit")).toBe(memLimit);
  });

  // Compose appends the tmpfs entries of every further file to the base file's (it de-duplicates
  // them only by the text before the first "="), so a second entry for the path is a second mount
  // of it: Compose refuses the files, or the bare entry drops size and mode.
  it("mounts it once, and no other compose file of the repository mounts it again for the web service", () => {
    const isNginxTemp = (entry: string): boolean => entry.split(":")[0] === "/var/cache/nginx";
    expect(serviceList(web, "tmpfs").filter(isNginxTemp)).toHaveLength(1);
    const overlays = readdirSync(root).filter((file) => /^docker-compose\..+\.ya?ml$/.test(file));
    expect(overlays).toContain("docker-compose.e2e.yml"); // its own nginx (e2e-site) keeps its tmpfs
    for (const overlay of overlays) {
      const overlayWeb = serviceBlock(read(overlay), "web");
      expect(serviceList(overlayWeb, "tmpfs").filter(isNginxTemp), overlay).toEqual([]);
      expect(overlayWeb.filter((line) => line.includes("/var/cache/nginx")), overlay).toEqual([]);
    }
  });
});
