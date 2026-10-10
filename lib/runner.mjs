import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { capture, compareTrials, ensure, inspectDriver, measureBudgets, statusOf, writeJSON } from "./model.mjs";
import { groundworkPath, runtimeExclusions } from "./layout.mjs";

export function git(root, args, optional = false) {
  const execution = spawnSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (optional && execution.status !== 0) return null;
  ensure(execution.status === 0, `Cannot identify source: ${execution.error?.message || execution.stderr?.toString().trim() || "Git failed"}`);
  return execution.stdout;
}

export function source(root, excluded = []) {
  git(root, ["rev-parse", "--show-toplevel"]);
  const revision = git(root, ["rev-parse", "--verify", "HEAD"], true)?.toString().trim() || null;
  const scope = ["--", ".", ...runtimeExclusions.map(path => `:(exclude,glob)${path}`), ...excluded.map(path => `:(exclude)${path}`)];
  const args = ["diff", "--binary", "--no-ext-diff", "--no-textconv"];
  const diff = revision ? git(root, [...args, "HEAD", ...scope])
    : Buffer.concat([git(root, [...args, "--cached", ...scope]), git(root, [...args, ...scope])]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...scope]).toString().split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(revision || "uncommitted").update(diff);
  for (const path of untracked) {
    const file = join(root, path);
    hash.update("\0").update(path).update("\0").update(lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
  }
  return { revision, fingerprint: hash.digest("hex"), dirty: diff.length > 0 || untracked.length > 0 };
}

export function changedFiles(root, ref) {
  const base = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();
  const scope = ["--", ".", ...runtimeExclusions.map(path => `:(exclude,glob)${path}`)];
  const paths = git(root, ["diff", "--relative", "--no-renames", "--name-only", "-z", base, ...scope]).toString().split("\0");
  paths.push(...git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...scope]).toString().split("\0"));
  return [...new Set(paths.filter(Boolean))];
}

export async function executeCommand({ command, args, cwd, env = process.env, directory, log, phase = "exercise", signal }) {
  const path = join(directory, log);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `$ ${command}\n\n`);
  const started = Date.now();
  let execution;
  if (signal?.aborted) execution = { code: null, reason: "Verification interrupted." };
  else execution = await new Promise(resolveExecution => {
    const child = args
      ? spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
      : spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", chunk => { appendFileSync(path, chunk); terminal.write(chunk); });
    }
    child.on("error", error => { signal?.removeEventListener("abort", abort); resolveExecution({ code: null, reason: error.message }); });
    child.on("close", (code, interrupted) => {
      signal?.removeEventListener("abort", abort);
      resolveExecution({ code, reason: interrupted ? `Interrupted by ${interrupted}` : null });
    });
    if (signal?.aborted) abort();
  });
  let status = execution.code === 0 ? "passed" : [null, 2, 126, 127].includes(execution.code) || phase !== "exercise" ? "inconclusive" : "failed";
  if (signal?.aborted) status = "inconclusive";
  const reason = execution.reason || (status === "passed" ? null : `Command exited ${execution.code}; inspect ${log}.`);
  if (reason) appendFileSync(path, `\n${reason}\n`);
  return { phase, command, status, reason, exitCode: execution.code, durationMs: Date.now() - started, log,
    logHash: capture(directory, log).sha256 };
}

export function pendingCheck(name, check) {
  return { name, command: check.command, expect: check.expect, covers: check.covers || [], kind: check.kind || "command",
    status: "inconclusive", reason: "Not completed.", exitCode: null, durationMs: 0,
    log: `${name}/output.log`, artifacts: [], observations: [], measurements: [], trials: [], problems: [] };
}

