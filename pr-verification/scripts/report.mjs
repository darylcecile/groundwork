import { readFileSync } from "node:fs";
import { assess, ensure, inspectObservations, object, safePath, statuses, statusOf, text, validateAssessment, within } from "../../lib/model.mjs";
import { makeRecord, renderRecord } from "../../lib/report.mjs";
import { publishRecord } from "../../lib/pr-records.mjs";

export { ensure, within };
export const relativePath = safePath;

const strings = value => Array.isArray(value) && value.length <= 20 && value.every(item => text(item) && item.length <= 2000);

export function validateAgent(value) {
  ensure(object(value) && Object.keys(value).every(key => ["summary", "checks", "gaps"].includes(key)) &&
    text(value.summary) && value.summary.length <= 2000 && strings(value.gaps) &&
    Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 20, "The agent report must contain a summary, checks, and gaps.");
  for (const check of value.checks) {
    ensure(object(check) && Object.keys(check).every(key => ["claim", "status", "observed", "evidence", "covers", "kind"].includes(key)) &&
      text(check.claim) && check.claim.length <= 2000 && text(check.observed) && check.observed.length <= 2000 &&
      statuses.includes(check.status) && strings(check.evidence) && check.evidence.every(relativePath) &&
      (check.covers === undefined || strings(check.covers)) &&
      (check.kind === undefined || ["assertion", "review", "measurement"].includes(check.kind)), "Invalid claim, observation, status, or evidence in the agent report.");
  }
  return value;
}

export function inspectAgent(path, directory) {
  const value = validateAgent(JSON.parse(readFileSync(path, "utf8")));
  const inspected = inspectObservations(value.checks.map((check, index) => ({
    id: `agent.${index + 1}`, covers: check.covers || [], status: check.status,
    observed: check.observed, evidence: check.evidence, kind: check.kind ?? "assertion",
  })), directory, { producer: "agent", forbidden: ["agent.json", "result.json", "report.md", "context.json", "plan.json",
    "agent.log", "agent-session.md", "planning.log", "planning-session.md"] });
  return { summary: value.summary,
    checks: value.checks.map((check, index) => ({ ...check, status: inspected.observations[index].status })),
    gaps: [...value.gaps, ...inspected.problems], observations: inspected.observations };
}

export function verificationFrontier(verification) {
  const evaluated = assess(verification);
  const requirements = evaluated.plan?.requirements || [];
  const missing = requirements.flatMap((requirement, index) => {
    const coverage = evaluated.coverage[index];
    return coverage.status !== "verified" ? [{ ...requirement, status: coverage.status, reason: coverage.reason }] : [];
  });
  return { missing, completed: evaluated.coverage.filter(item => item.status === "verified"),
    complete: requirements.length > 0 && missing.length === 0 && evaluated.status === "passed" };
}

export function verdict(result) {
  if (result.verification) {
    const problems = [...result.verification.problems, ...result.problems, ...result.agent.gaps];
    if (!result.verification.plan) problems.push("A verification plan is unavailable.");
    if (result.planning?.status !== "passed") problems.push("Planning did not complete.");
    if (result.setup.status !== "passed" || result.checks.status !== "passed") problems.push("Project verification did not complete successfully.");
    const complete = result.agent.execution.skipped === "complete" && verificationFrontier(result.verification).complete;
    if (result.agent.execution.status !== "passed" || (!complete && !result.agent.checks.length)) problems.push("Behaviour verification did not complete.");
    return assess({ ...result.verification, problems }).status;
  }
  if (result.checks.status === "failed" || result.agent.checks.some(check => check.status === "failed")) return "failed";
  if (result.problems.length || result.setup.status !== "passed" || result.checks.status !== "passed" ||
    result.agent.execution.status !== "passed" || !result.agent.checks.length || result.agent.gaps.length ||
    result.agent.checks.some(check => check.status !== "passed")) return "inconclusive";
  return "passed";
}

export function validateResult(value) {
  ensure(object(value) && [1, 2].includes(value.version) && text(value.repository) && Number.isInteger(value.pullRequest) &&
    text(value.headSha) && (value.testedSha === null || text(value.testedSha)) && statuses.includes(value.status) &&
    Array.isArray(value.problems) && value.problems.every(text) && object(value.agent) &&
    text(value.agent.summary) && Array.isArray(value.agent.checks) && Array.isArray(value.agent.gaps) && value.agent.gaps.every(text), "Invalid verification result.");
  for (const stage of [value.setup, value.checks, value.agent.execution]) {
    ensure(object(stage) && statuses.includes(stage.status) && text(stage.log), "Invalid verification stage.");
  }
  ensure(value.agent.execution.skipped === undefined || value.agent.execution.skipped === "complete", "Invalid agent skip reason.");
  if (value.agent.checks.length) validateAgent({ summary: value.agent.summary, checks: value.agent.checks, gaps: [] });
  if (value.version === 2) {
    validateAssessment(value.verification);
    ensure(object(value.planning) && statuses.includes(value.planning.status), "Invalid planning result.");
  }
  return value;
}

