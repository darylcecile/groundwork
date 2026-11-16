import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../lib/config.mjs";
import { assess, capture, validatePlan } from "../lib/model.mjs";
import { receiptRecipe } from "../lib/receipts.mjs";
import { makeRecord, parseRecord, reassessRun, renderRecord, validateLocalRun, validateRecord } from "../lib/report.mjs";
import { source } from "../lib/runner.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => {
  const directory = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-report-"));
  directories.push(directory);
  return directory;
};
const hash = "a".repeat(64);
const run = () => ({ kind: "local", id: "local-run", startedAt: "2026-11-16T10:00:00Z", finishedAt: "2026-11-16T10:00:01Z",
  source: { identityVersion: 2, revision: "abc123", fingerprint: hash, dirty: false },
  selection: { names: ["check"], reasons: { check: ["plan requirement: works", "required"] }, omitted: [] },
  runner: { platform: "test", architecture: "test" }, context: { fixture: "small" } });
const check = (status = "passed") => ({ name: "check", command: "printf 'ready\\n'", expect: "The behaviour works", covers: ["feature"],
  status, exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null, durationMs: 1,
  log: "check/output.log", logHash: hash, artifacts: [] });
const plan = review => validatePlan({ goal: "Verify the change", requirements: [{ id: "works", expect: "The behaviour works",
  checks: ["check"], behaviours: ["feature"], ...(review ? { review: true } : {}) }], decisions: [".groundwork/decisions/design.md"] });
const observation = () => ({ id: "driver.check.1.review", covers: ["works"], status: "passed", observed: "The output was inspected.",
  kind: "review", evidence: [{ path: "check/inspection.txt", sha256: hash }], producer: "driver", check: "check", trial: 1 });

test("compact records roundtrip exact commands, bindings, review coverage, and receipt provenance", () => {
  const executed = { ...check(), command: "printf '<!-- --> & <ready>\\n'", receipt: {
    disposition: "reused", reason: "Matching completed receipt.", id: "receipt-1", key: hash,
    run: "earlier-run", startedAt: "2026-11-15T10:00:00Z", recordedAt: "2026-11-15T10:00:01Z",
    source: run().source, reusable: true, executionDurationMs: 40,
  } };
  const assessment = assess({ plan: plan(true), checks: [executed], observations: [observation()] });
  const record = makeRecord({ run: run(), assessment });
  const markdown = renderRecord(record);
  const parsed = parseRecord(markdown);
  expect(parsed).toEqual({ record, publication: null });
  expect(parsed.record.checks[0]).toMatchObject({ command: executed.command, reasons: ["plan requirement: works", "required"],
    requirements: ["works"], receipt: executed.receipt });
  expect(parsed.record.coverage[0]).toMatchObject({ id: "works", status: "verified", review: true });
  expect(markdown).toContain("Reused: Matching completed receipt");
  expect(markdown).toContain("review required");
  expect(markdown).toContain("### Decisions");
  executed.receipt.source.dirty = true;
  expect(record.checks[0].receipt.source.dirty).toBe(false);
});

test("records retain failed and incomplete outcomes and a missing review gate", () => {
  const failed = makeRecord({ run: run(), assessment: assess({ plan: plan(true), checks: [check("failed")] }) });
  expect(parseRecord(renderRecord(failed)).record.status).toBe("failed");
  expect(failed.coverage[0]).toMatchObject({ status: "failed", review: true });
  expect(failed.gaps.join(" ")).toContain("evidence-backed review");

  const passing = assess({ plan: plan(false), checks: [check()] });
  const progress = makeRecord({ run: { ...run(), finishedAt: null }, assessment: passing });
  expect(progress.status).toBe("inconclusive");
  expect(progress.gaps).toContain("The selected run did not finish.");
  const outer = makeRecord({ run: { ...run(), kind: "pr" }, assessment: passing, status: "inconclusive",
    stages: [{ name: "Setup", status: "inconclusive", reason: "Environment unavailable." }] });
  expect(outer.status).toBe("inconclusive");
  expect(outer.gaps).toContain("Setup: Environment unavailable.");
  const early = makeRecord({ run: { kind: "pr", id: "early", finishedAt: null } });
  expect(parseRecord(renderRecord(early)).record).toMatchObject({ status: "inconclusive", checks: [], run: { source: null } });
});

test("rendered decision links retain filenames containing parentheses", () => {
  const decisions = ["docs/choice).md", "docs/(choice.md"];
  const record = makeRecord({ run: run(), assessment: assess({
    plan: validatePlan({ ...plan(false), decisions }), checks: [check()],
  }) });
  const body = renderRecord(record, { links: {
    decisions: Object.fromEntries(decisions.map(path => [path, `https://example.test/${path}`])),
  } });
  expect(body).toContain(String.raw`- [docs/choice\)\.md](https://example.test/docs/choice%29.md)`);
  expect(body).toContain(String.raw`- [docs/\(choice\.md](https://example.test/docs/%28choice.md)`);
});

