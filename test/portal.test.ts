import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciVariables, portalBuild, portalHealth, portalPorts, portalStateDirectory, portalURL, probePortal } from "../lib/portal.mjs";
import { createPortal } from "../portal/server";
import type { CatalogueResponse, Project, ProjectsResponse, RunResponse, RunsResponse } from "../portal/types";

const cli = fileURLToPath(new URL("../skills/verify-work/verify.mjs", import.meta.url));
const projects: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];
const previousCache = process.env.XDG_CACHE_HOME;

beforeEach(() => { process.env.XDG_CACHE_HOME = temporaryProject(); });

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCache;
});

function temporaryProject() {
  const root = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-portal-")));
  projects.push(root);
  return root;
}

function write(root: string, path: string, value: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}

function saved(id: string) {
  return { version: 2, id, startedAt: "2026-10-26T12:00:00Z", finishedAt: "2026-10-26T12:01:00Z",
    source: { revision: null, fingerprint: "a".repeat(64), dirty: true }, status: "passed", omitted: [],
    plan: { goal: "Retain the saved result", requirements: [{ id: "retained", expect: "The check passed", checks: ["check"], behaviours: [] }] },
    checks: [{ name: "check", command: "echo passed", expect: "The check passed", status: "passed", exitCode: 0,
      durationMs: 10, log: "check/output.log", covers: [], artifacts: [{ path: "check/artifacts/view.png", sha256: "b".repeat(64) }] }],
    observations: [], coverage: [], context: { fixture: "saved report" }, problems: [] };
}

type RequestPortal = (path: string, init?: RequestInit) => Response | Promise<Response>;

function portalInstance(scope = portalStateDirectory()) {
  const result = createPortal(scope, { watchIntervalMs: 50 });
  cleanup.push(result.close);
  const request: RequestPortal = (path, init) => result.app.fetch(new Request(`http://127.0.0.1${path}`, init));
  return { ...result, request };
}

async function register(request: RequestPortal, root: string): Promise<Project> {
  const response = await request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root }) });
  expect(response.status).toBe(200);
  return (await response.json()).project;
}

async function portal(root: string) {
  const { request } = portalInstance();
  const project = await register(request, root);
  return Object.assign((path: string, init?: RequestInit) => request(path.startsWith("/api/") ? path : `/api/projects/${project.id}${path}`, init), { project });
}

