import { readFileSync } from "node:fs";
import { assess, ensure, inspectObservations, object, safePath, statuses, statusOf, text, validateAssessment, within } from "../../lib/model.mjs";

export { ensure, within };
export const relativePath = safePath;

export const marker = "<!-- pr-verification -->";
const strings = value => Array.isArray(value) && value.length <= 20 && value.every(item => text(item) && item.length <= 2000);

export function validateAgent(value) {
  ensure(object(value) && Object.keys(value).every(key => ["summary", "checks", "gaps"].includes(key)) &&
    text(value.summary) && value.summary.length <= 2000 && strings(value.gaps) &&
    Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 20, "The agent report must contain a summary, checks, and gaps.");
  for (const check of value.checks) {
    ensure(object(check) && Object.keys(check).every(key => ["claim", "status", "observed", "evidence", "covers"].includes(key)) &&
      text(check.claim) && check.claim.length <= 2000 && text(check.observed) && check.observed.length <= 2000 &&
      statuses.includes(check.status) && strings(check.evidence) && check.evidence.every(relativePath) &&
      (check.covers === undefined || strings(check.covers)), "Invalid claim, observation, status, or evidence in the agent report.");
  }
  return value;
}

export function inspectAgent(path, directory) {
  const value = validateAgent(JSON.parse(readFileSync(path, "utf8")));
  const inspected = inspectObservations(value.checks.map((check, index) => ({
    id: `agent.${index + 1}`, covers: check.covers || [], status: check.status,
    observed: check.observed, evidence: check.evidence,
  })), directory, { producer: "agent", forbidden: ["agent.json", "result.json", "context.json", "plan.json",
    "agent.log", "agent-session.md", "planning.log", "planning-session.md"] });
  return { summary: value.summary,
    checks: value.checks.map((check, index) => ({ ...check, status: inspected.observations[index].status })),
    gaps: [...value.gaps, ...inspected.problems], observations: inspected.observations };
}

export function verdict(result) {
  if (result.verification) {
    const problems = [...result.verification.problems, ...result.problems, ...result.agent.gaps];
    if (!result.verification.plan) problems.push("A verification plan is unavailable.");
    if (result.planning?.status !== "passed") problems.push("Planning did not complete.");
    if (result.setup.status !== "passed" || result.checks.status !== "passed") problems.push("Project verification did not complete successfully.");
    if (result.agent.execution.status !== "passed" || !result.agent.checks.length) problems.push("Behaviour verification did not complete.");
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
  if (value.agent.checks.length) validateAgent({ summary: value.agent.summary, checks: value.agent.checks, gaps: [] });
  if (value.version === 2) {
    validateAssessment(value.verification);
    ensure(object(value.planning) && statuses.includes(value.planning.status), "Invalid planning result.");
  }
  return value;
}

function markdownText(value, limit = 2000) {
  const short = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return short.replace(/\s+/g, " ").replace(/[\\`*_{}\[\]()<>#+.!|]/g, "\\$&").replace(/@/g, "@\u200b");
}

export function formatComment(result, { artifactUrl, runUrl, conclusion }) {
  const problems = [...result.problems];
  if (!artifactUrl) problems.push("The evidence upload is unavailable; inspect the workflow logs.");
  if (conclusion !== "success") problems.push(`The verification job finished with status: ${conclusion}.`);
  const status = verdict({ ...result, problems });
  const label = status[0].toUpperCase() + status.slice(1);
  const lines = [marker, `## Final verification — ${label}`, "", `PR commit: \`${markdownText(result.headSha, 40)}\``];
  if (result.testedSha) lines.push(`Tested checkout: \`${markdownText(result.testedSha, 40)}\``);
  const behaviour = result.verification ? assess(result.verification).status : statusOf(
    [result.agent.execution.status === "passed" ? "passed" : "inconclusive", ...result.agent.checks.map(check => check.status)],
    result.agent.checks.length ? result.agent.gaps : ["No observations"],
  );
  lines.push("", `- **Setup:** ${result.setup.status}`, `- **Configured checks:** ${result.checks.status}`, `- **Behaviour verification:** ${behaviour}`, "", markdownText(result.agent.summary));
  if (result.verification?.plan) {
    const evaluated = assess(result.verification);
    lines.push("", "### Requirement coverage", markdownText(evaluated.plan.goal));
    for (const requirement of evaluated.coverage) lines.push(`- **${requirement.status}: ${markdownText(requirement.id, 100)}** — ${markdownText(requirement.expect, 700)}${requirement.reason ? ` (${markdownText(requirement.reason, 500)})` : ""}`);
    for (const check of evaluated.checks) {
      if (check.comparison) lines.push(`- **Comparison — ${markdownText(check.name, 100)}:** ${check.comparison.status}. ${markdownText(check.comparison.reason, 500)}`);
      if (check.trialSummary?.total > 1) lines.push(`- **Trials — ${markdownText(check.name, 100)}:** ${check.trialSummary.passed}/${check.trialSummary.total} passed.`);
    }
    if (Object.keys(evaluated.context).length) lines.push("", `Verification context: ${markdownText(JSON.stringify(evaluated.context), 1000)}`);
  }
  for (const check of result.agent.checks) {
    lines.push("", `- **${check.status}: ${markdownText(check.claim, 500)}** — ${markdownText(check.observed, 1000)}`);
    if (check.evidence.length) lines.push(`  Evidence: ${check.evidence.map(path => markdownText(path, 200)).join(", ")}`);
  }
  const gaps = [...new Set([...problems, ...(result.verification?.problems || []), ...result.agent.gaps])];
  if (gaps.length) lines.push("", "### Gaps", ...gaps.slice(0, 20).map(gap => `- ${markdownText(gap, 1000)}`));
  const body = lines.join("\n");
  const excerpt = body.length > 60000 ? `${body.slice(0, 59000)}\n\nFurther details are in the evidence bundle.` : body;
  return `${excerpt}\n\n[Workflow logs](${runUrl})${artifactUrl ? ` · [Download evidence](${artifactUrl})` : ""}`;
}

export async function publishComment({ github, context, raw, artifactUrl = "", conclusion }) {
  const pull = context.payload.pull_request;
  ensure(pull && Number.isInteger(pull.number), "This workflow must be called from a pull_request event.");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const current = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number });
  if (current.data.head.sha !== pull.head.sha) return { skipped: "The PR has a newer head commit." };
  if ((current.data.title || "") !== (pull.title || "") || (current.data.body || "") !== (pull.body || "")) {
    return { skipped: "The PR request changed after this verification run." };
  }
  let result;
  try {
    result = validateResult(JSON.parse(raw));
    ensure(result.repository === repository && result.pullRequest === pull.number && result.headSha === pull.head.sha, "Result belongs to a different PR or revision.");
  } catch (error) {
    const stage = { status: "inconclusive", log: "workflow logs" };
    result = {
      version: 1, repository, pullRequest: pull.number, headSha: pull.head.sha, testedSha: null, status: "inconclusive",
      setup: stage, checks: stage, agent: { execution: stage, summary: "Verification did not produce a complete result.", checks: [], gaps: [] },
      problems: [error.message],
    };
  }
  const runUrl = `${context.serverUrl || "https://github.com"}/${repository}/actions/runs/${context.runId}`;
  const body = formatComment(result, { artifactUrl, runUrl, conclusion });
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pull.number, per_page: 100 });
  const previous = comments.find(comment => comment.user?.type === "Bot" && comment.body?.startsWith(marker));
  if (previous) return github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
  return github.rest.issues.createComment({ ...context.repo, issue_number: pull.number, body });
}
