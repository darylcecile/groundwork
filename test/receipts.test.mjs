import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConfig } from "../lib/config.mjs";
import { refreshEvidence } from "../lib/model.mjs";
import { beginReceipt, receiptRecipe } from "../lib/receipts.mjs";
import { runChecks, source } from "../lib/runner.mjs";
import { prepareEvidenceStore, evidenceStore } from "../lib/store.mjs";

const directories = [];
let previousStateHome;
beforeEach(() => {
  previousStateHome = process.env.GROUNDWORK_STATE_HOME;
  process.env.GROUNDWORK_STATE_HOME = temporary();
});
afterEach(() => {
  if (previousStateHome === undefined) delete process.env.GROUNDWORK_STATE_HOME;
  else process.env.GROUNDWORK_STATE_HOME = previousStateHome;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporary() {
  const path = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-receipts-")));
  directories.push(path);
  return path;
}

function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(root) {
  git(root, "add", ".");
  git(root, "-c", "user.name=Receipt Test", "-c", "user.email=receipt@example.test", "commit", "-qm", "Fixture");
}

function fixture(overrides = {}) {
  const root = temporary();
  git(root, "init", "--quiet");
  write(root, ".gitignore", ".groundwork/tmp/\n");
  write(root, "source.txt", "original");
  write(root, ".groundwork/tmp/input.txt", "declared ignored input");
  write(root, ".groundwork/scripts/check.mjs", `import {existsSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
const count=".groundwork/tmp/count"; mkdirSync(".groundwork/tmp",{recursive:true});
writeFileSync(count,String((existsSync(count)?Number(readFileSync(count,"utf8")):0)+1));
const mode=process.env.TEST_MODE;
if(mode==="wait") await new Promise(resolve=>setTimeout(resolve,30000));
if(mode==="source") writeFileSync("source.txt","changed during check");
if(mode==="plan") writeFileSync(process.env.GROUNDWORK_PLAN,JSON.stringify({goal:"changed",requirements:[]}));
const evidence=process.env.GROUNDWORK_EVIDENCE_DIR;
writeFileSync(evidence+"/proof.txt","Observed fixture output");
writeFileSync(evidence+"/result.json",JSON.stringify({observations:[{id:"fixture",status:mode==="fail"?"failed":"passed",observed:"Observed fixture output",evidence:["proof.txt"]}]}));
console.log("Fixture command executed");
process.exitCode=mode==="fail"?1:mode==="inconclusive"?2:0;
`);
  const check = { command: `${JSON.stringify(process.execPath)} .groundwork/scripts/check.mjs`, expect: "Observe the fixture", result: "result.json", reuse: true, ...overrides };
  const checks = parseConfig({ checks: { fixture: check } }).checks;
  const store = prepareEvidenceStore(root);
  let sequence = 0;
  return { root, checks, count: () => Number(readFileSync(join(root, ".groundwork/tmp/count"), "utf8")),
    async run(options = {}) {
      const directory = join(store.runs, `run-${++sequence}`);
      mkdirSync(directory, { recursive: true });
      const result = await runChecks({ root, directory, checks, names: ["fixture"], stream: false, ...options });
      return { ...result, check: result.checks[0], directory };
    } };
}

const plan = { goal: "Verify the fixture", requirements: [{ id: "fixture", expect: "The fixture works", checks: ["fixture"], behaviours: [] }] };

test("a same-content commit reuses the receipt and materializes evidence with original execution provenance", async () => {
  const project = fixture();
  const first = await project.run();
  commit(project.root);
  const second = await project.run();
  expect(project.count()).toBe(1);
  expect(first.check.receipt.disposition).toBe("executed");
  expect(second.check.receipt).toMatchObject({ id: first.check.receipt.id, key: first.check.receipt.key, disposition: "reused",
    run: basename(first.directory), source: first.check.trials[0].source, executionDurationMs: first.check.durationMs });
  expect(second.check.receipt.startedAt).toBe(first.check.receipt.startedAt);
  expect(refreshEvidence(second.directory, second.checks, second.observations).problems).toEqual([]);
  rmSync(first.directory, { recursive: true });
  expect(readFileSync(join(second.directory, "fixture/artifacts/proof.txt"), "utf8")).toBe("Observed fixture output");
});

test.each(["source", "check", "context", "env", "file", "plan"])("changed %s inputs execute a new action", async change => {
  const project = fixture({ reuse: { env: ["FIXTURE_SECRET"], files: [".groundwork/tmp/input.txt"] } });
  const options = { context: { fixture: "one" }, env: { ...process.env, FIXTURE_SECRET: "private-value-one" }, plan };
  const first = await project.run(options);
  if (change === "source") write(project.root, "source.txt", "new source");
  if (change === "check") project.checks.fixture.expect = "Observe updated expectations";
  if (change === "context") options.context = { fixture: "two" };
  if (change === "env") options.env.FIXTURE_SECRET = "private-value-two";
  if (change === "file") write(project.root, ".groundwork/tmp/input.txt", "updated ignored input");
  if (change === "plan") options.plan = { ...plan, goal: "Another goal" };
  const second = await project.run(options);
  expect(project.count()).toBe(2);
  expect(second.check.status).toBe("passed");
  expect(second.check.receipt.disposition).toBe("executed");
  expect(second.check.receipt.key).not.toBe(first.check.receipt.key);
  const location = join(evidenceStore(project.root).receipts, second.check.receipt.key, second.check.receipt.id);
  expect(readFileSync(join(location, "attempt.json"), "utf8")).not.toContain("private-value");
  expect(readFileSync(join(location, "receipt.json"), "utf8")).not.toContain("private-value");
});

test("revision-dependent checks rerun after an otherwise content-equivalent commit", async () => {
  const project = fixture({ reuse: { revision: true } });
  const first = await project.run();
  commit(project.root);
  const second = await project.run();
  expect(project.count()).toBe(2);
  expect(second.check.receipt.key).not.toBe(first.check.receipt.key);
});

test("altered evidence forces execution and never falls back to an older receipt", async () => {
  const project = fixture();
  await project.run();
  const latest = await project.run({ fresh: true });
  write(latest.directory, "fixture/artifacts/proof.txt", "changed evidence");
  const next = await project.run();
  expect(project.count()).toBe(3);
  expect(next.check.receipt.disposition).toBe("executed");
  expect(next.check.receipt.reason).toContain("evidence changed");
});

test("forced fresh creates a new immutable receipt and a newer failure remains authoritative", async () => {
  const project = fixture();
  const passed = await project.run();
  const failed = await project.run({ fresh: true, env: { ...process.env, TEST_MODE: "fail" } });
  const reused = await project.run();
  expect(project.count()).toBe(2);
  expect(failed.check.receipt.reason).toContain("Fresh");
  expect(failed.check.receipt.id).not.toBe(passed.check.receipt.id);
  expect(failed.check.receipt.key).toBe(passed.check.receipt.key);
  expect(reused.check.status).toBe("failed");
  expect(reused.check.receipt.id).toBe(failed.check.receipt.id);
  const receipts = join(evidenceStore(project.root).receipts, passed.check.receipt.key);
  expect(readdirSync(receipts)).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(receipts, passed.check.receipt.id, "receipt.json"), "utf8")).check.status).toBe("passed");
});

