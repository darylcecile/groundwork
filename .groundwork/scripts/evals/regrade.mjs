import { randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultConfig, loadExperiment, root, runnerInventory, validateConfig } from "./experiment.mjs";
import { blindedPacket, parseJudgement } from "./judge.mjs";
import { readTrials, invokeJudge } from "./runtime.mjs";
import { buildReport, renderReport } from "./report.mjs";
import { concurrent, digest, ensure, inventory, readJSON, writeJSON } from "./util.mjs";

const safeID = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const rubricPath = join(root, ".groundwork/evals/rubric.md");

function graderSources() {
  const hashes = { ...Object.fromEntries(Object.entries(runnerInventory()).map(([path, hash]) => [`.groundwork/scripts/evals/${path}`, hash])),
    ".groundwork/config/evals.Dockerfile": digest(readFileSync(join(root, ".groundwork/config/evals.Dockerfile"))) };
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

// Original reports and publication receipts are not execution evidence. All inputs,
// native traces, verifier observations and original results are, including failed attempts.
function actorEvidence(run) {
  const hashes = {};
  for (const file of ["experiment.json", "schedule.json", "runtime-lock.json"]) {
    if (existsSync(join(run, file))) hashes[file] = digest(readFileSync(join(run, file)));
  }
  for (const part of ["inputs", "trials"]) {
    if (existsSync(join(run, part))) for (const [path, hash] of Object.entries(inventory(join(run, part)))) hashes[`${part}/${path}`] = hash;
  }
  return hashes;
}

function gradeFiles(directory) {
  return Object.fromEntries(Object.entries(inventory(directory)).filter(([path]) => !["manifest.json", "anana.json"].includes(path)));
}

function checkedDigest(value, label) {
  const { digest: expected, ...contents } = value;
  ensure(expected === digest(contents), `${label} changed or is incomplete.`);
  return value;
}

function acquireLocks(run) {
  const owned = [];
  try {
    for (const name of [".runtime-running", "judging.lock"]) {
      const path = join(run, name);
      let descriptor;
      try { descriptor = openSync(path, "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error(`Actor execution or judging is locked (${name}). Confirm it stopped before removing a stale lock.`);
        throw error;
      }
      owned.push(path);
      try { writeFileSync(descriptor, String(process.pid)); } finally { closeSync(descriptor); }
    }
  } catch (error) { owned.forEach(path => unlinkSync(path)); throw error; }
  return () => owned.forEach(path => unlinkSync(path));
}

function orderedTrials(run, trials) {
  const schedule = readJSON(join(run, "schedule.json"));
  ensure(Array.isArray(schedule), "Unsupported archived schedule.");
  const order = new Map(schedule.map((slot, index) => [slot.id, index]));
  return [...trials].sort((left, right) => (order.get(left.id) ?? schedule.length) - (order.get(right.id) ?? schedule.length));
}

async function gradeTrial({ run, directory, experiment, grading, instructions, trial, index, invoke }) {
  const output = join(directory, "trials", String(index + 1).padStart(4, "0"));
  mkdirSync(output, { recursive: true });
  const actor = experiment.models.find(model => model.id === trial.model);
  const actorPath = safeID(trial.id) ? `trials/${trial.id}` : null;
  const trialDirectory = actorPath && join(run, actorPath);
  const judgements = [];
  for (const judge of grading.judges.filter(item => !actor || item.family !== actor.family)) {
    let verdict;
    try {
      ensure(trial.version === 1, "Unsupported archived trial version.");
      ensure(actor && trialDirectory && trial.status === "completed" && trial.evidenceValid === true,
        "Complete unchanged actor evidence is unavailable; archived failures and incomplete attempts cannot be reconstructed.");
      const prompt = blindedPacket({ ...experiment, judges: grading.judges, maxJudgePacketBytes: grading.maxJudgePacketBytes }, trial, join(trialDirectory, "project"), instructions);
      writeFileSync(join(output, `judge-${judge.id}-packet.txt`), prompt);
      const response = await invoke({ judge, prompt, directory: output, trialDirectory,
        projectDirectory: join(trialDirectory, "project"), actorRunDirectory: run, timeoutSeconds: grading.judgeTimeoutSeconds });
      writeJSON(join(output, `judge-${judge.id}-response.json`), response);
      writeFileSync(join(output, `judge-${judge.id}-response.txt`), response.output || "");
      ensure(response.completed, response.error || "The judge did not complete.");
      verdict = parseJudgement(response.output, judge);
    } catch (error) {
      verdict = { judgeId: judge.id, model: judge.model, family: judge.family, status: "unavailable", reason: error.message };
    }
    writeJSON(join(output, `judge-${judge.id}.json`), verdict);
    judgements.push(verdict);
  }
  const artifactPath = `trials/${String(index + 1).padStart(4, "0")}/grade.json`;
  writeJSON(join(directory, artifactPath), { version: 1, gradingDigest: grading.digest, actorExperimentDigest: experiment.digest,
    actorTrialId: trial.id, actorResult: actorPath ? `../../${actorPath}/result.json` : null,
    actorResultDigest: actorPath && existsSync(join(trialDirectory, "result.json")) ? digest(readFileSync(join(trialDirectory, "result.json"))) : null,
    status: trial.status, evidenceValid: trial.evidenceValid, judgements });
  // This is an in-memory overlay, never an actor result or a new execution.
  const { judgementsDigest, judgementHashes, ...original } = trial;
  return { ...original, judgements, artifactPath };
}

async function regradeLocked(run, options, dependencies) {
  const experiment = loadExperiment(run, { allowRunnerChanges: true });
  ensure(experiment.version === 1, "Unsupported archived experiment version.");
  if (existsSync(join(run, "runtime-lock.json"))) ensure(readJSON(join(run, "runtime-lock.json")).version === 1, "Unsupported archived runtime version.");
  const config = validateConfig({ ...readJSON(options.config || defaultConfig), models: experiment.models });
  ensure(config.concurrency <= 8 && config.judgeTimeoutSeconds <= 1800, "Invalid grading concurrency or deadline.");
  const actorFiles = actorEvidence(run), sourceFiles = graderSources();
  const trials = orderedTrials(run, dependencies.readTrials(run, { allowArchived: true }));
  const instructions = readFileSync(rubricPath, "utf8");
  const id = `grade-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(run, "grades", id);
  mkdirSync(join(run, "grades"), { recursive: true });
  mkdirSync(directory);
  for (const path of Object.keys(sourceFiles)) {
    const destination = join(directory, "inputs/grader", path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination);
  }
  writeFileSync(join(directory, "inputs/rubric.md"), instructions);
  writeJSON(join(directory, "actor-evidence.json"), actorFiles);
  const grading = { version: 1, kind: "archive-regrade", id, createdAt: new Date().toISOString(),
    actorRunId: experiment.id, actorExperimentDigest: experiment.digest, actorDirectory: "../..",
    actorEvidenceDigest: digest(actorFiles), judges: config.judges, judgeTimeoutSeconds: config.judgeTimeoutSeconds,
    maxJudgePacketBytes: config.maxJudgePacketBytes ?? 300000,
    concurrency: config.concurrency, sourceDigest: digest(sourceFiles), rubricDigest: digest(instructions),
    sources: "inputs/grader", rubric: "inputs/rubric.md", caseReferences: "../../inputs/corpus" };
  grading.digest = digest(grading);
  writeJSON(join(directory, "grading.json"), grading);
  const overlays = new Array(trials.length);
  await concurrent(trials.map((trial, index) => ({ trial, index })), grading.concurrency, async ({ trial, index }) => {
    overlays[index] = await gradeTrial({ run, directory, experiment, grading, instructions, trial, index, invoke: dependencies.invokeJudge });
  });
  ensure(digest(actorEvidence(run)) === grading.actorEvidenceDigest, "Actor evidence changed during regrading; this revision is unsealed.");
  ensure(digest(graderSources()) === grading.sourceDigest && digest(inventory(join(directory, "inputs/grader"))) === grading.sourceDigest
    && digest(readFileSync(rubricPath)) === grading.rubricDigest, "Grader sources changed during regrading; this revision is unsealed.");
  const report = buildReport(experiment, overlays, { grading });
  writeJSON(join(directory, "report.json"), report);
  writeFileSync(join(directory, "report.md"), renderReport(report));
  const manifest = { version: 1, kind: "archive-regrade", gradingDigest: grading.digest,
    reportDigest: digest(report), files: gradeFiles(directory) };
  manifest.digest = digest(manifest);
  writeJSON(join(directory, "manifest.json"), manifest);
  return { directory, report };
}

/** Each invocation creates a revision. Only the judge transport performs inference. */
export async function regrade(directory, options = {}, dependencies = {}) {
  const run = resolve(directory), release = acquireLocks(run);
  try { return await regradeLocked(run, options, { readTrials, invokeJudge, ...dependencies }); }
  finally { release(); }
}

/** Read sealed output without importing old code or recompiling with today's grader. */
export function loadGrading(directory) {
  const grade = resolve(directory);
  const manifest = checkedDigest(readJSON(join(grade, "manifest.json")), "Grading manifest");
  ensure(manifest.version === 1 && manifest.kind === "archive-regrade", "Unsupported grading manifest.");
  ensure(digest(gradeFiles(grade)) === digest(manifest.files), "Sealed grading artifacts changed or are missing.");
  const grading = checkedDigest(readJSON(join(grade, "grading.json")), "Grading context");
  ensure(grading.version === 1 && grading.kind === "archive-regrade" && grading.actorDirectory === "../.."
    && grading.digest === manifest.gradingDigest, "Unsupported or mismatched grading context.");
  const run = resolve(grade, grading.actorDirectory), experiment = loadExperiment(run, { allowRunnerChanges: true });
  ensure(experiment.id === grading.actorRunId && experiment.digest === grading.actorExperimentDigest, "Original actor identity changed.");
  ensure(digest(readJSON(join(grade, "actor-evidence.json"))) === grading.actorEvidenceDigest
    && digest(actorEvidence(run)) === grading.actorEvidenceDigest, "Original actor evidence changed or is missing.");
  ensure(digest(inventory(join(grade, "inputs/grader"))) === grading.sourceDigest
    && digest(readFileSync(join(grade, "inputs/rubric.md"))) === grading.rubricDigest, "Frozen grader or rubric changed.");
  const report = readJSON(join(grade, "report.json"));
  ensure(digest(report) === manifest.reportDigest && report.id === grading.id && digest(report.grading) === digest(grading)
    && report.experiment.digest === experiment.digest, "Saved report does not match the grading revision.");
  return { report, markdown: readFileSync(join(grade, "report.md"), "utf8"), experiment, grading };
}
