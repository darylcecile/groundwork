#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { catalogue, catalogueIssues, hasConfig, loadConfig, selectChecks } from "../../lib/config.mjs";
import { installSkills, updatePackage } from "../../lib/distribution.mjs";
import { githubAPI, resolvePullRequest } from "../../lib/github.mjs";
import { renderMap } from "../../lib/map.mjs";
import { prepareProject } from "../../lib/migration.mjs";
import { ensurePortal } from "../../lib/portal.mjs";
import { listRecords, publishRecord } from "../../lib/pr-records.mjs";
import { assess, ensure, exitCode, readJSON, text, validatePlan, withInvariants, writeJSON } from "../../lib/model.mjs";
import { makeRecord, reassessRun, renderRecord, validateLocalRun } from "../../lib/report.mjs";
import { changedFiles, git, pendingCheck, runChecks, source, sourceMatches } from "../../lib/runner.mjs";
import { evidenceStore, prepareEvidenceStore } from "../../lib/store.mjs";

const skillDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(skillDirectory, "../..");
const oldGlobalInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Follow its workflow in normal chat, using the project's `VERIFY.md` and `verify.json` when present. Set up project verification files when I ask to adopt the framework.\n";
const globalInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Follow its workflow in normal chat, using the project's `.groundwork/VERIFY.md` and `.groundwork/verify.d/` when present. The agent maintains project guides and checks and automatically migrates older metadata.\n";
const help = `groundwork — checks and evidence

  groundwork install              Register all bundled skills and shared instructions
  groundwork update               Update the package and register its bundled skills
  groundwork init [directory]     Prepare project guides and checks, migrating older metadata
  groundwork verify [name ...]    Run checks and active project invariants
    --plan <file>                  Verify every requirement in a saved task plan
    --changed <ref>                Select checks for changed areas since a Git ref
    --base <ref>                   Compare source-aware drivers with a baseline
    --fresh                        Execute checks instead of reusing saved receipts
  groundwork view report [id]     Show results, coverage, measurements, and evidence
  groundwork publish pr [number-or-url] --run <id>
                                   Publish a saved run to a PR, defaulting to the current branch
  groundwork view pr [number-or-url]  Read published verification history for a PR
  groundwork view guide [query]   Find behaviours, invariants, and their checks
  groundwork map [feature]        Show recorded feature dependencies and pointers

Exit codes: 0 passed, 1 failed, 2 inconclusive or invalid setup.
`;

function instructionUpdate(path, content, ...legacy) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next = legacy.reduce((value, instruction) => value.replaceAll(instruction, content), previous);
  const sections = next.split(content);
  if (sections.length > 1) next = sections[0] + content + sections.slice(1).join("");
  else if (!/^## Verification workflow\s*$/m.test(previous)) {
    next += `${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${content}`;
  }
  return () => {
    if (next === previous) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    console.log(`Updated ${path}`);
  };
}

function install() {
  const home = homedir();
  const skills = installSkills(packageRoot);
  for (const path of [
    join(process.env.COPILOT_HOME || join(home, ".copilot"), "copilot-instructions.md"),
    join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "AGENTS.md"),
  ]) {
    instructionUpdate(path, globalInstruction, oldGlobalInstruction,
      oldGlobalInstruction.replace("`VERIFY.md` and `verify.json`", "`.groundwork/VERIFY.md` and `.groundwork/verify.json`"))();
  }
  console.log(`Groundwork skills installed: ${skills.join(", ")}. Start a new Copilot session and reload OpenCode's configuration.`);
}

function init(directory) {
  const root = resolve(directory || process.cwd());
  ensure(existsSync(root) && statSync(root).isDirectory(), `Project directory does not exist: ${root}`);
  prepareProject(root, { initialize: true });
  return root;
}

function projectRoot() {
  const parts = process.cwd().split(sep);
  const namespace = Math.max(parts.lastIndexOf(".groundwork"), parts.lastIndexOf(".verify"));
  let directory = namespace < 0 ? process.cwd() : parts.slice(0, namespace).join(sep) || sep;
  while (true) {
    if (hasConfig(directory) || ["VERIFY.md", ".groundwork/VERIFY.md", ".groundwork/latest", ".verify"]
      .some(path => existsSync(join(directory, path)))) return directory;
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) break;
    directory = parent;
  }
  throw new Error("No Groundwork project metadata found. The agent can prepare this project with groundwork init.");
}

function localRecord(result) {
  const assessment = assess(result);
  return makeRecord({ run: {
    kind: "local", id: result.id, startedAt: result.startedAt, finishedAt: result.finishedAt,
    source: result.source, selection: result.selection || null, omitted: result.omitted,
    context: result.context || {}, runner: result.runner || null, projectPath: result.projectPath || "",
  }, assessment, status: result.status || assessment.status });
}