function resultAssessment(result, problems = []) {
  return assess({ ...(result.verification || {}), problems: [...new Set([
    ...(result.verification?.problems || []), ...result.problems, ...result.agent.gaps, ...problems,
    ...(!result.verification ? ["A complete verification assessment is unavailable."] : []),
  ])] });
}

export function makePRRecord(result, { id = result.id, runner = result.runner || null } = {}) {
  validateResult(result);
  return makeRecord({
    run: { kind: "pr", id, startedAt: result.startedAt, finishedAt: result.finishedAt,
      source: result.source, selection: result.selection, context: result.verification?.context || {}, runner,
      repository: result.repository, pullRequest: result.pullRequest, headSha: result.headSha, testedSha: result.testedSha,
      projectPath: result.projectPath || "" },
    assessment: resultAssessment(result), status: verdict(result),
    stages: [
      ...(result.planning ? [{ name: "Planning", ...result.planning }] : []),
      { name: "Setup", ...result.setup }, { name: "Configured checks", ...result.checks },
      { name: "Behaviour verification", ...result.agent.execution, reason: result.agent.summary },
    ],
  });
}

export function formatComment(result, { artifactUrl, runUrl, conclusion }) {
  const problems = conclusion === "success" ? [] : [`The verification job finished with status: ${conclusion}.`];
  const assessment = resultAssessment(result, problems);
  return renderRecord(makePRRecord(result), { publication: { status: statusOf([verdict(result), assessment.status], problems),
    assessment: { status: assessment.status, coverage: assessment.coverage, problems: assessment.problems } },
  links: { run: runUrl, evidence: artifactUrl } });
}

export async function publishComment({ github, context, raw, artifactUrl = "", conclusion }) {
  const pull = context.payload.pull_request;
  ensure(pull && Number.isInteger(pull.number), "This workflow must be called from a pull_request event.");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const api = {
    request: (method, path, body) => github.request(`${method} ${path}`, body),
    paginate: path => github.paginate(`GET ${path}`),
  };
  const fallbackId = `actions-${context.runId}-${context.runAttempt || process.env.GITHUB_RUN_ATTEMPT || 1}`;
  let result;
  let record;
  try {
    result = validateResult(JSON.parse(raw));
    ensure(result.repository === repository && result.pullRequest === pull.number && result.headSha === pull.head.sha, "Result belongs to a different PR or revision.");
    record = makePRRecord(result, { id: result.id || fallbackId });
  } catch (error) {
    const stage = { status: "inconclusive", log: "workflow logs" };
    result = {
      version: 1, id: fallbackId,
      repository, pullRequest: pull.number, headSha: pull.head.sha, testedSha: null, status: "inconclusive",
      setup: stage, checks: stage, agent: { execution: stage, summary: "Verification did not produce a complete result.", checks: [], gaps: [] },
      problems: [error.message],
    };
    record = makePRRecord(result);
  }
  const runUrl = `${context.serverUrl || "https://github.com"}/${repository}/actions/runs/${context.runId}`;
  const problems = conclusion === "success" ? [] : [`The verification job finished with status: ${conclusion}.`];
  let sourceMatches = result.source?.dirty === false && result.source.revision === result.testedSha;
  if (sourceMatches && result.testedSha !== pull.head.sha) {
    sourceMatches = false;
    if (result.testedSha === context.sha && pull.base?.sha) {
      try {
        const commit = await api.request("GET", `/repos/${repository}/commits/${encodeURIComponent(result.testedSha)}`);
        sourceMatches = commit.data.sha === result.testedSha && commit.data.parents?.length === 2 &&
          commit.data.parents[0].sha === pull.base.sha && commit.data.parents[1].sha === pull.head.sha;
      } catch (error) { problems.push(`Could not establish the tested merge commit's relationship to this PR: ${error.message}`); }
    }
  }
  const assessment = resultAssessment(result, problems);
  return publishRecord({ api, target: { ...context.repo, number: pull.number, headSha: pull.head.sha },
    record, assessment, status: statusOf([verdict(result), assessment.status], problems), sourceMatches,
    links: { run: runUrl, evidence: artifactUrl }, expectedRequest: { title: pull.title, body: pull.body } });
}
