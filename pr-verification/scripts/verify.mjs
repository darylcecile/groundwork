import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { catalogue, catalogueIssues, loadConfig, parseConfig, selectChecks } from "../../lib/config.mjs";
import { assess, ensure, readJSON, refreshEvidence, safePath, validatePlan, withInvariants, within, writeJSON } from "../../lib/model.mjs";
import { changedFiles, executeCommand, git, runChecks, source } from "../../lib/runner.mjs";
import { inspectAgent, verdict } from "./report.mjs";

const repository = resolve(process.env.PR_VERIFY_REPOSITORY || process.cwd());
const output = resolve(process.env.PR_VERIFY_OUTPUT || "../pr-verification-results");
let initialized = false;
const pending = log => ({ status: "inconclusive", exitCode: null, durationMs: 0, log });
const result = {
  version: 2, repository: process.env.GITHUB_REPOSITORY || "", pullRequest: 0, headSha: "unknown", testedSha: null,
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
  mkdirSync(output, { recursive: true });
  const actualOutput = realpathSync(output);
  const actualRepository = realpathSync(repository);
  ensure(actualOutput !== actualRepository && !actualOutput.startsWith(`${actualRepository}${sep}`), "Keep the evidence directory outside the repository checkout.");
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
  const cwd = within(repository, resolve(repository, process.env.PR_VERIFY_DIRECTORY || "."));
  const commands = { setup: process.env.PR_VERIFY_SETUP || "", checks: process.env.PR_VERIFY_CHECKS || "" };
  const config = existsSync(join(cwd, "verify.json")) ? loadConfig(cwd) : parseConfig({ checks: {} });
  ensure(commands.checks.trim() || Object.keys(config.checks).length, "Provide checks or configure project checks in verify.json.");
  const artifacts = (process.env.PR_VERIFY_ARTIFACTS || "").split(/\r?\n/).map(path => path.trim().replace(/\/+$/, "")).filter(Boolean);
  ensure(artifacts.every(safePath), "Artifact paths must name files or directories within the project; globs and parent paths are not supported.");
  const excluded = artifacts.map(path => relative(repository, resolve(cwd, path)));
  result.testedSha = git(repository, ["rev-parse", "HEAD"]).toString().trim();
  const before = source(repository, excluded);
  result.source = before;
  const comparisonSha = git(repository, ["rev-parse", "HEAD^1"], true)?.toString().trim() || null;
  const changes = comparisonSha ? changedFiles(cwd, comparisonSha) : null;
  let configuredName = "configured-checks";
  while (Object.hasOwn(config.checks, configuredName)) configuredName += "-workflow";
  if (commands.checks.trim()) config.checks[configuredName] = parseConfig({ checks: {
    [configuredName]: { command: commands.checks, expect: "The configured project verification commands pass" },
  } }).checks[configuredName];
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
  const plannedNames = taskPlan?.requirements.flatMap(item => [
    ...item.checks,
    ...Object.entries(config.checks).flatMap(([name, check]) => check.covers.some(id => item.behaviours.includes(id)) ? [name] : []),
  ]) || [];
  const unknown = plannedNames.filter(name => !Object.hasOwn(config.checks, name));
  if (unknown.length) result.problems.push(`Unknown planned checks: ${[...new Set(unknown)].join(", ")}`);
  const explicit = commands.checks.trim() ? [configuredName, ...Object.entries(config.checks).flatMap(([name, check]) => check.required ? [name] : [])] : suggested.names;
  const names = [...new Set([...explicit, ...plannedNames.filter(name => Object.hasOwn(config.checks, name)),
    ...catalogue(config).filter(row => row.type === "invariant" && suggested.invariants.includes(row.id)).flatMap(row => row.checks)])];
  const plan = taskPlan ? withInvariants(taskPlan, config, suggested.invariants) : null;
  if (plan) writeJSON(planPath, plan);
  const originalPlan = plan ? readFileSync(planPath, "utf8") : null;
  result.selection = { ...suggested, names, omitted: Object.keys(config.checks).filter(name => !names.includes(name)) };
  result.problems.push(...catalogueIssues(config, cwd, [...new Set([...names.flatMap(name => config.checks[name].covers), ...suggested.invariants])]));
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
  writeJSON(contextPath, { ...context, setup: result.setup, checks: result.checks, verification: result.verification });
  if (plan && !(process.env.GITHUB_ACTIONS === "true" && !process.env.COPILOT_GITHUB_TOKEN)) {
    const prompt = `${readFileSync(new URL("../prompts/verify.md", import.meta.url), "utf8")}\n\nPR context: ${contextPath}\nFrozen verification plan: ${planPath}\nEvidence directory: ${output}\nWrite report: ${join(output, "agent.json")}\n`;
    result.agent.execution = await agent("agent", prompt, cwd);
  }
  for (const path of artifacts) {
    try {
      const source = within(cwd, resolve(cwd, path));
      cpSync(source, join(output, "project", path), {
        recursive: true, dereference: true,
        filter: file => { within(cwd, file); return true; },
      });
    } catch (error) {
      result.problems.push(`Could not collect ${path}: ${error.message}`);
    }
  }
  if (result.agent.execution.status === "passed") {
    try { Object.assign(result.agent, inspectAgent(join(output, "agent.json"), output)); }
    catch (error) { result.agent.gaps.push(`The agent report is unavailable or invalid: ${error.message}`); }
  } else if (!result.agent.gaps.length) {
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
  if (source(repository, excluded).fingerprint !== before.fingerprint) result.problems.push("The checked-out source changed during verification. These observations do not verify the original proposed change.");
  const retained = refreshEvidence(output, configured.checks, [...configured.observations, ...(result.agent.observations || [])]);
  result.problems.push(...retained.problems);
  result.verification = assess({ plan, ...retained,
    problems: [...result.problems, ...result.agent.gaps], context: context.environment });
  save();
} catch (error) {
  result.problems.push(error.message);
  console.error(error.message);
  if (initialized) save();
}
console.log(`\nFinal verification: ${result.status}. Evidence: ${output}`);
process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
