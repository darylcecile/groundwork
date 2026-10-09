import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatComment, marker, publishComment } from "../scripts/report.mjs";

const runner = fileURLToPath(new URL("../scripts/verify.mjs", import.meta.url));
const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function git(root, ...args) {
  const value = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (value.status !== 0) throw new Error(value.stderr);
  return value.stdout.trim();
}

function fixture(agent = "valid") {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "pr-verification-"));
  temporary.push(root);
  const project = join(root, "project");
  const output = join(root, "evidence");
  write(join(project, "app.txt"), "candidate implementation\n");
  git(project, "init", "--quiet");
  git(project, "add", ".");
  git(project, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Candidate");
  const sha = git(project, "rev-parse", "HEAD");
  const event = { pull_request: { number: 42, title: "Verify the requested behaviour", body: "Exercise the application's real entry point", head: { sha, repo: { full_name: "consumer/project" } } } };
  const eventPath = join(root, "event.json");
  write(eventPath, JSON.stringify(event));
  const fake = join(root, "bin", "copilot");
  write(fake, `#!${process.execPath}
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const output = process.env.PR_VERIFY_OUTPUT;
const mode = process.env.TEST_AGENT;
if (process.env.GROUNDWORK_AGENT_PHASE === "planning") {
  if (mode === "missing-plan") process.exit(0);
  const requirements = [{id: "behaviour", expect: "The requested behaviour works"}];
  if (["incomplete", "mutate-plan"].includes(mode)) requirements.push({id: "preserved", expect: "Existing behaviour is preserved"});
  writeFileSync(join(output, "plan.json"), JSON.stringify({goal: "Verify the proposed behaviour", requirements}));
  process.exit(0);
}
writeFileSync(join(output, "agent-was-run.txt"), "yes");
if (mode === "exit") process.exit(1);
if (mode === "missing-report") process.exit(0);
if (mode === "invalid") { writeFileSync(join(output, "agent.json"), "{}"); process.exit(0); }
if (mode === "mutate") writeFileSync("app.txt", "changed by verifier");
if (mode === "mutate-plan") writeFileSync(join(output, "plan.json"), JSON.stringify({goal: "Verify only one item", requirements: [{id: "behaviour", expect: "The requested behaviour works"}]}));
mkdirSync(join(output, "agent"), { recursive: true });
if (mode !== "missing-evidence") writeFileSync(join(output, "agent", "observation.txt"), "Observed the configured behaviour");
const evidence = mode === "self-report" ? ["agent.json"] : ["agent/observation.txt"];
writeFileSync(join(output, "agent.json"), JSON.stringify({
  summary: "Observed the requested behaviour.",
  checks: [{ claim: "The requested behaviour works", covers: ["behaviour"], status: mode === "failed" ? "failed" : "passed", observed: "Ran the project's entry point and inspected its output.", evidence }],
  gaps: mode === "gap" ? ["The required browser is unavailable"] : []
}));
`);
  chmodSync(fake, 0o755);
  return { root, project, output, event, env: {
    ...process.env, PATH: `${dirname(fake)}:${process.env.PATH}`, TEST_AGENT: agent,
    GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "consumer/project", GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: join(root, "github-output"), COPILOT_GITHUB_TOKEN: "test-copilot-credential",
    PR_VERIFY_REPOSITORY: project, PR_VERIFY_OUTPUT: output, PR_VERIFY_CHECKS: "true",
    PR_VERIFY_SETUP: "", PR_VERIFY_DIRECTORY: ".", PR_VERIFY_ARTIFACTS: "",
    PR_VERIFY_PLAN: "", PR_VERIFY_COMPARE_BASE: "false",
  } };
}

function run(value, overrides = {}) {
  const processResult = spawnSync(process.execPath, [runner], { env: { ...value.env, ...overrides }, encoding: "utf8" });
  return { code: processResult.status, output: processResult.stdout + processResult.stderr,
    report: JSON.parse(readFileSync(join(value.output, "result.json"), "utf8")) };
}

test("runs checks and the agent, captures configured assets, and keeps the Copilot credential out of project commands", () => {
  const value = fixture();
  const result = run(value, {
    PR_VERIFY_CHECKS: `bun -e 'if (process.env.COPILOT_GITHUB_TOKEN) process.exit(1); require("node:fs").mkdirSync("test-results"); require("node:fs").writeFileSync("test-results/response.json", JSON.stringify({ok:true})); console.log("Checks observed success")'`,
    PR_VERIFY_ARTIFACTS: "test-results",
  });
  expect(result.code).toBe(0);
  expect(result.report.status).toBe("passed");
  expect(result.report.repository).toBe("consumer/project");
  expect(existsSync(join(value.output, "project/test-results/response.json"))).toBe(true);
  expect(readFileSync(join(value.output, "checks.log"), "utf8")).toContain("Checks observed success");
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(true);
});

