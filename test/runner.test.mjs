import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../skills/verify-work/verify.mjs", import.meta.url));
const projects = [];
afterEach(() => { for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function invoke(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  return { code: result.status, output: result.stdout + result.stderr };
}

function project(config) {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-runner-"));
  projects.push(root);
  git(root, "init", "--quiet");
  const initialized = invoke(root, "init");
  if (initialized.code !== 0) throw new Error(initialized.output);
  write(root, "verify.json", config);
  return root;
}

function saved(root) {
  const id = readFileSync(join(root, ".verify/latest"), "utf8").trim();
  const directory = join(root, ".verify/runs", id);
  return { directory, report: JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) };
}

function commit(root) {
  git(root, "add", ".");
  git(root, "-c", "user.name=Groundwork Test", "-c", "user.email=groundwork@example.test", "commit", "-qm", "Fixture baseline");
  return git(root, "rev-parse", "HEAD");
}

test("a plan exposes an omitted requirement despite a passing named check", () => {
  const root = project({ checks: { current: { command: "printf 'Current behaviour observed\\n'", expect: "The current behaviour works" } } });
  write(root, ".verify/task.json", { goal: "Complete both outcomes", requirements: [
    { id: "current", expect: "Current behaviour works", checks: ["current"] },
    { id: "preserved", expect: "Existing behaviour survives restart" },
  ] });
  expect(invoke(root, "verify", "current", "--plan", ".verify/task.json").code).toBe(2);
  const { report } = saved(root);
  expect(report.checks[0].status).toBe("passed");
  expect(report.coverage.map(item => item.status)).toEqual(["verified", "unverified"]);
  expect(invoke(root, "view", "report").output).toContain("UNVERIFIED preserved");
});

test("a requirement bound to two behaviours is not satisfied by covering only one", () => {
  const root = project({ checks: { first: { command: "true", expect: "The first behaviour holds", covers: ["first"] } },
    behaviours: { first: { description: "First outcome" }, second: { description: "Second outcome" } } });
  write(root, ".verify/task.json", { goal: "Establish both outcomes", requirements: [
    { id: "combined", expect: "Both outcomes hold", behaviours: ["first", "second"] },
  ] });
  expect(invoke(root, "verify", "--plan", ".verify/task.json").code).toBe(2);
  expect(saved(root).report.coverage[0].reason).toContain("second");
});

test("a driver cannot shrink the frozen plan during verification", () => {
  const root = project({ checks: { current: {
    command: "bun alter-plan.mjs", expect: "Current behaviour works",
  } } });
  write(root, "alter-plan.mjs", `import {readFileSync,writeFileSync} from "node:fs";
const file=process.env.GROUNDWORK_PLAN; const plan=JSON.parse(readFileSync(file,"utf8"));
plan.requirements.pop(); writeFileSync(file,JSON.stringify(plan));
`);
  write(root, ".verify/task.json", { goal: "Keep the whole task", requirements: [
    { id: "current", expect: "Current behaviour works", checks: ["current"] },
    { id: "preserved", expect: "Existing behaviour is preserved" },
  ] });
  expect(invoke(root, "verify", "--plan", ".verify/task.json").code).toBe(2);
  const { report, directory } = saved(root);
  expect(report.plan.requirements).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(directory, "plan.json"), "utf8")).requirements).toHaveLength(2);
  expect(report.problems.join(" ")).toContain("plan changed");
});

test("invalid requirement IDs are rejected before a check executes", () => {
  const root = project({ checks: { current: { command: "touch executed", expect: "Observe a result" } } });
  write(root, ".verify/task.json", { goal: "Verify a result", requirements: [{ expect: "A missing ID is invalid" }] });
  expect(invoke(root, "verify", "--plan", ".verify/task.json").code).toBe(2);
  expect(existsSync(join(root, "executed"))).toBe(false);
});

test("named verification enforces the project's invariant and shows searchable catalogue entries", () => {
  const root = project({
    checks: {
      feature: { command: "true", expect: "The feature works", covers: ["editing"] },
      guard: { command: "false", expect: "The storage boundary holds" },
    },
    behaviours: { editing: { description: "Edit a document", entry: "/editor", paths: ["src/editor/**"], guide: "VERIFY.md#editing" } },
    invariants: { storage: { description: "Only approved modules access storage", checks: ["guard"] } },
  });
  write(root, "VERIFY.md", "# Behaviour guide\n\n## Editing\nUse the editor.\n");
  const guide = invoke(root, "view", "guide", "editor");
  expect(guide.code).toBe(0);
  expect(guide.output).toContain("editing (behaviour)");
  expect(guide.output).toContain("Checks: feature");
  expect(invoke(root, "verify", "feature").code).toBe(1);
  const { report } = saved(root);
  expect(report.checks.map(check => check.name)).toEqual(["feature", "guard"]);
  expect(report.coverage.find(item => item.id === "invariant:storage").status).toBe("failed");
});

