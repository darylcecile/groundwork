#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const skillDirectory = dirname(fileURLToPath(import.meta.url));
const globalInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Follow its workflow in normal chat, using the project's `VERIFY.md` and `verify.json` when present. Set up project verification files when I ask to adopt the framework.\n";
const projectInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Read `VERIFY.md` for this project's behaviour guide and use `verify.json` for repeatable checks.\n";
const help = `groundwork — checks and evidence

  groundwork install           Register the shared personal skill and instructions
  groundwork init [directory]  Set up a project without replacing existing files
  groundwork verify [name ...] Run all checks, or named checks plus required checks
  groundwork view report       Show the latest result, source freshness, and evidence

Exit codes: 0 passed, 1 failed, 2 inconclusive or invalid setup.
`;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safePath(value) {
  return text(value) && !isAbsolute(value) && !value.includes("\\") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

function saveJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendOnce(path, marker, content) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (previous.includes(marker)) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${content}`);
  console.log(`Updated ${path}`);
}

function install() {
  const home = homedir();
  const destination = join(home, ".agents", "skills", "verify-work");
  mkdirSync(dirname(destination), { recursive: true });
  let existing;
  try { existing = lstatSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    ensure(realpathSync(destination) === realpathSync(skillDirectory), `A different skill already exists at ${destination}. Keep it or move it before installing this one.`);
  } else {
    symlinkSync(skillDirectory, destination, "dir");
    console.log(`Installed ${destination}`);
  }
  for (const path of [
    join(process.env.COPILOT_HOME || join(home, ".copilot"), "copilot-instructions.md"),
    join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "AGENTS.md"),
  ]) {
    appendOnce(path, globalInstruction, globalInstruction);
  }
  console.log("Groundwork's verify-work skill is installed. Start a new Copilot session and reload OpenCode's configuration.");
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

function config(root) {
  const value = readJSON(join(root, "verify.json"));
  ensure(object(value) && Object.keys(value).every(key => key === "checks") && object(value.checks), "verify.json must contain a checks object.");
  for (const [name, check] of Object.entries(value.checks)) {
    ensure(/^[a-z0-9][a-z0-9._-]*$/.test(name), `Invalid check name: ${name}`);
    ensure(object(check) && text(check.command) && text(check.expect), `${name}: command and expect must be nonempty strings.`);
    ensure(Object.keys(check).every(key => ["command", "expect", "required", "artifacts"].includes(key)), `${name}: unknown option. Use command, expect, required, or artifacts.`);
    ensure(check.required === undefined || typeof check.required === "boolean", `${name}: required must be a boolean.`);
    ensure(check.artifacts === undefined || (Array.isArray(check.artifacts) && check.artifacts.every(safePath)), `${name}: artifacts must be relative file paths within VERIFY_ARTIFACTS.`);
  }
  return value.checks;
}

function git(root, args, optional = false) {
  const result = spawnSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (optional && result.status !== 0) return null;
  ensure(result.status === 0, `Cannot identify source: ${result.error?.message || result.stderr?.toString().trim() || "Git failed"}`);
  return result.stdout;
}

function source(root) {
  git(root, ["rev-parse", "--show-toplevel"]);
  const revision = git(root, ["rev-parse", "--verify", "HEAD"], true)?.toString().trim() || null;
  const scope = ["--", ".", ":(exclude).verify/**"];
  const diffArgs = ["diff", "--binary", "--no-ext-diff", "--no-textconv"];
  const diff = revision
    ? git(root, [...diffArgs, "HEAD", ...scope])
    : Buffer.concat([git(root, [...diffArgs, "--cached", ...scope]), git(root, [...diffArgs, ...scope])]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."])
    .toString().split("\0").filter(path => path && !path.startsWith(".verify/")).sort();
  const hash = createHash("sha256").update(revision || "uncommitted").update(diff);
  for (const path of untracked) {
    const absolute = join(root, path);
    const contents = lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute);
    hash.update("\0").update(path).update("\0").update(contents);
  }
  return { revision, fingerprint: hash.digest("hex"), dirty: diff.length > 0 || untracked.length > 0 };
}

function fileHash(path) {
  ensure(statSync(path).isFile(), `Evidence is not a file: ${path}`);
  const data = readFileSync(path);
  ensure(data.length > 0, `Evidence is empty: ${path}`);
  return createHash("sha256").update(data).digest("hex");
}

async function runCheck(root, runDirectory, name, check) {
  const log = `${name}/output.log`;
  const artifactDirectory = join(runDirectory, name, "artifacts");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(runDirectory, log), `$ ${check.command}\n\n`);
  const result = { name, command: check.command, expect: check.expect, status: "inconclusive", reason: null, exitCode: null, durationMs: 0, log, artifacts: [] };
  const started = Date.now();
  console.log(`\n[${name}] ${check.expect}\n$ ${check.command}`);
  const execution = await new Promise(resolveExecution => {
    const child = spawn(check.command, {
      cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VERIFY_ARTIFACTS: artifactDirectory },
    });
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", chunk => {
        appendFileSync(join(runDirectory, log), chunk);
        output.write(chunk);
      });
    }
    child.on("error", error => resolveExecution({ code: null, reason: error.message }));
    child.on("close", (code, signal) => resolveExecution({ code, reason: signal ? `Interrupted by ${signal}` : null }));
  });
  result.exitCode = execution.code;
  result.durationMs = Date.now() - started;
  if (execution.reason || [null, 2, 126, 127].includes(execution.code)) {
    result.reason = execution.reason || `Command could not complete verification (exit ${execution.code}).`;
  } else {
    result.status = execution.code === 0 ? "passed" : "failed";
    if (result.status === "failed") result.reason = `Command exited ${execution.code}; inspect the log.`;
  }
  for (const artifact of check.artifacts || []) {
    const path = `${name}/artifacts/${artifact}`;
    try {
      result.artifacts.push({ path, sha256: fileHash(join(runDirectory, path)) });
    } catch {
      if (result.status === "passed") result.status = "inconclusive";
      result.reason = `${result.reason ? `${result.reason} ` : ""}Missing or empty evidence: ${artifact}.`;
    }
  }
  console.log(`\n${result.status.toUpperCase()} ${name} (${(result.durationMs / 1000).toFixed(1)}s)`);
  return result;
}

function validateReport(value, id) {
  ensure(object(value) && value.version === 1 && value.id === id && text(value.startedAt) &&
    (value.finishedAt === null || text(value.finishedAt)) && object(value.source) &&
    (value.source.revision === null || text(value.source.revision)) &&
    /^[a-f0-9]{64}$/.test(value.source.fingerprint) && typeof value.source.dirty === "boolean" &&
    Array.isArray(value.omitted) && value.omitted.every(text) && Array.isArray(value.checks) &&
    value.checks.length > 0, "Invalid saved verification report.");
  for (const check of value.checks) {
    ensure(object(check) && text(check.name) && text(check.command) && text(check.expect) &&
      ["passed", "failed", "inconclusive"].includes(check.status) &&
      (check.reason === null || text(check.reason)) &&
      (check.exitCode === null || Number.isInteger(check.exitCode)) &&
      Number.isFinite(check.durationMs) && check.durationMs >= 0 && safePath(check.log) &&
      Array.isArray(check.artifacts) && check.artifacts.every(artifact => object(artifact) &&
        safePath(artifact.path) && /^[a-f0-9]{64}$/.test(artifact.sha256)), "Invalid check in saved verification report.");
    ensure(check.status !== "passed" || check.exitCode === 0, "A saved passing check must have exit code 0.");
  }
  return value;
}

function report(root) {
  const id = readFileSync(join(root, ".verify", "latest"), "utf8").trim();
  ensure(/^[a-zA-Z0-9_-]+$/.test(id), "Invalid latest run identifier.");
  const directory = join(root, ".verify", "runs", id);
  const result = validateReport(readJSON(join(directory, "result.json")), id);
  const issues = [];
  if (!result.finishedAt) issues.push("The latest run did not finish.");
  if (source(root).fingerprint !== result.source.fingerprint) issues.push("Source changed since this run; verify the affected behaviour again.");
  for (const check of result.checks) {
    if (check.status !== "passed") continue;
    try { fileHash(join(directory, check.log)); } catch { issues.push(`${check.name}: command log is missing or empty.`); }
    for (const artifact of check.artifacts) {
      try {
        if (fileHash(join(directory, artifact.path)) !== artifact.sha256) issues.push(`${check.name}: evidence changed: ${artifact.path}`);
      } catch { issues.push(`${check.name}: evidence is missing: ${artifact.path}`); }
    }
  }
  const failed = result.checks.some(check => check.status === "failed");
  const incomplete = issues.length > 0 || result.checks.some(check => check.status === "inconclusive");
  const status = incomplete ? "inconclusive" : failed ? "failed" : "passed";
  console.log(`\n${status.toUpperCase()} — checks from ${result.startedAt}`);
  console.log(`Source: ${result.source.revision?.slice(0, 12) || "no commit yet"}${result.source.dirty ? " + local changes" : ""} · ${result.source.fingerprint.slice(0, 12)}`);
  for (const check of result.checks) {
    console.log(`  ${check.status.toUpperCase()} ${check.name}: ${check.expect}`);
    if (check.reason) console.log(`    ${check.reason}`);
    console.log(`    Log: ${relative(root, join(directory, check.log))}`);
    for (const artifact of check.artifacts) console.log(`    Evidence: ${relative(root, join(directory, artifact.path))}`);
  }
  for (const issue of issues) console.log(`  ${issue}`);
  if (result.omitted.length) console.log(`Not selected: ${result.omitted.join(", ")}`);
  console.log(`Report: ${relative(root, join(directory, "result.json"))}`);
  return status === "passed" ? 0 : status === "failed" ? 1 : 2;
}

async function run(root, names) {
  const checks = config(root);
  for (const name of names) ensure(Object.hasOwn(checks, name), `Unknown check: ${name}. Available: ${Object.keys(checks).join(", ") || "none"}`);
  const selected = Object.entries(checks).filter(([name, check]) => names.length === 0 || names.includes(name) || check.required);
  ensure(selected.length > 0, "No checks configured. Add a real check to verify.json first.");
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const result = {
    version: 1, id, startedAt: new Date().toISOString(), finishedAt: null, source: source(root),
    omitted: Object.keys(checks).filter(name => !selected.some(([selectedName]) => selectedName === name)),
    checks: selected.map(([name, check]) => ({ name, command: check.command, expect: check.expect, status: "inconclusive", reason: "Not completed.", exitCode: null, durationMs: 0, log: `${name}/output.log`, artifacts: [] })),
  };
  const directory = join(root, ".verify", "runs", id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "result.json");
  saveJSON(path, result);
  writeFileSync(join(root, ".verify", "latest"), `${id}\n`);
  for (const [index, [name, check]] of selected.entries()) {
    console.log(`\nCheck ${index + 1}/${selected.length}`);
    result.checks[index] = await runCheck(root, directory, name, check);
    saveJSON(path, result);
  }
  result.finishedAt = new Date().toISOString();
  saveJSON(path, result);
  return report(root);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
  } else if (command === "install" && args.length === 0) {
    install();
  } else if (command === "init" && args.length <= 1) {
    init(args[0]);
  } else if (command === "verify") {
    process.exitCode = await run(projectRoot(), args);
  } else if (command === "view" && args.length === 1 && args[0] === "report") {
    process.exitCode = report(projectRoot());
  } else {
    throw new Error(`Unknown command or arguments.\n${help}`);
  }
} catch (error) {
  console.error(`INCONCLUSIVE — ${error.message}`);
  process.exitCode = 2;
}
