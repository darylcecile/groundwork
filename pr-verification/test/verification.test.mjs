import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatComment, publishComment, validateResult, verdict } from "../scripts/report.mjs";
import { parseRecord } from "../../lib/report.mjs";
import { evidenceStore } from "../../lib/store.mjs";
import { refreshEvidence } from "../../lib/model.mjs";
import { catalogueIssues, loadConfig } from "../../lib/config.mjs";

const runner = fileURLToPath(new URL("../scripts/verify.mjs", import.meta.url));
const realBun = realpathSync(process.execPath);
const temporary = [];
let previousStateHome;
beforeEach(() => {
  previousStateHome = process.env.GROUNDWORK_STATE_HOME;
  const state = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "pr-verification-state-")));
  temporary.push(state);
  process.env.GROUNDWORK_STATE_HOME = state;
});
afterEach(() => {
  if (previousStateHome === undefined) delete process.env.GROUNDWORK_STATE_HOME;
  else process.env.GROUNDWORK_STATE_HOME = previousStateHome;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

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
  const root = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "pr-verification-")));
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
  write(fake, `#!${realBun}
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
if (mode === "commit") spawnSync("git", ["-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "--allow-empty", "-qm", "Changed tested revision"]);
if (mode === "mutate-plan") writeFileSync(join(output, "plan.json"), JSON.stringify({goal: "Verify only one item", requirements: [{id: "behaviour", expect: "The requested behaviour works"}]}));
mkdirSync(join(output, "agent"), { recursive: true });
if (mode !== "missing-evidence") writeFileSync(join(output, "agent", "observation.txt"), "Observed the configured behaviour");
const evidence = mode === "self-report" ? ["agent.json"] : mode === "saved-report" ? ["report.md"] : ["agent/observation.txt"];
writeFileSync(join(output, "agent.json"), JSON.stringify({
  summary: "Observed the requested behaviour.",
  checks: [{ claim: "The requested behaviour works", covers: ["behaviour"], kind: mode === "unspecified-kind" ? undefined : ["review", "saved-report"].includes(mode) ? "review" : "assertion", status: mode === "failed" ? "failed" : "passed", observed: "Ran the project's entry point and inspected its output.", evidence }],
  gaps: mode === "gap" ? ["The required browser is unavailable"] : []
}));
`);
  chmodSync(fake, 0o755);
  return { root, project, output, event, env: {
    ...process.env, PATH: `${dirname(fake)}:${dirname(realBun)}:${process.env.PATH}`, TEST_AGENT: agent,
    GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "consumer/project", GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: join(root, "github-output"), COPILOT_GITHUB_TOKEN: "test-copilot-credential",
    PR_VERIFY_REPOSITORY: project, PR_VERIFY_OUTPUT: output, PR_VERIFY_CHECKS: "true",
    PR_VERIFY_SETUP: "", PR_VERIFY_DIRECTORY: ".", PR_VERIFY_ARTIFACTS: "",
    PR_VERIFY_PLAN: "", PR_VERIFY_COMPARE_BASE: "false",
  } };
}

function run(value, overrides = {}) {
  const processResult = spawnSync(realBun, [runner], { env: { ...value.env, ...overrides }, encoding: "utf8" });
  return { code: processResult.status, output: processResult.stdout + processResult.stderr,
    report: JSON.parse(readFileSync(join(value.output, "result.json"), "utf8")) };
}