test("change-aware verification keeps required checks and shows areas without a verification path", () => {
  const root = project({
    checks: {
      required: { command: "true", expect: "Project constraints hold", required: true },
      editor: { command: "true", expect: "The editor works", covers: ["editing"] },
      unrelated: { command: "false", expect: "Another component works", paths: ["other/**"] },
    },
    behaviours: { editing: { description: "Edit a document", paths: ["src/**"] },
      future: { description: "An unmapped journey", paths: ["future/**"] } },
  });
  write(root, "src/value.txt", "before");
  commit(root);
  write(root, "src/value.txt", "after");
  write(root, "future/value.txt", "new feature");
  write(root, "notes.txt", "unmapped change");
  const result = invoke(root, "verify", "--changed", "HEAD");
  expect(result.code).toBe(0);
  const { report } = saved(root);
  expect(report.checks.map(check => check.name)).toEqual(["required", "editor"]);
  expect(report.selection.unmappedPaths).toContain("notes.txt");
  expect(report.selection.uncoveredBehaviours).toContain("future");
});

function apiProject(value) {
  const root = project({
    context: { fixture: "local-http", upstream: "controlled" },
    behaviours: { response: { description: "The API returns its prepared state" } },
    checks: { api: {
      kind: "api", covers: ["response"], command: "bun driver.mjs", expect: "The prepared API state is observable",
      setup: `bun -e 'require("node:fs").writeFileSync(process.env.GROUNDWORK_EVIDENCE_DIR+"/seed.json",JSON.stringify({value:"${value}"}))'`,
      cleanup: `bun -e 'require("node:fs").writeFileSync(process.env.GROUNDWORK_EVIDENCE_DIR+"/cleanup.txt","completed")'`,
      result: "observations.json", artifacts: ["cleanup.txt"],
    } },
  });
  write(root, "driver.mjs", `import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const output=process.env.GROUNDWORK_EVIDENCE_DIR;
const state=JSON.parse(readFileSync(join(output,"seed.json"),"utf8"));
const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch(){return Response.json(state)}});
try {
  const response=await fetch(server.url); const actual=await response.json();
  writeFileSync(join(output,"response.json"),JSON.stringify(actual));
  const passed=response.ok && actual.value==="ready";
  writeFileSync(join(output,"observations.json"),JSON.stringify({observations:[{id:"prepared-state",status:passed?"passed":"failed",observed:"GET returned "+JSON.stringify(actual),evidence:["response.json"]}],context:{fixture:"local-http"}}));
  process.exitCode=passed?0:1;
} finally { server.stop(true); }
`);
  return root;
}

test.each(["ready", "wrong"])("the driver lifecycle captures a real HTTP observation and cleans up after %s state", value => {
  const root = apiProject(value);
  write(root, ".verify/task.json", { goal: "Observe the prepared API", requirements: [
    { id: "api-state", expect: "The API exposes the ready state", behaviours: ["response"] },
  ] });
  const result = invoke(root, "verify", "api", "--plan", ".verify/task.json");
  expect(result.code).toBe(value === "ready" ? 0 : 1);
  const { report, directory } = saved(root);
  expect(report.coverage[0].status).toBe(value === "ready" ? "verified" : "failed");
  expect(JSON.parse(readFileSync(join(directory, "api/artifacts/response.json"), "utf8")).value).toBe(value);
  expect(readFileSync(join(directory, "api/artifacts/cleanup.txt"), "utf8")).toBe("completed");
  expect(report.observations[0].kind).toBe("assertion");
  expect(report.checks[0].trials[0].context.upstream).toBe("controlled");
});

test("repeated agent-evaluation trials retain a failing tool-routing case instead of reporting only the last success", () => {
  const root = project({
    behaviours: { routing: { description: "Requests use the intended tool route" } },
    checks: { routing: { command: "bun evaluate.mjs", expect: "Every recorded request uses the correct tool", kind: "agent",
      repeat: 3, covers: ["routing"], result: "observations.json", context: { model: "recorded-fixtures" } } },
  });
  write(root, "evaluate.mjs", `import {writeFileSync} from "node:fs";
const output=process.env.GROUNDWORK_EVIDENCE_DIR;
const actual=Number(process.env.GROUNDWORK_TRIAL)===2?"wrong_route":"expected_route";
writeFileSync(output+"/tool-trace.json",JSON.stringify({called:actual}));
writeFileSync(output+"/observations.json",JSON.stringify({observations:[{id:"route",status:actual==="expected_route"?"passed":"failed",observed:"Called "+actual,evidence:["tool-trace.json"]}]}));
`);
  expect(invoke(root, "verify").code).toBe(1);
  const { report, directory } = saved(root);
  expect(report.checks[0].trialSummary).toEqual({ total: 3, passed: 2, failed: 1, inconclusive: 0 });
  expect(report.checks[0].trials.map(trial => trial.status)).toEqual(["passed", "failed", "passed"]);
  expect(new Set(report.observations.map(item => item.id)).size).toBe(3);
  for (let trial = 1; trial <= 3; trial++) expect(existsSync(join(directory, `routing/trial-${trial}/artifacts/tool-trace.json`))).toBe(true);
});

