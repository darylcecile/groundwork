import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suite, materializeCase } from "../../evals/corpus.mjs";
import { ensure, digest, inventory, readJSON, writeJSON, shuffled } from "./util.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const defaultConfig = join(root, ".groundwork/config/evals.json");
const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function runnerInventory() {
  const hashes = inventory(join(root, ".groundwork/scripts/evals"));
  return Object.fromEntries(Object.entries(hashes).filter(([path]) => !path.split("/").includes("__pycache__")));
}

export function validateConfig(config) {
  ensure(config.version === 1 && config.suite === suite.id, "Unsupported benchmark configuration or suite.");
  ensure(typeof config.seed === "string" && config.seed.length > 0, "Pin a nonempty experiment seed.");
  ensure([config.currentRef, config.cliRef].every(ref => typeof ref === "string" && ref.length > 0 && !ref.startsWith("-")),
    "Pin both currentRef and cliRef to Git revisions.");
  for (const key of ["attempts", "concurrency", "timeoutSeconds", "judgeTimeoutSeconds", "maxTrials"]) {
    ensure(positive(config[key]), `Invalid benchmark limit: ${key}`);
  }
  ensure(positive(config.maxJudgePacketBytes ?? 300000) && (config.maxJudgePacketBytes ?? 300000) <= 2000000,
    "maxJudgePacketBytes must be a positive integer no greater than 2000000.");
  for (const role of ["models", "judges"]) {
    ensure(Array.isArray(config[role]) && config[role].length > 0, `Configure benchmark ${role}.`);
    const ids = new Set();
    for (const model of config[role]) {
      ensure(identifier(model.id) && !ids.has(model.id), `Invalid or duplicate ${role} ID.`);
      ids.add(model.id);
      ensure(["copilot-cli", "opencode"].includes(model.runtime), `Unsupported runtime: ${model.runtime}`);
      ensure([model.model, model.family, model.version, model.effort].every(value => typeof value === "string" && value.length > 0), `Pin the model, family, runtime version and effort for ${model.id}.`);
      const name = model.model.split("/").at(-1).toLowerCase();
      const knownFamily = [["gpt-", "openai"], ["claude-", "anthropic"], ["grok-", "xai"], ["gemini-", "google"]].find(([prefix]) => name.startsWith(prefix))?.[1];
      ensure(!knownFamily || knownFamily === model.family, `Model family does not match ${model.model}.`);
    }
  }
  for (const actor of config.models) {
    const others = config.judges.filter(judge => judge.family !== actor.family);
    ensure(new Set(others.map(judge => judge.family)).size >= 2, `${actor.id} needs judges from two other model families.`);
  }
  return config;
}

