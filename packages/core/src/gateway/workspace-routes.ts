/**
 * Workspace file routes — upload / download / archive / preview / served-site
 * proxy for files under the agent workspace volume. Every path is resolved
 * through resolvePathWithinWorkspace so a request can never escape the workspace
 * boundary. Extracted verbatim from gateway/index.ts (god-file seam).
 */
import type { Hono } from "hono";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { ZipFile } from "yazl";
import { verifyToken, extractBearerToken } from "./auth.js";
import { getConfig } from "../config/loader.js";
import { resolvePathWithinWorkspace } from "../tools/workspace-path.js";
import { getServedApp, injectBaseHref } from "../tools/serve-app.js";
import { buildContentDisposition } from "./content-disposition.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("gateway:workspace");

// CSP for agent-authored workspace previews. Rendered inside a sandboxed
// (allow-scripts, opaque-origin) iframe, so origin isolation is already
// enforced there; this header is defense-in-depth against a misconfigured
// frame. It must still let real artifacts render: generated docs/decks use
// inline <script>/<style> and load libraries (reveal.js, chart.js, mermaid,
// highlight.js) from cdn.jsdelivr.net, so those are allowed while form
// submission, plugins, and <base> hijacking stay blocked. `frame-ancestors`
// is intentionally omitted so the dashboard can embed the preview even when it
// is served from a different origin (e.g. `pnpm web:dev` on :3001 → gateway).
const WORKSPACE_PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function registerWorkspaceRoutes(app: Hono): void {
  function guessWorkspaceContentType(filePath: string): string {
    const extension = extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      // Web
      ".html": "text/html; charset=utf-8",
      ".htm": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".ts": "text/plain; charset=utf-8",
      ".jsx": "text/plain; charset=utf-8",
      ".tsx": "text/plain; charset=utf-8",
      // Documents
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".doc": "application/msword",
      ".odt": "application/vnd.oasis.opendocument.text",
      ".rtf": "application/rtf",
      // Spreadsheets
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".ods": "application/vnd.oasis.opendocument.spreadsheet",
      ".csv": "text/csv; charset=utf-8",
      // Presentations
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".ppt": "application/vnd.ms-powerpoint",
      ".odp": "application/vnd.oasis.opendocument.presentation",
      // Data
      ".json": "application/json; charset=utf-8",
      ".jsonc": "application/json; charset=utf-8",
      ".jsonl": "application/json; charset=utf-8",
      ".yaml": "application/yaml; charset=utf-8",
      ".yml": "application/yaml; charset=utf-8",
      ".xml": "application/xml; charset=utf-8",
      ".toml": "text/plain; charset=utf-8",
      ".sql": "text/plain; charset=utf-8",
      ".sh": "text/plain; charset=utf-8",
      ".py": "text/plain; charset=utf-8",
      ".log": "text/plain; charset=utf-8",
      // Images
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".bmp": "image/bmp",
      ".tiff": "image/tiff",
      ".avif": "image/avif",
      // Audio
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".webm": "audio/webm",
      ".flac": "audio/flac",
      // Video
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
      // Archives
      ".zip": "application/zip",
      ".tar": "application/x-tar",
      ".gz": "application/gzip",
      // Fonts
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
    };
    return contentTypes[extension] ?? "application/octet-stream";
  }

  function resolveWorkspaceTarget(requestedPath: string): { resolved: string; relativePath: string } {
    return resolvePathWithinWorkspace(requestedPath, getConfig().workspacePath);
  }

  function mapWorkspaceRouteError(error: unknown): { status: 400 | 404 | 500; message: string } {
    if (error instanceof Error) {
      if (/workspace boundary|relative path within the workspace/i.test(error.message)) {
        return { status: 400, message: "Path must stay within the workspace" };
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: 404, message: "Workspace path not found" };
      }
      return { status: 500, message: error.message };
    }
    return { status: 500, message: String(error) };
  }

  async function addWorkspacePathToZip(zipFile: ZipFile, absolutePath: string, archivePath: string): Promise<void> {
    const fileStat = await stat(absolutePath);
    const normalizedArchivePath = archivePath.replace(/\\/g, "/");

    if (fileStat.isFile()) {
      zipFile.addFile(absolutePath, normalizedArchivePath);
      return;
    }

    if (!fileStat.isDirectory()) {
      throw new Error(`Unsupported workspace entry for archive: ${archivePath}`);
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    if (entries.length === 0) {
      zipFile.addEmptyDirectory(normalizedArchivePath);
      return;
    }

    for (const entry of entries) {
      await addWorkspacePathToZip(zipFile, resolve(absolutePath, entry.name), `${normalizedArchivePath}/${entry.name}`);
    }
  }

  async function estimateDirectorySize(dirPath: string): Promise<{ totalBytes: number; entryCount: number }> {
    let totalBytes = 0;
    let entryCount = 0;
    const visit = async (current: string) => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        entryCount++;
        const fullPath = resolve(current, entry.name);
        if (entry.isFile()) {
          const fileStat = await stat(fullPath);
          totalBytes += fileStat.size;
        } else if (entry.isDirectory()) {
          await visit(fullPath);
        }
      }
    };
    await visit(dirPath);
    return { totalBytes, entryCount };
  }

  async function buildWorkspaceArchiveBuffer(absolutePath: string, archiveRoot: string): Promise<Buffer> {
    const zipFile = new ZipFile();
    const chunks: Buffer[] = [];

    const bufferPromise = new Promise<Buffer>((resolvePromise, rejectPromise) => {
      zipFile.outputStream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      zipFile.outputStream.on("end", () => {
        resolvePromise(Buffer.concat(chunks));
      });
      zipFile.outputStream.on("error", rejectPromise);
    });

    await addWorkspacePathToZip(zipFile, absolutePath, archiveRoot);
    zipFile.end();
    return bufferPromise;
  }

  // ── Workspace file upload ────────────────────────────────────────────────
  // POST /api/workspace/upload
  //   Multipart form: field "file" — any file type
  //   Optional form field "subdir" — subdirectory under workspace (default: "uploads")
  //   Returns: { workspacePath: "<configured-workspace>/uploads/foo.png", relativePath: "uploads/foo.png", filename: "foo.png" }
  // Saves the uploaded file into the workspace volume so agents can access it.

  app.post("/api/workspace/upload", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const formData = await c.req.raw.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) {
      return c.json({ error: "file field is required" }, 400);
    }

    const subdirRaw = formData.get("subdir");
    const subdir = (typeof subdirRaw === "string" && /^[\w/-]+$/.test(subdirRaw))
      ? subdirRaw
      : "uploads";

    // Sanitise filename: keep extension, replace unsafe characters
    const ext = extname(uploadedFile.name);
    const safeName = basename(uploadedFile.name, ext)
      .replace(/[^\w\s.-]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 120) + ext;

    const workspaceRoot = getConfig().workspacePath;
    const targetDir = resolve(workspaceRoot, subdir);
    const targetPath = resolve(targetDir, safeName);

    // Prevent path traversal
    if (!targetPath.startsWith(resolve(workspaceRoot))) {
      return c.json({ error: "Invalid upload path" }, 400);
    }

    try {
      const buffer = new Uint8Array(await uploadedFile.arrayBuffer());

      // Fail-closed virus scan BEFORE the file lands in the workspace volume that agents
      // and the /api/workspace/file serve endpoint read from — the same "every upload is
      // scanned" contract the document/attachment handlers enforce. This path writes to
      // the workspace (not the object store) by design, so it scans in place rather than
      // routing through scanAndStoreUpload. Infected → 422; scanner down/errored → 503.
      const relativePath = `${subdir}/${safeName}`;
      try {
        const { scanBytes } = await import("../storage/scanner.js");
        const verdict = await scanBytes(buffer);
        if (verdict.oversize) {
          logAudit("upload_oversize_rejected", { key: relativePath, size: buffer.length, route: "workspace/upload" }, { severity: "warn" });
          return c.json({ error: "Upload rejected — the file is too large to virus-scan. Reduce its size, or raise storage.scan.maxScanBytes / disable storage.scan.rejectOverMaxBytes." }, 422);
        }
        if (!verdict.clean) {
          logAudit("upload_infected", { key: relativePath, signature: verdict.signature ?? "unknown", route: "workspace/upload" }, { severity: "warn" });
          return c.json({ error: `Upload rejected — malware detected (${verdict.signature ?? "unknown"}).` }, 422);
        }
      } catch (err) {
        logAudit("upload_scan_failed", { key: relativePath, error: err instanceof Error ? err.message : String(err), route: "workspace/upload" }, { severity: "error" });
        return c.json({ error: "Upload scanning is temporarily unavailable — please try again." }, 503);
      }

      await mkdir(targetDir, { recursive: true });
      await writeFile(targetPath, buffer);

      return c.json({
        workspacePath: `${workspaceRoot}/${subdir}/${safeName}`,
        relativePath,
        filename: safeName,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  const WORKSPACE_FILE_MAX_BYTES = 256 * 1024 * 1024; // 256 MB
  const WORKSPACE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024; // 512 MB
  const WORKSPACE_ARCHIVE_MAX_ENTRIES = 10_000;

  app.get("/api/workspace/file", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const requestedPath = c.req.query("path")?.trim();
    if (!requestedPath) {
      return c.json({ error: "path query parameter is required" }, 400);
    }

    const disposition = c.req.query("disposition") === "attachment" ? "attachment" : "inline";

    try {
      const { resolved, relativePath } = resolveWorkspaceTarget(requestedPath);
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        return c.json({ error: "Requested workspace path is not a file" }, 400);
      }
      if (fileStat.size > WORKSPACE_FILE_MAX_BYTES) {
        return c.json({ error: `File too large (${Math.round(fileStat.size / 1024 / 1024)} MB). Maximum is ${WORKSPACE_FILE_MAX_BYTES / 1024 / 1024} MB.` }, 413);
      }

      const bytes = await readFile(resolved);
      const filename = basename(resolved);
      return c.body(bytes, 200, {
        "Content-Type": guessWorkspaceContentType(filename),
        "Content-Disposition": buildContentDisposition(filename, disposition),
        "X-Workspace-Path": relativePath,
      });
    } catch (error) {
      const mapped = mapWorkspaceRouteError(error);
      return c.json({ error: mapped.message }, mapped.status);
    }
  });

  app.get("/api/workspace/archive", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const requestedPath = c.req.query("path")?.trim();
    if (!requestedPath) {
      return c.json({ error: "path query parameter is required" }, 400);
    }

    try {
      const { resolved, relativePath } = resolveWorkspaceTarget(requestedPath);
      const fileStat = await stat(resolved);
      if (!fileStat.isFile() && !fileStat.isDirectory()) {
        return c.json({ error: "Requested workspace path must be a file or directory" }, 400);
      }

      // Pre-flight size/entry check for directories
      if (fileStat.isDirectory()) {
        const { totalBytes, entryCount } = await estimateDirectorySize(resolved);
        if (entryCount > WORKSPACE_ARCHIVE_MAX_ENTRIES) {
          return c.json({ error: `Directory has too many entries (${entryCount}). Maximum is ${WORKSPACE_ARCHIVE_MAX_ENTRIES}.` }, 413);
        }
        if (totalBytes > WORKSPACE_ARCHIVE_MAX_BYTES) {
          return c.json({ error: `Directory too large (${Math.round(totalBytes / 1024 / 1024)} MB). Maximum is ${WORKSPACE_ARCHIVE_MAX_BYTES / 1024 / 1024} MB.` }, 413);
        }
      } else if (fileStat.size > WORKSPACE_ARCHIVE_MAX_BYTES) {
        return c.json({ error: `File too large (${Math.round(fileStat.size / 1024 / 1024)} MB). Maximum is ${WORKSPACE_ARCHIVE_MAX_BYTES / 1024 / 1024} MB.` }, 413);
      }

      const archiveBaseName = basename(resolved) || "workspace";
      const archiveBytes = await buildWorkspaceArchiveBuffer(resolved, archiveBaseName);
      const archiveName = `${archiveBaseName}.zip`;
      const responseBytes = new Uint8Array(archiveBytes);

      return c.body(responseBytes, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": buildContentDisposition(archiveName, "attachment"),
        "X-Workspace-Path": relativePath,
      });
    } catch (error) {
      const mapped = mapWorkspaceRouteError(error);
      return c.json({ error: mapped.message }, mapped.status);
    }
  });

  // ── Workspace static preview server ──────────────────────────────────────
  // GET /api/workspace/preview?root=<dir>&file=<rel>&token=<jwt>
  //
  // Serves any file within a workspace directory as a proper static response.
  // Designed for iframe use: the token travels as a query parameter because
  // browsers cannot set Authorization headers on iframe src attributes.
  // `root` is the workspace-relative directory that forms the document root.
  // `file` is the file path relative to that root (defaults to index.html).
  // Only files strictly inside the root are served (path-traversal blocked).
  //
  // This enables multi-file web projects (HTML + CSS + JS + assets) to load
  // with all relative imports resolved correctly, including fonts and images.
  app.get("/api/workspace/preview", async (c) => {
    const queryToken = c.req.query("token")?.trim();
    if (!queryToken || !await verifyToken(queryToken)) {
      return c.text("Unauthorized", 401);
    }

    const root = c.req.query("root")?.trim();
    const file = c.req.query("file")?.trim() || "index.html";

    if (!root) return c.text("root query parameter is required", 400);

    // Validate that both root and file stay within the workspace
    let rootResolved: string;
    let fileResolved: string;
    try {
      const rootTarget = resolveWorkspaceTarget(root);
      rootResolved = rootTarget.resolved;

      // Resolve the requested file within the root (not the workspace) to
      // block path traversal attempts like `../../etc/passwd`.
      const candidate = resolve(rootResolved, file.replace(/^\/+/, ""));
      if (!candidate.startsWith(rootResolved + sep) && candidate !== rootResolved) {
        return c.text("File path escapes root directory", 400);
      }
      fileResolved = candidate;
    } catch {
      return c.text("Path escapes workspace boundary", 400);
    }

    const fileStat = await stat(fileResolved).catch(() => null);
    if (!fileStat?.isFile()) {
      return c.text("File not found", 404);
    }
    if (fileStat.size > WORKSPACE_FILE_MAX_BYTES) {
      return c.text("File too large", 413);
    }

    const bytes = await readFile(fileResolved);
    const filename = basename(fileResolved);
    return c.body(bytes, 200, {
      "Content-Type": guessWorkspaceContentType(filename),
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": WORKSPACE_PREVIEW_CSP,
    });
  });

  // Path-based static site preview for multi-page websites. Unlike the
  // query-param form above (?root=&file=), the artifact directory is served
  // under a PATH prefix, so RELATIVE urls inside the HTML — <link href="theme.css">,
  // <a href="bom.html">, images — resolve against the document URL instead of
  // collapsing to /api/workspace/<file> and 404-ing (which left multi-page sites
  // unstyled with dead inter-page links). The directory is base64url-encoded into
  // one path segment; the token rides in ?token= on the first navigation and is
  // mirrored into a path-scoped cookie so the browser's own relative sub-resource
  // requests authenticate (mirrors the /api/app/:id/* live-app proxy).
  const SITE_PREVIEW_PREFIX = "/api/workspace/site/";
  app.get("/api/workspace/site/:enc", (c) => {
    const enc = c.req.param("enc");
    const tok = c.req.query("token");
    return c.redirect(`${SITE_PREVIEW_PREFIX}${enc}/index.html${tok ? `?token=${encodeURIComponent(tok)}` : ""}`);
  });
  app.get("/api/workspace/site/:enc/*", async (c) => {
    const enc = c.req.param("enc");
    const queryToken = c.req.query("token")?.trim();
    const cookieToken = /(?:^|;\s*)sai_site_token=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
    const token = queryToken || (cookieToken ? decodeURIComponent(cookieToken) : undefined) || extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.text("Unauthorized", 401);

    let root: string;
    try {
      root = Buffer.from(enc, "base64url").toString("utf8");
    } catch {
      return c.text("Invalid site root", 400);
    }
    if (!root) return c.text("Invalid site root", 400);

    const dirPrefix = `${SITE_PREVIEW_PREFIX}${enc}/`;
    const rawRel = c.req.path.startsWith(dirPrefix) ? c.req.path.slice(dirPrefix.length) : "";
    let rel: string;
    try {
      rel = decodeURIComponent(rawRel);
    } catch {
      rel = rawRel;
    }
    const file = rel.trim() || "index.html";

    let fileResolved: string;
    try {
      const rootTarget = resolveWorkspaceTarget(root);
      const candidate = resolve(rootTarget.resolved, file.replace(/^\/+/, ""));
      if (!candidate.startsWith(rootTarget.resolved + sep) && candidate !== rootTarget.resolved) {
        return c.text("File path escapes root directory", 400);
      }
      fileResolved = candidate;
    } catch {
      return c.text("Path escapes workspace boundary", 400);
    }

    const fileStat = await stat(fileResolved).catch(() => null);
    if (!fileStat?.isFile()) return c.text("File not found", 404);
    if (fileStat.size > WORKSPACE_FILE_MAX_BYTES) return c.text("File too large", 413);

    const bytes = await readFile(fileResolved);
    const headers: Record<string, string> = {
      "Content-Type": guessWorkspaceContentType(basename(fileResolved)),
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": WORKSPACE_PREVIEW_CSP,
    };
    // Set the path-scoped cookie only on the token-bearing first navigation so the
    // iframe's subsequent relative requests (CSS, sub-pages, images) authenticate.
    if (queryToken) {
      headers["Set-Cookie"] = `sai_site_token=${encodeURIComponent(queryToken)}; Path=${dirPrefix}; HttpOnly; SameSite=Lax`;
    }
    return c.body(bytes, 200, headers);
  });

  // ── Live app reverse proxy ────────────────────────────────────────────────
  // /api/app/:id/*  — forwards authenticated requests to a serve_app container
  // (running by name on the gateway's docker network). The first navigation
  // carries ?token=<jwt>, which we mirror into a path-scoped cookie so the app's
  // relative sub-resource requests authenticate too; HTML responses get a <base>
  // so those relative URLs resolve under the /api/app/<id>/ subpath.
  const APP_PROXY_HOP_BY_HOP = new Set(["host", "connection", "cookie", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);
  app.all("/api/app/:id", (c) => {
    const id = c.req.param("id");
    const tok = c.req.query("token");
    return c.redirect(`/api/app/${id}/${tok ? `?token=${encodeURIComponent(tok)}` : ""}`);
  });
  app.all("/api/app/:id/*", async (c) => {
    const id = c.req.param("id");
    const queryToken = c.req.query("token")?.trim();
    const cookieToken = /(?:^|;\s*)sai_app_token=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
    const token = queryToken || (cookieToken ? decodeURIComponent(cookieToken) : undefined) || extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.text("Unauthorized", 401);

    const served = getServedApp(id);
    if (!served) return c.text(`No running app '${id}'.`, 404);
    if (served.status !== "running") return c.text(`App '${id}' is ${served.status}.`, 503);

    const prefix = `/api/app/${id}/`;
    const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    const url = new URL(c.req.url);
    url.searchParams.delete("token");
    const qs = url.searchParams.toString();
    const target = `http://${served.containerName}:${served.internalPort}/${rest}${qs ? `?${qs}` : ""}`;

    const fwdHeaders = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      if (!APP_PROXY_HOP_BY_HOP.has(k.toLowerCase())) fwdHeaders.set(k, v);
    }
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

    let upstream: Response;
    try {
      upstream = await fetch(target, { method, headers: fwdHeaders, body, redirect: "manual" });
    } catch (err) {
      return c.text(`App '${id}' is not reachable: ${err instanceof Error ? err.message : String(err)}`, 502);
    }

    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete("content-encoding"); // fetch already decoded the body
    respHeaders.delete("content-length");
    respHeaders.delete("content-security-policy");
    if (queryToken) {
      respHeaders.append("Set-Cookie", `sai_app_token=${encodeURIComponent(queryToken)}; Path=${prefix}; HttpOnly; SameSite=Lax`);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (/text\/html/i.test(contentType)) {
      const html = injectBaseHref(await upstream.text(), prefix);
      return new Response(html, { status: upstream.status, headers: respHeaders });
    }
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: respHeaders });
  });
}
