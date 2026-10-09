import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export const statuses = ["passed", "failed", "inconclusive"];
export const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const text = value => typeof value === "string" && value.trim().length > 0;
export const strings = value => Array.isArray(value) && value.every(text);

export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

export function safePath(value) {
  return text(value) && !isAbsolute(value) && !value.includes("\\") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

export function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read ${path}: ${error.message}`); }
}

export function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function within(root, path) {
  const base = realpathSync(root);
  const resolved = realpathSync(path);
  ensure(resolved === base || resolved.startsWith(`${base}${sep}`), `Path leaves its evidence directory: ${path}`);
  return resolved;
}

export function context(value = {}) {
  ensure(object(value) && Object.entries(value).every(([key, item]) => text(key) &&
    (item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))), "Context must contain named scalar values.");
  return { ...value };
}

export function validatePlan(value) {
  ensure(object(value) && Object.keys(value).every(key => ["goal", "requirements"].includes(key)) && text(value.goal) &&
    Array.isArray(value.requirements) && value.requirements.length > 0, "A verification plan needs a goal and at least one requirement.");
  const ids = new Set();
  const requirements = value.requirements.map(item => {
    ensure(object(item) && Object.keys(item).every(key => ["id", "expect", "checks", "behaviours"].includes(key)) &&
      text(item.id) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(item.id) && text(item.expect) &&
      (item.checks === undefined || strings(item.checks)) && (item.behaviours === undefined || strings(item.behaviours)), "Invalid verification requirement; use id, expect, and optional checks/behaviours.");
    ensure(!ids.has(item.id), `Duplicate requirement: ${item.id}`);
    ids.add(item.id);
    return Object.freeze({ id: item.id, expect: item.expect,
      checks: Object.freeze([...(item.checks || [])]), behaviours: Object.freeze([...(item.behaviours || [])]) });
  });
  return Object.freeze({ goal: value.goal, requirements: Object.freeze(requirements) });
}

export function withInvariants(plan, config, ids) {
  if (!ids.length) return plan;
  const requirements = [...(plan?.requirements || [])];
  for (const id of ids) {
    const rule = config.invariants[id];
    const requirementId = `invariant:${id}`;
    ensure(!requirements.some(item => item.id === requirementId), `Requirement ID is reserved for the project invariant: ${requirementId}`);
    requirements.push({ id: requirementId, expect: rule.description, checks: rule.checks, behaviours: [id] });
  }
  return validatePlan({ goal: plan?.goal || "Preserve project invariants", requirements });
}

export function capture(root, path, boundary = root) {
  ensure(safePath(path), `Invalid evidence path: ${path}`);
  const file = within(boundary, resolve(root, path));
  const metadata = statSync(file);
  ensure(metadata.isFile() && metadata.size > 0, `Evidence is missing or empty: ${path}`);
  return { path, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

export function inspectObservations(values, root, { prefix = "", producer = "driver", covers = [], forbidden = [], check = null, trial = null, boundary = root } = {}) {
  ensure(Array.isArray(values), "Observations must be an array.");
  const observations = [];
  const problems = [];
  for (const [index, value] of values.entries()) {
    ensure(object(value) && Object.keys(value).every(key => ["id", "covers", "status", "observed", "evidence", "kind"].includes(key)) &&
      (value.id === undefined || text(value.id)) && (value.covers === undefined || strings(value.covers)) &&
      statuses.includes(value.status) && text(value.observed) && strings(value.evidence) && value.evidence.every(safePath) &&
      (value.kind === undefined || ["assertion", "review", "measurement"].includes(value.kind)), "Invalid observation; supply status, observed, evidence, and optional id/covers/kind.");
    const evidence = [];
    let valid = value.evidence.length > 0;
    for (const item of value.evidence) {
      const path = prefix ? `${prefix}/${item}` : item;
      try {
        ensure(!forbidden.includes(path), "A report cannot serve as evidence for its own claims.");
        const file = within(boundary, resolve(root, path));
        const selfReference = forbidden.some(forbiddenPath => {
          try { return realpathSync(resolve(root, forbiddenPath)) === file; } catch { return false; }
        });
        ensure(!selfReference, "A report cannot serve as evidence for its own claims.");
        evidence.push(capture(root, path, boundary));
      } catch (error) {
        valid = false;
        problems.push(error.message);
      }
    }
    if (!valid && value.status !== "inconclusive" && !value.evidence.length) problems.push(`No evidence supplied for observation ${value.id || index + 1}.`);
    observations.push({ id: `${producer}.${check || "check"}.${trial || 1}.${value.id || index + 1}`,
      covers: [...(value.covers || covers)], status: valid ? value.status : "inconclusive", observed: value.observed,
      kind: producer === "agent" ? "review" : value.kind || "assertion", producer, check, trial, evidence });
  }
  return { observations, problems };
}

export function inspectDriver(path, root, options) {
  within(options.boundary || root, path);
  const value = readJSON(path);
  ensure(object(value) && Object.keys(value).every(key => ["observations", "measurements", "context"].includes(key)), "Driver result must contain observations, measurements, or context.");
  const result = inspectObservations(value.observations || [], root, options);
  const measurements = [];
  ensure(value.measurements === undefined || Array.isArray(value.measurements), "Measurements must be an array.");
  const names = new Set();
  for (const metric of value.measurements || []) {
    ensure(object(metric) && Object.keys(metric).every(key => ["name", "value", "unit"].includes(key)) &&
      text(metric.name) && Number.isFinite(metric.value) && text(metric.unit) && !names.has(metric.name), "Each measurement needs a unique name, finite value, and unit.");
    names.add(metric.name);
    measurements.push({ name: metric.name, value: metric.value, unit: metric.unit });
  }
  ensure(result.observations.length > 0 || measurements.length > 0, "A structured result needs an observation or measurement.");
  return { ...result, measurements, context: context(value.context) };
}

export function statusOf(values, problems = []) {
  if (values.includes("failed")) return "failed";
  if (!values.length || problems.length || values.some(status => status !== "passed")) return "inconclusive";
  return "passed";
}

export function measureBudgets(measurements, budgets) {
  const results = [];
  for (const [name, budget] of Object.entries(budgets)) {
    const metric = measurements.find(item => item.name === name);
    if (!metric || metric.unit !== budget.unit) {
      results.push({ name, status: "inconclusive", reason: `Missing ${name} measurement in ${budget.unit}.` });
      continue;
    }
    const failed = (budget.min !== undefined && metric.value < budget.min) || (budget.max !== undefined && metric.value > budget.max);
    results.push({ ...metric, min: budget.min, max: budget.max, status: failed ? "failed" : "passed", reason: failed ? `${name} is outside its configured budget.` : null });
  }
  return results;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function compareTrials(mode, baseline, candidate, budgets) {
  const results = [];
  const baseStatus = statusOf(baseline.map(item => item.status));
  const headStatus = statusOf(candidate.map(item => item.status));
  const uncertain = [...baseline, ...candidate].some(item => item.status === "inconclusive" || item.problems.length ||
    item.observations.some(observation => observation.status === "inconclusive") || item.metrics.some(metric => metric.status === "inconclusive") ||
    item.stages.some(stage => stage.phase !== "exercise" && stage.status !== "passed"));
  if (headStatus === "failed") return { status: "failed", reason: "The candidate failed verification.", measurements: results };
  if (uncertain || headStatus !== "passed" || baseStatus === "inconclusive") return { status: "inconclusive", reason: "Both revisions need a usable verification environment and retained evidence.", measurements: results };
  const contexts = [...baseline, ...candidate].map(item => JSON.stringify(Object.entries(item.context).sort(([a], [b]) => a.localeCompare(b))));
  if (new Set(contexts).size > 1) return { status: "inconclusive", reason: "Baseline and candidate workload context differs.", measurements: results };
  if (mode === "regression") {
    const reproduced = baseStatus === "failed" && baseline.some(item => item.assertionFailed);
    return { status: reproduced ? "passed" : "inconclusive",
      reason: reproduced ? "Failure reproduced on the baseline; the candidate passes." : "The expected assertion failure was not reproduced on the baseline.", measurements: results };
  }
  if (baseStatus !== "passed") return { status: "inconclusive", reason: "The baseline must complete successfully for a measurement comparison.", measurements: results };
  for (const [name, budget] of Object.entries(budgets)) {
    if (budget.maxRegressionPercent === undefined) continue;
    const samples = trials => trials.map(trial => trial.measurements.find(item => item.name === name && item.unit === budget.unit)?.value);
    const before = samples(baseline);
    const after = samples(candidate);
    if (![...before, ...after].every(Number.isFinite)) {
      results.push({ name, status: "inconclusive", reason: "Both revisions must produce the configured measurement and unit." });
      continue;
    }
    const base = median(before);
    const head = median(after);
    if (base === 0 && head !== 0) {
      results.push({ name, status: "inconclusive", reason: "A relative comparison needs a non-zero baseline." });
      continue;
    }
    const change = base === 0 ? 0 : ((head - base) / Math.abs(base)) * 100 * (budget.direction === "higher" ? -1 : 1);
    results.push({ name, unit: budget.unit, baseline: base, candidate: head, baselineSamples: before, candidateSamples: after,
      aggregation: "median", regressionPercent: change, maxRegressionPercent: budget.maxRegressionPercent,
      status: change > budget.maxRegressionPercent ? "failed" : "passed" });
  }
  return { status: statusOf(results.map(item => item.status)), reason: "Compare median measurements under the same declared workload.", measurements: results };
}

export function coverage(plan, checks, observations) {
  if (!plan) return [];
  return plan.requirements.map(requirement => {
    const targets = new Set([requirement.id, ...requirement.behaviours]);
    const linked = checks.filter(check => requirement.checks.includes(check.name) || (check.covers || []).some(id => targets.has(id)));
    const recorded = observations.filter(observation => observation.covers.some(id => targets.has(id)));
    const missing = requirement.checks.filter(name => !checks.some(check => check.name === name));
    const missingBehaviours = recorded.some(observation => observation.covers.includes(requirement.id)) ? []
      : requirement.behaviours.filter(id => !linked.some(check => (check.covers || []).includes(id)) && !recorded.some(observation => observation.covers.includes(id)));
    const values = [...linked.map(check => check.status), ...recorded.map(observation => observation.status)];
    const evidence = [...new Set([...linked.flatMap(check => [check.log, ...check.artifacts.map(item => item.path)]), ...recorded.flatMap(observation => observation.evidence.map(item => item.path))])];
    const status = statusOf(values, [...missing, ...missingBehaviours]);
    return { id: requirement.id, expect: requirement.expect,
      status: status === "passed" ? "verified" : status === "failed" ? "failed" : "unverified",
      checks: linked.map(check => check.name), observations: recorded.map(observation => observation.id), evidence,
      reason: missing.length ? `Planned checks did not run: ${missing.join(", ")}` : missingBehaviours.length ? `Behaviours were not verified: ${missingBehaviours.join(", ")}` : !values.length ? "No executed check or evidence-backed observation covers this requirement." : null };
  });
}

export function assess({ plan = null, checks = [], observations = [], problems = [], context: values = {} }) {
  const requirements = coverage(plan, checks, observations);
  const outcomes = [...checks.map(check => check.status), ...observations.map(observation => observation.status),
    ...requirements.map(item => item.status === "verified" ? "passed" : item.status === "failed" ? "failed" : "inconclusive")];
  return { plan, checks, observations, coverage: requirements, problems, context: context(values), status: statusOf(outcomes, problems) };
}

export function validateArtifact(value) {
  ensure(object(value) && safePath(value.path) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256), "Invalid saved evidence reference.");
}

export function validateCheck(value) {
  ensure(object(value) && text(value.name) && text(value.command) && text(value.expect) && statuses.includes(value.status) &&
    safePath(value.log) && (value.exitCode === null || Number.isInteger(value.exitCode)) && Number.isFinite(value.durationMs) && value.durationMs >= 0 &&
    Array.isArray(value.artifacts) && (value.covers === undefined || strings(value.covers)), "Invalid check in saved verification report.");
  for (const artifact of value.artifacts) validateArtifact(artifact);
  if (value.logHash !== undefined) ensure(typeof value.logHash === "string" && /^[a-f0-9]{64}$/.test(value.logHash), "Invalid saved log hash.");
  ensure(value.status !== "passed" || value.exitCode === 0, "A saved passing check must have exit code 0.");
  if (value.trials !== undefined) {
    ensure(Array.isArray(value.trials) && value.trials.every(trial => object(trial) && statuses.includes(trial.status)), "Invalid saved trial results.");
    ensure(value.status !== "passed" || (value.trials.length > 0 && value.trials.every(trial => trial.status === "passed")), "A passing check needs successful trials.");
  }
  if (value.trialSummary !== undefined) {
    const summary = value.trialSummary;
    ensure(object(summary) && [summary.total, summary.passed, summary.failed, summary.inconclusive].every(count => Number.isSafeInteger(count) && count >= 0) &&
      summary.total === summary.passed + summary.failed + summary.inconclusive, "Invalid trial summary.");
    ensure(value.status !== "passed" || (summary.total > 0 && summary.passed === summary.total), "A passing check needs all requested trials to pass.");
  }
  if (value.comparison !== undefined && value.comparison !== null) {
    const comparison = value.comparison;
    ensure(object(comparison) && statuses.includes(comparison.status) && text(comparison.reason) && Array.isArray(comparison.measurements), "Invalid saved comparison.");
    ensure(value.status !== "passed" || comparison.status === "passed", "An incomplete comparison cannot establish a passing check.");
    for (const metric of comparison.measurements) {
      ensure(object(metric) && text(metric.name) && statuses.includes(metric.status), "Invalid saved comparison measurement.");
      if (metric.baseline !== undefined) ensure(Number.isFinite(metric.baseline) && Number.isFinite(metric.candidate) && Number.isFinite(metric.regressionPercent) && text(metric.unit), "Invalid baseline or candidate measurement.");
    }
  }
}

export function validateAssessment(value) {
  ensure(object(value) && (value.plan === null || object(value.plan)) && Array.isArray(value.checks) && Array.isArray(value.observations) &&
    strings(value.problems) && statuses.includes(value.status), "Invalid saved verification result.");
  if (value.plan) validatePlan(value.plan);
  context(value.context);
  for (const check of value.checks) validateCheck(check);
  for (const observation of value.observations) {
    ensure(object(observation) && text(observation.id) && strings(observation.covers) && statuses.includes(observation.status) && text(observation.observed) &&
      ["assertion", "review", "measurement"].includes(observation.kind) && Array.isArray(observation.evidence), "Invalid saved observation.");
    for (const artifact of observation.evidence) validateArtifact(artifact);
    ensure(observation.status === "inconclusive" || observation.evidence.length > 0, "A verified observation needs evidence.");
  }
  return value;
}

export function refreshEvidence(root, checks, observations = []) {
  const problems = new Set();
  const cached = new Map();
  const available = artifact => {
    if (!cached.has(artifact.path)) {
      try { cached.set(artifact.path, capture(root, artifact.path)); } catch { cached.set(artifact.path, null); }
    }
    const actual = cached.get(artifact.path);
    const issue = !actual ? `Evidence is missing or empty: ${artifact.path}`
      : artifact.sha256 && artifact.sha256 !== actual.sha256 ? `evidence changed: ${artifact.path}` : null;
    if (issue) problems.add(issue);
    return !issue;
  };
  const checked = checks.map(check => {
    if (!["passed", "failed"].includes(check.status)) return check;
    const valid = [{ path: check.log, sha256: check.logHash }, ...check.artifacts].map(available).every(Boolean);
    return !valid && check.status === "passed" ? { ...check, status: "inconclusive" } : check;
  });
  const inspected = observations.map(observation => {
    const valid = observation.evidence.map(available).every(Boolean);
    return !valid ? { ...observation, status: "inconclusive" } : observation;
  });
  return { checks: checked, observations: inspected, problems: [...problems] };
}

export const exitCode = status => status === "passed" ? 0 : status === "failed" ? 1 : 2;