function comparisonProject(mode, before, after, contextMismatch = false) {
  const root = project({ checks: {} });
  write(root, "value.txt", before);
  const base = commit(root);
  write(root, "value.txt", after);
  write(root, "verify.json", { checks: { scenario: {
    command: "bun compare.mjs", expect: mode === "regression" ? "The regression is fixed" : "Payload growth stays within budget",
    compare: mode, result: "observations.json", repeat: 2,
    ...(mode === "measurement" ? { metrics: { payload: { unit: "bytes", max: 100, maxRegressionPercent: 10 } } } : {}),
  } } });
  write(root, "compare.mjs", `import {readFileSync,writeFileSync} from "node:fs";
const output=process.env.GROUNDWORK_EVIDENCE_DIR;
const value=readFileSync(process.env.GROUNDWORK_SOURCE_DIR+"/value.txt","utf8");
writeFileSync(output+"/actual.txt",value);
const passed=${JSON.stringify(mode)}==="measurement" || value==="fixed";
writeFileSync(output+"/observations.json",JSON.stringify({
  observations:[{status:passed?"passed":"failed",observed:"Read source value: "+value,evidence:["actual.txt"]}],
  measurements:[{name:"payload",value:Buffer.byteLength(value),unit:"bytes"}],
  context:{fixture:${contextMismatch ? "process.env.GROUNDWORK_PHASE" : '"same-workload"'}}
}));
process.exitCode=passed?0:1;
`);
  return { root, base };
}

test("the candidate's new regression driver checks both source revisions and cleans up its baseline worktree", () => {
  const { root, base } = comparisonProject("regression", "broken", "fixed");
  const result = invoke(root, "verify", "scenario", "--base", base);
  expect(result.code).toBe(0);
  const { report, directory } = saved(root);
  expect(report.checks[0].comparison.status).toBe("passed");
  expect(report.checks[0].baseline.map(trial => trial.status)).toEqual(["failed", "failed"]);
  expect(report.checks[0].trials.map(trial => trial.status)).toEqual(["passed", "passed"]);
  expect(readFileSync(join(directory, "scenario/baseline/trial-1/artifacts/actual.txt"), "utf8")).toBe("broken");
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("fixed");
  expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
});

test("an unavailable or already-passing baseline cannot establish a reproduced bug", () => {
  const unavailable = comparisonProject("regression", "broken", "fixed");
  expect(invoke(unavailable.root, "verify", "--base", "nonexistent-ref").code).toBe(2);
  expect(saved(unavailable.root).report.checks[0].comparison.reason).toContain("Baseline unavailable");
  const passing = comparisonProject("regression", "fixed", "fixed");
  expect(invoke(passing.root, "verify", "--base", passing.base).code).toBe(2);
  expect(saved(passing.root).report.checks[0].comparison.reason).toContain("not reproduced");
});

test("an unsuccessful baseline process without a failed assertion does not count as reproducing the bug", () => {
  const { root, base } = comparisonProject("regression", "broken", "fixed");
  write(root, "compare.mjs", `import {writeFileSync} from "node:fs";
const output=process.env.GROUNDWORK_EVIDENCE_DIR;
const baseline=process.env.GROUNDWORK_PHASE==="baseline";
writeFileSync(output+"/actual.txt",baseline?"Service unavailable":"Observed fixed behaviour");
writeFileSync(output+"/observations.json",JSON.stringify({observations:[{status:baseline?"inconclusive":"passed",observed:baseline?"Could not reach required service":"Observed expected behaviour",evidence:["actual.txt"]}]}));
process.exitCode=baseline?1:0;
`);
  expect(invoke(root, "verify", "--base", base).code).toBe(2);
  expect(saved(root).report.checks[0].comparison.status).toBe("inconclusive");
});

