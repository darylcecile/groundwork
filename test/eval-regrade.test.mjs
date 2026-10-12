import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadExperiment, prepare, root } from "../.groundwork/scripts/evals/experiment.mjs";
import { normalizeCapture } from "../.groundwork/scripts/evals/native.mjs";
import { readTrials } from "../.groundwork/scripts/evals/runtime.mjs";
import { loadGrading, regrade } from "../.groundwork/scripts/evals/regrade.mjs";
import { digest, inventory, readJSON, writeJSON } from "../.groundwork/scripts/evals/util.mjs";

// A credential-free contract fixture using the recorded Copilot/Harbor file shapes.
// The tiny native stream and judge responses are synthetic, not paid inference evidence.
function archive({ failed = false, incomplete = false } = {}) {
  const temporary = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-regrade-"));
  const { directory: run, experiment } = prepare({ output: join(temporary, "run"), caseIds: ["labels-plural"],
    models: ["gpt"], attempts: 1, currentRef: "worktree", cliRef: "worktree" });
  // Freeze an older compiler/panel before recording the synthetic actor attempts.
  writeFileSync(join(run, "inputs/runner/judge.mjs"), "// previous packet compiler\n");
  writeFileSync(join(run, "inputs/corpus/rubric.md"), "Previous generic rubric\n");
  experiment.runnerFiles = inventory(join(run, "inputs/runner"));
  experiment.runnerDigest = digest(experiment.runnerFiles);
  experiment.corpusDigest = digest(inventory(join(run, "inputs/corpus")));
  experiment.judges = experiment.judges.map(judge => ({ ...judge, id: `original-${judge.id}` }));
  delete experiment.digest;
  experiment.digest = digest(experiment);
  writeJSON(join(run, "experiment.json"), experiment);
  cpSync(join(run, "inputs/runner"), join(run, "inputs/runtime/.groundwork/scripts/evals"), { recursive: true });
  const files = inventory(join(run, "inputs/runtime"));
  writeJSON(join(run, "runtime-lock.json"), { version: 1, experimentDigest: experiment.digest,
    scheduleDigest: experiment.scheduleDigest, files, sourceDigest: digest(files) });
  const schedule = readJSON(join(run, "schedule.json"));
  for (const [index, slot] of schedule.entries()) {
    const path = join(run, "trials", slot.id), agent = join(path, "harbor", `gw-${slot.id}`, "agent");
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(path, "project"));
    writeFileSync(join(path, "project/cli.mjs"), "console.log('fixture');\n");
    const capture = { completed: true, exitCode: 0 };
    const raw = JSON.stringify({ type: "assistant.message", data: { content: "Synthetic contract answer", model: "gpt-6-astra" } });
    writeJSON(join(agent, "capture.json"), capture);
    writeFileSync(join(agent, "raw.jsonl"), raw);
    const native = normalizeCapture({ runtime: "copilot-cli", raw, capture, expectedModel: "gpt-6-astra", expectedEffort: "high", targetSkill: "implement" });
    const failure = failed && index === 0;
    const execution = { version: 1, ...slot, experimentDigest: experiment.digest, ...native,
      status: incomplete && index === 0 ? "incomplete" : native.status, durationMs: 1,
      checks: [{ id: "separate-verifier", status: failure ? "failed" : "passed", observed: "Synthetic behavioural observation" }],
      success: !failure, evidenceValid: true, verifierMode: "separate" };
    writeJSON(join(path, "harbor", `gw-${slot.id}`, "verifier/grade.json"), { checks: execution.checks, success: execution.success });
    writeJSON(join(path, "started.json"), { ...slot, experimentDigest: experiment.digest });
    writeJSON(join(path, "execution.json"), execution);
    const artifactHashes = {};
    for (const part of ["project", "harbor"]) for (const [name, hash] of Object.entries(inventory(join(path, part)))) artifactHashes[`${part}/${name}`] = hash;
    for (const name of ["started.json", "execution.json"]) artifactHashes[name] = digest(readFileSync(join(path, name)));
    writeJSON(join(path, "result.json"), { ...execution, artifactHashes,
      judgements: [{ judgeId: "old-panel", status: "unavailable", reason: "Old packet compiler rejected the trace" }] });
  }
  return { temporary, run, experiment, schedule, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

function fakeJudges(calls) {
  return async request => {
    calls.push(request);
    const output = { status: "scored", criteria: Object.fromEntries(["correctness", "completeness", "evidence", "proportionality"]
      .map(name => [name, { score: 4, evidence: ["Synthetic behavioural observation"] }])),
    falseVerification: { value: false, evidence: ["Synthetic contract answer"] } };
    return { completed: true, output: JSON.stringify(output) };
  };
}

const actorFiles = run => Object.fromEntries(Object.entries(inventory(run)).filter(([path]) => !path.startsWith("grades/")));

test("regrades archived actors with a new panel/compiler, retaining identity and failed behaviour", async () => {
  const fixture = archive({ failed: true }), calls = [];
  try {
    const { run, experiment, schedule } = fixture, before = actorFiles(run);
    expect(() => loadExperiment(run)).toThrow("code changed");
    expect(loadExperiment(run, { allowRunnerChanges: true }).digest).toBe(experiment.digest);
    expect(readTrials(run, { allowArchived: true }).every(trial => trial.evidenceValid)).toBe(true);
    const config = readJSON(defaultConfig);
    config.judges = config.judges.map(judge => ({ ...judge, id: `selected-${judge.id}` }));
    const configPath = join(fixture.temporary, "grading-config.json");
    writeJSON(configPath, config);
    const result = await regrade(run, { config: configPath }, { invokeJudge: fakeJudges(calls) });
    expect(calls).toHaveLength(4);
    expect(calls.every(call => call.judge.family !== "openai" && call.directory.startsWith(result.directory))).toBe(true);
    expect(calls.every(call => call.trialDirectory.startsWith(join(run, "trials")) && call.projectDirectory.endsWith("/project"))).toBe(true);
    expect(calls.every(call => !call.prompt.includes("Previous generic rubric"))).toBe(true);
    expect(JSON.parse(calls[0].prompt.split("\n").at(-1)).reference).toBe(experiment.cases[0].reference);
    expect(result.report.id).not.toBe(experiment.id);
    expect(result.report.experiment).toMatchObject({ id: experiment.id, digest: experiment.digest, judges: experiment.judges });
    expect(result.report.grading.judges).toEqual(config.judges);
    expect(result.report.grading.digest).not.toBe(experiment.digest);
    expect(result.report.trials.map(trial => trial.id)).toEqual(schedule.map(slot => slot.id));
    expect(result.report.trials.every(trial => trial.experimentDigest === experiment.digest)).toBe(true);
    expect(result.report.trials[0].evaluation).toMatchObject({ outcome: "failed", qualityScore: 0 });
    expect(result.report.trials[1].evaluation.outcome).toBe("passed");
    expect(result.report.groups.every(group => group.judgeScores.every(judge => judge.judgeId.startsWith("selected-")))).toBe(true);
    expect(actorFiles(run)).toEqual(before);
    const saved = loadGrading(result.directory);
    expect(saved.report).toEqual(result.report);
    expect(saved.markdown).toContain("Regraded saved attempts; no actor executions");
    expect(saved.markdown).toContain(experiment.id);
    const cli = Bun.spawnSync(["bun", join(root, ".groundwork/scripts/eval.mjs"), "report", result.directory]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toContain(saved.markdown);
    expect(readFileSync(join(result.directory, "report.md"), "utf8")).toBe(saved.markdown);
    const revision = await regrade(run, {}, { invokeJudge: fakeJudges(calls) });
    expect(revision.directory).not.toBe(result.directory);
    expect(revision.report.grading.judges).toEqual(readJSON(defaultConfig).judges);
    expect(calls).toHaveLength(8);
    expect(actorFiles(run)).toEqual(before);
    expect(loadGrading(result.directory).report).toEqual(result.report);
  } finally { fixture.cleanup(); }
});

test("saved grades reject changes to report, packets, source snapshots, manifest and original actors", async () => {
  const fixture = archive();
  try {
    const { directory, report } = await regrade(fixture.run, {}, { invokeJudge: fakeJudges([]) });
    const paths = [join(directory, "report.json"), join(directory, "report.md"), join(directory, "manifest.json"),
      join(directory, "grading.json"), join(directory, "inputs/rubric.md"),
      join(directory, "inputs/grader/.groundwork/scripts/evals/judge.mjs"),
      join(directory, "trials/0001/judge-claude-packet.txt"), join(directory, "trials/0001/grade.json"),
      join(fixture.run, "trials", report.trials[0].id, "project/cli.mjs"),
      join(fixture.run, "trials", report.trials[0].id, "result.json")];
    for (const path of paths) {
      const original = readFileSync(path);
      writeFileSync(path, path.endsWith(".json") ? "{}" : "tampered success");
      expect(() => loadGrading(directory)).toThrow();
      writeFileSync(path, original);
    }
    expect(loadGrading(directory).report.status).toBe("complete");
    writeJSON(join(directory, "anana.json"), { pageId: "publication-receipt" });
    expect(loadGrading(directory).report.id).toBe(report.id);
  } finally { fixture.cleanup(); }
});

test("source-invalid and incomplete actors retain metadata and never invoke judges", async () => {
  const fixture = archive({ incomplete: true }), calls = [];
  try {
    const invalid = fixture.schedule[1];
    writeFileSync(join(fixture.run, "trials", invalid.id, "project/cli.mjs"), "changed after execution");
    const before = actorFiles(fixture.run);
    const { directory, report } = await regrade(fixture.run, {}, { invokeJudge: fakeJudges(calls) });
    expect(calls).toHaveLength(0);
    expect(report.status).toBe("incomplete");
    expect(report.trials[0].status).toBe("incomplete");
    expect(report.trials[1]).toMatchObject({ id: invalid.id, evidenceValid: false, success: true });
    expect(report.trials.every(trial => trial.judgements.every(judge => judge.status === "unavailable"))).toBe(true);
    expect(report.groups.every(group => group.passed === 0 && group.qualityScore === null)).toBe(true);
    expect(actorFiles(fixture.run)).toEqual(before);
    expect(loadGrading(directory).report).toEqual(report);
  } finally { fixture.cleanup(); }
});

test("unavailable judge responses stay visible without retrying or selecting another score", async () => {
  const fixture = archive(), calls = [];
  try {
    const score = fakeJudges(calls);
    const { directory, report } = await regrade(fixture.run, {}, { invokeJudge: async request => {
      const response = await score(request);
      return request.judge.family === "anthropic" ? { completed: false, output: "partial response", error: "Synthetic timeout" } : response;
    } });
    expect(calls).toHaveLength(4);
    expect(report.status).toBe("incomplete");
    expect(report.trials.every(trial => trial.judgements.map(judge => judge.status).join(",") === "unavailable,scored")).toBe(true);
    expect(report.groups.every(group => group.passed === 0 && group.qualityScore === null)).toBe(true);
    expect(readFileSync(join(directory, "trials/0001/judge-claude-response.txt"), "utf8")).toBe("partial response");
    expect(loadGrading(directory).report).toEqual(report);
  } finally { fixture.cleanup(); }
});

test("active runs and frozen archive damage block regrading before inference", async () => {
  const fixture = archive(), calls = [];
  try {
    const lock = join(fixture.run, ".runtime-running");
    writeFileSync(lock, String(process.pid));
    await expect(regrade(fixture.run, {}, { invokeJudge: fakeJudges(calls) })).rejects.toThrow("locked");
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    rmSync(lock);
    const config = readJSON(defaultConfig);
    config.judges = config.judges.filter(judge => judge.family !== "xai");
    const configPath = join(fixture.temporary, "invalid-panel.json");
    writeJSON(configPath, config);
    await expect(regrade(fixture.run, { config: configPath }, { invokeJudge: fakeJudges(calls) })).rejects.toThrow("two other model families");
    writeFileSync(join(fixture.run, "inputs/runner/judge.mjs"), "damaged old compiler");
    await expect(regrade(fixture.run, {}, { invokeJudge: fakeJudges(calls) })).rejects.toThrow("Frozen benchmark runner inputs changed");
    expect(existsSync(lock)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(fixture.run, "grades"))).toBe(false);
  } finally { fixture.cleanup(); }
});
