import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { catalogue, catalogueIssues, hasConfig, loadConfig, parseConfig, selectChecks } from "../../lib/config.mjs";
import { groundworkPath } from "../../lib/layout.mjs";
import { assess, ensure, readJSON, refreshEvidence, safePath, validatePlan, withInvariants, within, writeJSON } from "../../lib/model.mjs";
import { changedFiles, executeCommand, git, runChecks, source } from "../../lib/runner.mjs";
import { prepareEvidenceStore } from "../../lib/store.mjs";
import { inspectAgent, verdict, verificationFrontier } from "./report.mjs";

const repository = resolve(process.env.PR_VERIFY_REPOSITORY || process.cwd());
const projectDirectory = resolve(repository, process.env.PR_VERIFY_DIRECTORY || ".");
const id = `pr-${randomUUID()}`;
let output;
let initialized = false;
const pending = log => ({ status: "inconclusive", exitCode: null, durationMs: 0, log });
const result = {
  version: 2, id, startedAt: new Date().toISOString(), finishedAt: null,
  repository: process.env.GITHUB_REPOSITORY || "", pullRequest: 0, headSha: "unknown", testedSha: null,
  planning: pending("planning.log"), verification: assess({ problems: ["A verification plan is not available."] }),
  status: "inconclusive", setup: pending("setup.log"), checks: pending("checks.log"),
  agent: { execution: pending("agent.log"), summary: "Behaviour verification has not completed.", checks: [], gaps: [] },
  problems: [],
};

