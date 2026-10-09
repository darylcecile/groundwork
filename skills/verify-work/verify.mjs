#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { catalogue, catalogueIssues, loadConfig, selectChecks } from "../../lib/config.mjs";
import { installSkills, updatePackage } from "../../lib/distribution.mjs";
import { assess, ensure, exitCode, object, readJSON, refreshEvidence, text, validateAssessment,
  validateCheck, validatePlan, withInvariants, writeJSON } from "../../lib/model.mjs";
import { changedFiles, pendingCheck, runChecks, source } from "../../lib/runner.mjs";

const skillDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(skillDirectory, "../..");
const globalInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Follow its workflow in normal chat, using the project's `VERIFY.md` and `verify.json` when present. Set up project verification files when I ask to adopt the framework.\n";
const projectInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Read `VERIFY.md` for this project's behaviour guide and use `verify.json` for repeatable checks.\n";
const help = `groundwork — checks and evidence

  groundwork install              Register all bundled skills and shared instructions
  groundwork update               Update the package and register its bundled skills
  groundwork init [directory]     Set up a project without replacing existing files
  groundwork verify [name ...]    Run checks and active project invariants
    --plan <file>                  Verify every requirement in a saved task plan
    --changed <ref>                Select checks for changed areas since a Git ref
    --base <ref>                   Compare source-aware drivers with a baseline
  groundwork view report          Show results, coverage, measurements, and evidence
  groundwork view guide [query]   Find behaviours, invariants, and their checks

Exit codes: 0 passed, 1 failed, 2 inconclusive or invalid setup.
`;

function appendOnce(path, marker, content) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (previous.includes(marker)) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${content}`);
  console.log(`Updated ${path}`);
}

function install() {
  const home = homedir();
  const skills = installSkills(packageRoot);
  for (const path of [
    join(process.env.COPILOT_HOME || join(home, ".copilot"), "copilot-instructions.md"),
    join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "AGENTS.md"),
  ]) {
    appendOnce(path, globalInstruction, globalInstruction);
  }
  console.log(`Groundwork skills installed: ${skills.join(", ")}. Start a new Copilot session and reload OpenCode's configuration.`);
}

function init(directory) {
  const root = resolve(directory || process.cwd());
  ensure(existsSync(root) && statSync(root).isDirectory(), `Project directory does not exist: ${root}`);
  for (const [name, content] of [
    ["verify.json", `${JSON.stringify({ checks: {} }, null, 2)}\n`],
    ["VERIFY.md", readFileSync(join(skillDirectory, "project.md"), "utf8")],
  ]) {
    const path = join(root, name);
    if (existsSync(path)) continue;
    writeFileSync(path, content, { flag: "wx" });
    console.log(`Created ${path}`);
  }
  appendOnce(join(root, "AGENTS.md"), projectInstruction, projectInstruction);
  const ignorePath = join(root, ".gitignore");
  const ignored = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split(/\r?\n/) : [];
  if (!ignored.includes("/.verify/")) appendOnce(ignorePath, "\n/.verify/\n", "/.verify/\n");
  console.log("Fill VERIFY.md and verify.json from the project. Start with one real journey.");
}

