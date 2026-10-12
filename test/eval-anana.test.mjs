import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReport } from "../.groundwork/scripts/evals/anana.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-anana-"));
  directories.push(directory);
  return {
    origin: "https://benchmarks.useanana.com", token: "test-personal-token", workspaceId: "workspace-1",
    receiptPath: join(directory, "run-1.json"), evidenceUrl: "https://example.com/evidence/run-1",
    report: {
      version: 1, id: "run-1", createdAt: "2026-10-11T12:00:00.000Z",
      experiment: { digest: "experiment-sha256", suite: "skills-v1", split: "development" },
      groups: [
        { runtime: "native", model: "model-a", family: "a", condition: "current", attempts: 3,
          completed: 2, passed: 1, failed: 1, inconclusive: 1, qualityScore: 0.7, judgeScores: [{ model: "judge-b", score: 0.7 }] },
        { runtime: "native", model: "model-b", family: "b", condition: "none", attempts: 3,
          completed: 1, passed: 1, failed: 0, inconclusive: 2, qualityScore: 0.9, judgeScores: [{ model: "judge-a", score: 0.9 }] },
      ], comparisons: [], trials: [],
    },
    markdown: "# Run 1\n\n## Raw judge verdicts\n\nJudge B: 0.7; Judge A: 0.9.\n\nEvidence is incomplete for three attempts.",
  };
}

// A stateful external HTTP boundary: writes persist independently of their response delivery.
function anana() {
  const pages = new Map();
  const content = new Map();
  const calls = [];
  const server = { pages, content, calls, intercept: null, workspace: "workspace-1" };
  server.fetch = async (input, options) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { path: url.pathname, method: options.method, body };
    calls.push(call);
    expect(url.origin).toBe("https://benchmarks.useanana.com");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    if (options.headers.Authorization !== "Bearer test-personal-token") return Response.json({ error: "unauthorized" }, { status: 401 });
    const intercepted = await server.intercept?.(call);
    if (intercepted) return intercepted;
    if (call.path === "/api/bootstrap") return Response.json({ user: { id: "user-1" }, workspace: { id: server.workspace, slug: "benchmarks" } });
    if (call.path === "/api/workspaces/workspace-1/pages") {
      expect(url.searchParams.get("removed")).toBe("true");
      return Response.json([...pages.values()]);
    }
    if (call.path === "/api/pages" && call.method === "POST") {
      const page = { id: `page-${pages.size + 1}`, workspace_id: body.workspaceId, parent_id: body.parentId,
        kind: body.kind, title: body.title, owner_id: "user-1", visibility: body.visibility || "inherit",
        properties: body.properties || {}, schema: [], views: [], access: "full",
        public_token: null, archived_at: null, deleted_at: null, locked: false };
      if (page.kind === "database") {
        page.schema = [{ id: "existing-tags", name: "Tags", type: "text", width: 200 }];
        page.views = [{ id: "table", name: "All records", type: "table" }];
      }
      pages.set(page.id, page);
      content.set(page.id, body.markdown);
      if (server.loseResponse === page.kind) {
        server.loseResponse = null;
        throw new Error("Connection dropped after commit");
      }
      return Response.json(page, { status: 201 });
    }
    const contentRequest = call.path.endsWith("/content");
    const id = call.path.split("/").at(contentRequest ? -2 : -1);
    const page = pages.get(id);
    if (!page) return Response.json({ error: "not found" }, { status: 404 });
    if (contentRequest) {
      const markdown = content.get(id) || "";
      return Response.json({ markdown, blocks: markdown ? [{ type: "paragraph", content: markdown }] : [], version: "document-version-1" });
    }
    if (call.method === "PATCH") {
      Object.assign(page, body);
      return Response.json(page);
    }
    return Response.json({ page, children: [...pages.values()].filter(child => child.parent_id === id), ancestors: [], blocks: [] });
  };
  return server;
}

function property(server, databaseId, name) {
  return server.pages.get(databaseId).schema.find(field => field.name === name).id;
}

function receipt(options) {
  return JSON.parse(readFileSync(options.receiptPath, "utf8"));
}

