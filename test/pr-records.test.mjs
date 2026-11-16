import { expect, test } from "bun:test";
import { assess } from "../lib/model.mjs";
import { makeRecord, parseRecord, renderRecord } from "../lib/report.mjs";
import { listRecords, publishRecord, statusContext } from "../lib/pr-records.mjs";

const target = { owner: "consumer", repo: "project", number: 42, headSha: "head-commit" };
const base = "/repos/consumer/project";
const pullPath = `${base}/pulls/42`;
const commentPath = `${base}/issues/42/comments`;
const author = { id: 17, login: "verification[bot]", type: "Bot" };
const other = { id: 18, login: "another[bot]", type: "Bot" };
const httpError = (status, message = `HTTP ${status}`, headers = {}) => Object.assign(new Error(message), { status, headers });

function run(id = "run-1", status = "passed", startedAt = "2026-11-16T12:00:00Z") {
  const assessment = assess({
    plan: { goal: "Exercise the application", requirements: [{ id: "app", expect: "The application works", checks: ["app"], behaviours: [] }] },
    checks: [{ name: "app", command: "bun check", expect: "The application works", covers: ["app"], status,
      exitCode: status === "passed" ? 0 : 1, durationMs: 1, log: "app/output.log", artifacts: [] }],
  });
  const record = makeRecord({ assessment, run: { kind: "local", id, startedAt, finishedAt: startedAt,
    source: { identityVersion: 2, revision: target.headSha, fingerprint: "a".repeat(64), dirty: false } } });
  return { record, assessment, sourceMatches: true };
}

