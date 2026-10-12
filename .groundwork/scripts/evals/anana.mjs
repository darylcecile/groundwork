import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const OWNER = "groundwork-benchmarks-v1";
const TIMEOUT_MS = 30_000;
const COUNTS = ["attempts", "completed", "passed", "failed", "inconclusive"];
const FIELD = {
  run: "gw_run_id", report: "gw_report_sha256", content: "gw_content_sha256",
  digest: "gw_experiment", suite: "gw_suite", split: "gw_split", date: "gw_date",
  score: "gw_quality", decision: "gw_decision", evidence: "gw_evidence",
  status: "gw_status", models: "gw_models", conditions: "gw_conditions",
};
const SCHEMA = [
  [FIELD.run, "Run ID", "text"], [FIELD.report, "Report SHA-256", "text"],
  [FIELD.content, "Content SHA-256", "text"], [FIELD.digest, "Experiment", "text"],
  [FIELD.suite, "Suite", "text"], [FIELD.split, "Split", "text"], [FIELD.date, "Run date", "date"],
  [FIELD.status, "Evidence status", "text"], [FIELD.models, "Models", "text"], [FIELD.conditions, "Conditions", "text"],
  ...COUNTS.map(name => [`gw_${name}`, name[0].toUpperCase() + name.slice(1), "number"]),
  [FIELD.score, "Quality (single group only)", "number"], [FIELD.evidence, "Evidence", "url"],
].map(([id, name, type]) => ({ id, name, type }));
SCHEMA.push({ id: FIELD.decision, name: "Human decision", type: "select", options: [
  { id: "pending", name: "Pending", color: "gray" },
  { id: "adopt", name: "Adopt", color: "green" },
  { id: "reject", name: "Reject", color: "red" },
  { id: "investigate", name: "Investigate", color: "yellow" },
] });

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function workspaceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Set ANANA_ORIGIN to an HTTPS Anana workspace origin."); }
  ensure(url.protocol === "https:" && /^[a-z0-9]+(?:-[a-z0-9]+)*\.useanana\.com$/.test(url.hostname)
    && !url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "Set ANANA_ORIGIN to https://SLUG.useanana.com without a path, credentials, or query.");
  return url.origin;
}

function evidenceLink(value) {
  if (value == null) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error("Evidence URL must be an absolute HTTPS URL."); }
  ensure(url.protocol === "https:" && !url.username && !url.password, "Evidence URL must be HTTPS without embedded credentials.");
  return url.href;
}

function number(value, count = false) {
  if (value == null) return null;
  ensure(typeof value === "number" && Number.isFinite(value), "Benchmark metrics must be finite numbers or null.");
  ensure(!count || (Number.isSafeInteger(value) && value >= 0), "Completion counts must be nonnegative integers or null.");
  return value;
}