export function validateSuite(value = suite) {
  const ids = new Set();
  const families = new Map();
  ensure(value.version === 1 && value.cases.length > 0, "The benchmark suite is empty or unsupported.");
  for (const item of value.cases) {
    ensure(identifier(item.id) && !ids.has(item.id), `Invalid or duplicate case: ${item.id}`);
    ids.add(item.id);
    ensure(["development", "holdout"].includes(item.split), `Invalid split for ${item.id}`);
    ensure(["natural", "explicit"].includes(item.activation), `Invalid activation mode for ${item.id}`);
    ensure(typeof item.shouldActivate === "boolean", `Missing activation expectation: ${item.id}`);
    ensure(typeof item.prompt === "string" && item.prompt.trim(), `Missing task prompt: ${item.id}`);
    ensure(!/\b(benchmark|candidate|rubric|experiment)\b/i.test(item.prompt), `Experiment metadata in task prompt: ${item.id}`);
    ensure(Array.isArray(item.rubric) && item.rubric.length > 0 && item.reference, `Missing grading reference: ${item.id}`);
    ensure(!families.has(item.family) || families.get(item.family) === item.split, `Problem family crosses development/holdout splits: ${item.family}`);
    families.set(item.family, item.split);
  }
  return { suite: value.id, cases: value.cases.length, families: families.size };
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

function snapshot(ref, destination) {
  mkdirSync(destination, { recursive: true });
  if (ref === "worktree") {
    for (const path of ["lib", "skills", "package.json"]) cpSync(join(root, path), join(destination, path), { recursive: true });
  } else {
    ensure(typeof ref === "string" && ref.length > 0 && !ref.startsWith("-"), "Supply a Git skill revision.");
    const revision = git("rev-parse", "--verify", `${ref}^{commit}`);
    for (const path of git("ls-tree", "-r", "--name-only", revision, "--", "lib", "skills", "package.json").split("\n")) {
      if (!path) continue;
      mkdirSync(dirname(join(destination, path)), { recursive: true });
      writeFileSync(join(destination, path), execFileSync("git", ["show", `${revision}:${path}`], { cwd: root }));
    }
    ref = revision;
  }
  ensure(existsSync(join(destination, "skills/verify-work/verify.mjs")), "Snapshot is not a complete Groundwork package.");
  const hashes = inventory(destination);
  return { revision: ref, digest: digest(hashes), files: hashes };
}

function selectCases({ split = "development", tier = "smoke", activation = "natural", caseIds } = {}) {
  ensure(["development", "holdout"].includes(split), "Select exactly one split: development or holdout.");
  ensure(["smoke", "full"].includes(tier), "Select smoke or full tier.");
  ensure(["natural", "explicit"].includes(activation), "Select natural or explicit activation.");
  if (caseIds) ensure(caseIds.every(id => suite.cases.some(item => item.id === id)), "Unknown benchmark case.");
  const cases = suite.cases.filter(item => item.split === split && item.activation === activation &&
    (caseIds ? caseIds.includes(item.id) : tier === "full" || item.smoke));
  ensure(cases.length > 0, "No cases match this split, tier and activation mode.");
  return cases;
}

export function prepare(options = {}) {
  validateSuite();
  const config = validateConfig(readJSON(options.config || defaultConfig));
  const cases = selectCases(options);
  const models = config.models.filter(model => !options.models || options.models.includes(model.id));
  ensure(models.length > 0 && (!options.models || models.length === options.models.length), "Unknown or duplicate selected model.");
  const attempts = options.attempts ?? config.attempts;
  ensure(positive(attempts), "Attempts must be a positive integer.");
  const conditionIds = options.activation === "explicit" ? ["current"] : ["none", "current"];
  if (options.candidateRef) conditionIds.push("candidate");
  const count = cases.length * models.length * conditionIds.length * attempts;
  ensure(count <= config.maxTrials, `Requested ${count} trials exceeds configured maxTrials=${config.maxTrials}.`);
  const id = `eval-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(options.output || join(root, ".groundwork/runs", id));
  ensure(!existsSync(directory), "Preparation requires a new output directory.");
  mkdirSync(directory, { recursive: true });
  const cli = snapshot(options.cliRef || config.cliRef, join(directory, "inputs/cli"));
  const conditions = conditionIds.map(name => name === "none" ? { id: name, revision: null, digest: digest("no-groundwork-instructions") } :
    { id: name, ...snapshot(name === "candidate" ? options.candidateRef : options.currentRef || config.currentRef, join(directory, "inputs", name)) });
  cpSync(join(root, ".groundwork/evals"), join(directory, "inputs/corpus"), { recursive: true });
  const runnerFiles = runnerInventory();
  for (const path of Object.keys(runnerFiles)) {
    const destination = join(directory, "inputs/runner", path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, ".groundwork/scripts/evals", path), destination);
  }
  const fixtures = {};
  for (const item of cases) {
    const path = join(directory, "inputs/projects", item.id);
    mkdirSync(path, { recursive: true });
    materializeCase(item.id, path);
    fixtures[item.id] = inventory(path);
  }
  const experiment = {
    version: 1, id, createdAt: new Date().toISOString(), suite: suite.id, split: options.split || "development",
    tier: options.tier || "smoke", activation: options.activation || "natural", seed: options.seed || config.seed,
    attempts, models, judges: config.judges, conditions, caseIds: cases.map(item => item.id), cases,
    cli, fixtures, corpusDigest: digest(inventory(join(directory, "inputs/corpus"))),
    runnerDigest: digest(runnerFiles), runnerFiles,
    configDigest: digest(config), concurrency: config.concurrency, timeoutSeconds: config.timeoutSeconds,
    judgeTimeoutSeconds: config.judgeTimeoutSeconds, maxJudgePacketBytes: config.maxJudgePacketBytes ?? 300000, anana: config.anana || {},
  };
  const tasks = [];
  for (const item of cases) for (const model of models) for (const condition of conditions) for (let attempt = 1; attempt <= attempts; attempt++) {
    tasks.push({ id: randomUUID(), caseId: item.id, model: model.id, condition: condition.id, attempt });
  }
  const schedule = shuffled(tasks, experiment.seed);
  experiment.scheduleDigest = digest(schedule);
  experiment.digest = digest(experiment);
  writeJSON(join(directory, "experiment.json"), experiment);
  writeJSON(join(directory, "schedule.json"), schedule);
  return { directory, experiment, trials: count };
}

export function loadExperiment(directory, { allowRunnerChanges = false } = {}) {
  const experiment = readJSON(join(directory, "experiment.json"));
  const { digest: expected, ...contents } = experiment;
  ensure(digest(contents) === expected, "The frozen experiment changed. Prepare a new experiment.");
  ensure(digest(readJSON(join(directory, "schedule.json"))) === experiment.scheduleDigest, "The frozen trial schedule changed.");
  ensure(digest(inventory(join(directory, "inputs/corpus"))) === experiment.corpusDigest, "Frozen corpus or rubric changed. Prepare a new experiment.");
  ensure(digest(inventory(join(directory, "inputs/runner"))) === experiment.runnerDigest, "Frozen benchmark runner inputs changed.");
  ensure(allowRunnerChanges || digest(runnerInventory()) === experiment.runnerDigest,
    "Benchmark execution or grading code changed. Prepare a new experiment; this run's saved report and runner snapshot remain available for inspection.");
  return experiment;
}