test("publishes a private database and a read-back-confirmed run without averaging heterogeneous scores", async () => {
  const options = fixture();
  const server = anana();
  delete options.report.groups[1].failed;
  const result = await publishReport({ ...options, fetchImpl: server.fetch });
  const database = server.pages.get(result.databaseId);
  const row = server.pages.get(result.pageId);
  expect(result.created).toBe(true);
  expect(result.url).toBe(`${options.origin}/p/${result.pageId}`);
  expect(database.visibility).toBe("private");
  expect(database.parent_id).toBeNull();
  expect(database.schema).toContainEqual({ id: "existing-tags", name: "Tags", type: "text", width: 200 });
  expect(database.views).toEqual([{ id: "table", name: "All records", type: "table" }]);
  expect(row.parent_id).toBe(database.id);
  expect(row.properties[property(server, database.id, "Run ID")]).toBe("run-1");
  expect(row.properties[property(server, database.id, "Completed")]).toBe(3);
  expect(row.properties[property(server, database.id, "Failed")]).toBeNull();
  expect(row.properties[property(server, database.id, "Quality (single group only)")]).toBeNull();
  expect(row.properties[property(server, database.id, "Human decision")]).toBe("pending");
  expect(server.content.get(row.id)).toBe(options.markdown);
  expect(server.calls.some(call => call.method === "GET" && call.path === `/api/pages/${row.id}`)).toBe(true);
  expect(server.calls.some(call => call.method === "GET" && call.path === `/api/pages/${row.id}/content`)).toBe(true);
  expect(receipt(options).state).toBe("confirmed");
  expect(receipt(options).document.version).toBe("document-version-1");
  expect(readFileSync(options.receiptPath, "utf8")).not.toContain(options.token);
});

test("new rows remain pending on empty live content and recover without duplicate writes or byte-exact Markdown matching", async () => {
  const options = fixture();
  const server = anana();
  server.intercept = call => {
    if (call.path.endsWith("/content")) return Response.json({ markdown: " \n", blocks: [], version: "empty-version" });
  };
  await expect(publishReport({ ...options, fetchImpl: server.fetch })).rejects.toThrow("live document read-back");
  expect(receipt(options).state).toBe("pending");
  expect(receipt(options).document).toBeUndefined();
  expect(server.pages.size).toBe(2);
  const row = [...server.pages.values()].find(page => page.kind === "page");
  const normalized = `${options.markdown.replaceAll("\n", "\r\n")}\r\n`;
  server.content.set(row.id, normalized);
  server.intercept = null;
  const recovered = await publishReport({ ...options, fetchImpl: server.fetch });
  expect(recovered.pageId).toBe(row.id);
  expect(recovered.created).toBe(false);
  expect(receipt(options).state).toBe("confirmed");
  expect(receipt(options).document.version).toBe("document-version-1");
  expect(server.calls.filter(call => call.method === "POST")).toHaveLength(2);
  expect(server.content.get(row.id)).toBe(normalized);
});

test("repeat publication discovers the same run, preserves human decisions and notes, and rejects changed immutable input", async () => {
  const options = fixture();
  const server = anana();
  const first = await publishReport({ ...options, fetchImpl: server.fetch });
  const row = server.pages.get(first.pageId);
  row.properties[property(server, first.databaseId, "Human decision")] = "investigate";
  row.properties["reviewer-notes"] = "Keep this benchmark, but inspect the missing evidence.";
  server.content.set(row.id, `${options.markdown}\n\nHuman review: investigate.`);
  const database = server.pages.get(first.databaseId);
  database.schema.push({ id: "reviewer-notes", name: "Reviewer notes", type: "text" });
  const schemaBefore = structuredClone(database.schema);
  const writes = server.calls.filter(call => call.method !== "GET").length;
  server.intercept = call => {
    // Previously confirmed reports must not require revalidating an editor-modified live document.
    if (call.path.endsWith("/content")) return Response.json({ error: "live editor unavailable" }, { status: 503 });
  };
  const second = await publishReport({ ...options, fetchImpl: server.fetch });
  expect(second).toEqual({ ...first, created: false });
  // Also recover using remote identity when a new machine has no successful receipt yet.
  const anotherReceipt = { ...options, receiptPath: join(directories.at(-1), "recovered.json") };
  const discovered = await publishReport({ ...anotherReceipt, fetchImpl: server.fetch });
  expect(discovered.pageId).toBe(first.pageId);
  expect(server.pages.size).toBe(2);
  expect(server.calls.filter(call => call.method !== "GET").length).toBe(writes);
  expect(row.properties[property(server, first.databaseId, "Human decision")]).toBe("investigate");
  expect(row.properties["reviewer-notes"]).toContain("inspect");
  expect(server.content.get(row.id)).toContain("Human review: investigate.");
  expect(database.schema).toEqual(schemaBefore);
  await expect(publishReport({ ...options, markdown: "Changed results", fetchImpl: server.fetch })).rejects.toThrow("immutable run content");
  await expect(publishReport({ ...options, receiptPath: join(directories.at(-1), "changed.json"),
    markdown: "Changed results", fetchImpl: server.fetch })).rejects.toThrow("Immutable run content differs");
  expect(server.pages.size).toBe(2);
});