test.each(["direct", "symlink"])("runs checks and the agent from a %s repository, captures configured assets, and keeps the Copilot credential out of project commands", location => {
  const value = fixture();
  if (location === "symlink") {
    const linked = join(value.root, "linked-project");
    symlinkSync(value.project, linked, "dir");
    value.env.PR_VERIFY_REPOSITORY = linked;
  }
  const result = run(value, {
    PR_VERIFY_CHECKS: `bun -e 'if (process.env.COPILOT_GITHUB_TOKEN) process.exit(1); require("node:fs").mkdirSync("test-results"); require("node:fs").writeFileSync("test-results/response.json", JSON.stringify({ok:true})); console.log("Checks observed success")'`,
    PR_VERIFY_ARTIFACTS: "test-results",
  });
  expect(result.report.problems).toEqual([]);
  expect(result.report.agent.gaps).toEqual([]);
  expect(result.code).toBe(0);
  expect(result.report.status).toBe("passed");
  expect(result.report.repository).toBe("consumer/project");
  const saved = parseRecord(readFileSync(join(value.output, "report.md"), "utf8"));
  expect(saved.record.status).toBe("passed");
  expect(saved.record.run.id).toBe(result.report.id);
  expect(saved.record.run.source).toEqual(result.report.source);
  expect(saved.record.coverage).toEqual(result.report.verification.coverage);
  expect(existsSync(join(value.output, "project/test-results/response.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(value.output, "project/test-results/response.json"), "utf8"))).toEqual({ ok: true });
  expect(readFileSync(join(value.output, "checks.log"), "utf8")).toContain("Checks observed success");
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(true);
  expect(existsSync(join(value.project, ".groundwork"))).toBe(false);
});

test("failed configured checks remain failures after positive agent observations", () => {
  const value = fixture();
  const result = run(value, { PR_VERIFY_CHECKS: "printf 'Observed failure\\n'; exit 1" });
  expect(result.code).toBe(1);
  expect(result.report.status).toBe("failed");
  expect(result.report.agent.checks[0].status).toBe("passed");
  const saved = parseRecord(readFileSync(join(value.output, "report.md"), "utf8"));
  expect(saved.record.status).toBe("failed");
  expect(saved.record.checks.some(check => check.status === "failed")).toBe(true);
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

test.each([".groundwork/verify.d/feature.json", ".groundwork/verify.json", "verify.json", ".verify/verify.json"])("project catalogue at %s uses the shared runner when the workflow omits a command block", path => {
  const value = fixture();
  write(join(value.project, path), JSON.stringify({
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
  expect(result.report.problems).toEqual([]);
});

test("PR preparation migrates legacy metadata before catalogue, changed-path selection and source capture", () => {
  const value = fixture();
  git(value.project, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "--allow-empty", "-qm", "Candidate revision");
  write(join(value.project, ".verify/verify.json"), JSON.stringify({ checks: {
    feature: { command: "bun .verify/scripts/check.mjs", expect: "The existing driver still works", paths: [".groundwork/verify.d/**"], covers: ["feature"] },
  }, behaviours: { feature: { description: "The feature works", guide: ".verify/VERIFY.md#journey" } } }));
  write(join(value.project, ".verify/VERIFY.md"), "# Project context\n\nKeep shared setup.\n\n## Journey\nExercise the existing feature.\n");
  write(join(value.project, ".verify/scripts/check.mjs"), 'console.log("Legacy driver preserved");\n');
  const result = run(value, { PR_VERIFY_CHECKS: "" });
  expect(result.code).toBe(0);
  expect(result.report.problems).toEqual([]);
  expect(result.report.verification.checks.map(check => check.name)).toEqual(["feature"]);
  expect(result.report.selection.reasons.feature.some(reason => reason.startsWith("changed path: .groundwork/verify.d/"))).toBe(true);
  expect(readFileSync(join(value.output, "feature/output.log"), "utf8")).toContain("Legacy driver preserved");
  const config = loadConfig(value.project);
  expect(catalogueIssues(config, value.project)).toEqual([]);
  expect(readFileSync(join(value.project, config.behaviours.feature.guide.split("#")[0]), "utf8")).toContain("Exercise the existing feature.");
  expect(readFileSync(join(value.project, ".groundwork/guides/project.md"), "utf8")).toContain("Keep shared setup.");
  expect(existsSync(join(value.project, ".verify"))).toBe(false);
  expect(existsSync(join(value.project, ".groundwork/verify.json"))).toBe(false);
});

test("default PR evidence uses external project storage and its nested root-relative driver", () => {
  const value = fixture();
  const project = join(value.project, "packages/app");
  write(join(project, "app.txt"), "nested project\n");
  write(join(project, ".groundwork/scripts/check.mjs"), `import { readFileSync } from "node:fs";
if (readFileSync("app.txt", "utf8") !== "nested project\\n") process.exit(1);
console.log("Nested project driver passed");\n`);
  write(join(project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    feature: { command: "bun .groundwork/scripts/check.mjs", expect: "The nested project driver runs from its project root" },
  } }));
  const env = { ...value.env, PR_VERIFY_OUTPUT: "", PR_VERIFY_DIRECTORY: "packages/app", PR_VERIFY_CHECKS: "" };
  const execute = () => spawnSync(realBun, [runner], { env, encoding: "utf8" });
  const first = execute();
  expect(first.status).toBe(0);
  const runs = evidenceStore(project).runs;
  const [id] = readdirSync(runs);
  const report = JSON.parse(readFileSync(join(runs, id, "result.json"), "utf8"));
  expect(report.status).toBe("passed");
  expect(report.problems).toEqual([]);
  const saved = parseRecord(readFileSync(join(runs, id, "report.md"), "utf8"));
  expect(saved.record.run.id).toBe(id);
  expect(saved.record.run.source).toEqual(report.source);
  expect(saved.record.run.projectPath).toBe("packages/app");
  expect(saved.record.checks[0].command).toBe("bun .groundwork/scripts/check.mjs");
  expect(readFileSync(join(runs, id, "feature/output.log"), "utf8")).toContain("Nested project driver passed");
  expect(existsSync(value.output)).toBe(false);
  expect(existsSync(join(project, ".groundwork/runs"))).toBe(false);
  expect(existsSync(join(project, ".verify"))).toBe(false);
  expect(execute().status).toBe(0);
  const previousRuns = readdirSync(runs);
  expect(previousRuns).toHaveLength(2);
  const changed = spawnSync(realBun, [runner], { env: { ...env, TEST_AGENT: "mutate" }, encoding: "utf8" });
  expect(changed.status).toBe(2);
  const changedRun = readdirSync(runs).find(id => !previousRuns.includes(id));
  const changedReport = JSON.parse(readFileSync(join(runs, changedRun, "result.json"), "utf8"));
  expect(changedReport.problems.join(" ")).toContain("source changed during verification");
});

test("completed automated requirements skip the verification agent without requiring its credential", () => {
  const value = fixture("exit");
  const command = 'printf "Automated proof\\n"';
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    feature: { command, expect: "The requested behaviour works" },
  } }));
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Verify the requested behaviour", requirements: [
    { id: "behaviour", expect: "The requested behaviour works", checks: ["feature"] },
  ] }));
  const result = run(value, { PR_VERIFY_CHECKS: command, PR_VERIFY_PLAN: ".groundwork/plans/pr.json", COPILOT_GITHUB_TOKEN: "" });
  expect(result.code).toBe(0);
  expect(result.report.verification.checks.map(check => check.name)).toEqual(["feature"]);
  expect(result.report.agent.execution.skipped).toBe("complete");
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(false);
  expect(result.report.agent.gaps).toEqual([]);
  expect(verdict(validateResult(result.report))).toBe("passed");
  const comment = formatComment(result.report, { artifactUrl: "https://example.test/evidence", runUrl: "https://example.test/run", conclusion: "success" });
  expect(comment).toContain("Verification — Passed");
  expect(comment).toContain("no further agent verification is required");
  const unavailable = structuredClone(result.report);
  delete unavailable.agent.execution.skipped;
  expect(verdict(unavailable)).toBe("inconclusive");
});

