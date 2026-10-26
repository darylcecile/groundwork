import { realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { claimPortal, portalBuild, portalHealth, portalPorts, portalProtocol, portalService, portalStateDirectory } from "../lib/portal.mjs";
import { containedFile, DataError, evidencePath, fileType, readCatalogue, readGuide, readRun, readRuns } from "./data";
import { createProjects } from "./projects";
import type { Project } from "./types";
import { watchProject } from "./watch";

const mimeTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".m4v": "video/mp4", ".ogv": "video/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".pdf": "application/pdf",
};

function fileResponse(file: string, download: boolean) {
  const type = fileType(file);
  const contentType = type === "text" ? "text/plain; charset=utf-8" : mimeTypes[extname(file).toLowerCase()] || "application/octet-stream";
  const name = basename(file);
  const headers = new Headers({ "Content-Type": contentType, "Content-Security-Policy": "sandbox; default-src 'none'" });
  if (download || type === "file") {
    const fallback = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(Bun.file(file), { headers });
}

function localRequest(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || host !== url.host) return false;
  const origin = request.headers.get("origin");
  return (!origin || origin === url.origin) && request.headers.get("sec-fetch-site") !== "cross-site";
}

type PortalEvent = { event: "change" | "projects"; data: string; key: string };
type ProjectWatcher = ReturnType<typeof watchProject>;

export function createPortal(directory: string, options: { publicDirectory?: string; watchIntervalMs?: number; build?: string } = {}) {
  const scope = resolve(directory);
  const build = options.build || portalBuild(import.meta.path);
  const publicDirectory = options.publicDirectory || join(import.meta.dir, "public");
  const projects = createProjects(scope);
  const watchers = new Map<string, ProjectWatcher>();
  const listeners = new Set<(event: PortalEvent | null) => void>();
  const publish = (event: PortalEvent) => { for (const listener of listeners) listener(event); };
  const app = new Hono();
  let lastActivity = Date.now();
  let connections = 0;
  let closed = false;
  const active = () => { lastActivity = Date.now(); };

  function watcherFor(project: Project) {
    let watcher = watchers.get(project.id);
    if (!watcher) {
      watcher = watchProject(project.root, options.watchIntervalMs);
      watcher.subscribe(() => publish({ event: "change", key: project.id, data: JSON.stringify({ projectId: project.id }) }));
      watchers.set(project.id, watcher);
    }
    return watcher;
  }

  app.use("*", async (c, next) => {
    if (!localRequest(c.req.raw)) c.res = c.json({ error: "Only same-origin loopback requests are allowed." }, 403);
    else if (!["GET", "HEAD"].includes(c.req.method) && !(c.req.method === "POST" && c.req.path === "/api/projects")) {
      c.res = c.json({ error: "Only project registration can modify portal metadata." }, 405);
    }
    else { active(); await next(); }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    return c.res;
  });
  app.get("/api/health", c => c.json({ service: portalService, scope, protocol: portalProtocol, pid: process.pid, build }));
  app.get("/api/projects", c => c.json(projects.list()));
  app.post("/api/projects", async c => {
    if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new DataError("Project registration requires application/json.");
    }
    const value = await c.req.json().catch(() => { throw new DataError("Invalid project registration JSON."); });
    const project = projects.register(value?.root);
    publish({ event: "projects", data: "{}", key: "projects" });
    return c.json({ project });
  });

  const scoped = new Hono<{ Variables: { project: Project; watcher: ProjectWatcher } }>();
  scoped.use("*", async (c, next) => {
    const project = projects.get(c.req.param("projectId") || "");
    c.set("project", project);
    c.set("watcher", watcherFor(project));
    await next();
  });
  scoped.get("/runs", c => {
    const project = c.get("project");
    const result = readRuns(project.root);
    return c.json({ ...result, project, runs: result.runs.map(run => ({ ...run, projectId: project.id })) });
  });
  scoped.get("/runs/:storage/:id", c => {
    const project = c.get("project");
    const result = readRun(project.root, c.req.param("storage"), c.req.param("id"));
    return c.json({ ...result, summary: { ...result.summary, projectId: project.id } });
  });
  scoped.get("/catalogue", c => c.json(readCatalogue(c.get("project").root)));
  scoped.get("/guide", c => {
    const guide = readGuide(c.get("project").root, c.req.query("path") || "");
    c.get("watcher").track(guide.path);
    return c.json(guide);
  });
  scoped.get("/files/:storage/:id", c => fileResponse(
    evidencePath(c.get("project").root, c.req.param("storage"), c.req.param("id"), c.req.query("path") || ""), c.req.query("download") === "1",
  ));
  app.route("/api/projects/:projectId", scoped);
  app.get("/api/events", c => streamSSE(c, async stream => {
    connections++;
    let wake: (() => void) | undefined;
    const pending = new Map<string, PortalEvent>();
    const listener = (event: PortalEvent | null) => { if (event) pending.set(event.key, event); wake?.(); };
    listeners.add(listener);
    const heartbeat = setInterval(() => wake?.(), 15000);
    stream.onAbort(() => wake?.());
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ build }) });
      while (!stream.aborted && !closed) {
        if (!pending.size) await new Promise<void>(resolve => { wake = resolve; });
        if (stream.aborted || closed) break;
        wake = undefined;
        const events = [...pending.values()];
        pending.clear();
        for (const event of events) await stream.writeSSE({ event: event.event, data: event.data });
        if (!events.length) await stream.write(": keepalive\n\n");
      }
    } finally { listeners.delete(listener); clearInterval(heartbeat); connections--; active(); }
  }));
  app.get("/api/*", c => c.json({ error: "API route not found." }, 404));
  app.get("*", c => {
    try {
      const path = c.req.path === "/" ? "index.html" : decodeURIComponent(c.req.path.slice(1));
      const file = containedFile(realpathSync(publicDirectory), path);
      if (!statSync(file).isFile()) return c.notFound();
      const asset = Bun.file(file);
      return new Response(asset, { headers: { "Content-Type": asset.type } });
    } catch { return c.notFound(); }
  });
  app.onError((error, c) => {
    const status = error instanceof DataError ? error.status : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    return c.json({ error: status === 500 ? "Could not read the saved project data." : error.message }, status);
  });
  return {
    app,
    close() {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const listener of listeners) listener(null);
    },
    idle: () => connections === 0 && Date.now() - lastActivity > 30 * 60 * 1000,
  };
}

