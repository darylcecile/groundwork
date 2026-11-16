import { createHash } from "node:crypto";
import { assess, ensure, statusOf, validateAssessment } from "./model.mjs";
import { parseRecord, renderRecord, validateRecord } from "./report.mjs";

export const statusContext = "groundwork/verification";
const stateOf = status => status === "passed" ? "success" : status === "failed" ? "failure" : "error";
const identity = author => author?.id ?? author?.node_id;
const sameAuthor = (left, right) => identity(left) !== undefined && identity(left) === identity(right);
const commentMarker = (record, author) => `<!-- groundwork-publication:${identity(author)}:${encodeURIComponent(record.run.id)} -->`;
const runTime = (record, publication) => Date.parse(record.run.startedAt || record.run.finishedAt || publication?.publishedAt || "") || 0;
const runKey = id => createHash("sha256").update(id).digest("hex").slice(0, 16);

function statusHistory(statuses) {
  const attempts = new Map();
  for (const status of statuses) {
    if (status.context !== statusContext) continue;
    const match = status.description?.match(/\[gw:([a-f0-9]{16}):(\d+)\]$/);
    if (!match) continue;
    const attempt = { key: match[1], time: Number(match[2]) };
    const previous = attempts.get(attempt.key);
    if (previous) previous.attempt.time = Math.min(previous.attempt.time, attempt.time);
    else attempts.set(attempt.key, { status, attempt });
  }
  return [...attempts.values()];
}

function paths(target) {
  ensure(typeof target.owner === "string" && typeof target.repo === "string" && Number.isSafeInteger(target.number) && target.number > 0,
    "A PR target needs owner, repo, and number.");
  const repository = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  return { repository, pull: `${repository}/pulls/${target.number}`, comments: `${repository}/issues/${target.number}/comments` };
}

async function request(api, method, path, body) {
  const response = await api.request(method, path, body);
  if (response.status >= 400) {
    throw Object.assign(new Error(`${method} ${path}: ${response.data?.message || `HTTP ${response.status}`}`), response);
  }
  return response;
}

function unavailable(error) {
  const status = error.status ?? error.response?.status;
  const headers = error.headers ?? error.response?.headers ?? {};
  const message = error.data?.message ?? error.response?.data?.message ?? error.message ?? "";
  return [403, 404, 405, 501].includes(status) && headers["x-ratelimit-remaining"] !== "0" && !headers["retry-after"] &&
    !/rate limit|abuse|bad credentials|authentication/i.test(message);
}

function itemUrl(item, pull) {
  return item.html_url || item.permalink || pull.html_url;
}

async function readRecords(api, target, pull) {
  const path = paths(target);
  let artifactsAvailable = true;
  const diagnostics = [];
  const [artifacts, comments] = await Promise.all([
    api.paginate(`${path.pull}/artifacts?per_page=100`).catch(error => {
      if (!unavailable(error)) throw error;
      artifactsAvailable = false;
      diagnostics.push(`PR artifacts are unavailable (HTTP ${error.status ?? error.response?.status}); reading comments.`);
      return [];
    }),
    api.paginate(`${path.comments}?per_page=100`),
  ]);
  const records = [];
  for (const [type, items] of [["artifact", artifacts], ["comment", comments]]) {
    for (const item of items) {
      const parsed = parseRecord(item.body || "");
      if (!parsed) {
        if (item.body?.includes("<!-- groundwork-record:")) diagnostics.push(`Malformed Groundwork record in ${type} ${item.id}.`);
        continue;
      }
      const { record, publication } = parsed;
      const author = type === "artifact" ? item.creator : item.user;
      const source = { type, id: item.id, name: item.name, url: itemUrl(item, pull), author,
        updatedAt: item.updated_at || item.created_at || null };
      const matchingTarget = publication?.repository === `${target.owner}/${target.repo}` && publication?.pullRequest === target.number;
      const current = matchingTarget && publication.headSha === pull.head.sha;
      const problems = [];
      if (!matchingTarget) problems.push("This record is not bound to this PR.");
      else if (!current) problems.push(`Historical record: PR head is now ${pull.head.sha}.`);
      if (publication?.sourceMatches === false) problems.push("The published assessment does not establish a match to the pushed PR source.");
      const status = statusOf([record.status, publication?.status],
        publication?.sourceMatches === true && record.run.finishedAt ? [] : ["Unverified source or incomplete run"]);
      const entry = { record, publication, source, current, status, diagnostics: problems };
      const previousIndex = records.findIndex(item => sameAuthor(item.source.author, author) && item.record.run.id === record.run.id);
      if (previousIndex < 0) records.push(entry);
      else {
        const previous = records[previousIndex];
        const updated = Date.parse(source.updatedAt || "") || 0;
        const previousUpdated = Date.parse(previous.source.updatedAt || "") || 0;
        if (type !== previous.source.type ? type === "comment" : updated >= previousUpdated) records[previousIndex] = entry;
      }
    }
  }
  records.sort((left, right) => runTime(right.record, right.publication) - runTime(left.record, left.publication));
  return { records, diagnostics, artifactsAvailable, artifacts, comments };
}

export async function listRecords({ api, target }) {
  const path = paths(target);
  const pull = (await request(api, "GET", path.pull)).data;
  const [{ records, diagnostics }, statuses] = await Promise.all([
    readRecords(api, target, pull),
    api.paginate(`${path.repository}/commits/${encodeURIComponent(pull.head.sha)}/statuses?per_page=100`),
  ]);
  const commitStatus = statuses.find(item => item.context === statusContext) || null;
  return { pull, records, diagnostics, commitStatus };
}