function projectRoot() {
  let directory = process.cwd();
  while (true) {
    if (existsSync(join(directory, "verify.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) break;
    directory = parent;
  }
  throw new Error("No verify.json found. Adopt the project with groundwork init first.");
}

function validateReport(value, id) {
  ensure(object(value) && [1, 2].includes(value.version) && value.id === id && text(value.startedAt) &&
    (value.finishedAt === null || text(value.finishedAt)) && object(value.source) &&
    (value.source.revision === null || text(value.source.revision)) &&
    /^[a-f0-9]{64}$/.test(value.source.fingerprint) && typeof value.source.dirty === "boolean" &&
    Array.isArray(value.omitted) && value.omitted.every(text) && Array.isArray(value.checks) &&
    value.checks.length > 0, "Invalid saved verification report.");
  for (const check of value.checks) validateCheck(check);
  if (value.version === 2) validateAssessment(value);
  return value;
}

function report(root) {
  const id = readFileSync(join(root, ".verify", "latest"), "utf8").trim();
  ensure(/^[a-zA-Z0-9_-]+$/.test(id), "Invalid latest run identifier.");
  const directory = join(root, ".verify", "runs", id);
  const result = validateReport(readJSON(join(directory, "result.json")), id);
  const issues = [...(result.problems || [])];
  if (!result.finishedAt) issues.push("The latest run did not finish.");
  if (source(root).fingerprint !== result.source.fingerprint) issues.push("Source changed since this run; verify the affected behaviour again.");
  const retained = refreshEvidence(directory, result.checks, result.observations || []);
  issues.push(...retained.problems);
  const evaluated = assess({ plan: result.plan || null, ...retained, problems: issues, context: result.context || {} });
  const { status } = evaluated;
  console.log(`\n${status.toUpperCase()} — checks from ${result.startedAt}`);
  console.log(`Source: ${result.source.revision?.slice(0, 12) || "no commit yet"}${result.source.dirty ? " + local changes" : ""} · ${result.source.fingerprint.slice(0, 12)}`);
  for (const check of evaluated.checks) {
    console.log(`  ${check.status.toUpperCase()} ${check.name}: ${check.expect}`);
    if (check.reason) console.log(`    ${check.reason}`);
    console.log(`    Log: ${relative(root, join(directory, check.log))}`);
    for (const artifact of check.artifacts) console.log(`    Evidence: ${relative(root, join(directory, artifact.path))}`);
    if (check.trials?.length > 1) console.log(`    Trials: ${check.trials.filter(trial => trial.status === "passed").length}/${check.trials.length} passed`);
    if (check.comparison) console.log(`    Comparison: ${check.comparison.status} — ${check.comparison.reason}`);
    for (const metric of check.comparison?.measurements || []) {
      if (metric.baseline !== undefined) console.log(`    ${metric.name}: ${metric.baseline} → ${metric.candidate} ${metric.unit} (${metric.regressionPercent.toFixed(2)}% regression)`);
    }
  }
  if (result.plan) {
    console.log(`Goal: ${result.plan.goal}`);
    for (const item of evaluated.coverage) console.log(`  ${item.status.toUpperCase()} ${item.id}: ${item.expect}${item.reason ? ` — ${item.reason}` : ""}`);
  }
  if (result.context && Object.keys(result.context).length) console.log(`Context: ${JSON.stringify(result.context)}`);
  for (const issue of issues) console.log(`  ${issue}`);
  if (result.selection?.unmappedPaths?.length) console.log(`Unmapped changed paths: ${result.selection.unmappedPaths.join(", ")}`);
  if (result.selection?.uncoveredBehaviours?.length) console.log(`Behaviours without mapped checks: ${result.selection.uncoveredBehaviours.join(", ")}`);
  if (result.omitted.length) console.log(`Not selected: ${result.omitted.join(", ")}`);
  console.log(`Report: ${relative(root, join(directory, "result.json"))}`);
  return exitCode(status);
}

function options(args) {
  const value = { names: [], plan: null, changed: null, base: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--plan", "--changed", "--base"].includes(arg)) {
      const key = arg.slice(2);
      ensure(!value[key] && text(args[index + 1]) && !args[index + 1].startsWith("--"), `${arg} needs one value.`);
      value[key] = args[++index];
    } else {
      ensure(!arg.startsWith("--"), `Unknown option: ${arg}`);
      value.names.push(arg);
    }
  }
  return value;
}

function guide(root, query) {
  const config = loadConfig(root);
  const entries = catalogue(config, query);
  for (const item of entries) {
    console.log(`${item.id} (${item.type}) — ${item.description}`);
    if (item.entry) console.log(`  Entry: ${item.entry}`);
    if (item.guide) console.log(`  Guide: ${item.guide}`);
    console.log(`  Paths: ${item.paths.join(", ") || "all"}\n  Checks: ${item.checks.join(", ") || "not mapped yet"}`);
  }
  if (!entries.length) console.log("No matching catalogue entries. Add behaviours and invariants incrementally in verify.json.");
  const issues = catalogueIssues(config, root, entries.map(item => item.id));
  for (const issue of issues) console.log(`  ${issue}`);
  return issues.length ? 2 : 0;
}

async function run(root, args) {
  const requested = options(args);
  const config = loadConfig(root);
  const changes = requested.changed ? changedFiles(root, requested.changed) : null;
  const selection = selectChecks(config, { names: requested.names, changedPaths: changes });
  ensure(selection.names.length > 0, "No checks selected. Add a real check to verify.json or choose a mapped behaviour.");
  const task = requested.plan ? validatePlan(readJSON(resolve(requested.plan))) : null;
  const plan = withInvariants(task, config, selection.invariants);
  const ids = [...new Set([...selection.names.flatMap(name => config.checks[name].covers), ...selection.invariants])];
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const result = {
    version: 2, id, startedAt: new Date().toISOString(), finishedAt: null, source: source(root),
    selection, omitted: selection.omitted,
    ...assess({ plan, checks: selection.names.map(name => pendingCheck(name, config.checks[name])), problems: catalogueIssues(config, root, ids),
      context: { ...config.context, runnerPlatform: process.platform, runnerArchitecture: process.arch } }),
  };
  const directory = join(root, ".verify", "runs", id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "result.json");
  const save = () => {
    Object.assign(result, assess(result));
    if (!result.finishedAt && result.status === "passed") result.status = "inconclusive";
    writeJSON(path, result);
  };
  save();
  writeFileSync(join(root, ".verify", "latest"), `${id}\n`);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const execution = await runChecks({ root, directory, checks: config.checks, names: selection.names, plan,
      base: requested.base, context: result.context, signal: controller.signal,
      onUpdate(checks, observations) { result.checks = checks; result.observations = observations; save(); } });
    result.checks = execution.checks;
    result.observations = execution.observations;
    result.problems.push(...execution.problems);
    if (!controller.signal.aborted) result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.problems.push(error.message);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    save();
  }
  return report(root);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
  } else if (command === "install" && args.length === 0) {
    install();
  } else if (command === "update" && args.length === 0) {
    updatePackage(packageRoot);
  } else if (command === "init" && args.length <= 1) {
    init(args[0]);
  } else if (command === "verify") {
    process.exitCode = await run(projectRoot(), args);
  } else if (command === "view" && args.length === 1 && args[0] === "report") {
    process.exitCode = report(projectRoot());
  } else if (command === "view" && args[0] === "guide") {
    process.exitCode = guide(projectRoot(), args.slice(1).join(" "));
  } else {
    throw new Error(`Unknown command or arguments.\n${help}`);
  }
} catch (error) {
  console.error(`INCONCLUSIVE — ${error.message}`);
  process.exitCode = 2;
}