function listen(portal: ReturnType<typeof createPortal>, ports: number[]) {
  for (const port of ports) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port, fetch: portal.app.fetch, idleTimeout: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No local portal port is available.");
}

async function ownership(scope: string, candidates: number[], build: string) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const owner = claimPortal(scope);
    if (owner) return owner;
    const running = await Promise.all(candidates.map(port => portalHealth(scope, port)));
    if (running.some(health => health?.build === build)) return null;
    await Bun.sleep(50);
  }
  throw new Error("Another portal process still owns this cache scope.");
}

export async function startPortal(directory = portalStateDirectory(), preferredPort?: number) {
  const scope = resolve(directory);
  const build = portalBuild(import.meta.path);
  const candidates = portalPorts(scope);
  const owner = await ownership(scope, candidates, build);
  if (!owner) return null;
  let portal: ReturnType<typeof createPortal> | undefined;
  let server: ReturnType<typeof listen> | undefined;
  try {
    const running = await Promise.all(candidates.map(port => portalHealth(scope, port)));
    if (running.some(Boolean)) { owner.release(); return null; }
    const previousPort = owner.preferredPort();
    const preferred = previousPort !== undefined && candidates.includes(previousPort) ? previousPort : preferredPort;
    const ports = preferred !== undefined && candidates.includes(preferred)
      ? [preferred, ...candidates.filter(port => port !== preferred)] : candidates;
    // Only the daemon owner loads the registry, after the previous writer has stopped.
    portal = createPortal(scope, { build });
    server = listen(portal, ports);
    owner.recordPort(server.port);
    const idle = setInterval(() => { if (portal?.idle()) shutdown(); }, 60000);
    const shutdown = () => { clearInterval(idle); portal?.close(); server?.stop(true); owner.release(); process.exit(0); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.once("exit", owner.release);
    return server;
  } catch (error) {
    portal?.close();
    server?.stop(true);
    owner.release();
    throw error;
  }
}

if (import.meta.main) {
  try { await startPortal(process.argv[2] || portalStateDirectory(), Number(process.argv[3]) || undefined); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