test("lost POST responses recover both database and row by identity instead of sending duplicate creates", async () => {
  for (const kind of ["database", "page"]) {
    const options = fixture();
    const server = anana();
    server.loseResponse = kind;
    const result = await publishReport({ ...options, fetchImpl: server.fetch });
    expect(result.created).toBe(true);
    expect(server.pages.size).toBe(2);
    expect(server.calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(receipt(options).state).toBe("confirmed");
    await publishReport({ ...options, fetchImpl: server.fetch });
    expect(server.pages.size).toBe(2);
  }
});

test("an uncertain create stays pending until a later lookup confirms it and never blindly retries POST", async () => {
  const options = fixture();
  const server = anana();
  let failLookup = false;
  server.loseResponse = "page";
  server.intercept = call => {
    if (call.method === "POST" && call.body?.kind === "page") failLookup = true;
    if (call.path.includes("/workspaces/") && failLookup) return Response.json({ error: "unavailable" }, { status: 503 });
  };
  await expect(publishReport({ ...options, fetchImpl: server.fetch })).rejects.toThrow("HTTP 503");
  expect(receipt(options).state).toBe("pending");
  const persistedRow = [...server.pages.values()].find(page => page.kind === "page");
  server.intercept = null;
  server.pages.delete(persistedRow.id); // Simulate an unobservable commit: the publisher must not assume absence means failure.
  await expect(publishReport({ ...options, fetchImpl: server.fetch })).rejects.toThrow("unknown outcome");
  expect(server.calls.filter(call => call.method === "POST")).toHaveLength(2);
  server.pages.set(persistedRow.id, persistedRow);
  const recovered = await publishReport({ ...options, fetchImpl: server.fetch });
  expect(recovered.pageId).toBe(persistedRow.id);
  expect(recovered.created).toBe(false);
  expect(receipt(options).state).toBe("confirmed");
});

test("bad credentials, wrong workspace, redirects, rate limits and failed read-back cannot produce success receipts", async () => {
  const cases = [
    { input: { token: "wrong-token" }, message: "HTTP 401" },
    { input: { workspaceId: "wrong-workspace" }, message: "different workspace" },
    { input: { origin: "https://example.com" }, message: "ANANA_ORIGIN" },
    { status: 302, message: "HTTP 302" },
    { status: 429, message: "Retry after 120s" },
    { readback: true, message: "HTTP 503" },
    { corrupt: true, message: "Immutable run content differs" },
  ];
  for (const scenario of cases) {
    const options = { ...fixture(), ...scenario.input };
    const server = anana();
    server.intercept = call => {
      if (scenario.status) return Response.json({ error: options.token }, { status: scenario.status, headers: { "Retry-After": "120" } });
      if (scenario.readback && call.path === "/api/pages/page-2" && call.method === "GET") return Response.json({ error: options.token }, { status: 503 });
      if (scenario.corrupt && call.path === "/api/pages/page-2" && call.method === "GET") {
        const page = structuredClone(server.pages.get("page-2"));
        page.properties[property(server, "page-1", "Report SHA-256")] = "wrong-content";
        return Response.json({ page, children: [], ancestors: [], blocks: [] });
      }
    };
    let error;
    try { await publishReport({ ...options, fetchImpl: server.fetch }); } catch (caught) { error = caught; }
    expect(error?.message).toContain(scenario.message);
    expect(error?.message).not.toContain(options.token);
    let saved;
    try { saved = receipt(options); } catch (caught) { if (caught.code !== "ENOENT") throw caught; }
    expect(saved?.state).not.toBe("confirmed");
    if (!scenario.readback && !scenario.corrupt) expect(server.pages.size).toBe(0);
  }
});

test("a shared publication directory serializes concurrent publishers before either can create a duplicate", async () => {
  const options = fixture();
  const server = anana();
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  server.intercept = async call => {
    if (call.path === "/api/bootstrap") { entered(); await blocked; }
  };
  const first = publishReport({ ...options, fetchImpl: server.fetch });
  await started;
  try {
    await expect(publishReport({ ...options, receiptPath: join(directories.at(-1), "other-run.json"), fetchImpl: server.fetch })).rejects.toThrow("publisher is locked");
  } finally { release(); }
  await first;
  expect(server.pages.size).toBe(2);
});