function snapshot(root: string, prefix = ""): Record<string, { data: string; modified: number }> {
  const values: Record<string, { data: string; modified: number }> = {};
  for (const name of readdirSync(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = statSync(join(root, path));
    if (info.isDirectory()) Object.assign(values, snapshot(root, path));
    else values[path] = { data: readFileSync(join(root, path)).toString("base64"), modified: info.mtimeMs };
  }
  return values;
}

test("history reads local versions and PR envelopes as saved snapshots without changing any files", async () => {
  const root = temporaryProject();
  write(root, ".groundwork/runs/shared/result.json", saved("shared"));
  write(root, ".groundwork/runs/shared/check/output.log", "Saved output; deliberately different from evidence hashes.\n");
  write(root, ".groundwork/runs/shared/check/artifacts/extra.txt", "Ancillary evidence");
  write(root, ".groundwork/runs/shared/check/artifacts/notes.markdown", "# Saved observation");
  write(root, ".groundwork/runs/shared/check/artifacts/result.json", '{"driver":"not a run"}');
  const legacy = { ...saved("shared"), version: 1, status: undefined, plan: null };
  legacy.checks[0]!.status = "failed";
  legacy.checks[0]!.exitCode = 1;
  write(root, ".verify/runs/shared/result.json", legacy);
  write(root, ".groundwork/runs/pr-new/result.json", { version: 2, repository: "owner/repo", pullRequest: 1,
    status: "inconclusive", verification: saved("unused"), problems: ["Agent review is incomplete."] });
  write(root, ".groundwork/runs/pr-old/result.json", { version: 1, repository: "owner/repo", status: "failed", problems: [],
    checks: { status: "passed", log: "checks.log", exitCode: 0 },
    agent: { checks: [{ claim: "Persists", status: "failed", observed: "The value was lost", evidence: ["agent/output.log"] }], gaps: [] } });
  write(root, ".groundwork/runs/interrupted/result.json", { ...saved("interrupted"), finishedAt: null });
  write(root, ".groundwork/runs/broken/result.json", "{ partial write");
  write(root, ".groundwork/latest", "interrupted\n");
  write(root, ".verify/latest", "shared\n");
  const before = snapshot(root);
  const request = await portal(root);
  const history: RunsResponse = await (await request("/runs")).json();
  expect(history.project.id).toBe(request.project.id);
  expect(history.runs.every(run => run.projectId === request.project.id)).toBe(true);
  expect(history.latest).toBe("groundwork:interrupted");
  expect(history.runs).toHaveLength(6);
  expect(history.runs.find(run => run.storage === "verify")?.status).toBe("failed");
  expect(history.runs.find(run => run.id === "interrupted")?.status).toBe("unfinished");
  expect(history.runs.find(run => run.id === "pr-new")).toMatchObject({ kind: "pr", status: "inconclusive", startedAt: null, finishedAt: null });
  expect(history.runs.find(run => run.id === "broken")?.error).toBeTruthy();
  const detail: RunResponse = await (await request("/runs/groundwork/shared")).json();
  expect(detail.summary.projectId).toBe(request.project.id);
  expect(detail.report?.status).toBe("passed");
  expect(detail.report?.coverage[0]?.status).toBe("verified");
  expect(detail.files.map(file => file.path)).toContain("check/artifacts/extra.txt");
  expect(detail.files.map(file => file.path)).toContain("check/artifacts/result.json");
  expect(detail.files.find(file => file.path.endsWith("notes.markdown"))?.type).toBe("text");
  expect(await (await request("/files/groundwork/shared?path=check/artifacts/extra.txt")).text()).toBe("Ancillary evidence");
  const oldPR: RunResponse = await (await request("/runs/groundwork/pr-old")).json();
  expect(oldPR.report?.observations[0]?.observed).toContain("The value was lost");
  expect((await (await request("/runs/groundwork/broken")).json()).report).toBeNull();
  expect(snapshot(root)).toEqual(before);
  const evidence = join(root, ".groundwork/runs/shared/check/artifacts/extra.txt");
  writeFileSync(evidence, "Different evidence");
  const modified = new Date(Date.now() + 1000);
  utimesSync(evidence, modified, modified);
  const refreshed: RunResponse = await (await request("/runs/groundwork/shared")).json();
  const originalFile = detail.files.find(file => file.path.endsWith("extra.txt"))!;
  const updatedFile = refreshed.files.find(file => file.path.endsWith("extra.txt"))!;
  expect(updatedFile.size).toBe(originalFile.size);
  expect(updatedFile.modifiedAt).not.toBe(originalFile.modifiedAt);
  expect(updatedFile.modifiedAt).toBe(statSync(evidence).mtimeMs);
  expect(refreshed.files.find(file => file.path.endsWith("notes.markdown"))).toEqual(detail.files.find(file => file.path.endsWith("notes.markdown")));
  write(root, ".groundwork/latest", "unavailable\n");
  const invalidLatest: RunsResponse = await (await request("/runs")).json();
  expect(invalidLatest.latest).toBe("groundwork:unavailable");
  expect(invalidLatest.problems.join(" ")).toContain("latest");
  expect((await request("/runs/groundwork/unavailable")).status).toBe(404);
  write(root, ".groundwork/latest", "../invalid\n");
  expect((await (await request("/runs")).json()).latest).toBeNull();
  rmSync(join(root, ".groundwork/latest"));
  symlinkSync(join(root, "missing-pointer"), join(root, ".groundwork/latest"));
  expect((await (await request("/runs")).json()).latest).toBeNull();
});

test("file and metadata reads stay inside their run and active evidence is inert", async () => {
  const root = temporaryProject();
  const outside = temporaryProject();
  write(outside, "secret.txt", "outside secret");
  write(outside, "result.json", saved("external"));
  write(root, ".groundwork/runs/one/result.json", saved("one"));
  write(root, ".groundwork/runs/one/nested/page.html", "<script>alert('not executable')</script>");
  write(root, ".groundwork/runs/one/nested/image.svg", "<svg onload=alert(1) />");
  symlinkSync(join(outside, "secret.txt"), join(root, ".groundwork/runs/one/escape.txt"));
  symlinkSync(outside, join(root, ".groundwork/runs/external"));
  write(root, ".groundwork/runs/linked/log.txt", "Retained log");
  symlinkSync(join(outside, "result.json"), join(root, ".groundwork/runs/linked/result.json"));
  const request = await portal(root);
  for (const path of ["../result.json", "/etc/passwd", "nested/../../result.json", "escape.txt", "nested\\page.html"]) {
    const response = await request(`/files/groundwork/one?path=${encodeURIComponent(path)}`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("outside secret");
  }
  const history: RunsResponse = await (await request("/runs")).json();
  expect(history.runs.find(run => run.id === "external")?.error).toBeTruthy();
  expect(history.runs.find(run => run.id === "linked")?.error).toBeTruthy();
  const detail: RunResponse = await (await request("/runs/groundwork/one")).json();
  expect(detail.files.map(file => file.path)).not.toContain("escape.txt");
  for (const name of ["page.html", "image.svg"]) {
    const response = await request(`/files/groundwork/one?path=nested/${name}`);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  }
  const download = await request("/files/groundwork/one?path=nested/page.html&download=1");
  expect(download.headers.get("Content-Disposition")).toStartWith("attachment;");
  expect((await request("/api/health", { headers: { Host: "evil.example" } })).status).toBe(403);
  expect((await request("/api/health", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  expect((await request("/runs", { method: "POST" })).status).toBe(405);
  const linkedRoot = temporaryProject();
  symlinkSync(outside, join(linkedRoot, ".groundwork"));
  const linkedRequest = await portal(linkedRoot);
  const blocked = await (await linkedRequest("/runs")).json();
  expect(blocked.runs).toEqual([]);
  expect(blocked.problems.length).toBeGreaterThan(0);
});

test("catalogue exposes declared edges, invariant bindings and project Markdown navigation", async () => {
  const root = temporaryProject();
  const request = await portal(root);
  const empty = await request("/catalogue");
  expect(empty.status).toBe(200);
  expect((await empty.json()).problems.join(" ")).toContain("groundwork init");
  write(root, ".groundwork/verify.json", { checks: { check: { command: "touch must-not-run", expect: "The flow works", covers: ["flow"] } },
    behaviours: { flow: { description: "Main flow", dependsOn: ["storage"], guide: ".groundwork/VERIFY.md#flow" },
      storage: { description: "Save state", paths: ["lib/**"] } },
    invariants: { stable: { description: "Keep storage stable", checks: ["check"] } } });
  write(root, ".groundwork/VERIFY.md", "# Guide\n\n## Flow\nRead the saved value.\n");
  write(root, "related.md", "# Related project guide");
  write(root, "private.txt", "Not project documentation");
  const outside = temporaryProject();
  write(outside, "external.md", "Outside the project");
  symlinkSync(join(outside, "external.md"), join(root, "external.md"));
  const before = snapshot(root);
  const result: CatalogueResponse = await (await request("/catalogue")).json();
  expect(result.behaviours.find(item => item.id === "flow")?.dependsOn).toEqual(["storage"]);
  expect(result.behaviours.find(item => item.id === "storage")?.consumers).toEqual(["flow"]);
  expect(result.invariants[0]?.checks).toEqual(["check"]);
  expect(result.checks[0]?.covers).toEqual(["flow", "stable"]);
  expect(result.problems).toEqual([]);
  expect(await (await request("/guide?path=.groundwork%2FVERIFY.md%23flow")).json()).toMatchObject({ content: "# Guide\n\n## Flow\nRead the saved value.\n" });
  expect(await (await request("/guide?path=related.md")).json()).toMatchObject({ content: "# Related project guide" });
  expect((await request("/guide?path=private.txt")).status).toBe(400);
  expect((await request("/guide?path=external.md")).status).toBe(400);
  expect(snapshot(root)).toEqual(before);
  write(root, ".groundwork/verify.json", "{ broken");
  const broken = await request("/catalogue");
  expect(broken.status).toBe(400);
  expect((await broken.json()).error).toContain("Could not read the project catalogue");
  expect(readFileSync(join(root, ".groundwork/verify.json"), "utf8")).toBe("{ broken");
  rmSync(join(root, ".groundwork/verify.json"));
  symlinkSync(join(root, "missing-config"), join(root, ".groundwork/verify.json"));
  expect((await request("/catalogue")).status).toBe(400);
});

test("registered project IDs isolate identical run IDs and canonical aliases without repository writes", async () => {
  const first = temporaryProject();
  const second = temporaryProject();
  const alias = join(temporaryProject(), "alias");
  symlinkSync(first, alias);
  for (const [root, value] of [[first, "First evidence"], [second, "Second evidence"]] as const) {
    write(root, ".groundwork/runs/shared/result.json", saved("shared"));
    write(root, ".groundwork/runs/shared/output.log", value);
  }
  const before = [snapshot(first), snapshot(second)];
  const { request } = portalInstance();
  const a = await register(request, first);
  const b = await register(request, second);
  expect(a.id).not.toBe(b.id);
  expect(await register(request, alias)).toEqual(a);
  expect(await register(request, `${first}/.`)).toEqual(a);
  const list: ProjectsResponse = await (await request("/api/projects")).json();
  expect(list).toEqual({ projects: [a, b], problems: [] });
  for (const [project, output] of [[a, "First evidence"], [b, "Second evidence"]] as const) {
    const prefix = `/api/projects/${project.id}`;
    const runs: RunsResponse = await (await request(`${prefix}/runs`)).json();
    expect(runs.runs[0]).toMatchObject({ id: "shared", projectId: project.id });
    const detail: RunResponse = await (await request(`${prefix}/runs/groundwork/shared`)).json();
    expect(detail.summary.projectId).toBe(project.id);
    expect(await (await request(`${prefix}/files/groundwork/shared?path=output.log`)).text()).toBe(output);
  }
  for (const suffix of ["/runs", "/runs/groundwork/shared", "/catalogue", "/guide?path=README.md", "/files/groundwork/shared?path=output.log"]) {
    expect((await request(`/api/projects/unknown${suffix}`)).status).toBe(404);
    expect((await request(`/api${suffix}`)).status).toBe(404);
  }
  expect([snapshot(first), snapshot(second)]).toEqual(before);

  rmSync(first, { recursive: true });
  const missing: ProjectsResponse = await (await request("/api/projects")).json();
  expect(missing.projects).toEqual([{ ...a, available: false }, b]);
  expect(missing.problems.join(" ")).toContain(first);
  expect((await request(`/api/projects/${a.id}/runs`)).status).toBe(404);
  symlinkSync(second, first);
  expect((await request(`/api/projects/${a.id}/files/groundwork/shared?path=output.log`)).status).toBe(404);
  expect(await (await request(`/api/projects/${b.id}/files/groundwork/shared?path=output.log`)).text()).toBe("Second evidence");
});

test("registration validates same-origin JSON and existing directories before changing portal metadata", async () => {
  const root = temporaryProject();
  const { request } = portalInstance();
  const payload = JSON.stringify({ root });
  for (const headers of [{ Origin: "https://evil.example" }, { Host: "evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    expect((await request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload })).status).toBe(403);
  }
  expect((await request("/api/projects", { method: "POST", body: payload })).status).toBe(400);
  write(root, "file.txt", "Not a directory");
  for (const body of ["{broken", "null", JSON.stringify({ root: "." }), JSON.stringify({ root: join(root, "missing") }), JSON.stringify({ root: join(root, "file.txt") })]) {
    expect((await request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(400);
  }
  for (const method of ["PUT", "PATCH", "DELETE"]) expect((await request("/api/projects", { method })).status).toBe(405);
  expect(await (await request("/api/projects")).json()).toEqual({ projects: [], problems: [] });
  expect(existsSync(join(portalStateDirectory(), "projects.json"))).toBe(false);
});

test("registration preserves malformed and partially invalid saved project lists", async () => {
  const root = temporaryProject();
  const other = temporaryProject();
  for (const content of ["{ broken project list\n", JSON.stringify({ projects: [{ root }, { root: 42 }] }, null, 2)]) {
    const scope = join(temporaryProject(), "portal");
    write(scope, "projects.json", content);
    const { request } = portalInstance(scope);
    const list: ProjectsResponse = await (await request("/api/projects")).json();
    expect(list.problems.length).toBeGreaterThan(0);
    if (list.projects.length) {
      expect(list.projects[0]?.root).toBe(root);
      expect(await register(request, root)).toEqual(list.projects[0]!);
    }
    const response = await request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: other }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Registration cannot overwrite");
    expect(readFileSync(join(scope, "projects.json"), "utf8")).toBe(content);
    expect(readdirSync(scope)).toEqual(["projects.json"]);
  }
});

test("unreadable registries and cache write failures retain the original project list", async () => {
  const root = temporaryProject();
  const other = temporaryProject();
  const scope = portalStateDirectory();
  const instance = portalInstance();
  const project = await register(instance.request, root);
  const path = join(scope, "projects.json");
  const content = readFileSync(path, "utf8");
  const registration = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: other }) };
  try {
    chmodSync(path, 0o000);
    const unreadable = portalInstance();
    chmodSync(path, 0o600);
    expect((await (await unreadable.request("/api/projects")).json()).problems.join(" ")).toContain("Could not read the project list");
    expect((await unreadable.request("/api/projects", registration)).status).toBe(400);
    expect(readFileSync(path, "utf8")).toBe(content);
    chmodSync(scope, 0o500);
    expect((await instance.request("/api/projects", registration)).status).toBe(500);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect((await (await instance.request("/api/projects")).json()).projects).toEqual([project]);
  } finally { chmodSync(path, 0o600); chmodSync(scope, 0o700); }
  expect((await register(instance.request, other)).root).toBe(other);
  expect((await (await instance.request("/api/projects")).json()).projects).toHaveLength(2);
});

function events(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  return async (name: string, projectId?: string) => {
    while (true) {
      const end = text.indexOf("\n\n");
      if (end === -1) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Stream closed before ${name}: ${text}`);
        text += new TextDecoder().decode(chunk.value);
        continue;
      }
      const frame = text.slice(0, end);
      text = text.slice(end + 2);
      if (!frame.includes(`event: ${name}\n`)) continue;
      const data = JSON.parse(frame.match(/^data: (.*)$/m)![1]!);
      if (!projectId || data.projectId === projectId) return data;
    }
  };
}

test("global SSE scopes evidence, configuration and opened-guide changes and announces registrations", async () => {
  const root = temporaryProject();
  const other = temporaryProject();
  const instance = portalInstance();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: instance.app.fetch, idleTimeout: 0 });
  const controller = new AbortController();
  cleanup.push(() => { controller.abort(); server.stop(true); instance.close(); });
  const response = await fetch(`${server.url}api/events`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
  const event = events(response.body!.getReader());
  expect((await event("ready")).build).toMatch(/^[a-f0-9]{64}$/);
  const project = await register(instance.request, root);
  expect(await event("projects")).toEqual({});
  const second = await register(instance.request, other);
  expect(await event("projects")).toEqual({});
  const prefix = `${server.url}api/projects/${project.id}`;
  await fetch(`${prefix}/runs`);
  await fetch(`${server.url}api/projects/${second.id}/runs`);
  write(root, ".groundwork/runs/arrived/result.json", saved("arrived"));
  expect(await event("change", project.id)).toEqual({ projectId: project.id });
  write(root, ".groundwork/verify.json", { checks: {} });
  await event("change", project.id);
  const history: RunsResponse = await (await fetch(`${prefix}/runs`)).json();
  expect(history.runs[0]?.id).toBe("arrived");
  write(root, "docs/related.markdown", "# Original guide\n");
  const guideURL = `${prefix}/guide?path=docs%2Frelated.markdown`;
  expect((await (await fetch(guideURL)).json()).content).toBe("# Original guide\n");
  write(root, "docs/related.markdown", "# Updated guide\n");
  expect((await (await fetch(guideURL)).json()).content).toBe("# Updated guide\n");
  await event("change", project.id);
  expect((await (await fetch(guideURL)).json()).content).toBe("# Updated guide\n");
  write(other, ".verify/runs/arrived/result.json", saved("arrived"));
  expect(await event("change", second.id)).toEqual({ projectId: second.id });
  rmSync(root, { recursive: true });
  expect(await event("change", project.id)).toEqual({ projectId: project.id });
  const listed: ProjectsResponse = await (await fetch(`${server.url}api/projects`)).json();
  expect(listed.projects.find(item => item.id === project.id)?.available).toBe(false);
  expect((await fetch(`${server.url}api/projects/${second.id}/runs`)).status).toBe(200);
  mkdirSync(root);
  expect(await register(instance.request, root)).toEqual(project);
  expect(await event("projects")).toEqual({});
  expect((await fetch(`${prefix}/runs`)).status).toBe(200);
});

function localEnvironment(extra: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of [...ciVariables, "GROUNDWORK_EVIDENCE_DIR", "GROUNDWORK_PORTAL"]) delete env[key];
  return { ...env, ...extra };
}

async function invoke(root: string, args: string[], env: Record<string, string | undefined>, entry = cli) {
  const child = Bun.spawn([process.execPath, entry, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const url = stderr.match(/Groundwork portal: (http:\/\/127\.0\.0\.1:\d+\/\?project=[a-f0-9]+)/)?.[1];
  return { code, stdout, stderr, url, origin: url ? new URL(url).origin : undefined };
}

async function stopPortal(scope: string) {
  const ports = portalPorts(scope);
  const health = await Promise.all(ports.map(port => portalHealth(scope, port)));
  for (const value of health) {
    if (!value) continue;
    try { process.kill(value.pid, "SIGTERM"); } catch { /* It may already have stopped. */ }
  }
  const deadline = Date.now() + 2000;
  while ((await Promise.all(ports.map(port => probePortal(scope, port)))).some(Boolean)) {
    if (Date.now() > deadline) throw new Error("Fixture portal did not stop.");
    await Bun.sleep(25);
  }
}

function stopDaemons(scope = portalStateDirectory()) { cleanup.push(() => stopPortal(scope)); }

async function sourceInstallation() {
  const root = temporaryProject();
  cpSync(fileURLToPath(new URL("../lib", import.meta.url)), join(root, "lib"), { recursive: true });
  write(root, "skills/verify-work/verify.mjs", readFileSync(cli, "utf8"));
  const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("../portal/server.ts", import.meta.url))], target: "bun", minify: true });
  if (!result.success) throw new AggregateError(result.logs, "Could not build the fixture portal.");
  write(root, "portal/dist/server.js", await result.outputs[0]!.text());
  return { cli: join(root, "skills/verify-work/verify.mjs"), server: join(root, "portal/dist/server.js") };
}

test("concurrent CLI commands in multiple repositories share one detached daemon and project-specific URLs", async () => {
  expect(existsSync(fileURLToPath(new URL("../portal/dist/server.js", import.meta.url)))).toBe(true);
  const root = temporaryProject();
  const other = temporaryProject();
  const scope = portalStateDirectory();
  stopDaemons();
  const roots = [root, other, root, other];
  const results = await Promise.all(roots.map(directory => invoke(directory, ["--help"], localEnvironment({ CI: "false" }))));
  expect(results.every(result => result.code === 0 && result.stdout.includes("groundwork —"))).toBe(true);
  expect(results.every(result => Boolean(result.url))).toBe(true);
  expect(new Set(results.map(result => result.origin)).size).toBe(1);
  expect(new Set(results.map(result => result.url)).size).toBe(2);
  const origin = results[0]!.origin!;
  const health = await (await fetch(`${origin}/api/health`)).json();
  expect(health).toMatchObject({ service: "groundwork-portal", scope, protocol: 2 });
  const list: ProjectsResponse = await (await fetch(`${origin}/api/projects`)).json();
  expect(list.projects.map(project => project.root).sort()).toEqual([root, other].sort());
  for (const [index, result] of results.entries()) {
    const id = new URL(result.url!).searchParams.get("project");
    expect(list.projects.find(project => project.id === id)?.root).toBe(roots[index]);
    expect((await (await fetch(`${result.origin}/api/health`)).json()).pid).toBe(health.pid);
  }
  const repeat = await invoke(root, ["bad-command"], localEnvironment({ CI: "0" }));
  expect(repeat.code).toBe(2);
  expect(repeat.url).toBe(results[0]!.url);
  expect((await (await fetch(`${origin}/api/health`)).json()).pid).toBe(health.pid);
  expect(readdirSync(root)).toEqual([]);
  expect(readdirSync(other)).toEqual([]);
  const matches = await Promise.all(portalPorts(scope).map(port => probePortal(scope, port)));
  expect(matches.filter(Boolean)).toHaveLength(1);
}, 15000);

test("registered projects survive daemon restart and a removed repository does not break other projects", async () => {
  const root = temporaryProject();
  const other = temporaryProject();
  write(other, ".groundwork/runs/shared/result.json", saved("shared"));
  write(other, ".groundwork/runs/shared/output.log", "Surviving repository");
  const scope = portalStateDirectory();
  stopDaemons();
  const first = await invoke(root, ["--help"], localEnvironment());
  const second = await invoke(other, ["--help"], localEnvironment());
  expect(first.origin).toBe(second.origin);
  const health = await (await fetch(`${first.origin}/api/health`)).json();
  const a = new URL(first.url!).searchParams.get("project");
  const b = new URL(second.url!).searchParams.get("project");
  rmSync(root, { recursive: true });
  expect((await fetch(`${first.origin}/api/projects/${a}/runs`)).status).toBe(404);
  expect((await (await fetch(`${second.origin}/api/health`)).json()).pid).toBe(health.pid);
  expect(await (await fetch(`${second.origin}/api/projects/${b}/files/groundwork/shared?path=output.log`)).text()).toBe("Surviving repository");
  await stopPortal(scope);
  const restarted = await invoke(other, ["--help"], localEnvironment());
  expect(restarted.url).toBe(second.url);
  expect((await (await fetch(`${restarted.origin}/api/health`)).json()).pid).not.toBe(health.pid);
  const list: ProjectsResponse = await (await fetch(`${restarted.origin}/api/projects`)).json();
  expect(list.projects).toEqual([
    expect.objectContaining({ id: a, root, available: false }),
    expect.objectContaining({ id: b, root: other, available: true }),
  ]);
  expect(list.problems.join(" ")).toContain(root);
  expect(await (await fetch(`${restarted.origin}/api/projects/${b}/files/groundwork/shared?path=output.log`)).text()).toBe("Surviving repository");
}, 15000);

test("CLI uses init target and existing project discovery while CI, recursion and opt-out skip startup", async () => {
  const cwd = temporaryProject();
  const target = temporaryProject();
  stopDaemons();
  const init = await invoke(cwd, ["init", target], localEnvironment());
  expect(init.code).toBe(0);
  expect(init.url).toBeTruthy();
  const id = new URL(init.url!).searchParams.get("project");
  expect((await (await fetch(`${init.origin}/api/projects/${id}/runs`)).json()).project.root).toBe(target);
  mkdirSync(join(target, "nested"));
  const nested = await invoke(join(target, "nested"), ["view", "guide"], localEnvironment());
  expect(nested.url).toBe(init.url);
  for (const env of [{ CI: "1" }, { CI: "false", GITHUB_ACTIONS: "true" }, { GROUNDWORK_EVIDENCE_DIR: "/evidence" }, { GROUNDWORK_PORTAL: "0" }]) {
    const result = await invoke(cwd, ["--help"], localEnvironment(env));
    expect(result.code).toBe(0);
    expect(result.url).toBeUndefined();
  }
  expect((await (await fetch(`${init.origin}/api/projects`)).json()).projects.map((project: Project) => project.root)).toEqual([target]);
  const home = temporaryProject();
  const update = await invoke(target, ["update"], localEnvironment({
    HOME: home, COPILOT_HOME: join(home, ".copilot"), XDG_CONFIG_HOME: join(home, ".config"),
  }));
  expect(update.code).toBe(0);
  expect(update.url).toBe(init.url);
  expect(update.stderr.match(/Groundwork portal:/g)).toHaveLength(1);
  expect((await (await fetch(`${init.origin}/api/projects`)).json()).projects.map((project: Project) => project.root)).toEqual([target]);
  expect(existsSync(join(home, ".cache/groundwork/portal"))).toBe(false);
}, 15000);

test("occupied ports fall back without changing CLI exits, including when all candidates are unavailable", async () => {
  const root = temporaryProject();
  const scope = portalStateDirectory();
  const ports = portalPorts(scope);
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: ports[0], fetch: () => Response.json({ service: "groundwork-portal", scope: "/another-cache", protocol: 2, build: "f".repeat(64), pid: process.pid }) });
  cleanup.push(() => { occupied.stop(true); });
  stopDaemons();
  const result = await invoke(root, ["--help"], localEnvironment());
  expect(result.code).toBe(0);
  expect(result.url).toBeTruthy();
  expect(result.origin).not.toBe(portalURL(ports[0]!));
  const blocked = temporaryProject();
  const blockedCache = temporaryProject();
  const blockedScope = join(blockedCache, "groundwork/portal");
  for (const port of portalPorts(blockedScope)) {
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("Occupied") });
    cleanup.push(() => { server.stop(true); });
  }
  const started = Date.now();
  const failed = await invoke(blocked, ["bad-command"], localEnvironment({ XDG_CACHE_HOME: blockedCache }));
  expect(failed.code).toBe(2);
  expect(failed.url).toBeUndefined();
  expect(failed.stderr).toContain("Unknown command");
  expect(Date.now() - started).toBeLessThan(6000);
}, 15000);

test("a new CLI build replaces its outdated daemon on the same fallback port", async () => {
  const root = temporaryProject();
  const fixture = temporaryProject();
  const bundle = fileURLToPath(new URL("../portal/dist/server.js", import.meta.url));
  const previous = join(fixture, "previous.js");
  const scope = portalStateDirectory();
  const [first, fallback] = portalPorts(scope);
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: first, fetch: () => new Response("Occupied") });
  cleanup.push(() => { occupied.stop(true); });
  writeFileSync(previous, `${readFileSync(bundle, "utf8")}\n// Previous package build\n`);
  const old = Bun.spawn([process.execPath, previous, scope], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => { old.kill(); });
  stopDaemons();
  const deadline = Date.now() + 3000;
  while (!await probePortal(scope, fallback) && Date.now() < deadline) await Bun.sleep(25);
  expect(await probePortal(scope, fallback)).toBe(true);
  occupied.stop(true);
  const result = await invoke(root, ["--help"], localEnvironment());
  expect(result.code).toBe(0);
  expect(result.origin).toBe(portalURL(fallback));
  const health = await (await fetch(`${result.origin}/api/health`)).json();
  expect(health.build).toBe(portalBuild(bundle));
  expect(health.pid).not.toBe(old.pid);
  expect(await old.exited).toBe(0);
}, 15000);

test("simultaneous fallback upgrades and crash recovery retain one daemon, origin and complete registry", async () => {
  const installation = await sourceInstallation();
  const root = temporaryProject();
  const other = temporaryProject();
  const previous = join(temporaryProject(), "previous.js");
  const scope = portalStateDirectory();
  const [first, fallback] = portalPorts(scope);
  const origin = portalURL(fallback);
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: first, fetch: () => new Response("Occupied") });
  cleanup.push(() => { occupied.stop(true); });
  writeFileSync(previous, `${readFileSync(installation.server, "utf8")}\n// Previous build\n`);
  const old = Bun.spawn([process.execPath, previous, scope], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => { old.kill(); });
  stopDaemons();
  const deadline = Date.now() + 3000;
  while (!await probePortal(scope, fallback) && Date.now() < deadline) await Bun.sleep(25);
  expect(await probePortal(scope, fallback)).toBe(true);
  await register((path, init) => fetch(`${origin}${path}`, init), root);
  occupied.stop(true);

  // Direct launches also race the CLI's replacement, with and without the old port hint.
  const starters = [fallback, undefined, fallback, undefined].map(preferred => {
    const child = Bun.spawn([process.execPath, installation.server, scope, ...(preferred ? [String(preferred)] : [])], { stdout: "ignore", stderr: "ignore" });
    cleanup.push(() => { child.kill(); });
    return child;
  });
  const invokeProject = (directory: string) => invoke(directory, ["--help"], localEnvironment(), installation.cli);
  const results = await Promise.all([root, other, root, other].map(invokeProject));
  expect(results.every(result => result.code === 0 && result.origin === origin)).toBe(true);
  const health = await (await fetch(`${origin}/api/health`)).json();
  expect(health.build).toBe(portalBuild(installation.server));
  expect(health.pid).not.toBe(old.pid);
  const matches = await Promise.all(portalPorts(scope).map(port => portalHealth(scope, port)));
  expect(matches.filter(Boolean).map(value => value.pid)).toEqual([health.pid]);
  for (const child of starters) if (child.pid !== health.pid) expect(await child.exited).toBe(0);
  expect(await old.exited).toBe(0);
  const list: ProjectsResponse = await (await fetch(`${origin}/api/projects`)).json();
  expect(list.projects.map(project => project.root).sort()).toEqual([root, other].sort());
  await stopPortal(scope);
  const restart = await invokeProject(other);
  expect(restart.origin).toBe(origin);
  expect(await (await fetch(`${origin}/api/projects`)).json()).toEqual(list);

  const restarted = await (await fetch(`${origin}/api/health`)).json();
  process.kill(restarted.pid, "SIGKILL");
  const recovered = await Promise.all([root, other, root, other].map(invokeProject));
  expect(recovered.every(result => result.code === 0 && result.origin === origin)).toBe(true);
  const survivors = (await Promise.all(portalPorts(scope).map(port => portalHealth(scope, port)))).filter(Boolean);
  expect(survivors).toHaveLength(1);
  expect(survivors[0].pid).not.toBe(restarted.pid);
  expect(await (await fetch(`${origin}/api/projects`)).json()).toEqual(list);
}, 15000);

test("a UI-only update in a copied installation replaces the prior distribution daemon", async () => {
  const root = temporaryProject();
  const previousInstall = temporaryProject();
  const nextInstall = temporaryProject();
  const distribution = fileURLToPath(new URL("../portal/dist", import.meta.url));
  for (const install of [previousInstall, nextInstall]) cpSync(distribution, join(install, "portal/dist"), { recursive: true });
  const previousEntry = join(previousInstall, "portal/dist/server.js");
  const nextEntry = join(nextInstall, "portal/dist/server.js");
  expect(readFileSync(previousEntry)).toEqual(readFileSync(nextEntry));
  expect(portalBuild(previousEntry)).not.toBe(portalBuild(nextEntry));
  const beforeUIChange = portalBuild(nextEntry);
  const browser = join(nextInstall, "portal/dist/public/assets/app.js");
  writeFileSync(browser, `${readFileSync(browser, "utf8")}\n// UI-only update\n`);
  expect(portalBuild(nextEntry)).not.toBe(beforeUIChange);
  cpSync(fileURLToPath(new URL("../lib", import.meta.url)), join(nextInstall, "lib"), { recursive: true });
  const nextCLI = join(nextInstall, "skills/verify-work/verify.mjs");
  write(nextInstall, "skills/verify-work/verify.mjs", readFileSync(cli, "utf8"));
  const scope = portalStateDirectory();
  const old = Bun.spawn([process.execPath, previousEntry, scope], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => { old.kill(); });
  stopDaemons();
  const deadline = Date.now() + 3000;
  while (!await probePortal(scope, portalPorts(scope)[0]) && Date.now() < deadline) await Bun.sleep(25);
  expect(await probePortal(scope, portalPorts(scope)[0])).toBe(true);
  const result = await invoke(root, ["--help"], localEnvironment(), nextCLI);
  expect(result.code).toBe(0);
  expect(result.url).toBeTruthy();
  const health = await (await fetch(`${result.origin}/api/health`)).json();
  expect(health.build).toBe(portalBuild(nextEntry));
  expect(health.pid).not.toBe(old.pid);
  expect(await (await fetch(`${result.origin}/assets/app.js`)).text()).toEndWith("// UI-only update\n");
  expect(await old.exited).toBe(0);
}, 15000);