test.each([".verify/plan.json", ".groundwork/runs/previous/plan.json"])("PR verification captures supplied %s before metadata and evidence migration", path => {
  const value = fixture("exit");
  write(join(value.project, ".verify/verify.json"), JSON.stringify({ checks: {
    feature: { command: "bun driver.mjs", expect: "The supplied requirement is exercised", covers: ["saving"] },
    unrelated: { command: "false", expect: "An unrelated check" },
  }, behaviours: { saving: { description: "Save a document" } } }));
  write(join(value.project, "driver.mjs"), `import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.env.GROUNDWORK_PLAN, "utf8"));
if (plan.requirements[0].id !== "saved-outcome" || readFileSync("app.txt", "utf8") !== "candidate implementation\\n") process.exit(1);
console.log("Supplied requirement exercised");\n`);
  const plan = { goal: "Keep the supplied verification scope", requirements: [
    { id: "saved-outcome", expect: "The saved behaviour holds", checks: ["feature"], behaviours: ["saving"] },
  ] };
  write(join(value.project, path), JSON.stringify(plan));
  const result = run(value, { PR_VERIFY_PLAN: path, COPILOT_GITHUB_TOKEN: "" });
  expect(result.code).toBe(0);
  expect(result.report.problems).toEqual([]);
  expect(result.report.verification.plan).toEqual(plan);
  expect(result.report.verification.checks.map(check => check.name)).toEqual(["feature", "configured-checks"]);
  expect(result.report.verification.coverage.map(item => [item.id, item.status])).toEqual([["saved-outcome", "verified"]]);
  expect(result.report.agent.execution.skipped).toBe("complete");
  expect(JSON.parse(readFileSync(join(value.output, "plan.json"), "utf8"))).toEqual(plan);
  expect(readFileSync(join(value.output, "feature/output.log"), "utf8")).toContain("Supplied requirement exercised");
  expect(existsSync(join(value.project, path))).toBe(false);
});