test("a newer inconclusive or unfinished attempt blocks an older success", async () => {
  const project = fixture();
  await project.run();
  const incomplete = await project.run({ fresh: true, env: { ...process.env, TEST_MODE: "inconclusive" } });
  expect(incomplete.check.receipt.reusable).toBe(false);
  const next = await project.run();
  expect(project.count()).toBe(3);
  expect(next.check.receipt.disposition).toBe("executed");
  const snapshot = source(project.root);
  const recipe = receiptRecipe({ root: project.root, name: "fixture", check: project.checks.fixture, source: snapshot, context: {}, plan: null, env: process.env });
  beginReceipt(project.root, recipe, snapshot, next.directory);
  const recovered = await project.run();
  expect(project.count()).toBe(4);
  expect(recovered.check.receipt.disposition).toBe("executed");
});

test("interrupted execution is recorded and cannot revive an earlier success", async () => {
  const project = fixture();
  await project.run();
  const controller = new AbortController();
  const running = project.run({ fresh: true, signal: controller.signal, env: { ...process.env, TEST_MODE: "wait" } });
  const deadline = Date.now() + 3000;
  while (project.count() < 2 && Date.now() < deadline) await Bun.sleep(10);
  controller.abort();
  const interrupted = await running;
  expect(project.count()).toBe(2);
  expect(interrupted.check.status).toBe("inconclusive");
  expect(interrupted.check.receipt.reusable).toBe(false);
  const recovered = await project.run();
  expect(project.count()).toBe(3);
  expect(recovered.check.receipt.disposition).toBe("executed");
});