function server({ unavailable = null, writeError = null, commentError = null } = {}) {
  const artifacts = [];
  const comments = [];
  const calls = [];
  const states = [];
  const pull = { number: 42, head: { sha: target.headSha }, html_url: "https://github.com/consumer/project/pull/42" };
  let nextId = 1;
  const api = {
    async paginate(path) {
      calls.push({ method: "paginate", path });
      if (path === `${pullPath}/artifacts?per_page=100`) {
        if (unavailable) throw unavailable;
        return artifacts.flat();
      }
      if (path === `${commentPath}?per_page=100`) return comments.flat();
      if (path === `${base}/commits/${pull.head.sha}/statuses?per_page=100`) return states.slice().reverse();
      throw new Error(`Unexpected pagination: ${path}`);
    },
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "GET" && path === pullPath) return { status: 200, data: pull };
      if (method === "POST" && path === `${base}/statuses/${target.headSha}`) {
        states.push(body);
        return { status: 201, data: { creator: author, ...body } };
      }
      if (method === "PUT" && path.startsWith(`${pullPath}/artifacts/`)) {
        if (writeError) throw writeError;
        const name = decodeURIComponent(path.split("/").at(-1));
        let item = artifacts.flat().find(item => item.name === name && item.creator.id === author.id);
        if (!item) { item = { id: nextId++, name, creator: author }; artifacts.push(item); }
        Object.assign(item, body);
        return { status: 200, data: item };
      }
      if (method === "POST" && path === commentPath) {
        if (commentError) throw commentError;
        const id = nextId++;
        const item = { id, user: author, html_url: `${pull.html_url}#issuecomment-${id}`, ...body };
        comments.push(item);
        return { status: 201, data: item };
      }
      if (method === "PATCH" && path.startsWith(`${base}/issues/comments/`)) {
        if (commentError) throw commentError;
        const item = comments.flat().find(item => item.id === Number(path.split("/").at(-1)));
        Object.assign(item, body);
        return { status: 200, data: item };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  return { api, artifacts, comments, calls, states, pull,
    failWrites: error => { writeError = error; }, failComments: error => { commentError = error; } };
}

test("artifact and fallback publish the same frozen record and current assessment without requiring an archive", async () => {
  const input = run();
  const artifact = server();
  const fallback = server({ unavailable: httpError(404) });
  const first = await publishRecord({ api: artifact.api, target, ...input });
  const second = await publishRecord({ api: fallback.api, target, ...input });
  const artifactPayload = parseRecord(artifact.artifacts[0].body);
  const commentPayload = parseRecord(fallback.comments[0].body);
  expect(artifactPayload.record).toEqual(input.record);
  expect(commentPayload.record).toEqual(artifactPayload.record);
  expect(commentPayload.publication.assessment).toEqual(artifactPayload.publication.assessment);
  expect(first).toMatchObject({ transport: "artifact", status: "success", url: artifact.pull.html_url });
  expect(second).toMatchObject({ transport: "comment", status: "success", url: fallback.comments[0].html_url });
  expect(artifact.states.map(item => item.state)).toEqual(["pending", "success"]);
  expect(artifact.states.every(item => item.context === statusContext)).toBe(true);
  const writes = artifact.calls.filter(item => ["POST", "PUT", "PATCH"].includes(item.method));
  expect(writes.map(item => item.method)).toEqual(["POST", "PUT", "POST"]);
  expect(artifactPayload.publication.publisher.id).toBe(author.id);
});

test.each([403, 404])("an unavailable artifact write (HTTP %s) uses the owned comment transport", async status => {
  const value = server({ writeError: httpError(status) });
  const result = await publishRecord({ api: value.api, target, ...run() });
  expect(result.transport).toBe("comment");
  expect(parseRecord(value.comments[0].body).record.run.id).toBe("run-1");
  expect(value.states.at(-1).state).toBe("success");
});

test("same-run artifact retries update their own identity, and new runs retain prior history", async () => {
  const value = server();
  const input = run();
  await publishRecord({ api: value.api, target, ...input });
  const first = structuredClone(value.artifacts[0]);
  const foreign = { ...first, id: 99, creator: other };
  value.artifacts.unshift(foreign);
  await publishRecord({ api: value.api, target, ...input });
  expect(value.artifacts).toHaveLength(2);
  expect(value.artifacts[1].id).toBe(first.id);
  expect(foreign).toEqual({ ...first, id: 99, creator: other });
  await publishRecord({ api: value.api, target, ...run("run-2", "failed", "2026-11-16T13:00:00Z") });
  expect(value.artifacts).toHaveLength(3);
  expect(value.states.at(-1).state).toBe("failure");
  const retry = await publishRecord({ api: value.api, target, ...input });
  expect(retry).toMatchObject({ superseded: true, status: "failure" });
  expect(parseRecord(value.artifacts[2].body).record.status).toBe("failed");
});

test("comment retries use payload run identity and server author across all pages", async () => {
  const value = server({ unavailable: httpError(404) });
  const input = run();
  await publishRecord({ api: value.api, target, ...input });
  const own = value.comments.pop();
  const foreign = { ...own, id: 99, user: other };
  const foreignBody = foreign.body;
  value.comments.push([foreign], [own]);
  await publishRecord({ api: value.api, target, ...input });
  expect(value.calls.filter(item => item.method === "PATCH").at(-1).path).toBe(`${base}/issues/comments/${own.id}`);
  expect(value.comments.flat()).toHaveLength(2);
  expect(foreign.body).toBe(foreignBody);
  await publishRecord({ api: value.api, target, ...run("run-2", "failed", "2026-11-16T13:00:00Z") });
  const retry = await publishRecord({ api: value.api, target, ...input });
  expect(retry).toMatchObject({ superseded: true, status: "failure" });
  expect(value.comments.flat()).toHaveLength(3);
});

test("a refreshed assessment is published separately from the original passing record", async () => {
  const input = run();
  const value = server();
  const assessment = assess({ ...input.assessment, problems: ["Saved evidence changed."] });
  const result = await publishRecord({ api: value.api, target, ...input, assessment, sourceMatches: false });
  const parsed = parseRecord(value.artifacts[0].body);
  expect(parsed.record).toEqual(input.record);
  expect(parsed.record.status).toBe("passed");
  expect(parsed.publication.status).toBe("inconclusive");
  expect(parsed.publication.assessment.problems).toContain("Saved evidence changed.");
  expect(result.status).toBe("error");
  expect(value.states.map(item => item.state)).toEqual(["pending", "error"]);
});

test("an incomplete result without run timestamps supersedes an earlier pass and keeps its ordering on retry", async () => {
  const value = server();
  await publishRecord({ api: value.api, target, ...run("completed", "passed", "2000-01-01T00:00:00Z") });
  const input = run("incomplete");
  input.record = makeRecord({ run: { ...input.record.run, startedAt: null, finishedAt: null }, assessment: input.assessment });
  const first = await publishRecord({ api: value.api, target, ...input });
  expect(first).toMatchObject({ status: "error", superseded: false });
  await publishRecord({ api: value.api, target, ...run("newer", "failed", new Date(Date.now() + 1000).toISOString()) });
  const retry = await publishRecord({ api: value.api, target, ...input });
  expect(retry).toMatchObject({ status: "failure", superseded: true });
  expect(retry.publication.publishedAt).toBe(first.publication.publishedAt);
});

test.each([
  httpError(401), httpError(429), httpError(403, "API rate limit exceeded"),
  httpError(503), new Error("Connection reset after write"),
])("authentication, throttling and uncertain artifact writes remain explicit failures: %s", async error => {
  const value = server({ writeError: error });
  await expect(publishRecord({ api: value.api, target, ...run() })).rejects.toThrow(error.message);
  expect(value.states.map(item => item.state)).toEqual(["pending", "error"]);
  expect(value.comments).toHaveLength(0);
});

test("a read failure after pending clears an earlier success instead of silently publishing elsewhere", async () => {
  const value = server({ unavailable: httpError(401, "Bad credentials") });
  value.states.push({ state: "success" });
  await expect(publishRecord({ api: value.api, target, ...run() })).rejects.toThrow("Bad credentials");
  expect(value.states.map(item => item.state)).toEqual(["success", "pending", "error"]);
});

test("discovery exposes a failed publication even when its only retained record is an older pass", async () => {
  const value = server();
  await publishRecord({ api: value.api, target, ...run() });
  value.failWrites(new Error("Publication connection failed"));
  await expect(publishRecord({ api: value.api, target, ...run("newer", "failed", "2026-11-16T13:00:00Z") }))
    .rejects.toThrow("Publication connection failed");
  value.states.push({ context: "unrelated-check", state: "success" });
  value.calls.length = 0;
  const result = await listRecords({ api: value.api, target });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ status: "passed", current: true });
  expect(result.commitStatus).toMatchObject({ state: "error", context: statusContext });
  expect(value.calls.every(call => ["GET", "paginate"].includes(call.method))).toBe(true);
});