function propertiesFor(report, markdown, evidenceUrl) {
  ensure(report?.version === 1 && text(report.id) && report.id.length <= 20_000, "Expected a version 1 report with a stable run ID.");
  ensure(text(report.createdAt) && Number.isFinite(Date.parse(report.createdAt)), "Report needs a valid creation date.");
  ensure(text(report.experiment?.digest) && text(report.experiment?.suite) && text(report.experiment?.split), "Report needs experiment digest, suite, and split.");
  ensure(Array.isArray(report.groups), "Report groups must be an array.");
  ensure(typeof markdown === "string" && markdown.trim() && markdown.length <= 1_000_000, "Supply nonempty report Markdown (at most 1,000,000 characters).");
  const properties = {
    [FIELD.run]: report.id, [FIELD.report]: hash(report), [FIELD.content]: hash({ markdown, evidenceUrl }),
    [FIELD.digest]: report.experiment.digest, [FIELD.suite]: report.experiment.suite,
    [FIELD.split]: report.experiment.split, [FIELD.date]: new Date(report.createdAt).toISOString(),
    [FIELD.decision]: "pending", [FIELD.evidence]: evidenceUrl,
    [FIELD.status]: report.status ?? null,
    [FIELD.models]: [...new Set(report.groups.map(group => group.model).filter(text))].join(", ") || null,
    [FIELD.conditions]: [...new Set(report.groups.map(group => group.condition).filter(text))].join(", ") || null,
  };
  for (const name of COUNTS) {
    const values = report.groups.map(group => number(group?.[name], true));
    const total = values.length && values.every(value => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
    properties[`gw_${name}`] = number(total, true);
  }
  const scores = report.groups.map(group => number(group?.qualityScore));
  properties[FIELD.score] = scores.length === 1 ? scores[0] : null;
  return properties;
}

function retrySeconds(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 31_536_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

function client(origin, token, fetchImpl) {
  return async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Anana ${method} request failed or timed out after ${TIMEOUT_MS / 1000}s; write outcome may be unknown.`);
    }
    if (!response.ok) {
      const seconds = retrySeconds(response.headers.get("Retry-After"));
      const error = new Error(`Anana ${method} failed (HTTP ${response.status}).${seconds === null ? "" : ` Retry after ${seconds}s.`}`);
      error.status = response.status;
      error.retryAfterSeconds = seconds;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error(`Anana ${method} returned invalid JSON; write outcome may be unknown.`); }
  };
}

function saveReceipt(path, receipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (file !== undefined) closeSync(file);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function loadReceipt(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read the Anana receipt; preserve it and resolve the local file error before retrying.");
  }
}

function lockPublisher(path) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = join(realpathSync(dirname(path)), ".anana-publisher.lock");
  let file;
  try { file = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Anana publisher is locked. Wait for the other publisher, or confirm it stopped before removing the stale .anana-publisher.lock.");
    throw new Error("Cannot acquire the local Anana publisher lock.");
  }
  try { writeFileSync(file, `${process.pid}\n`); } finally { closeSync(file); }
  return () => unlinkSync(lock);
}

function active(page) {
  ensure(page && !page.deleted_at && !page.archived_at, "Anana page is missing, archived, or trashed; refusing to recreate it.");
}

function pageInWorkspace(page, workspaceId) {
  ensure(text(page?.id) && page.workspace_id === workspaceId, "Anana returned a page from the wrong workspace or an invalid page.");
}

function compatibleSchema(schema) {
  return Array.isArray(schema) && SCHEMA.every(field => schema.some(existing => existing.id === field.id && existing.type === field.type));
}

function mergedSchema(schema) {
  ensure(Array.isArray(schema), "Anana database schema is unavailable.");
  const result = [...schema];
  ensure(new Set(schema.map(field => field.id)).size === schema.length, "Database schema contains duplicate property IDs.");
  for (const field of SCHEMA) {
    const existing = result.find(item => item.id === field.id);
    if (!existing) { result.push(field); continue; }
    ensure(existing.type === field.type, "Existing database has an incompatible Groundwork property type.");
    if (field.options) {
      ensure(Array.isArray(existing.options) && field.options.every(option => existing.options.some(item => item.id === option.id)),
        "Existing human decision property must retain pending, adopt, reject, and investigate option IDs.");
    }
  }
  ensure(result.length <= 100, "Database has no room for the benchmark properties (100-property API limit).");
  return result;
}

async function listPages(context) {
  const pages = await context.request("GET", `/api/workspaces/${encodeURIComponent(context.workspaceId)}/pages?removed=true`);
  ensure(Array.isArray(pages), "Anana did not return the accessible pages array.");
  for (const page of pages) pageInWorkspace(page, context.workspaceId);
  return pages;
}

async function readPage(context, id) {
  const detail = await context.request("GET", `/api/pages/${encodeURIComponent(id)}`);
  pageInWorkspace(detail?.page, context.workspaceId);
  ensure(detail.page.id === id, "Anana read-back returned the wrong page identity.");
  active(detail.page);
  return detail.page;
}

function single(pages, message) {
  ensure(pages.length <= 1, message);
  return pages[0];
}

async function createOnce(context, key, body, find) {
  const { receipt, save } = context;
  ensure(!receipt[`${key}Attempted`], "An earlier Anana create has an unknown outcome. No matching page is visible yet; retry discovery later, never blindly recreate.");
  receipt[`${key}Attempted`] = true;
  save(); // Persist intent before sending a non-idempotent request.
  try {
    const page = await context.request("POST", "/api/pages", body);
    pageInWorkspace(page, context.workspaceId);
    receipt[`${key}Id`] = page.id;
    save();
    return page;
  } catch (error) {
    // Only a definite client rejection establishes that this request did not create a page.
    if ([400, 401, 403, 404, 409, 429].includes(error.status)) {
      receipt[`${key}Attempted`] = false;
      if (error.retryAfterSeconds !== null && error.retryAfterSeconds !== undefined) receipt.retryAt = Date.now() + error.retryAfterSeconds * 1000;
      save();
      throw error;
    }
    const recovered = await find();
    if (!recovered) throw error;
    receipt[`${key}Id`] = recovered.id;
    save();
    return recovered;
  }
}

async function databaseFor(context, specifiedId) {
  const { receipt, save } = context;
  const find = async () => single((await listPages(context)).filter(page => page.kind === "database"
    && page.owner_id === context.userId && (page.properties?.gw_publisher === OWNER || compatibleSchema(page.schema))),
  "Several owned benchmark databases match. Specify databaseId rather than creating another.");
  let id = specifiedId || receipt.databaseId;
  if (!id) {
    let found = await find();
    if (!found) found = await createOnce(context, "database", {
      workspaceId: context.workspaceId, parentId: null, kind: "database", title: "Groundwork Benchmarks",
      visibility: "private", properties: { gw_publisher: OWNER },
      markdown: "# Groundwork Benchmarks\n\nImmutable benchmark runs. Human decisions and notes are maintained by reviewers.",
    }, find);
    id = found.id;
  }
  receipt.databaseId = id;
  save();
  let page = await readPage(context, id);
  ensure(page.kind === "database", "Specified Anana page is not a database.");
  ensure(["edit", "full"].includes(page.access) && !page.locked, "Anana database is locked or lacks edit access.");
  if (receipt.databaseAttempted && receipt.state !== "confirmed") ensure(page.visibility === "private" && !page.parent_id && !page.public_token, "New benchmark database was not confirmed private.");
  const schema = mergedSchema(page.schema);
  if (schema.length !== page.schema.length) {
    const previous = page.schema;
    await context.request("PATCH", `/api/pages/${encodeURIComponent(id)}`, { schema });
    page = await readPage(context, id);
    ensure(compatibleSchema(page.schema), "Anana database schema read-back did not confirm benchmark properties.");
    mergedSchema(page.schema);
    for (const field of previous) ensure(page.schema.some(item => item.id === field.id && hash(item) === hash(field)), "Anana schema read-back did not preserve existing properties.");
  }
  return id;
}

async function confirmContent(context, pageId) {
  const content = await context.request("GET", `/api/pages/${encodeURIComponent(pageId)}/content`);
  // The editor serializes Markdown from its live document; formatting need not round-trip byte-for-byte.
  ensure(text(content?.markdown) && Array.isArray(content.blocks) && content.blocks.length > 0,
    "Anana live document read-back did not confirm saved benchmark content; publication remains pending.");
  context.receipt.document = { hash: hash(content.markdown), version: content.version ?? null,
    confirmedAt: new Date().toISOString() };
}

async function rowFor(context, databaseId, properties, markdown, title) {
  const { receipt, save } = context;
  const find = async () => single((await listPages(context)).filter(page => page.parent_id === databaseId
    && page.properties?.[FIELD.run] === properties[FIELD.run]), "Multiple rows have this run ID; resolve the duplicate before publishing.");
  let page = await find();
  let created = false;
  if (receipt.pageId) {
    ensure(!page || page.id === receipt.pageId, "Run ID points to a different row than the durable receipt.");
    page = await readPage(context, receipt.pageId);
  }
  if (!page) {
    page = await createOnce(context, "page", {
      workspaceId: context.workspaceId, parentId: databaseId, kind: "page", title,
      markdown, properties,
    }, find);
    created = true;
  }
  page = await readPage(context, page.id);
  ensure(page.kind === "page" && page.parent_id === databaseId && page.properties?.[FIELD.run] === properties[FIELD.run],
    "Anana read-back did not confirm the benchmark row identity.");
  ensure(page.properties[FIELD.report] === properties[FIELD.report] && page.properties[FIELD.content] === properties[FIELD.content],
    "Immutable run content differs. Use a new run ID; existing benchmark and human content were not overwritten.");
  if (created || (receipt.pageAttempted && receipt.state !== "confirmed")) await confirmContent(context, page.id);
  receipt.pageId = page.id;
  receipt.state = "confirmed";
  receipt.confirmedAt = new Date().toISOString();
  save();
  return { databaseId, pageId: page.id, url: `${context.origin}/p/${encodeURIComponent(page.id)}`, created };
}

/** Credentials must come from the caller's environment, never persisted in reports or receipts. */
export async function publishReport({ origin, token, workspaceId, databaseId, report, markdown, evidenceUrl, receiptPath, fetchImpl = fetch }) {
  origin = workspaceOrigin(origin);
  ensure(text(token) && !/\s/.test(token), "Set ANANA_TOKEN to a personal read/write bearer token in the environment.");
  ensure(text(receiptPath), "Supply a durable receiptPath in the shared local publication directory.");
  const properties = propertiesFor(report, markdown, evidenceLink(evidenceUrl));
  const path = resolve(receiptPath);
  const unlock = lockPublisher(path);
  try {
    let receipt = loadReceipt(path);
    if (receipt) {
      ensure(receipt.version === 1 && receipt.origin === origin && receipt.runId === report.id
        && receipt.reportHash === properties[FIELD.report] && receipt.contentHash === properties[FIELD.content],
      "Receipt belongs to another destination or immutable run content. Preserve it and use the matching report.");
      ensure(!databaseId || !receipt.databaseId || databaseId === receipt.databaseId, "databaseId does not match the durable receipt.");
      ensure(!workspaceId || receipt.workspaceId === workspaceId, "workspaceId does not match the durable receipt.");
      ensure(!receipt.retryAt || Date.now() >= receipt.retryAt, "Anana Retry-After has not elapsed; retry publication later.");
    }
    const request = client(origin, token, fetchImpl);
    const bootstrap = await request("GET", "/api/bootstrap");
    const workspace = bootstrap?.workspace;
    ensure(text(workspace?.id) && text(bootstrap?.user?.id) && `${workspace.slug}.useanana.com` === new URL(origin).hostname,
      "Anana bootstrap did not confirm the requested workspace origin.");
    ensure(!workspaceId || workspaceId === workspace.id, "Anana token belongs to a different workspace.");
    ensure(!receipt || receipt.workspaceId === workspace.id, "Anana token workspace does not match the durable receipt.");
    receipt ||= { version: 1, origin, workspaceId: workspace.id, runId: report.id,
      reportHash: properties[FIELD.report], contentHash: properties[FIELD.content], state: "pending" };
    const context = { origin, workspaceId: workspace.id, userId: bootstrap.user.id, request, receipt,
      save: () => saveReceipt(path, receipt) };
    context.save();
    const target = await databaseFor(context, databaseId);
    return await rowFor(context, target, properties, markdown, `${report.experiment.suite} — ${report.id}`.slice(0, 300));
  } finally { unlock(); }
}