test.each(["outside", "symlink", "missing", "invalid"])("an %s supplied PR plan retains its saved error and does not execute checks", mode => {
  const value = fixture();
  let path = ".verify/plan.json";
  let message;
  if (mode === "outside" || mode === "symlink") {
    const outside = join(value.root, "outside.json");
    write(outside, "This must not be read as a plan.");
    if (mode === "outside") {
      path = "../outside.json";
      message = "The plan input must be a relative file within the project.";
    } else {
      mkdirSync(join(value.project, ".verify"));
      symlinkSync(outside, join(value.project, path));
      message = "Path leaves its evidence directory";
    }
  } else if (mode === "missing") message = "ENOENT";
  else {
    write(join(value.project, path), "null");
    message = "A verification plan needs a goal and at least one requirement.";
  }
  const result = run(value, { PR_VERIFY_PLAN: path, PR_VERIFY_CHECKS: "touch executed" });
  expect(result.code).toBe(2);
  expect(result.report.pullRequest).toBe(42);
  expect(result.report.problems.join(" ")).toContain(message);
  expect(existsSync(join(value.project, "executed"))).toBe(false);
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(false);
});

test.each(["assertion", "review", "unspecified-kind"])("required review invokes the agent and distinguishes %s observations", kind => {
  const value = fixture(kind);
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    feature: { command: "true", expect: "The automated behaviour works", covers: ["feature"] },
  }, behaviours: { feature: { description: "The feature works" } } }));
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Verify and review the behaviour", requirements: [
    { id: "behaviour", expect: "The requested behaviour fits the design", behaviours: ["feature"], review: true },
  ] }));
  const result = run(value, { PR_VERIFY_CHECKS: "", PR_VERIFY_PLAN: ".groundwork/plans/pr.json" });
  expect(result.code).toBe(kind === "review" ? 0 : 2);
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(true);
  expect(result.report.verification.observations[0].kind).toBe(kind === "unspecified-kind" ? "assertion" : kind);
  expect(result.report.verification.coverage[0].status).toBe(kind === "review" ? "verified" : "unverified");
  const context = JSON.parse(readFileSync(join(value.output, "context.json"), "utf8"));
  expect(context.frontier.missing.map(item => item.id)).toEqual(["behaviour"]);
  expect(context.verification.checks[0].status).toBe("passed");
});

