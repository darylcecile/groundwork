import { createHash } from "node:crypto";
import {
  appendFileSync, cpSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { ensure, inspectAgent, relativePath, verdict, within } from "./report.mjs";

const repository = resolve(process.env.PR_VERIFY_REPOSITORY || process.cwd());
const output = resolve(process.env.PR_VERIFY_OUTPUT || "../pr-verification-results");
let initialized = false;
const pending = log => ({ status: "inconclusive", exitCode: null, durationMs: 0, log });
const result = {
  version: 1, repository: process.env.GITHUB_REPOSITORY || "", pullRequest: 0, headSha: "unknown", testedSha: null,
  status: "inconclusive", setup: pending("setup.log"), checks: pending("checks.log"),
  agent: { execution: pending("agent.log"), summary: "Behaviour verification has not completed.", checks: [], gaps: [] },
  problems: [],
};

function save() {
  result.status = verdict(result);
  writeFileSync(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${JSON.stringify(result)}\n`);
}

function git(args, optional = false) {
  const execution = spawnSync("git", args, { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
  if (optional && execution.status !== 0) return null;
  ensure(execution.status === 0, `Git failed: ${execution.error?.message || execution.stderr.toString().trim()}`);
  return execution.stdout;
}

function snapshot(artifacts) {
  const scope = ["--", ".", ...artifacts.map(path => `:(exclude)${path}`)];
  const hash = createHash("sha256").update(git(["rev-parse", "HEAD"]));
  hash.update(git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", ...scope]));
  const paths = git(["ls-files", "--others", "--exclude-standard", "-z", ...scope]).toString().split("\0").filter(Boolean).sort();
  for (const path of paths) {
    const file = join(repository, path);
    const state = lstatSync(file);
    hash.update("\0").update(path).update(`\0${state.mode}\0`).update(state.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
  }
  return hash.digest("hex");
}

async function execute(label, command, args, cwd, env) {
  const log = `${label}.log`;
  const path = join(output, log);
  writeFileSync(path, `Stage: ${label}\n\n`);
  console.log(`\nStarting ${label}`);
  const started = Date.now();
  const execution = await new Promise(resolveExecution => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", chunk => { appendFileSync(path, chunk); terminal.write(chunk); });
    }
    child.on("error", error => resolveExecution({ code: null, error: error.message }));
    child.on("close", (code, signal) => resolveExecution({ code, error: signal ? `Interrupted by ${signal}` : null }));
  });
  if (execution.error) appendFileSync(path, `${execution.error}\n`);
  const status = execution.code === 0 ? "passed" : execution.code === null ? "inconclusive" : "failed";
  const stage = { status, exitCode: execution.code, durationMs: Date.now() - started, log };
  console.log(`\n${label}: ${status} (${(stage.durationMs / 1000).toFixed(1)}s)`);
  return stage;
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
  ensure(commands.checks.trim().length > 0, "Provide the project's verification commands using the checks input.");
  const artifacts = (process.env.PR_VERIFY_ARTIFACTS || "").split(/\r?\n/).map(path => path.trim().replace(/\/+$/, "")).filter(Boolean);
  ensure(artifacts.every(relativePath), "Artifact paths must name files or directories within the project; globs and parent paths are not supported.");
  const excluded = artifacts.map(path => relative(repository, resolve(cwd, path)));
  result.testedSha = git(["rev-parse", "HEAD"]).toString().trim();
  const before = snapshot(excluded);
  const contextPath = join(output, "context.json");
  const context = {
    repository: result.repository, pullRequest: pull.number, title: pull.title || "", description: pull.body || "",
    headSha: pull.head.sha, testedSha: result.testedSha,
    comparisonSha: git(["rev-parse", "HEAD^1"], true)?.toString().trim() || null,
    workingDirectory: cwd, commands, artifacts,
  };
  const commandEnv = { ...process.env, PR_VERIFY_OUTPUT: output };
  delete commandEnv.COPILOT_GITHUB_TOKEN;
  delete commandEnv.GITHUB_OUTPUT;
  const shell = (label, command) => execute(label, "bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], cwd, commandEnv);
  result.setup = commands.setup.trim() ? await shell("setup", commands.setup) : { status: "passed", exitCode: 0, durationMs: 0, log: "setup.log" };
  if (!commands.setup.trim()) writeFileSync(join(output, "setup.log"), "No setup command requested.\n");
  if (result.setup.status === "passed") result.checks = await shell("checks", commands.checks);
  else result.problems.push("Project setup failed; the configured checks could not run.");
  save();
  writeFileSync(contextPath, `${JSON.stringify({ ...context, setup: result.setup, checks: result.checks }, null, 2)}\n`);
  if (process.env.GITHUB_ACTIONS === "true" && !process.env.COPILOT_GITHUB_TOKEN) {
    result.agent.gaps.push("COPILOT_TOKEN is unavailable. Configure a Copilot credential in the importing repository.");
  } else {
    const prompt = `${readFileSync(new URL("../prompts/verify.md", import.meta.url), "utf8")}\n\nPR context: ${contextPath}\nEvidence directory: ${output}\nWrite report: ${join(output, "agent.json")}\n`;
    result.agent.execution = await execute("agent", "copilot", [
      "--prompt", prompt, "--silent", "--no-ask-user", "--allow-all-tools", "--allow-all-urls",
      "--add-dir", output, "--disable-builtin-mcps", "--no-auto-update",
      "--secret-env-vars=COPILOT_GITHUB_TOKEN", "--share", join(output, "agent-session.md"),
    ], cwd, { ...process.env, GITHUB_OUTPUT: "", PR_VERIFY_OUTPUT: output });
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
  if (snapshot(excluded) !== before) result.problems.push("The checked-out source changed during verification. These observations do not verify the original proposed change.");
  save();
} catch (error) {
  result.problems.push(error.message);
  console.error(error.message);
  if (initialized) save();
}
console.log(`\nFinal verification: ${result.status}. Evidence: ${output}`);
process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