async function trial({ root, target, directory, name, check, prefix, phase, index, planPath, env, signal, context, excluded }) {
  const started = Date.now();
  const location = join(directory, prefix);
  const artifactsDirectory = join(location, "artifacts");
  mkdirSync(artifactsDirectory, { recursive: true });
  const originalEvidenceDirectory = realpathSync(artifactsDirectory);
  const problems = [];
  const stages = [];
  const artifacts = [];
  const before = source(target, excluded);
  const environment = {
    ...env, VERIFY_ARTIFACTS: artifactsDirectory, GROUNDWORK_EVIDENCE_DIR: artifactsDirectory,
    GROUNDWORK_SOURCE_DIR: target, GROUNDWORK_PROJECT_DIR: root, GROUNDWORK_PHASE: phase,
    GROUNDWORK_TRIAL: String(index), GROUNDWORK_PLAN: planPath || "",
  };
  const execute = (command, step, filename, interrupt = signal) => executeCommand({ command, cwd: root, env: environment,
    directory, log: `${prefix}/${filename}`, phase: step, signal: interrupt });
  console.log(`\n[${name}] ${phase}, trial ${index}/${check.repeat}: ${check.expect}`);
  let exercise = null;
  let observations = [];
  let measurements = [];
  let actualContext = { ...context, ...check.context, runnerPlatform: process.platform, runnerArchitecture: process.arch };
  try {
    if (check.setup) {
      const setup = await execute(check.setup, "setup", "setup.log");
      stages.push(setup);
      if (setup.status !== "passed") problems.push("Driver setup could not complete.");
    }
    if (!problems.length && !signal?.aborted) {
      exercise = await execute(check.command, "exercise", "output.log");
      stages.push(exercise);
    }
  } finally {
    if (check.cleanup) {
      const cleanup = await execute(check.cleanup, "cleanup", "cleanup.log", null);
      stages.push(cleanup);
      if (cleanup.status !== "passed") problems.push("Driver cleanup could not complete.");
    }
  }
  if (!exercise) {
    const log = `${prefix}/output.log`;
    writeFileSync(join(directory, log), "Exercise did not run.\n");
    exercise = { phase: "exercise", status: "inconclusive", exitCode: null, durationMs: 0, log,
      logHash: capture(directory, log).sha256, reason: signal?.aborted ? "Verification interrupted." : "Driver setup is unavailable." };
  }
  let localEvidence = false;
  try { localEvidence = lstatSync(artifactsDirectory).isDirectory() && realpathSync(artifactsDirectory) === originalEvidenceDirectory; } catch {}
  if (!localEvidence) problems.push("The trial evidence directory is unavailable or was replaced.");
  if (check.result && !signal?.aborted && localEvidence) {
    const resultPath = `${prefix}/artifacts/${check.result}`;
    try {
      const observed = inspectDriver(join(directory, resultPath), directory, {
        prefix: `${prefix}/artifacts`, producer: "driver", covers: check.covers,
        forbidden: [resultPath], check: name, trial: index,
        boundary: artifactsDirectory,
      });
      for (const [key, value] of Object.entries(observed.context)) {
        if (Object.hasOwn(actualContext, key) && actualContext[key] !== value) problems.push(`Observed context ${key} differs from its declared value.`);
      }
      actualContext = { ...actualContext, ...observed.context };
      observations = observed.observations;
      measurements = observed.measurements;
      problems.push(...observed.problems);
      artifacts.push(capture(directory, resultPath, artifactsDirectory));
    } catch (error) { problems.push(`Structured result is unavailable: ${error.message}`); }
  }
  for (const path of check.artifacts) {
    try {
      ensure(localEvidence, "The trial evidence directory was replaced.");
      artifacts.push(capture(directory, `${prefix}/artifacts/${path}`, artifactsDirectory));
    }
    catch (error) { problems.push(error.message); }
  }
  for (const observation of observations) artifacts.push(...observation.evidence);
  for (const stage of stages) if (stage.log !== exercise.log) artifacts.push(capture(directory, stage.log));
  const budgets = phase === "baseline" && check.compare === "measurement"
    ? Object.fromEntries(Object.entries(check.metrics).map(([key, metric]) => [key, { unit: metric.unit }])) : check.metrics;
  const metrics = measureBudgets(measurements, budgets);
  if (source(target, excluded).fingerprint !== before.fingerprint) problems.push("Source changed during this trial.");
  const status = statusOf([exercise.status, ...observations.map(item => item.status), ...metrics.map(item => item.status)], problems);
  console.log(`${status.toUpperCase()} ${name} (${phase}, trial ${index})`);
  const assertionFailed = observations.some(item => item.status === "failed") || metrics.some(item => item.status === "failed") ||
    (!check.result && exercise.exitCode === 1);
  return { phase, index, status, assertionFailed, source: before, context: actualContext, stages, problems, observations, measurements, metrics,
    exitCode: exercise.exitCode, log: exercise.log, logHash: exercise.logHash, artifacts,
    reason: problems.join(" ") || exercise.reason || metrics.find(item => item.status !== "passed")?.reason || null,
    durationMs: Date.now() - started };
}

function baselineCheckout(root, ref) {
  const repository = git(root, ["rev-parse", "--show-toplevel"]).toString().trim();
  const revision = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();
  const temporary = process.env.GROUNDWORK_TEMP || process.env.VERIFY_TEST_TMPDIR || groundworkPath(root, "tmp");
  mkdirSync(temporary, { recursive: true });
  const parent = mkdtempSync(join(temporary, "groundwork-base-"));
  const checkout = join(parent, "source");
  try { git(repository, ["worktree", "add", "--detach", checkout, revision]); }
  catch (error) { rmSync(parent, { recursive: true, force: true }); throw error; }
  return { root: join(checkout, relative(repository, root)), revision,
    remove() { try { git(repository, ["worktree", "remove", "--force", checkout]); } finally { rmSync(parent, { recursive: true, force: true }); } } };
}