test("the generated run report cannot supply its own required review evidence or retain a proof hash", () => {
  const value = fixture("saved-report");
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Review the requested behaviour", requirements: [
    { id: "behaviour", expect: "The requested behaviour fits the design", review: true },
  ] }));
  const result = run(value, { PR_VERIFY_PLAN: ".groundwork/plans/pr.json" });
  expect(result.code).toBe(2);
  expect(result.report.status).toBe("inconclusive");
  expect(result.report.agent.gaps.join(" ")).toContain("A report cannot serve as evidence for its own claims");
  expect(result.report.verification.coverage[0].status).toBe("unverified");
  expect(result.report.verification.observations[0]).toMatchObject({ kind: "review", status: "inconclusive", evidence: [] });
  const saved = parseRecord(readFileSync(join(value.output, "report.md"), "utf8"));
  expect(saved.record.status).toBe("inconclusive");
  expect(saved.record.observations[0].evidence).toEqual([]);
});

test("the verification frontier supplies only missing requirements alongside completed evidence", () => {
  const value = fixture();
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    feature: { command: "true", expect: "The automated outcome holds" },
  } }));
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Verify both outcomes", requirements: [
    { id: "automated", expect: "The automated outcome holds", checks: ["feature"] },
    { id: "behaviour", expect: "The unbound outcome needs an observation" },
  ] }));
  const result = run(value, { PR_VERIFY_CHECKS: "", PR_VERIFY_PLAN: ".groundwork/plans/pr.json" });
  expect(result.code).toBe(0);
  const context = JSON.parse(readFileSync(join(value.output, "context.json"), "utf8"));
  expect(context.frontier.missing.map(item => item.id)).toEqual(["behaviour"]);
  expect(context.frontier.completed.map(item => item.id)).toEqual(["automated"]);
  expect(context.frontier.completed[0].evidence).toContain("feature/output.log");
  expect(context.selection.reasons.feature.join(" ")).toContain("automated");
});

test("an evidence-backed review from a completed check closes the frontier without another agent pass", () => {
  const value = fixture("exit");
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    review: { command: "bun .groundwork/scripts/review.mjs", expect: "The requested contract has been reviewed", result: "result.json" },
  } }));
  write(join(value.project, ".groundwork/scripts/review.mjs"), `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.GROUNDWORK_EVIDENCE_DIR;
writeFileSync(join(directory, "review.txt"), "Reviewed the public contract and confirmed its documented inputs and return value are preserved.");
writeFileSync(join(directory, "result.json"), JSON.stringify({ observations: [{
  kind: "review", status: "passed", covers: ["behaviour"], observed: "Reviewed the public contract against the requested change.", evidence: ["review.txt"]
}] }));\n`);
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Verify the reviewed contract", requirements: [
    { id: "behaviour", expect: "The public contract is preserved", checks: ["review"], review: true },
  ] }));
  const result = run(value, { PR_VERIFY_CHECKS: "", PR_VERIFY_PLAN: ".groundwork/plans/pr.json", COPILOT_GITHUB_TOKEN: "" });
  expect(result.code).toBe(0);
  expect(result.report.verification.coverage[0].status).toBe("verified");
  expect(result.report.agent.execution.skipped).toBe("complete");
  expect(existsSync(join(value.output, "agent-was-run.txt"))).toBe(false);
  const context = JSON.parse(readFileSync(join(value.output, "context.json"), "utf8"));
  expect(context.frontier.missing).toEqual([]);
  expect(context.frontier.completed[0].evidence).toContain("review/artifacts/review.txt");
  expect(verdict(validateResult(result.report))).toBe("passed");
});