function publicationOptions(args) {
  let reference;
  let id;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") {
      ensure(!id && text(args[index + 1]) && /^[a-zA-Z0-9_-]+$/.test(args[index + 1]), "--run needs one run identifier.");
      id = args[++index];
    } else {
      ensure(!arg.startsWith("-") && reference === undefined, "Use groundwork publish pr [number-or-url] --run <id>.");
      reference = arg;
    }
  }
  ensure(id, "Publishing requires an explicit --run <id>; use the run ID from groundwork verify.");
  return { reference, id };
}

function decisionLinks(target, record, revision) {
  return Object.fromEntries((record.plan?.decisions || []).map(path => [path,
    `https://${target.host}/${target.owner}/${target.repo}/blob/${encodeURIComponent(revision)}/${[record.run.projectPath, path]
      .filter(Boolean).join("/").split("/").map(encodeURIComponent).join("/")}`]));
}

async function publishPR(root, { reference, id }) {
  const directory = join(evidenceStore(root).runs, id);
  const result = validateLocalRun(readJSON(join(directory, "result.json")), id);
  const record = localRecord(result);
  const config = loadConfig(root);
  const current = reassessRun({ root, directory, source: result.source, finishedAt: result.finishedAt,
    assessment: result, config });
  const target = resolvePullRequest(reference, { cwd: root });
  const matches = sourceMatches(result.source, current.currentSource) && !current.currentSource.dirty &&
    current.currentSource.revision === target.headSha;
  const published = await publishRecord({ api: githubAPI(target, { cwd: root }), target, record,
    assessment: current.assessment, status: current.assessment.status, sourceMatches: matches,
    links: { decisions: decisionLinks(target, record, target.headSha) } });
  if (published.skipped) {
    console.log(`INCONCLUSIVE — ${published.skipped}`);
    return 2;
  }
  console.log(`${published.publication.status.toUpperCase()} — published run ${id} to ${target.url}`);
  console.log(`Record (${published.transport}): ${published.url}`);
  for (const problem of published.publication.assessment.problems) console.log(`  ${problem}`);
  if (published.superseded) console.log("A newer verification attempt determines the PR commit status.");
  return exitCode(published.publication.status);
}

function terminalStyle(stream = process.stdout) {
  const enabled = !("NO_COLOR" in process.env) &&
    (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(stream.isTTY));
  const code = open => value => enabled ? `\x1b[${open}m${value}\x1b[0m` : String(value);
  const statusColor = { passed: code(32), failed: code(31), inconclusive: code(33) };
  return {
    bold: code(1), dim: code(2), link: code(36), heading: code(34),
    status: (value, label = value) => (statusColor[value] || statusColor.inconclusive)(label.toUpperCase()),
  };
}

const coverageStatus = { verified: "passed", failed: "failed", unverified: "inconclusive" };

const shortSha = value => value ? value.slice(0, 12) : "no commit recorded";
const statusFromState = { success: "passed", failure: "failed" };