test("publication renders current applicability separately without changing the saved run", () => {
  const record = makeRecord({ run: run(), assessment: assess({ checks: [check()] }) });
  const publication = { headSha: "new-head", testedSha: "abc123", status: "inconclusive", sourceMatches: false,
    assessment: { status: "inconclusive", coverage: [], problems: ["Receipt inputs changed for check; verify again."] } };
  const body = renderRecord(record, { publication, links: { run: "https://example.test/run/1" } });
  expect(parseRecord(body)).toEqual({ record, publication });
  expect(body).toStartWith("## Verification — Inconclusive");
  expect(body).toContain("Current publication: **inconclusive** · recorded run: **passed**");
  expect(body).toContain("PR commit: new-head");
  expect(body).toContain("Receipt inputs changed for check");
  expect(body).toContain("Source matches pushed PR: no");
  expect(record.status).toBe("passed");
});

test("the hidden payload safely retains long observations and cannot be closed by their content", () => {
  const observed = `${"Detail ".repeat(10000)}--> <script>unexpected</script> & \u2028\u2029`;
  const record = makeRecord({ run: run(), assessment: assess({ observations: [{ ...observation(), observed }] }) });
  const body = renderRecord(record);
  const payload = body.slice(body.indexOf("<!-- groundwork-record:v1\n") + "<!-- groundwork-record:v1\n".length, body.lastIndexOf("\n-->"));
  expect(payload).not.toContain("-->");
  expect(parseRecord(body).record.observations[0].observed).toBe(observed);
  expect(parseRecord(`${body}\n${body}`)).toBeNull();
  expect(parseRecord("A report with no machine record")).toBeNull();
  expect(parseRecord("<!-- groundwork-record:v1\n{bad json}\n-->")).toBeNull();
  const malformed = structuredClone(record);
  malformed.coverage = "verified";
  expect(() => validateRecord(malformed)).toThrow("Invalid verification record");
});

function savedNestedRun(status = "passed") {
  const repository = temporary();
  const root = join(repository, "app");
  const directory = temporary();
  mkdirSync(root);
  mkdirSync(join(root, ".fixture"));
  mkdirSync(join(directory, "check"));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: repository, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  writeFileSync(join(repository, ".gitignore"), ".fixture/\n");
  writeFileSync(join(repository, "shared.txt"), "shared source");
  writeFileSync(join(root, "input.txt"), "application source");
  writeFileSync(join(root, "generated.txt"), "excluded build output");
  writeFileSync(join(root, ".fixture/value"), "ready");
  writeFileSync(join(directory, "check/output.log"), "ready\n");
  const config = parseConfig({ checks: { check: { command: check().command, expect: check().expect,
    reuse: { env: ["MODE"], files: [".fixture/value"] } } } });
  const context = { runnerPlatform: process.platform, runnerArchitecture: process.arch };
  const env = { MODE: "ready" };
  const sourceExcluded = ["app/generated.txt"];
  const checkExcluded = ["generated.txt"];
  const recipe = receiptRecipe({ root, name: "check", check: config.checks.check, source: source(root, checkExcluded), context, plan: null, env });
  const assessment = assess({ context, checks: [{ ...check(status), logHash: capture(directory, "check/output.log").sha256,
    receipt: { key: recipe.key, disposition: "executed", reason: "No matching receipt." } }] });
  return { root, directory, sourceRoot: repository, source: source(repository, sourceExcluded), sourceExcluded, checkExcluded,
    finishedAt: run().finishedAt, assessment, config, context, env };
}

test("reassessment uses nested receipt scope and original exclusions, retaining the frozen assessment", () => {
  const saved = savedNestedRun();
  const frozen = JSON.stringify(saved.assessment);
  writeFileSync(join(saved.root, "generated.txt"), "changed excluded output");
  expect(reassessRun(saved)).toMatchObject({ applicability: true, assessment: { status: "passed" }, problems: [] });
  const changedEnv = reassessRun({ ...saved, env: { MODE: "different" } });
  expect(changedEnv.applicability).toBe(false);
  expect(changedEnv.assessment.status).toBe("inconclusive");
  expect(changedEnv.problems.join(" ")).toContain("Receipt inputs changed for check");
  writeFileSync(join(saved.root, ".fixture/value"), "changed");
  expect(reassessRun(saved).problems.join(" ")).toContain("Receipt inputs changed for check");
  writeFileSync(join(saved.root, ".fixture/value"), "ready");
  writeFileSync(join(saved.sourceRoot, "shared.txt"), "changed shared source");
  expect(reassessRun(saved).problems.join(" ")).toContain("Source changed since this run");
  expect(JSON.stringify(saved.assessment)).toBe(frozen);
});

test("reassessment retains failed verdicts while exposing missing evidence and incomplete historical runs", () => {
  const saved = savedNestedRun("failed");
  expect(reassessRun(saved)).toMatchObject({ applicability: true, assessment: { status: "failed" } });
  rmSync(join(saved.directory, "check/output.log"));
  const result = reassessRun({ ...saved, finishedAt: null, source: { ...saved.source, identityVersion: undefined } });
  expect(result).toMatchObject({ applicability: false, assessment: { status: "failed" } });
  expect(result.problems.join(" ")).toContain("The selected run did not finish.");
  expect(result.problems.join(" ")).toContain("Historical source identity");
  expect(result.problems.join(" ")).toContain("Evidence is missing or empty");
  const value = { version: 2, id: "saved", startedAt: run().startedAt, finishedAt: saved.finishedAt,
    source: saved.source, omitted: [], ...saved.assessment };
  expect(validateLocalRun(value, "saved")).toBe(value);
  expect(() => validateLocalRun(value, "other")).toThrow("Invalid saved verification report");
});