test("a workflow override includes required, planned, and active invariant checks without unrelated changed-path checks", () => {
  const value = fixture("exit");
  git(value.project, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "--allow-empty", "-qm", "Candidate revision");
  write(join(value.project, "app.txt"), "changed candidate implementation\n");
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    required: { command: "true", expect: "The required check passes", required: true },
    planned: { command: "true", expect: "The planned check passes" },
    journey: { command: "true", expect: "The planned behaviour works", covers: ["feature"] },
    active: { command: "true", expect: "The affected invariant holds" },
    inactive: { command: "false", expect: "The unaffected invariant" },
    unrelated: { command: "false", expect: "A path-matched catalogue check", paths: ["app.txt"] },
    unscoped: { command: "false", expect: "An unscoped catalogue check" },
  }, behaviours: { feature: { description: "The planned feature works", paths: ["feature.txt"] } }, invariants: {
    affected: { description: "Preserve the affected contract", checks: ["active"], paths: ["app.txt"] },
    unaffected: { description: "Preserve another contract", checks: ["inactive"], paths: ["other.txt"] },
  } }));
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Verify the requested outcome", requirements: [
    { id: "named", expect: "The planned check passes", checks: ["planned"] },
    { id: "behaviour", expect: "The planned behaviour works", behaviours: ["feature"] },
  ] }));
  const result = run(value, { PR_VERIFY_CHECKS: "printf 'Workflow assertion\\n'", PR_VERIFY_PLAN: ".groundwork/plans/pr.json" });
  expect(result.code).toBe(0);
  expect(result.report.verification.checks.map(check => check.name)).toEqual(["required", "planned", "journey", "active", "configured-checks"]);
  expect(result.report.selection.invariants).toEqual(["affected"]);
  expect(result.report.selection.reasons.active).toContain("invariant: affected");
  expect(result.report.selection.omitted).toEqual(["inactive", "unrelated", "unscoped"]);
  expect(result.report.verification.coverage.every(item => item.status === "verified")).toBe(true);
});

test("a workflow block is retained when it only contains a catalogue command as part of a larger block", () => {
  const value = fixture();
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    feature: { command: "true", expect: "A required catalogue check passes", required: true },
  } }));
  const result = run(value, { PR_VERIFY_CHECKS: "true\nprintf 'Workflow-specific assertion\\n'" });
  expect(result.code).toBe(0);
  expect(result.report.verification.checks.map(check => check.name)).toEqual(["feature", "configured-checks"]);
  expect(readFileSync(join(value.output, "checks.log"), "utf8")).toContain("Workflow-specific assertion");
});

test("explicit PR output remains a portable bundle when matching check receipts are reused", () => {
  const value = fixture();
  write(join(value.project, ".groundwork/verify.d/feature.json"), JSON.stringify({ checks: {
    feature: { command: "printf 'Retained assertion\\n'", expect: "The automated result is retained", reuse: true },
  } }));
  write(join(value.project, ".groundwork/plans/pr.json"), JSON.stringify({ goal: "Retain portable proof", requirements: [
    { id: "behaviour", expect: "The automated result is retained", checks: ["feature"] },
  ] }));
  const overrides = { PR_VERIFY_CHECKS: "", PR_VERIFY_PLAN: ".groundwork/plans/pr.json" };
  expect(run(value, overrides).code).toBe(0);
  const previous = value.output;
  value.output = join(value.root, "second-evidence");
  const result = run(value, { ...overrides, PR_VERIFY_OUTPUT: value.output });
  expect(result.code).toBe(0);
  expect(result.report.verification.checks[0].receipt.disposition).toBe("reused");
  const portable = join(value.root, "portable");
  renameSync(value.output, portable);
  rmSync(previous, { recursive: true });
  const retained = refreshEvidence(portable, result.report.verification.checks, result.report.verification.observations);
  expect(retained.problems).toEqual([]);
  expect(retained.checks[0].status).toBe("passed");
  expect(readFileSync(join(portable, retained.checks[0].log), "utf8")).toContain("Retained assertion");
});

test("local PR artifacts cannot recursively copy their own evidence directory", () => {
  const value = fixture();
  value.output = join(value.project, ".groundwork/runs/pr-artifact-overlap");
  const result = run(value, { PR_VERIFY_OUTPUT: value.output, PR_VERIFY_ARTIFACTS: ".groundwork" });
  expect(result.code).toBe(2);
  expect(result.report.problems.join(" ")).toContain("Artifact path overlaps the evidence directory");
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
  const committed = run(fixture("commit"));
  expect(committed.code).toBe(2);
  expect(committed.report.problems.join(" ")).toContain("source changed");
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
  const execution = spawnSync(realBun, [runner], { env: value.env, encoding: "utf8" });
  expect(execution.status).toBe(2);
  expect(readFileSync(join(value.output, "result.json"), "utf8")).toBe(previous);
});

