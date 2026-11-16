import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { capture, ensure, readJSON, safePath, validateAssessment, within } from "./model.mjs";
import { evidenceStore } from "./store.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const engine = digest(["runner.mjs", "model.mjs", "receipts.mjs", "config.mjs", "layout.mjs", "store.mjs"].map(name =>
  [name, readFileSync(new URL(name, import.meta.url), "utf8")]));

export function reusePolicy(check, base) {
  if (!check.reuse) return "Reuse is not enabled for this check.";
  if (check.repeat > 1) return "Repeated trials require independent executions.";
  if (base) return "Baseline comparison runs require fresh executions.";
  if (check.setup || check.cleanup) return "Setup and cleanup side effects require execution.";
  return null;
}

function declaredFile(root, path) {
  ensure(safePath(path) && !path.includes("\0"), `Invalid declared reuse input: ${path}`);
  const file = resolve(root, path);
  let info;
  try { info = lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return { path, missing: true }; throw error; }
  const target = within(root, file);
  ensure(info.isFile() || info.isSymbolicLink(), `Reuse input must be a file: ${path}`);
  return { path, executable: Boolean(info.mode & 0o111), link: info.isSymbolicLink() ? readlinkSync(file) : null,
    sha256: createHash("sha256").update(readFileSync(target)).digest("hex") };
}

export function receiptRecipe({ root, name, check, source, context, plan, env }) {
  const declaration = check.reuse === true ? {} : check.reuse;
  const inputs = {
    version: 1, source: { identityVersion: source.identityVersion, fingerprint: source.fingerprint },
    check: digest({ name, ...check }), engine,
    runtime: { platform: process.platform, architecture: process.arch, versions: process.versions },
    context: digest(context), plan: digest(plan),
    env: Object.fromEntries((declaration.env || []).map(name => [name, digest(env[name] ?? null)])),
    files: (declaration.files || []).map(path => declaredFile(root, path)),
    ...(declaration.revision ? { revision: source.revision } : {}),
  };
  return { key: digest(inputs), inputs, name };
}

function references(check) {
  const files = new Map();
  const add = item => {
    ensure(safePath(item.path) && item.path.startsWith(`${check.name}/`) && /^[a-f0-9]{64}$/.test(item.sha256), "Invalid receipt evidence reference.");
    ensure(!files.has(item.path) || files.get(item.path).sha256 === item.sha256, "Receipt evidence hashes disagree.");
    files.set(item.path, item);
  };
  const visit = value => {
    if (value.log) add({ path: value.log, sha256: value.logHash });
    for (const item of value.artifacts || []) add(item);
    for (const observation of value.observations || []) for (const item of observation.evidence) add(item);
    for (const stage of value.stages || []) visit(stage);
  };
  visit(check);
  for (const trial of check.trials || []) visit(trial);
  return [...files.values()];
}

function completed(check) {
  return ["passed", "failed"].includes(check.status) && !check.problems.length && check.trials.length === 1 &&
    check.trials.every(trial => ["passed", "failed"].includes(trial.status) && !trial.problems.length &&
      trial.observations.every(item => item.status !== "inconclusive") && trial.metrics.every(item => item.status !== "inconclusive") &&
      trial.stages.every(item => ["passed", "failed"].includes(item.status)));
}

function checkedEvidence(directory, check) {
  const files = references(check);
  for (const file of files) ensure(capture(directory, file.path).sha256 === file.sha256, `Receipt evidence changed: ${file.path}`);
  return files;
}

export function reuseReceipt(root, recipe, directory) {
  const started = Date.now();
  const location = join(evidenceStore(root).receipts, recipe.key);
  let ids;
  try { ids = readdirSync(location).filter(id => /^[0-9]+_[0-9]+_[a-f0-9-]+$/.test(id)).sort(); }
  catch (error) { if (error.code === "ENOENT") return { reason: "No receipt matches the current source, recipe, and declared inputs." }; throw error; }
  const id = ids.at(-1);
  if (!id) return { reason: "No receipt matches the current source, recipe, and declared inputs." };
  let temporary;
  try {
    const attempt = readJSON(join(location, id, "attempt.json"));
    ensure(attempt.id === id && attempt.key === recipe.key, "The latest receipt attempt is invalid.");
    const receipt = readJSON(join(location, id, "receipt.json"));
    ensure(receipt.version === 1 && receipt.id === id && receipt.key === recipe.key && receipt.resultHash === digest(receipt.check), "The latest receipt is invalid.");
    const check = receipt.check;
    ensure(check.name === recipe.name, "The latest receipt belongs to a different check.");
    validateAssessment({ plan: null, checks: [check], observations: check.observations, problems: [], status: check.status });
    ensure(check.receipt.reusable && completed(check), "The latest attempt is incomplete or inconclusive.");
    const files = checkedEvidence(receipt.directory, check);
    temporary = mkdtempSync(join(directory, ".receipt-"));
    for (const file of files) {
      const destination = join(temporary, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(within(receipt.directory, join(receipt.directory, file.path)), destination);
    }
    checkedEvidence(temporary, check);
    renameSync(join(temporary, check.name), join(directory, check.name));
    return { check: { ...check, durationMs: Date.now() - started, receipt: { ...check.receipt, id, key: recipe.key, disposition: "reused", reusable: true,
      reason: `Matching completed ${check.status} receipt with intact evidence.`, recordedAt: receipt.finishedAt } } };
  } catch (error) {
    return { reason: `The latest receipt cannot be reused: ${error.message}` };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export function beginReceipt(root, recipe, source, directory) {
  const id = `${Date.now()}_${process.hrtime.bigint().toString().padStart(20, "0")}_${randomUUID()}`;
  const location = join(evidenceStore(root).receipts, recipe.key, id);
  mkdirSync(location, { recursive: true });
  const attempt = { version: 1, id, key: recipe.key, startedAt: new Date().toISOString(), source, inputs: recipe.inputs, directory: resolve(directory) };
  writeFileSync(join(location, "attempt.json"), `${JSON.stringify(attempt, null, 2)}\n`, { flag: "wx" });
  return { ...attempt, location };
}

export function finishReceipt(attempt, check) {
  let reason = null;
  if (!completed(check)) reason = "Only completed passed or failed checks with usable evidence are reusable.";
  else {
    try { checkedEvidence(attempt.directory, check); }
    catch (error) {
      reason = error.message;
      check.problems.push(reason);
      if (check.status === "passed") check.status = "inconclusive";
      for (const observation of check.observations) if (observation.status === "passed") observation.status = "inconclusive";
    }
  }
  Object.assign(check.receipt, { run: basename(attempt.directory), startedAt: attempt.startedAt, source: attempt.source,
    executionDurationMs: check.durationMs });
  check.receipt.reusable = reason === null;
  if (reason && !check.receipt.nonReusableReason) check.receipt.nonReusableReason = reason;
  const receipt = { version: 1, id: attempt.id, key: attempt.key, directory: attempt.directory,
    finishedAt: new Date().toISOString(), check, resultHash: digest(check) };
  writeFileSync(join(attempt.location, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}