async function viewPR(reference) {
  const target = resolvePullRequest(reference);
  const { pull, records, diagnostics, commitStatus } = await listRecords({ api: githubAPI(target), target });
  const style = terminalStyle();
  const latest = records.find(item => item.current);
  let status = latest?.status || "inconclusive";
  if (latest && commitStatus && commitStatus.state !== "success") status = commitStatus.state === "failure" ? "failed" : "inconclusive";
  const revision = record => `${shortSha(record.run.testedSha || record.run.source?.revision)}${record.run.source?.dirty ? " + local changes" : ""}`;
  console.log(`${style.bold(style.status(status))} — ${latest ? "latest published attempt for this PR head"
    : "No published verification record for the current PR head."}`);
  console.log(`${style.bold(`${target.owner}/${target.repo}#${pull.number || target.number}`)} ${style.dim(`· head ${shortSha(pull.head.sha)}`)} ${style.link(pull.html_url || target.url)}`);
  if (commitStatus && commitStatus.state !== "success") {
    const description = (commitStatus.description || "").replace(/\s*\[gw:[^\]]*\]/g, "").trim();
    console.log(`Latest publication status: ${style.status(statusFromState[commitStatus.state] || "inconclusive")} (${commitStatus.state})${description ? ` — ${description}` : ""}`);
  }
  for (const diagnostic of diagnostics) console.log(`  ${/^PR artifacts are unavailable .*reading comments\.$/.test(diagnostic) ? style.dim(diagnostic) : diagnostic}`);
  if (latest) {
    const { record, publication } = latest;
    console.log(`\n${style.heading("Current PR head record")} ${style.dim(`· tested ${revision(record)} · ${record.run.startedAt || "time unavailable"}`)}`);
    console.log(`  Record: ${style.link(latest.source.url)}`);
    if (publication?.sourceMatches === false) console.log(`  ${style.bold("Source mismatch:")} the tested source did not match the published PR head.`);
    if (record.plan) console.log(`  Goal: ${record.plan.goal}`);
    const passing = record.checks.filter(check => check.status === "passed");
    console.log(`  Checks: ${passing.length}/${record.checks.length} passed`);
    const shown = [...record.checks.filter(check => check.status !== "passed"), ...passing.slice(0, 8)];
    for (const check of shown) {
      const label = check.receipt ? style.dim(` (${check.receipt.disposition})`) : "";
      console.log(`    ${style.status(check.status)} ${check.name}${label}`);
      if (check.status !== "passed") {
        console.log(`      ${check.expect}`);
        if (check.receipt?.reason) console.log(`      ${check.receipt.reason}`);
      }
    }
    if (passing.length > 8) console.log(style.dim(`    … ${passing.length - 8} more passed checks in the record`));
    const coverage = publication?.assessment?.coverage || record.coverage;
    if (coverage.length) {
      const counts = Object.entries(Object.groupBy(coverage, item => item.status)).map(([key, items]) => `${items.length} ${key}`);
      console.log(`  Coverage: ${counts.join(", ")}`);
      for (const item of coverage.filter(entry => entry.status !== "verified")) {
        console.log(`    ${style.status(coverageStatus[item.status] || "inconclusive", item.status)} ${item.id}: ${item.expect}${item.reason ? ` — ${item.reason}` : ""}`);
      }
    }
    for (const gap of new Set([...record.gaps, ...(publication?.assessment?.problems || []), ...latest.diagnostics])) console.log(`  ${style.bold("Gap:")} ${gap}`);
    for (const [path, url] of Object.entries(decisionLinks(target, record, publication?.headSha || pull.head.sha))) {
      console.log(`  Decision: ${path} ${style.link(url)}`);
    }
  }
  const history = records.filter(item => item !== latest);
  if (history.length) console.log(`\n${style.heading("Earlier published records")}`);
  for (const item of history) {
    const failing = item.record.checks.filter(check => check.status !== "passed").length;
    console.log(`  ${item.current ? "CURRENT PR HEAD" : "HISTORICAL"} · ${style.status(item.status)} · ${style.dim(`tested ${revision(item.record)} · ${item.record.run.startedAt || "time unavailable"}`)}` +
      `${failing ? ` · ${failing} not passed` : ""} ${style.link(item.source.url)}`);
  }
  return exitCode(status);
}