function client(event, currentSha = event.pull_request.head.sha) {
  const calls = [];
  const comments = [];
  const states = [];
  const author = { id: 17, login: "github-actions[bot]", type: "Bot" };
  const current = { ...event.pull_request, head: { sha: currentSha }, html_url: "https://github.com/consumer/project/pull/42" };
  return {
    calls, comments, states, current,
    github: {
      request: async (route, input) => {
        calls.push([route, input]);
        if (route === "GET /repos/consumer/project/pulls/42") return { status: 200, data: current };
        if (route.startsWith("POST /repos/consumer/project/statuses/")) {
          states.push(input);
          return { status: 201, data: { creator: author, ...input } };
        }
        if (route === "POST /repos/consumer/project/issues/42/comments") {
          const item = { id: comments.length + 1, user: author, html_url: `${current.html_url}#issuecomment-${comments.length + 1}`, ...input };
          comments.push(item);
          return { status: 201, data: item };
        }
        throw new Error(`Unexpected API request: ${route}`);
      },
      paginate: async route => {
        calls.push([route]);
        if (route === "GET /repos/consumer/project/pulls/42/artifacts?per_page=100") throw Object.assign(new Error("Not found"), { status: 404 });
        if (route === "GET /repos/consumer/project/issues/42/comments?per_page=100") return comments;
        if (route === `GET /repos/consumer/project/commits/${currentSha}/statuses?per_page=100`) return states.slice().reverse();
        throw new Error(`Unexpected pagination: ${route}`);
      },
    },
    context: { payload: event, repo: { owner: "consumer", repo: "project" }, runId: 123, runAttempt: 1,
      actor: "human-who-triggered-the-workflow", serverUrl: "https://github.com" },
  };
}

test("publishes the shared record on the importing PR with stage results and an optional evidence link", async () => {
  const value = fixture();
  const { report } = run(value);
  const api = client(value.event);
  await publishComment({ ...api, raw: JSON.stringify(report), artifactUrl: "https://github.com/consumer/project/actions/runs/123/artifacts/456", conclusion: "success" });
  const request = api.calls.find(([route]) => route === "POST /repos/consumer/project/issues/42/comments")[1];
  expect(request.body).toContain("Verification — Passed");
  expect(request.body).toContain("Retained evidence");
  expect(request.body).toContain("agent/observation\\.txt");
  const parsed = parseRecord(request.body);
  expect(parsed.record.run.id).toBe(report.id);
  expect(parsed.record.run.source).toEqual(report.source);
  expect(parsed.publication).toMatchObject({ status: "passed", sourceMatches: true, publisher: { id: 17 } });
  expect(api.calls.filter(([route]) => route.includes("/statuses/")).map(([, body]) => body.state)).toEqual(["pending", "success"]);
});

test("a failed job cannot publish success even when the captured checks passed", async () => {
  const value = fixture();
  const { report } = run(value);
  const api = client(value.event);
  const result = await publishComment({ ...api, raw: JSON.stringify(report), conclusion: "failure" });
  expect(result.status).toBe("error");
  const parsed = parseRecord(api.comments[0].body);
  expect(parsed.record.status).toBe("passed");
  expect(parsed.publication.status).toBe("inconclusive");
  expect(parsed.publication.assessment.problems.join(" ")).toContain("job finished with status: failure");
});

test("a stale PR head does not overwrite the current verification comment", async () => {
  const value = fixture();
  const api = client(value.event, "newer-commit");
  const result = await publishComment({ ...api, raw: "", conclusion: "cancelled" });
  expect(result.skipped).toContain("newer head");
  expect(api.calls.map(([route]) => route)).toEqual(["GET /repos/consumer/project/pulls/42"]);
});

test("an edited PR request cannot receive a result based on its old requirement plan", async () => {
  const value = fixture();
  const api = client(value.event);
  api.current.body = "The requested outcome has changed";
  const result = await publishComment({ ...api, raw: "", conclusion: "success" });
  expect(result.skipped).toContain("request changed");
  expect(api.calls.map(([route]) => route)).toEqual(["GET /repos/consumer/project/pulls/42"]);
});