export async function runChecks({ root, directory, checks, names, plan = null, base = null, context = {}, env = process.env,
  signal, excluded = [], onUpdate = () => {} }) {
  const results = names.map(name => pendingCheck(name, checks[name]));
  const observations = [];
  const problems = [];
  const planPath = plan ? join(directory, "plan.json") : null;
  if (planPath) writeJSON(planPath, plan);
  const planContents = planPath ? readFileSync(planPath, "utf8") : null;
  let baseline;
  let baselineError;
  if (base) {
    ensure(names.some(name => checks[name].compare), "No selected check declares a source-aware comparison.");
    try { baseline = baselineCheckout(root, base); }
    catch (error) { baselineError = error.message; }
  }
  try {
    for (const [position, name] of names.entries()) {
      if (signal?.aborted) break;
      const check = checks[name];
      console.log(`\nCheck ${position + 1}/${names.length}: ${name}`);
      const candidates = [];
      const baselines = [];
      for (const phase of base && check.compare ? ["baseline", "candidate"] : ["candidate"]) {
        if (phase === "baseline" && !baseline) continue;
        for (let index = 1; index <= check.repeat && !signal?.aborted; index++) {
          const prefix = `${name}${phase === "baseline" ? "/baseline" : ""}${check.repeat > 1 ? `/trial-${index}` : ""}`;
          try {
            const result = await trial({ root, target: phase === "baseline" ? baseline.root : root, directory,
              name, check, prefix, phase, index, planPath, env, signal, context, excluded });
            (phase === "baseline" ? baselines : candidates).push(result);
          } catch (error) {
            problems.push(`${name} (${phase}): ${error.message}`);
            break;
          }
        }
      }
      const current = candidates[0];
      const comparison = base && check.compare ? baselineError
        ? { status: "inconclusive", reason: `Baseline unavailable: ${baselineError}`, measurements: [] }
        : compareTrials(check.compare, baselines, candidates, check.metrics) : null;
      const localProblems = candidates.flatMap(item => item.problems);
      if (candidates.length !== check.repeat) localProblems.push("Not all candidate trials completed.");
      if (base && check.compare && baselines.length !== check.repeat) localProblems.push("Not all baseline trials completed.");
      const status = statusOf([...candidates.map(item => item.status), ...(comparison ? [comparison.status] : [])], localProblems);
      const artifacts = new Map();
      for (const item of [...candidates, ...baselines]) {
        for (const artifact of item.artifacts) artifacts.set(artifact.path, artifact);
        if (item.log !== current?.log) artifacts.set(item.log, { path: item.log, sha256: item.logHash });
      }
      const checkObservations = candidates.flatMap(item => item.observations);
      observations.push(...checkObservations);
      results[position] = { ...results[position], status, trials: candidates, baseline: baselines,
        trialSummary: { total: check.repeat, passed: candidates.filter(item => item.status === "passed").length,
          failed: candidates.filter(item => item.status === "failed").length, inconclusive: check.repeat - candidates.filter(item => item.status === "passed" || item.status === "failed").length },
        comparison, context: { ...context, ...check.context }, observations: checkObservations,
        measurements: candidates.flatMap(item => item.measurements), problems: localProblems,
        reason: localProblems.join(" ") || comparison?.reason || candidates.find(item => item.reason)?.reason || null,
        exitCode: status === "passed" ? 0 : candidates.find(item => item.exitCode !== 0)?.exitCode ?? current?.exitCode ?? null,
        durationMs: [...candidates, ...baselines].reduce((total, item) => total + item.durationMs, 0),
        log: current?.log || results[position].log, ...(current ? { logHash: current.logHash } : {}), artifacts: [...artifacts.values()] };
      await onUpdate(results, observations);
    }
  } finally {
    if (planPath) {
      try {
        if (readFileSync(planPath, "utf8") !== planContents) problems.push("The verification plan changed during execution; original requirements were retained.");
      } catch { problems.push("The verification plan was removed during execution; original requirements were retained."); }
      writeJSON(planPath, plan);
    }
    if (baseline) {
      try { baseline.remove(); }
      catch (error) { problems.push(`Could not remove baseline checkout: ${error.message}`); }
    }
  }
  return { checks: results, observations, problems };
}
