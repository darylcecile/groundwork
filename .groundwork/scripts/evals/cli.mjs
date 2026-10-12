import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { suite, materializeCase, checkCase, applyReference } from "../../evals/corpus.mjs";
import { defaultConfig, root, validateSuite, validateConfig, prepare, loadExperiment } from "./experiment.mjs";
import { readJSON, writeJSON, ensure, digest, checkInventory } from "./util.mjs";
import { buildReport, renderReport, calibrationReport } from "./report.mjs";
import { runExperiment, readTrials, invokeJudge, preflight } from "./runtime.mjs";
import { judgeExperiment } from "./judge.mjs";
import { publishReport } from "./anana.mjs";
import { judgeControls } from "./controls.mjs";
import { regrade, loadGrading } from "./regrade.mjs";

const help = `Groundwork skills benchmark

  bun run eval validate
  bun run eval prepare [--tier smoke|full] [--split development|holdout]
    [--activation natural|explicit] [--models gpt,claude,grok] [--attempts N]
    [--case ID] [--current-ref REF] [--candidate-ref REF|worktree] [--cli-ref REF]
    [--config FILE] [--output DIRECTORY] [--seed VALUE]
  bun run eval preflight [--config FILE]
  bun run eval run DIRECTORY
  bun run eval judge DIRECTORY
  bun run eval regrade DIRECTORY [--config FILE]
  bun run eval report DIRECTORY
  bun run eval publish DIRECTORY [--database-id ID] [--evidence-url URL]
  bun run eval controls
  bun run eval judge-controls [--case ID]
  bun run eval calibrate LABELS_JSON JUDGEMENTS_JSON

prepare freezes the experiment without model calls. run and judge use paid models.
regrade judges saved attempts with current grading; it makes no actor executions.
report and publish also accept a sealed grades/<id> directory.
Natural invocation compares no skills with released skills and an optional candidate.
Explicit invocation measures loaded skills; its experiment excludes the no-skill arm.
Runs retain their complete schedule; resume runs only attempts not previously started.
publish reads ANANA_TOKEN or ANANA_TOKEN_FILE. Credentials never enter trial environments.
Exit 0: command completed; 1: grading controls failed; 2: invalid or incomplete result.
`;

function options(args, allowed) {
  const result = {};
  const names = { "tier": "tier", "split": "split", "activation": "activation", "models": "models", "attempts": "attempts",
    "case": "caseIds", "current-ref": "currentRef", "candidate-ref": "candidateRef", "cli-ref": "cliRef",
    "config": "config", "output": "output", "seed": "seed", "database-id": "databaseId", "evidence-url": "evidenceUrl" };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    ensure(args[index]?.startsWith("--") && names[key] && args[index + 1] && !args[index + 1].startsWith("--"), `Invalid option: ${args[index]}`);
    ensure(allowed.includes(key), `Option is not supported for this command: ${args[index]}`);
    ensure(!(names[key] in result), `Repeated option: ${args[index]}`);
    const value = args[index + 1];
    result[names[key]] = key === "attempts" ? Number(value) : ["models", "case"].includes(key) ? value.split(",") : value;
  }
  return result;
}

function report(directory) {
  const experiment = loadExperiment(directory);
  const trials = readTrials(directory).map(trial => {
    if (trial.judgements?.length && (digest(trial.judgements) !== trial.judgementsDigest ||
      !trial.judgementHashes || !checkInventory(join(directory, "trials", trial.id), trial.judgementHashes))) {
      return { ...trial, evidenceValid: false, evidenceProblem: "Saved judge evidence changed or is missing." };
    }
    return trial;
  });
  const result = buildReport(experiment, trials);
  writeJSON(join(directory, "report.json"), result);
  writeFileSync(join(directory, "report.md"), renderReport(result));
  return result;
}