test("CI invalidates an earlier passing status when the new result's initial PR lookup fails", async () => {
  const value = fixture();
  const { report } = run(value);
  const api = client(value.event);
  await publishComment({ ...api, raw: JSON.stringify(report), conclusion: "success" });
  expect(api.states.at(-1).state).toBe("success");
  const failed = structuredClone(report);
  failed.id = `${report.id}-failed`;
  failed.startedAt = new Date(Date.parse(report.startedAt) + 1000).toISOString();
  failed.finishedAt = failed.startedAt;
  failed.status = "failed";
  failed.checks.status = "failed";
  failed.verification.checks[0].status = "failed";
  failed.verification.checks[0].exitCode = 1;
  const request = api.github.request;
  api.github.request = (route, body) => route === "GET /repos/consumer/project/pulls/42"
    ? Promise.reject(new Error("PR metadata unavailable")) : request(route, body);
  await expect(publishComment({ ...api, raw: JSON.stringify(failed), conclusion: "failure" })).rejects.toThrow("PR metadata unavailable");
  expect(api.states.at(-1).state).toBe("error");
  expect(api.comments).toHaveLength(1);
  expect(parseRecord(api.comments[0].body).record.status).toBe("passed");
});

test.each(["mismatched", "absent", "malformed"])("a %s result publishes an inconclusive record and error status", async mode => {
  const value = fixture();
  const { report } = run(value);
  report.repository = "another/repository";
  const api = client(value.event);
  const raw = mode === "mismatched" ? JSON.stringify(report) : mode === "malformed" ? "{}" : "";
  const result = await publishComment({ ...api, raw, conclusion: "failure" });
  const parsed = parseRecord(api.comments[0].body);
  expect(parsed.record.status).toBe("inconclusive");
  expect(parsed.record.run.id).toBe("actions-123-1");
  expect(parsed.record.gaps.length).toBeGreaterThan(0);
  if (mode === "mismatched") expect(parsed.record.gaps.join(" ")).toContain("different PR or revision");
  expect(result.status).toBe("error");
});

test("a complete textual assessment passes without an archive; a job failure remains a separate publication gap", () => {
  const { report } = run(fixture());
  const success = parseRecord(formatComment(report, { artifactUrl: "", runUrl: "https://example.test/run", conclusion: "success" }));
  expect(success.publication.status).toBe("passed");
  const failure = parseRecord(formatComment(report, { artifactUrl: "", runUrl: "https://example.test/run", conclusion: "failure" }));
  expect(failure.record).toEqual(success.record);
  expect(failure.publication.status).toBe("inconclusive");
  expect(failure.publication.assessment.problems.join(" ")).toContain("job finished with status: failure");
});

test.each([true, false])("CI retains the actual tested merge source and checks its relationship to the PR (matching parents: %s)", async matches => {
  const value = fixture();
  const { report } = run(value);
  const head = value.event.pull_request.head.sha;
  value.event.pull_request.base = { sha: "base-commit" };
  report.testedSha = "tested-merge";
  report.source.revision = report.testedSha;
  const api = client(value.event);
  api.context.sha = report.testedSha;
  const request = api.github.request;
  api.github.request = async (route, body) => route === "GET /repos/consumer/project/commits/tested-merge"
    ? { status: 200, data: { sha: report.testedSha, parents: [{ sha: "base-commit" }, { sha: matches ? head : "another-head" }] } }
    : request(route, body);
  const result = await publishComment({ ...api, raw: JSON.stringify(report), conclusion: "success" });
  const parsed = parseRecord(api.comments[0].body);
  expect(parsed.record.run.source.revision).toBe("tested-merge");
  expect(parsed.record.run.testedSha).toBe("tested-merge");
  expect(parsed.publication.headSha).toBe(head);
  expect(parsed.publication.sourceMatches).toBe(matches);
  expect(result.status).toBe(matches ? "success" : "error");
});