test.each([
  [{ reuse: false }, {}, 2, "not enabled"],
  [{ repeat: 2 }, {}, 4, "independent"],
  [{ setup: "true", cleanup: "true" }, {}, 2, "side effects"],
  [{ compare: "regression" }, { base: "HEAD" }, 4, "comparison"],
])("ineligible check %j keeps every real execution", async (check, options, count, reason) => {
  const project = fixture(check);
  commit(project.root);
  await project.run(options);
  const second = await project.run(options);
  expect(second.problems, second.check.comparison?.reason).toEqual([]);
  expect(project.count()).toBe(count);
  expect(second.check.receipt).toMatchObject({ id: null, disposition: "executed", reusable: false });
  expect(second.check.receipt.reason).toContain(reason);
  if (check.repeat) expect(second.check.trials).toHaveLength(check.repeat);
});

test("a missing explicitly declared ignored file makes the attempt inconclusive", async () => {
  const project = fixture({ reuse: { files: [".groundwork/tmp/input.txt"] } });
  await project.run();
  rmSync(join(project.root, ".groundwork/tmp/input.txt"));
  const next = await project.run();
  expect(project.count()).toBe(2);
  expect(next.check.status).toBe("inconclusive");
  expect(next.check.receipt.reusable).toBe(false);
  expect(next.check.receipt.reason).toContain("input is missing");
});

test.each(["plan", "source"])("changing the %s during execution cannot publish a reusable success", async mode => {
  const project = fixture();
  await project.run({ plan });
  const changed = await project.run({ plan, fresh: true, env: { ...process.env, TEST_MODE: mode } });
  expect(changed.check.status).toBe("inconclusive");
  expect(changed.check.receipt.reusable).toBe(false);
  expect(changed.problems.join(" ")).toContain(mode === "source" ? "Source changed" : "plan changed");
  expect(JSON.parse(readFileSync(join(changed.directory, "plan.json"), "utf8"))).toEqual(plan);
  write(project.root, "source.txt", "original");
  const recovered = await project.run({ plan });
  expect(project.count()).toBe(3);
  expect(recovered.check.receipt.disposition).toBe("executed");
});

test("a same-content commit during a trial still changes the execution snapshot", async () => {
  const project = fixture({ command: "git -c user.name=Receipt -c user.email=receipt@example.test commit --allow-empty -qm 'During trial'", result: undefined });
  commit(project.root);
  const before = source(project.root);
  const result = await project.run();
  expect(source(project.root).fingerprint).toBe(before.fingerprint);
  expect(result.check.status).toBe("inconclusive");
  expect(result.check.problems).toContain("Source changed during this trial.");
  expect(result.check.receipt.reusable).toBe(false);
});

test("engine identity follows the actual code bytes across installation locations", async () => {
  const project = fixture();
  const options = { root: project.root, name: "fixture", check: project.checks.fixture, source: source(project.root), context: {}, plan: null, env: process.env };
  const original = receiptRecipe(options);
  const library = fileURLToPath(new URL("../lib", import.meta.url));
  const copied = join(temporary(), "lib");
  cpSync(library, copied, { recursive: true });
  const same = await import(pathToFileURL(join(copied, "receipts.mjs")).href);
  expect(same.receiptRecipe(options).key).toBe(original.key);
  const changed = join(temporary(), "lib");
  cpSync(library, changed, { recursive: true });
  appendFileSync(join(changed, "model.mjs"), "\n// Changed engine build.\n");
  const updated = await import(pathToFileURL(join(changed, "receipts.mjs")).href);
  expect(updated.receiptRecipe(options).key).not.toBe(original.key);
});