test.each(["artifact", "comment"])("an older retry preserves a newer unpublished failure in %s transport until a new verified run", async transport => {
  const value = server(transport === "comment" ? { unavailable: httpError(404) } : {});
  const fail = transport === "comment" ? value.failComments : value.failWrites;
  const original = run("original", "passed", "2026-11-16T12:00:00Z");
  await publishRecord({ api: value.api, target, ...original });
  fail(new Error("New run publication failed"));
  await expect(publishRecord({ api: value.api, target, ...run("unpublished", "failed", "2026-11-16T13:00:00Z") }))
    .rejects.toThrow("New run publication failed");
  fail(null);
  const retried = await publishRecord({ api: value.api, target, ...original });
  expect(retried).toMatchObject({ status: "error", superseded: true });
  const discovered = await listRecords({ api: value.api, target });
  expect(discovered.records).toHaveLength(1);
  expect(discovered.records[0].record.run.id).toBe("original");
  expect(discovered.commitStatus.state).toBe("error");
  const next = await publishRecord({ api: value.api, target, ...run("new-verified", "passed", "2026-11-16T14:00:00Z") });
  expect(next).toMatchObject({ status: "success", superseded: false });
  expect(value.states.at(-1).state).toBe("success");
});

test("fallback comments replace stale same-author artifact views while preserving other runs and authors", async () => {
  const value = server();
  const older = run("older", "passed", "2026-11-16T11:00:00Z");
  const current = run("current", "passed", "2026-11-16T12:00:00Z");
  await publishRecord({ api: value.api, target, ...older });
  await publishRecord({ api: value.api, target, ...current });
  const oldArtifact = structuredClone(value.artifacts[1]);
  value.artifacts.push({ ...oldArtifact, id: 99, creator: other });
  value.failWrites(httpError(403));
  const assessment = assess({ ...current.assessment, problems: ["The retained evidence is no longer applicable."] });
  await publishRecord({ api: value.api, target, ...current, assessment });
  expect(parseRecord(value.artifacts[1].body).publication.status).toBe("passed");
  const firstView = await listRecords({ api: value.api, target });
  expect(firstView.records[0]).toMatchObject({ status: "inconclusive", source: { type: "comment", author } });
  expect(firstView.records).toHaveLength(3);
  expect(firstView.records.find(item => item.source.author.id === other.id).record.run.id).toBe("current");
  expect(firstView.records.find(item => item.record.run.id === "older").status).toBe("passed");
  const active = value.comments[0];
  active.updated_at = "2026-11-16T13:00:00Z";
  value.comments.push({ ...active, id: 100, body: oldArtifact.body, updated_at: "2026-11-16T12:00:00Z" });
  const updatedView = await listRecords({ api: value.api, target });
  expect(updatedView.records[0]).toMatchObject({ status: "inconclusive", source: { id: active.id, type: "comment" } });
  value.failWrites(null);
  const retry = await publishRecord({ api: value.api, target, ...older });
  expect(retry).toMatchObject({ status: "error", superseded: true });
});

