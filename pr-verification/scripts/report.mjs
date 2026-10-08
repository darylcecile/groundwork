import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export const marker = "<!-- pr-verification -->";
const statuses = ["passed", "failed", "inconclusive"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.length <= 20 && value.every(item => text(item) && item.length <= 2000);

export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

export function relativePath(value) {
  return text(value) && !isAbsolute(value) && !value.includes("\\") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

export function within(root, path) {
  const resolved = realpathSync(path);
  const base = realpathSync(root);
  ensure(resolved === base || resolved.startsWith(`${base}${sep}`), `Path leaves its allowed directory: ${path}`);
  return resolved;
}

export function validateAgent(value) {
  ensure(object(value) && Object.keys(value).every(key => ["summary", "checks", "gaps"].includes(key)) &&
    text(value.summary) && value.summary.length <= 2000 && strings(value.gaps) &&
    Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 20, "The agent report must contain a summary, checks, and gaps.");
  for (const check of value.checks) {
    ensure(object(check) && Object.keys(check).every(key => ["claim", "status", "observed", "evidence"].includes(key)) &&
      text(check.claim) && check.claim.length <= 2000 && text(check.observed) && check.observed.length <= 2000 &&
      statuses.includes(check.status) && strings(check.evidence) && check.evidence.every(relativePath), "Invalid claim, observation, status, or evidence in the agent report.");
  }
  return value;
}

export function inspectAgent(path, directory) {
  const value = validateAgent(JSON.parse(readFileSync(path, "utf8")));
  const gaps = [...value.gaps];
  const checks = value.checks.map(check => {
    let valid = check.evidence.length > 0;
    for (const evidence of check.evidence) {
      try {
        ensure(!["agent.json", "result.json", "context.json", "agent.log", "agent-session.md"].includes(evidence), "Use directly captured evidence for a claim.");
        const file = within(directory, resolve(directory, evidence));
        ensure(statSync(file).isFile() && statSync(file).size > 0, "Evidence is missing or empty.");
      } catch {
        valid = false;
        gaps.push(`Unavailable evidence for ${check.claim}: ${evidence}`);
      }
    }
    if (!valid && check.status !== "inconclusive") {
      if (check.evidence.length === 0) gaps.push(`No evidence was supplied for ${check.claim}.`);
      return { ...check, status: "inconclusive" };
    }
    return check;
  });
  return { summary: value.summary, checks, gaps };
}

export function verdict(result) {
  if (result.checks.status === "failed" || result.agent.checks.some(check => check.status === "failed")) return "failed";
  if (result.problems.length || result.setup.status !== "passed" || result.checks.status !== "passed" ||
    result.agent.execution.status !== "passed" || !result.agent.checks.length || result.agent.gaps.length ||
    result.agent.checks.some(check => check.status !== "passed")) return "inconclusive";
  return "passed";
}

export function validateResult(value) {
  ensure(object(value) && value.version === 1 && text(value.repository) && Number.isInteger(value.pullRequest) &&
    text(value.headSha) && (value.testedSha === null || text(value.testedSha)) && statuses.includes(value.status) &&
    Array.isArray(value.problems) && value.problems.every(text) && object(value.agent) &&
    text(value.agent.summary) && Array.isArray(value.agent.checks) && Array.isArray(value.agent.gaps) && value.agent.gaps.every(text), "Invalid verification result.");
  for (const stage of [value.setup, value.checks, value.agent.execution]) {
    ensure(object(stage) && statuses.includes(stage.status) && text(stage.log), "Invalid verification stage.");
  }
  if (value.agent.checks.length) validateAgent({ summary: value.agent.summary, checks: value.agent.checks, gaps: [] });
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
  lines.push("", `- **Setup:** ${result.setup.status}`, `- **Configured checks:** ${result.checks.status}`, `- **Behaviour verification:** ${result.agent.execution.status === "passed" ? verdict({ ...result, setup: { status: "passed" }, checks: { status: "passed" }, problems: [] }) : "inconclusive"}`, "", markdownText(result.agent.summary));
  for (const check of result.agent.checks) {
    lines.push("", `- **${check.status}: ${markdownText(check.claim, 500)}** — ${markdownText(check.observed, 1000)}`);
    if (check.evidence.length) lines.push(`  Evidence: ${check.evidence.map(path => markdownText(path, 200)).join(", ")}`);
  }
  const gaps = [...problems, ...result.agent.gaps];
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