function save() {
  result.status = verdict(result);
  writeJSON(join(output, "result.json"), result);
  const compact = { ...result, verification: { ...result.verification,
    checks: result.verification.checks.map(({ trials, baseline, observations, ...check }) => check) } };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${JSON.stringify(compact)}\n`);
}

async function agent(phase, prompt, cwd) {
  console.log(`\nStarting ${phase}`);
  return executeCommand({ command: "copilot", args: [
    "--prompt", prompt, "--silent", "--no-ask-user", "--allow-all-tools", "--allow-all-urls",
    "--add-dir", output, "--disable-builtin-mcps", "--no-auto-update",
    "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--share", join(output, `${phase}-session.md`),
  ], cwd, directory: output, log: `${phase}.log`, phase: "tool",
  env: { ...process.env, GITHUB_OUTPUT: "", PR_VERIFY_OUTPUT: output, GROUNDWORK_AGENT_PHASE: phase,
    GROUNDWORK_PLAN: join(output, "plan.json"), GROUNDWORK_EVIDENCE_DIR: join(output, "agent") } });
}

try {
  const cwd = within(repository, projectDirectory);
  const storage = prepareEvidenceStore(cwd);
  output = resolve(process.env.PR_VERIFY_OUTPUT || join(storage.runs, id));
  mkdirSync(output, { recursive: true });
  const actualOutput = realpathSync(output);
  const actualRepository = realpathSync(repository);
  const localRuns = groundworkPath(cwd, "runs");
  const outsideRepository = actualOutput !== actualRepository && !actualOutput.startsWith(`${actualRepository}${sep}`);
  ensure(outsideRepository || actualOutput.startsWith(`${localRuns}${sep}`),
    "Keep evidence in a fresh .groundwork/runs/ subdirectory or outside the repository checkout.");
  ensure(readdirSync(output).length === 0, "Use an empty evidence directory for each verification run.");
  initialized = true;
  mkdirSync(join(output, "agent"));
  save();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pull = event.pull_request;
  ensure(pull && Number.isInteger(pull.number) && typeof pull.head?.sha === "string", "Call this workflow from a pull_request event.");
  result.pullRequest = pull.number;
  result.headSha = pull.head.sha;
  ensure(pull.head.repo?.full_name === result.repository, "This version verifies PR branches within the importing repository.");
  const commands = { setup: process.env.PR_VERIFY_SETUP || "", checks: process.env.PR_VERIFY_CHECKS || "" };
  const config = hasConfig(cwd) ? loadConfig(cwd) : parseConfig({ checks: {} });
  ensure(commands.checks.trim() || Object.keys(config.checks).length, "Provide checks or configure project checks in .groundwork/verify.json.");
  const artifacts = (process.env.PR_VERIFY_ARTIFACTS || "").split(/\r?\n/).map(path => path.trim().replace(/\/+$/, "")).filter(Boolean);
  ensure(artifacts.every(safePath), "Artifact paths must name files or directories within the project; globs and parent paths are not supported.");
  const excluded = artifacts.map(path => relative(actualRepository, resolve(cwd, path)));
  result.testedSha = git(repository, ["rev-parse", "HEAD"]).toString().trim();
  const before = source(repository, excluded);
  result.source = before;
  const comparisonSha = git(repository, ["rev-parse", "HEAD^1"], true)?.toString().trim() || null;
  const changes = comparisonSha ? changedFiles(cwd, comparisonSha) : null;
  let configuredName = "configured-checks";
  while (Object.hasOwn(config.checks, configuredName)) configuredName += "-workflow";
  if (commands.checks.trim()) {
    const matching = Object.entries(config.checks).find(([, check]) => check.command === commands.checks);
    if (matching) configuredName = matching[0];
    else config.checks[configuredName] = parseConfig({ checks: {
      [configuredName]: { command: commands.checks, expect: "The configured project verification commands pass" },
    } }).checks[configuredName];
  }
  const suggested = selectChecks(config, { changedPaths: changes });
  const contextPath = join(output, "context.json");
  const context = {
    repository: result.repository, pullRequest: pull.number, title: pull.title || "", description: pull.body || "",
    headSha: pull.head.sha, testedSha: result.testedSha,
    comparisonSha, changedPaths: changes, workingDirectory: cwd, commands, artifacts,
    catalogue: catalogue(config), availableChecks: config.checks, suggested,
    environment: { ...config.context, runnerPlatform: process.platform, runnerArchitecture: process.arch },
  };
  writeJSON(contextPath, context);
  const planPath = join(output, "plan.json");
  let taskPlan = null;
  if (process.env.PR_VERIFY_PLAN) {
    ensure(safePath(process.env.PR_VERIFY_PLAN), "The plan input must be a relative file within the project.");
    taskPlan = validatePlan(readJSON(within(cwd, resolve(cwd, process.env.PR_VERIFY_PLAN))));
    writeFileSync(join(output, "planning.log"), "Using the supplied verification plan.\n");
    result.planning = { status: "passed", exitCode: 0, durationMs: 0, log: "planning.log" };
  } else if (process.env.GITHUB_ACTIONS === "true" && !process.env.COPILOT_GITHUB_TOKEN) {
    result.agent.gaps.push("COPILOT_TOKEN is unavailable. Configure a Copilot credential in the importing repository.");
  } else {
    const prompt = `${readFileSync(new URL("../prompts/plan.md", import.meta.url), "utf8")}\n\nPR context: ${contextPath}\nWrite plan: ${planPath}\n`;
    result.planning = await agent("planning", prompt, cwd);
    if (result.planning.status === "passed") {
      try { taskPlan = validatePlan(readJSON(planPath)); }
      catch (error) { result.problems.push(`The verification plan is invalid: ${error.message}`); }
    }
  }
  if (!taskPlan) result.problems.push("A complete verification plan is unavailable.");
  const selectionConfig = commands.checks.trim() ? { ...config,
    invariants: Object.fromEntries(suggested.invariants.map(id => [id, config.invariants[id]])),
  } : config;
  const selected = selectChecks(selectionConfig, {
    names: commands.checks.trim() ? [configuredName] : [],
    changedPaths: commands.checks.trim() ? null : changes, plan: taskPlan,
  });
  const selection = { ...suggested, names: selected.names, omitted: selected.omitted, reasons: selected.reasons };
  const { names } = selection;
  const plan = taskPlan ? withInvariants(taskPlan, config, selection.invariants) : null;
  if (plan) writeJSON(planPath, plan);
  const originalPlan = plan ? readFileSync(planPath, "utf8") : null;
  result.selection = selection;
  result.problems.push(...catalogueIssues(config, cwd, [...new Set([...names.flatMap(name => config.checks[name].covers), ...selection.invariants])]));
  result.verification = assess({ plan, problems: result.problems, context: context.environment });
  save();
  const commandEnv = { ...process.env, PR_VERIFY_OUTPUT: output };
  delete commandEnv.COPILOT_GITHUB_TOKEN;
  delete commandEnv.GITHUB_OUTPUT;
  result.setup = commands.setup.trim() ? await executeCommand({ command: "bash",
    args: ["--noprofile", "--norc", "-eo", "pipefail", "-c", commands.setup], cwd, env: commandEnv,
    directory: output, log: "setup.log", phase: "setup" }) : { status: "passed", exitCode: 0, durationMs: 0, log: "setup.log" };
  if (!commands.setup.trim()) writeFileSync(join(output, "setup.log"), "No setup command requested.\n");
  let configured = { checks: [], observations: [], problems: [] };
  if (result.setup.status === "passed") {
    const base = process.env.PR_VERIFY_COMPARE_BASE === "true" ? comparisonSha : null;
    if (process.env.PR_VERIFY_COMPARE_BASE === "true" && !base) result.problems.push("The baseline revision is unavailable.");
    configured = await runChecks({ root: cwd, directory: output, checks: config.checks, names, plan,
      base, context: context.environment, env: commandEnv, excluded: artifacts });
    const checked = assess({ checks: configured.checks, observations: configured.observations, problems: configured.problems });
    result.checks = { status: checked.status, exitCode: checked.status === "passed" ? 0 : checked.status === "failed" ? 1 : 2,
      durationMs: configured.checks.reduce((total, check) => total + check.durationMs, 0), log: "checks.log" };
    writeFileSync(join(output, "checks.log"), configured.checks.map(check => `${check.name}: ${check.status}\n${readFileSync(join(output, check.log), "utf8")}`).join("\n"));
  } else result.problems.push("Project setup failed; the configured checks could not run.");
  result.problems.push(...configured.problems);
  result.verification = assess({ plan, ...configured, problems: result.problems, context: context.environment });
  save();
  const frontier = verificationFrontier(result.verification);
  writeJSON(contextPath, { ...context, selection, setup: result.setup, checks: result.checks, verification: result.verification, frontier });
  if (frontier.complete) {
    const reason = "All planned requirements are verified by completed checks and evidence; no further agent verification is required.";
    result.agent.execution = { status: "passed", exitCode: 0, durationMs: 0, log: "agent.log", skipped: "complete", reason };
    result.agent.summary = reason;
    writeFileSync(join(output, "agent.log"), `${reason}\n`);
  } else if (plan && !(process.env.GITHUB_ACTIONS === "true" && !process.env.COPILOT_GITHUB_TOKEN)) {
    const prompt = `${readFileSync(new URL("../prompts/verify.md", import.meta.url), "utf8")}\n\nPR context: ${contextPath}\nFrozen verification plan: ${planPath}\nEvidence directory: ${output}\nWrite report: ${join(output, "agent.json")}\n`;
    result.agent.execution = await agent("agent", prompt, cwd);
  } else if (plan) {
    result.agent.gaps.push("COPILOT_TOKEN is unavailable. Configure a Copilot credential in the importing repository.");
  }
  for (const path of artifacts) {
    try {
      const source = within(cwd, resolve(cwd, path));
      ensure(source !== actualOutput && !actualOutput.startsWith(`${source}${sep}`) && !source.startsWith(`${actualOutput}${sep}`),
        "Artifact path overlaps the evidence directory.");
      cpSync(source, join(output, "project", path), {
        recursive: true, dereference: true,
        filter: file => { within(cwd, file); return true; },
      });
    } catch (error) {
      result.problems.push(`Could not collect ${path}: ${error.message}`);
    }
  }
  if (result.agent.execution.status === "passed" && !result.agent.execution.skipped) {
    try { Object.assign(result.agent, inspectAgent(join(output, "agent.json"), output)); }
    catch (error) { result.agent.gaps.push(`The agent report is unavailable or invalid: ${error.message}`); }
  } else if (result.agent.execution.status !== "passed" && !result.agent.gaps.length) {
    result.agent.gaps.push("The agent did not finish successfully; inspect agent.log.");
  }
  if (plan) {
    let currentPlan;
    try { currentPlan = readFileSync(planPath, "utf8"); } catch { currentPlan = null; }
    if (currentPlan !== originalPlan) {
      result.problems.push("The verification plan was changed during execution; its original requirements were retained.");
      writeJSON(planPath, plan);
    }
  }
  const after = source(repository, excluded);
  if (after.fingerprint !== before.fingerprint || after.revision !== before.revision) result.problems.push("The checked-out source changed during verification. These observations do not verify the original proposed change.");
  const retained = refreshEvidence(output, configured.checks, [...configured.observations, ...(result.agent.observations || [])]);
  result.problems.push(...retained.problems);
  result.verification = assess({ plan, ...retained,
    problems: [...result.problems, ...result.agent.gaps], context: context.environment });
  result.finishedAt = new Date().toISOString();
  save();
} catch (error) {
  result.problems.push(error.message);
  console.error(error.message);
  if (initialized) save();
}
console.log(`\nFinal verification: ${result.status}. Evidence: ${output}`);
process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