test("a failed initial PR lookup invalidates earlier green on the known expected SHA", async () => {
  const value = server();
  await publishRecord({ api: value.api, target, ...run() });
  const request = value.api.request;
  value.api.request = (method, path, body) => method === "GET" && path === pullPath
    ? Promise.reject(new Error("PR lookup failed")) : request(method, path, body);
  await expect(publishRecord({ api: value.api, target, ...run("new-failed", "failed", "2026-11-16T13:00:00Z") }))
    .rejects.toThrow("PR lookup failed");
  expect(value.states.at(-1).state).toBe("error");
  expect(value.artifacts).toHaveLength(1);
  value.api.request = request;
  const retry = await publishRecord({ api: value.api, target, ...run() });
  expect(retry).toMatchObject({ status: "error", superseded: true });
});

test("preflight failure reports when its failure status cannot be written", async () => {
  const value = server();
  await publishRecord({ api: value.api, target, ...run() });
  value.api.request = async method => { throw new Error(method === "GET" ? "PR lookup failed" : "Status write unavailable"); };
  await expect(publishRecord({ api: value.api, target, ...run("new-failed", "failed", "2026-11-16T13:00:00Z") }))
    .rejects.toThrow("PR lookup failed; could not mark publication failure: Status write unavailable");
  expect(value.artifacts).toHaveLength(1);
});

test("read-only discovery retains all pages, source authors, historical labels and malformed diagnostics", async () => {
  const value = server();
  await publishRecord({ api: value.api, target, ...run("old") });
  const old = value.artifacts.pop();
  value.artifacts.push([{ id: 200, body: "An unrelated document", creator: other }], [old]);
  value.pull.head.sha = "new-head";
  const current = run("current", "failed", "2026-11-16T13:00:00Z").record;
  value.comments.push([{ id: 201, user: other, body: "<!-- groundwork-record:v1\n{bad json}\n-->" }], [{
    id: 202, user: author, html_url: `${value.pull.html_url}#issuecomment-202`,
    body: renderRecord(current, { publication: { repository: "consumer/project", pullRequest: 42,
      headSha: "new-head", sourceMatches: true, status: "failed" } }),
  }]);
  value.calls.length = 0;
  const result = await listRecords({ api: value.api, target });
  expect(result.records.map(item => [item.record.run.id, item.current])).toEqual([["current", true], ["old", false]]);
  expect(result.records[0].source).toMatchObject({ type: "comment", id: 202, author });
  expect(result.records[1].diagnostics.join(" ")).toContain("Historical record");
  expect(result.diagnostics).toContain("Malformed Groundwork record in comment 201.");
  expect(value.calls.map(item => item.method)).toEqual(["GET", "paginate", "paginate", "paginate"]);
});

test("a moved PR head is detected before a record or status is written", async () => {
  const value = server();
  value.pull.head.sha = "new-head";
  const result = await publishRecord({ api: value.api, target, ...run() });
  expect(result.skipped).toContain("newer head");
  expect(value.calls.map(item => item.method)).toEqual(["GET"]);
});