export async function publishRecord({ api, target, record, assessment, status = assessment?.status, sourceMatches, links = {}, expectedRequest = null }) {
  validateRecord(record);
  const evaluated = assess(validateAssessment(assessment));
  ensure(["passed", "failed", "inconclusive"].includes(status), "Publication needs an authoritative verification verdict.");
  ensure(typeof target.headSha === "string" && target.headSha.length > 0, "Publication needs the expected PR head SHA.");
  const path = paths(target);
  const statusPath = `${path.repository}/statuses/${encodeURIComponent(target.headSha)}`;
  let pull;
  const attempt = { key: runKey(record.run.id), time: runTime(record) || Date.now() };
  const setStatus = (state, description, url = pull?.html_url || target.url, identity = attempt) => request(api, "POST", statusPath,
    { state, context: statusContext, description: `${description} [gw:${identity.key}:${identity.time}]`, ...(url ? { target_url: url } : {}) });
  try {
    pull = (await request(api, "GET", path.pull)).data;
    if (pull.head.sha !== target.headSha) return { skipped: "The PR has a newer head commit." };
    if (expectedRequest && ((pull.title || "") !== (expectedRequest.title || "") || (pull.body || "") !== (expectedRequest.body || ""))) {
      return { skipped: "The PR request changed after this verification run." };
    }
    const history = statusHistory(await api.paginate(`${path.repository}/commits/${encodeURIComponent(target.headSha)}/statuses?per_page=100`));
    if (!runTime(record)) attempt.time = history.find(item => item.attempt.key === attempt.key)?.attempt.time || attempt.time;
    const pending = await setStatus("pending", "Publishing verification record");
    const principal = pending.data.creator;
    ensure(identity(principal) !== undefined, "The pending commit status did not identify its publishing principal.");
    const existing = await readRecords(api, target, pull);
    const problems = [...evaluated.problems];
    if (sourceMatches !== true) problems.push("The verified source does not match the clean pushed PR source.");
    if (!record.run.finishedAt) problems.push("The verification run did not finish.");
    const outcome = statusOf([record.status, status, evaluated.status], problems);
    const previousRecord = existing.records.find(item => sameAuthor(item.source.author, principal) && item.record.run.id === record.run.id);
    const publication = {
      repository: `${target.owner}/${target.repo}`, pullRequest: target.number,
      headSha: target.headSha, testedSha: record.run.testedSha || record.run.source?.revision || null,
      publishedAt: previousRecord?.publication?.publishedAt || new Date(runTime(record) ? Date.now() : attempt.time).toISOString(),
      publisher: { id: identity(principal), login: principal.login },
      status: outcome, sourceMatches: sourceMatches === true,
      assessment: { status: outcome, coverage: evaluated.coverage, problems },
    };
    attempt.time = runTime(record, publication);
    const body = renderRecord(record, { publication, links });
    const marker = commentMarker(record, principal);
    const previousComment = existing.comments.find(comment => sameAuthor(comment.user, principal) && comment.body?.startsWith(marker) &&
      parseRecord(comment.body)?.record.run.id === record.run.id);
    let transport;
    let saved;
    if (previousComment) {
      transport = "comment";
      saved = await request(api, "PATCH", `${path.repository}/issues/comments/${previousComment.id}`, { body: `${marker}\n${body}` });
    } else if (existing.artifactsAvailable) {
      const name = `groundwork-${createHash("sha256").update(record.run.id).digest("hex").slice(0, 24)}`;
      const previous = existing.artifacts.find(artifact => artifact.name === name && sameAuthor(artifact.creator, principal));
      ensure(!previous || parseRecord(previous.body)?.record.run.id === record.run.id,
        "The caller-owned artifact name is already used by another document.");
      try {
        saved = await request(api, "PUT", `${path.pull}/artifacts/${name}`, { body });
        transport = "artifact";
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    if (!saved) {
      transport = "comment";
      saved = await request(api, "POST", path.comments, { body: `${marker}\n${body}` });
    }
    const url = itemUrl(saved.data, pull);
    const newerRecord = existing.records.find(item => item.current && item.record.run.id !== record.run.id &&
      runTime(item.record, item.publication) > attempt.time);
    const newerStatus = history.filter(item => item.attempt.key !== attempt.key && item.attempt.time > attempt.time)
      .sort((left, right) => right.attempt.time - left.attempt.time)[0];
    const newer = newerStatus && (!newerRecord || newerStatus.attempt.time >= runTime(newerRecord.record, newerRecord.publication))
      ? { state: newerStatus.status.state, url: newerStatus.status.target_url, attempt: newerStatus.attempt }
      : newerRecord ? { state: stateOf(newerRecord.status), url: newerRecord.source.url,
        attempt: { key: runKey(newerRecord.record.run.id), time: runTime(newerRecord.record, newerRecord.publication) } } : null;
    const state = newer?.state || stateOf(outcome);
    await setStatus(state, newer ? "A newer verification attempt determines this status" : `Verification ${outcome}`,
      newer?.url || url, newer?.attempt || attempt);
    return { record, publication, transport, url, status: state, superseded: Boolean(newer) };
  } catch (error) {
    try { await setStatus("error", "Verification record publication failed"); }
    catch (statusError) { throw new Error(`${error.message}; could not mark publication failure: ${statusError.message}`, { cause: error }); }
    throw error;
  }
}