async function controls() {
  const parent = join(root, ".groundwork/tmp");
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, "controls-"));
  const results = [];
  try {
    for (const item of suite.cases) {
      const directory = join(temporary, item.id);
      mkdirSync(directory, { recursive: true });
      materializeCase(item.id, directory);
      const original = await checkCase(item.id, directory, {});
      const answer = await applyReference(item.id, directory);
      const corrected = await checkCase(item.id, directory, { answer });
      results.push({ id: item.id, original, corrected });
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const output = join(root, ".groundwork/runs", `eval-controls-${Date.now()}`);
  const result = { version: 1, suite: suite.id, createdAt: new Date().toISOString(), source: "authored reference controls; no model execution", results };
  writeJSON(join(output, "result.json"), result);
  console.log(output);
  const correctedPass = results.every(item => item.corrected.success === true);
  const detectedFault = results.some(item => item.original.success === false);
  console.log(`${results.filter(item => item.corrected.success === true).length}/${results.length} reference solutions pass; ${results.filter(item => item.original.success === false).length} original defects detected.`);
  return correctedPass && detectedFault ? 0 : 1;
}

export async function main(args) {
  const [command, ...rest] = args;
  if (!command || ["help", "--help", "-h"].includes(command)) { console.log(help); return 0; }
  if (command === "validate") {
    const settings = options(rest, ["config"]);
    validateConfig(readJSON(settings.config || defaultConfig));
    console.log(JSON.stringify(validateSuite(), null, 2));
    return 0;
  }
  if (command === "prepare") {
    const result = prepare(options(rest, ["tier", "split", "activation", "models", "attempts", "case", "current-ref", "candidate-ref", "cli-ref", "config", "output", "seed"]));
    console.log(JSON.stringify({ directory: result.directory, id: result.experiment.id, trials: result.trials,
      models: result.experiment.models.map(item => item.model), conditions: result.experiment.conditions.map(item => item.id),
      split: result.experiment.split, activation: result.experiment.activation }, null, 2));
    return 0;
  }
  if (command === "preflight") {
    const settings = options(rest, ["config"]);
    console.log(JSON.stringify(await preflight(validateConfig(readJSON(settings.config || defaultConfig))), null, 2));
    return 0;
  }
  if (command === "controls") { ensure(!rest.length, "controls takes no arguments."); return controls(); }
  if (command === "judge-controls") {
    const settings = options(rest, ["case"]);
    const result = await judgeControls(invokeJudge, settings);
    console.log(JSON.stringify({ directory: result.directory, source: result.source, caseIds: result.caseIds, summary: result.summary }, null, 2));
    return result.summary.every(item => item.status === "complete" && item.agreement === 1) ? 0 : 2;
  }
  if (command === "calibrate") {
    ensure(rest.length === 2, "Supply human labels and judge decisions as JSON files.");
    console.log(JSON.stringify(calibrationReport(readJSON(rest[0]), readJSON(rest[1])), null, 2));
    return 0;
  }
  ensure(["run", "judge", "regrade", "report", "publish"].includes(command) && rest[0] && !rest[0].startsWith("--"), "Supply a benchmark command and run directory. Use --help.");
  const directory = resolve(rest[0]);
  const settings = options(rest.slice(1), command === "publish" ? ["database-id", "evidence-url"] : command === "regrade" ? ["config"] : []);
  if (command === "regrade") {
    const { directory: gradeDirectory, report: result } = await regrade(directory, settings);
    console.log(JSON.stringify({ directory: gradeDirectory, id: result.id, actorRunId: result.grading.actorRunId,
      status: result.status, report: join(gradeDirectory, "report.md") }, null, 2));
    return result.status === "complete" ? 0 : 2;
  }
  if (command === "run") await runExperiment(directory);
  if (command === "judge") await judgeExperiment(directory, { readTrials, invokeJudge });
  const saved = ["report", "publish"].includes(command) && (existsSync(join(directory, "grading.json")) || existsSync(join(directory, "manifest.json")))
    ? loadGrading(directory) : null;
  const result = saved?.report || report(directory);
  const markdown = saved?.markdown ?? renderReport(result);
  if (command === "publish") {
    const experiment = saved?.experiment || loadExperiment(directory);
    const token = process.env.ANANA_TOKEN || (process.env.ANANA_TOKEN_FILE && readFileSync(process.env.ANANA_TOKEN_FILE, "utf8").trim());
    ensure(token, "Set ANANA_TOKEN or ANANA_TOKEN_FILE to publish to Anana.");
    const publication = await publishReport({ ...experiment.anana, ...settings, token, report: result,
      markdown, receiptPath: join(root, ".groundwork/runs/anana", `${result.id}.json`) });
    writeJSON(join(directory, "anana.json"), publication);
    console.log(JSON.stringify(publication, null, 2));
    return 0;
  }
  if (command === "run") {
    const trials = readTrials(directory);
    console.log(JSON.stringify({ stage: "execution", completed: result.groups.reduce((sum, group) => sum + group.completed, 0),
      expected: result.groups.reduce((sum, group) => sum + group.attempts, 0), next: "judge",
      problems: trials.filter(trial => trial.status !== "completed" || !trial.evidenceValid).map(trial =>
        ({ id: trial.id, status: trial.status, error: trial.error, traceGaps: trial.traceGaps, checks: trial.checks })),
      evidence: directory }, null, 2));
    return result.groups.every(group => group.completed === group.attempts) ? 0 : 2;
  }
  if (command === "judge") {
    console.log(JSON.stringify({ status: result.status, groups: result.groups.map(group =>
      ({ model: group.model, condition: group.condition, passed: group.passed, attempts: group.attempts, quality: group.qualityScore })),
      problems: result.problems, report: join(directory, "report.md") }, null, 2));
    return result.status === "complete" ? 0 : 2;
  }
  console.log(markdown);
  console.log(`Evidence: ${directory}`);
  return result.status === "complete" ? 0 : 2;
}