test("failed configured checks remain failures after positive agent observations", () => {
  const value = fixture();
  const result = run(value, { PR_VERIFY_CHECKS: "printf 'Observed failure\\n'; exit 1" });
  expect(result.code).toBe(1);
  expect(result.report.status).toBe("failed");
  expect(result.report.agent.checks[0].status).toBe("passed");
  expect(readFileSync(join(value.output, "checks.log"), "utf8")).toContain("Observed failure");
});

test("agent-observed failures fail the final verification even when configured checks pass", () => {
  const result = run(fixture("failed"));
  expect(result.code).toBe(1);
  expect(result.report.checks.status).toBe("passed");
  expect(result.report.status).toBe("failed");
});

test("every planned requirement needs coverage even after successful checks and a positive agent report", () => {
  const result = run(fixture("incomplete"));
  expect(result.code).toBe(2);
  expect(result.report.checks.status).toBe("passed");
  expect(result.report.agent.execution.status).toBe("passed");
  expect(result.report.verification.coverage.map(item => item.status)).toEqual(["verified", "unverified"]);
  const comment = formatComment(result.report, {artifactUrl: "https://example.test/evidence", runUrl: "https://example.test/run", conclusion: "failure"});
  expect(comment).toContain("unverified: preserved");
});

test("the verification agent cannot remove requirements by rewriting the plan", () => {
  const value = fixture("mutate-plan");
  const result = run(value);
  expect(result.code).toBe(2);
  expect(result.report.verification.plan.requirements).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(value.output, "plan.json"), "utf8")).requirements).toHaveLength(2);
  expect(result.report.problems.join(" ")).toContain("plan was changed");
});

test("planning failure leaves configured check results available but cannot produce a passing outcome", () => {
  const value = fixture("missing-plan");
  const result = run(value);
  expect(result.code).toBe(2);
  expect(result.report.checks.status).toBe("passed");
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(false);
});

test("project catalogue checks and invariants use the shared runner when the workflow omits a command block", () => {
  const value = fixture();
  write(join(value.project, "verify.json"), JSON.stringify({
    checks: {
      feature: {command: "true", expect: "The feature passes", covers: ["feature"]},
      boundary: {command: "false", expect: "The required boundary holds"},
    },
    behaviours: {feature: {description: "The feature works", paths: ["app.txt"]}},
    invariants: {boundary: {description: "Preserve the boundary", checks: ["boundary"]}},
  }));
  const result = run(value, {PR_VERIFY_CHECKS: ""});
  expect(result.code).toBe(1);
  expect(result.report.verification.checks.map(check => check.name)).toEqual(["feature", "boundary"]);
  expect(result.report.verification.coverage.find(item => item.id === "invariant:boundary").status).toBe("failed");
});

test("a multi-command block stops at the failed check", () => {
  const value = fixture();
  const result = run(value, {PR_VERIFY_CHECKS: "false\ntouch should-not-run\ntrue"});
  expect(result.code).toBe(1);
  expect(existsSync(join(value.project, "should-not-run"))).toBe(false);
});

test.each(["missing-report", "invalid", "missing-evidence", "self-report", "gap", "exit"])("%s cannot establish a passing verification", mode => {
  const result = run(fixture(mode));
  expect(result.code).toBe(2);
  expect(result.report.status).toBe("inconclusive");
  expect(result.report.agent.gaps.length).toBeGreaterThan(0);
});

test("setup failure prevents project checks while preserving a diagnostic agent pass", () => {
  const value = fixture();
  const result = run(value, { PR_VERIFY_SETUP: "exit 1", PR_VERIFY_CHECKS: "touch should-not-run" });
  expect(result.code).toBe(2);
  expect(existsSync(join(value.project, "should-not-run"))).toBe(false);
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(true);
});

test("missing configured assets and changed source leave verification inconclusive", () => {
  const missing = run(fixture(), { PR_VERIFY_ARTIFACTS: "missing.png" });
  expect(missing.code).toBe(2);
  expect(missing.report.problems.join(" ")).toContain("Could not collect missing.png");
  const changed = run(fixture("mutate"));
  expect(changed.code).toBe(2);
  expect(changed.report.problems.join(" ")).toContain("source changed");
});