test("measurement comparisons use actual declared measurements and expose a regression", () => {
  const { root, base } = comparisonProject("measurement", "0123456789", "01234567890123456789");
  expect(invoke(root, "verify", "--base", base).code).toBe(1);
  const metric = saved(root).report.checks[0].comparison.measurements[0];
  expect(metric).toMatchObject({ name: "payload", baseline: 10, candidate: 20, unit: "bytes", regressionPercent: 100, status: "failed" });
  expect(metric.baselineSamples).toEqual([10, 10]);
  expect(metric.candidateSamples).toEqual([20, 20]);
});

test("different declared workload contexts make before/after measurements inconclusive", () => {
  const { root, base } = comparisonProject("measurement", "same", "same", true);
  expect(invoke(root, "verify", "--base", base).code).toBe(2);
  expect(saved(root).report.checks[0].comparison.reason).toContain("context differs");
});

test("a successful process with a missing metric cannot pass a configured measurement budget", () => {
  const root = project({ checks: { measured: { command: "bun measure.mjs", expect: "Measure actual memory use", result: "result.json",
    metrics: { memory: { unit: "MiB", max: 100 } } } } });
  write(root, "measure.mjs", `import {writeFileSync} from "node:fs";
writeFileSync(process.env.GROUNDWORK_EVIDENCE_DIR+"/result.json",JSON.stringify({measurements:[{name:"memory",value:10,unit:"bytes"}]}));
`);
  expect(invoke(root, "verify").code).toBe(2);
  expect(saved(root).report.checks[0].trials[0].metrics[0].status).toBe("inconclusive");
});

test("saved observations lose coverage when their evidence is altered", () => {
  const root = apiProject("ready");
  write(root, ".verify/task.json", { goal: "Observe API state", requirements: [{ id: "api-state", expect: "The API state is ready", behaviours: ["response"] }] });
  expect(invoke(root, "verify", "--plan", ".verify/task.json").code).toBe(0);
  const { directory } = saved(root);
  writeFileSync(join(directory, "api/artifacts/response.json"), '{"value":"altered"}');
  const result = invoke(root, "view", "report");
  expect(result.code).toBe(2);
  expect(result.output).toContain("evidence changed");
  expect(result.output).toContain("UNVERIFIED api-state");
});

test("a later trial cannot reuse an earlier trial's evidence through a symbolic link", () => {
  const root = project({ checks: { trials: { command: "bun trials.mjs", expect: "Each trial has its own observation", repeat: 2, result: "result.json" } } });
  write(root, "trials.mjs", `import {writeFileSync,symlinkSync} from "node:fs";
import {resolve} from "node:path";
const dir=process.env.GROUNDWORK_EVIDENCE_DIR;
if(process.env.GROUNDWORK_TRIAL==="1") writeFileSync(dir+"/actual.txt","first trial only");
else symlinkSync(resolve(dir,"../../trial-1/artifacts/actual.txt"),dir+"/actual.txt");
writeFileSync(dir+"/result.json",JSON.stringify({observations:[{status:"passed",observed:"Observed this trial",evidence:["actual.txt"]}]}));
`);
  expect(invoke(root, "verify").code).toBe(2);
  expect(saved(root).report.checks[0].trials.map(trial => trial.status)).toEqual(["passed", "inconclusive"]);
});

test("a structured result cannot count an alias of itself as empirical evidence", () => {
  const root = project({ checks: { self: { command: "bun self.mjs", expect: "Capture a real observation", result: "result.json" } } });
  write(root, "self.mjs", `import {writeFileSync,symlinkSync} from "node:fs";
const dir=process.env.GROUNDWORK_EVIDENCE_DIR;
writeFileSync(dir+"/result.json",JSON.stringify({observations:[{status:"passed",observed:"Self report",evidence:["alias.json"]}]}));
symlinkSync(dir+"/result.json",dir+"/alias.json");
`);
  expect(invoke(root, "verify").code).toBe(2);
  expect(saved(root).report.checks[0].problems.join(" ")).toContain("report cannot serve as evidence");
});

test("previously saved version-one reports remain readable", () => {
  const root = project({ checks: { original: { command: "true", expect: "The original check passes" } } });
  expect(invoke(root, "verify").code).toBe(0);
  const { directory, report } = saved(root);
  const legacy = { version: 1, id: report.id, startedAt: report.startedAt, finishedAt: report.finishedAt,
    source: report.source, omitted: [], checks: report.checks.map(check => ({
      name: check.name, command: check.command, expect: check.expect, status: check.status, reason: check.reason,
      exitCode: check.exitCode, durationMs: check.durationMs, log: check.log, artifacts: check.artifacts,
    })) };
  writeFileSync(join(directory, "result.json"), JSON.stringify(legacy));
  expect(invoke(root, "view", "report").code).toBe(0);
});