function report(root, requestedId) {
  const storage = prepareEvidenceStore(root);
  const id = requestedId || readFileSync(storage.latest, "utf8").trim();
  ensure(/^[a-zA-Z0-9_-]+$/.test(id), "Invalid run identifier.");
  const directory = join(storage.runs, id);
  const result = validateLocalRun(readJSON(join(directory, "result.json")), id);
  const { assessment: evaluated, problems: issues } = reassessRun({ root, directory, source: result.source,
    finishedAt: result.finishedAt, assessment: result });
  const { status } = evaluated;
  console.log(`\n${status.toUpperCase()} — checks from ${result.startedAt}`);
  console.log(`Run: ${id}`);
  console.log(`Source: ${result.source.revision?.slice(0, 12) || "no commit yet"}${result.source.dirty ? " + local changes" : ""} · ${result.source.fingerprint.slice(0, 12)}`);
  for (const check of evaluated.checks) {
    console.log(`  ${check.status.toUpperCase()} ${check.name}: ${check.expect}`);
    if (check.receipt) console.log(`    ${check.receipt.disposition.toUpperCase()}: ${check.receipt.reason}${check.receipt.id ? ` (receipt ${check.receipt.id})` : ""}`);
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
  if (existsSync(join(directory, "report.md"))) console.log(`Record: ${relative(root, join(directory, "report.md"))}`);
  return exitCode(status);
}

function options(args) {
  const value = { names: [], plan: null, changed: null, base: null, fresh: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--plan", "--changed", "--base"].includes(arg)) {
      const key = arg.slice(2);
      ensure(!value[key] && text(args[index + 1]) && !args[index + 1].startsWith("--"), `${arg} needs one value.`);
      value[key] = args[++index];
    } else if (arg === "--fresh") {
      value.fresh = true;
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
  if (!entries.length) console.log("No matching catalogue entries. The agent records behaviours and invariants in .groundwork/verify.d/<feature>.json.");
  const issues = catalogueIssues(config, root, entries.map(item => item.id));
  for (const issue of issues) console.log(`  ${issue}`);
  return issues.length ? 2 : 0;
}

function map(root, args) {
  for (const arg of args) ensure(!arg.startsWith("-"), `Unknown option: ${arg}`);
  const config = loadConfig(root);
  const rendered = renderMap(config, args.join(" "));
  console.log(rendered.text);
  const issues = catalogueIssues(config, root, rendered.ids);
  for (const issue of issues) console.log(`  ${issue.replace(/\s+/g, " ").trim()}`);
  return issues.length ? 2 : 0;
}

async function run(root, requested, planInput) {
  const config = loadConfig(root);
  const task = requested.plan ? validatePlan(planInput) : null;
  const changes = requested.changed ? changedFiles(root, requested.changed) : null;
  const selection = selectChecks(config, { names: requested.names, changedPaths: changes, plan: task });
  ensure(selection.names.length > 0, "No checks selected. The agent must record a real check in .groundwork/verify.d/<feature>.json or choose a mapped behaviour.");
  const plan = withInvariants(task, config, selection.invariants);
  const ids = [...new Set([...selection.names.flatMap(name => config.checks[name].covers), ...selection.invariants])];
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const storage = prepareEvidenceStore(root);
  const result = {
    version: 2, id, kind: "local", startedAt: new Date().toISOString(), finishedAt: null, source: source(root),
    projectPath: relative(git(root, ["rev-parse", "--show-toplevel"]).toString().trim(), root).split(sep).join("/"),
    runner: { runtime: process.versions.bun ? "bun" : "node", version: process.versions.bun || process.version,
      platform: process.platform, architecture: process.arch },
    selection, omitted: selection.omitted,
    ...assess({ plan, checks: selection.names.map(name => pendingCheck(name, config.checks[name])), problems: catalogueIssues(config, root, ids),
      context: { ...config.context, runnerPlatform: process.platform, runnerArchitecture: process.arch } }),
  };
  const directory = join(storage.runs, id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "result.json");
  const save = () => {
    Object.assign(result, assess(result));
    if (!result.finishedAt && result.status === "passed") result.status = "inconclusive";
    writeJSON(path, result);
    writeFileSync(join(directory, "report.md"), renderRecord(localRecord(result)));
  };
  save();
  writeFileSync(storage.latest, `${id}\n`);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const execution = await runChecks({ root, directory, checks: config.checks, names: selection.names, plan,
      base: requested.base, fresh: requested.fresh, context: result.context, signal: controller.signal,
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
  return report(root, id);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "view" && args[0] === "pr") {
    ensure(args.length <= 2, "Use groundwork view pr [number-or-url].");
    process.exitCode = await viewPR(args[1]);
    return;
  }
  if (command === "publish" && args[0] === "pr") {
    const requested = publicationOptions(args.slice(1));
    process.exitCode = await publishPR(projectRoot(), requested);
    return;
  }
  const requested = command === "verify" ? options(args) : null;
  const planInput = requested?.plan ? readJSON(resolve(requested.plan)) : null;
  let portalRoot = process.cwd();
  if (command === "init" && args.length <= 1) portalRoot = init(args[0]);
  else if (command === "verify" || command === "map" ||
    (command === "view" && (args[0] === "guide" || (args[0] === "report" && args.length <= 2)))) {
    portalRoot = projectRoot();
    prepareProject(portalRoot);
  } else { try { portalRoot = projectRoot(); } catch { /* An unadopted directory has an empty portal. */ } }
  await ensurePortal(portalRoot);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
  } else if (command === "install" && args.length === 0) {
    install();
  } else if (command === "update" && args.length === 0) {
    process.env.GROUNDWORK_PORTAL = "0"; // The nested installer runs from home; keep this invocation's project portal.
    updatePackage(packageRoot);
  } else if (command === "init" && args.length <= 1) {
    console.log("Project metadata is ready. The agent maintains feature guides and checks in .groundwork/guides/ and .groundwork/verify.d/.");
  } else if (command === "verify") {
    process.exitCode = await run(portalRoot, requested, planInput);
  } else if (command === "view" && args.length <= 2 && args[0] === "report") {
    process.exitCode = report(portalRoot, args[1]);
  } else if (command === "view" && args[0] === "guide") {
    process.exitCode = guide(portalRoot, args.slice(1).join(" "));
  } else if (command === "map") {
    process.exitCode = map(portalRoot, args);
  } else {
    throw new Error(`Unknown command or arguments.\n${help}`);
  }
}

try { await main(); } catch (error) {
  console.error(`INCONCLUSIVE — ${error.message}`);
  process.exitCode = 2;
}