test("an unavailable CI credential is reported instead of starting an interactive authentication flow", () => {
  const value = fixture();
  const result = run(value, { COPILOT_GITHUB_TOKEN: "" });
  expect(result.code).toBe(2);
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(false);
  expect(result.report.agent.gaps.join(" ")).toContain("COPILOT_TOKEN is unavailable");
});

test("declared artifacts cannot copy files from outside the importing project", () => {
  const value = fixture();
  const result = run(value, { PR_VERIFY_ARTIFACTS: "../event.json" });
  expect(result.code).toBe(2);
  expect(existsSync(join(value.output, "project"))).toBe(false);
});

test("a reused evidence directory preserves the earlier result and refuses a new success", () => {
  const value = fixture();
  expect(run(value).code).toBe(0);
  const previous = readFileSync(join(value.output, "result.json"), "utf8");
  const execution = spawnSync(process.execPath, [runner], { env: value.env, encoding: "utf8" });
  expect(execution.status).toBe(2);
  expect(readFileSync(join(value.output, "result.json"), "utf8")).toBe(previous);
});

function client(event, comments = [], currentSha = event.pull_request.head.sha) {
  const calls = [];
  return {
    calls,
    github: {
      rest: {
        pulls: { get: async input => { calls.push(["get", input]); return { data: { ...event.pull_request, head: { sha: currentSha } } }; } },
        issues: {
          listComments: () => {},
          createComment: async input => { calls.push(["create", input]); return input; },
          updateComment: async input => { calls.push(["update", input]); return input; },
        },
      },
      paginate: async (_method, input) => { calls.push(["list", input]); return comments; },
    },
    context: { payload: event, repo: { owner: "consumer", repo: "project" }, runId: 123, serverUrl: "https://github.com" },
  };
}

test("creates a comment on the importing PR with stage results and its evidence link", async () => {
  const value = fixture();
  const { report } = run(value);
  const api = client(value.event);
  await publishComment({ ...api, raw: JSON.stringify(report), artifactUrl: "https://github.com/consumer/project/actions/runs/123/artifacts/456", conclusion: "success" });
  const request = api.calls.find(([method]) => method === "create")[1];
  expect(request.owner).toBe("consumer");
  expect(request.repo).toBe("project");
  expect(request.issue_number).toBe(42);
  expect(request.body).toContain("Final verification — Passed");
  expect(request.body).toContain("Download evidence");
  expect(request.body).toContain("agent/observation\\.txt");
});

test("updates the existing bot comment instead of duplicating it or overwriting a user's comment", async () => {
  const value = fixture();
  const { report } = run(value);
  const api = client(value.event, [
    { id: 1, user: { type: "User" }, body: marker },
    { id: 2, user: { type: "Bot" }, body: `${marker}\nEarlier result` },
  ]);
  await publishComment({ ...api, raw: JSON.stringify(report), artifactUrl: "https://example.test/evidence", conclusion: "success" });
  expect(api.calls.find(([method]) => method === "update")[1].comment_id).toBe(2);
  expect(api.calls.some(([method]) => method === "create")).toBe(false);
});

test("a stale PR head does not overwrite the current verification comment", async () => {
  const value = fixture();
  const api = client(value.event, [], "newer-commit");
  const result = await publishComment({ ...api, raw: "", conclusion: "cancelled" });
  expect(result.skipped).toContain("newer head");
  expect(api.calls.map(([method]) => method)).toEqual(["get"]);
});

test("an edited PR request cannot receive a result based on its old requirement plan", async () => {
  const value = fixture();
  const api = client(value.event);
  api.github.rest.pulls.get = async () => ({ data: { ...value.event.pull_request, body: "The requested outcome has changed" } });
  const result = await publishComment({ ...api, raw: "", conclusion: "success" });
  expect(result.skipped).toContain("request changed");
  expect(api.calls).toEqual([]);
});

test("a mismatched or absent result produces an inconclusive comment rather than trusting another PR's report", async () => {
  const value = fixture();
  const { report } = run(value);
  report.repository = "another/repository";
  const api = client(value.event);
  await publishComment({ ...api, raw: JSON.stringify(report), conclusion: "failure" });
  const body = api.calls.find(([method]) => method === "create")[1].body;
  expect(body).toContain("Final verification — Inconclusive");
  expect(body).toContain("different PR or revision");
});

test("an upload or job failure remains visible even when the captured checks passed", () => {
  const { report } = run(fixture());
  const body = formatComment(report, { artifactUrl: "", runUrl: "https://example.test/run", conclusion: "failure" });
  expect(body).toContain("Final verification — Inconclusive");
  expect(body).toContain("evidence upload is unavailable");
});
