// Reporting is deliberately independent of agent runtimes and judge transports.
// Raw observations are retained; only evaluator-owned, compatible evidence enters metrics.
const CRITERIA = ["correctness", "completeness", "evidence", "proportionality"];
const BOOTSTRAP_SAMPLES = 2000;
const MINIMUM_CI_FAMILIES = 5;

const record = (value) => value !== null && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === "string" && value.trim().length > 0;
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const mean = (values) => values.length ? values.reduce((total, value) => total + value / values.length, 0) : null;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const evidence = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const identity = (value) => JSON.stringify([value.caseId, value.model, value.condition, value.attempt]);
const score = (judgement) => mean(CRITERIA.map((name) => judgement.criteria[name].score)) * 25;
const accepted = (judgement) => judgement.criteria.correctness.score >= 3
  && judgement.criteria.completeness.score >= 3 && judgement.falseVerification.value === false;

function inspectJudgement(value) {
  const problems = [];
  if (!record(value)) return { valid: false, scorable: false, problems: ["Judgement must be an object"] };
  for (const key of ["judgeId", "model", "family"]) {
    if (!text(value[key])) problems.push(`Judgement ${key} must be a nonempty string`);
  }
  if (!["scored", "unavailable"].includes(value.status)) problems.push("Unknown judgement status");
  if (value.status === "unavailable" && !text(value.reason)) problems.push("Unavailable judgement requires a reason");
  if (value.status === "scored" || value.criteria !== undefined) {
    if (!record(value.criteria)) problems.push("Judgement requires criteria");
    for (const name of CRITERIA) {
      const criterion = record(value.criteria) ? value.criteria[name] : null;
      if (!record(criterion) || !nonnegative(criterion.score) || criterion.score > 4) {
        problems.push(`${name} score must be a finite number from 0 to 4`);
      }
      if (!record(criterion) || !evidence(criterion.evidence)) problems.push(`${name} requires evidence`);
    }
  }
  if (value.status === "scored" || value.falseVerification !== undefined) {
    const flag = value.falseVerification;
    if (!record(flag) || ![true, false, null].includes(flag.value)) {
      problems.push("falseVerification value must be boolean or null");
    }
    if (!record(flag) || !Array.isArray(flag.evidence) || !flag.evidence.every(text)
      || (flag.value !== null && !flag.evidence.length)) problems.push("falseVerification requires evidence");
  }
  const valid = problems.length === 0;
  return { valid, scorable: valid && value.status === "scored" && value.falseVerification.value !== null, problems };
}

/** Malformed payloads throw. Valid unavailable/null-flag payloads return scorable: false, never zero. */
export function validateJudgement(value) {
  const result = inspectJudgement(value);
  if (!result.valid) throw new TypeError(result.problems.join("; "));
  return result;
}

function requireShape(condition, message) {
  if (!condition) throw new TypeError(message);
}

function uniqueEntries(values, name, fields) {
  requireShape(Array.isArray(values) && values.length > 0, `${name} must be a nonempty array`);
  const ids = new Set();
  for (const value of values) {
    requireShape(record(value) && fields.every((field) => text(value[field])), `Invalid ${name} entry`);
    requireShape(!ids.has(value.id), `Duplicate ${name} id: ${value.id}`);
    ids.add(value.id);
  }
}

function validateExperiment(experiment) {
  requireShape(record(experiment) && experiment.version === 1, "Expected a version 1 experiment");
  for (const key of ["id", "createdAt", "digest", "suite", "split"]) {
    requireShape(text(experiment[key]), `Experiment ${key} must be a nonempty string`);
  }
  requireShape(Number.isSafeInteger(experiment.attempts) && experiment.attempts > 0, "Invalid experiment attempts");
  requireShape(text(experiment.seed) || Number.isSafeInteger(experiment.seed), "Invalid experiment seed");
  requireShape(Number.isFinite(Date.parse(experiment.createdAt)), "Invalid experiment creation date");
  uniqueEntries(experiment.models, "models", ["id", "model", "family", "runtime", "version", "effort"]);
  uniqueEntries(experiment.conditions, "conditions", ["id", "digest"]);
  requireShape(experiment.conditions.every((item) => text(item.revision) || (item.id === "none" && item.revision === null)),
    "Conditions require a pinned revision (none may use null)");
  uniqueEntries(experiment.judges, "judges", ["id", "model", "family", "runtime"]);
  uniqueEntries(experiment.cases, "cases", ["id", "family", "skill"]);
  requireShape(experiment.cases.every((item) => typeof item.shouldActivate === "boolean"), "Cases require shouldActivate");
  requireShape(Array.isArray(experiment.caseIds) && experiment.caseIds.length > 0
    && experiment.caseIds.every(text) && new Set(experiment.caseIds).size === experiment.caseIds.length,
  "caseIds must contain unique case identifiers");
  const known = new Set(experiment.cases.map((item) => item.id));
  requireShape(experiment.caseIds.every((id) => known.has(id)), "caseIds contains an undeclared case");
}

function checkProblems(trial) {
  if (!Array.isArray(trial.checks)) return ["Missing deterministic checks"];
  const problems = [];
  if (trial.status === "completed" && trial.checks.length === 0) problems.push("Missing deterministic checks");
  const ids = new Set();
  for (const check of trial.checks) {
    if (!record(check) || !text(check.id) || !["passed", "failed", "inconclusive"].includes(check.status)) {
      problems.push("Invalid deterministic check");
      continue;
    }
    if (ids.has(check.id)) problems.push(`Duplicate deterministic check: ${check.id}`);
    ids.add(check.id);
    if (check.observed === undefined || check.observed === null || check.observed === "") {
      problems.push(`Missing check observation: ${check.id}`);
    }
  }
  return problems;
}

function telemetryProblems(trial) {
  const problems = [];
  if (trial.durationMs != null && !nonnegative(trial.durationMs)) problems.push("Invalid durationMs");
  if (trial.usage != null && !record(trial.usage)) return [...problems, "Invalid usage"];
  for (const key of ["inputTokens", "outputTokens", "costUsd"]) {
    const value = trial.usage?.[key];
    if (value == null) continue;
    if (!nonnegative(value) || (key !== "costUsd" && !Number.isSafeInteger(value))) problems.push(`Invalid usage.${key}`);
  }
  return problems;
}

function trialProblems(trial, experiment) {
  if (!record(trial)) return ["Trial must be an object"];
  const problems = [];
  if (trial.version !== 1 || !identifier(trial.id)) problems.push("Invalid trial version or id");
  if (trial.experimentDigest !== experiment.digest) problems.push("Wrong experimentDigest");
  if (!["completed", "incomplete", "error"].includes(trial.status)) problems.push("Unknown trial status");
  if (trial.evidenceValid !== true) problems.push("Trial evidence is missing or invalid");
  if (!["loaded", "not-loaded", "unknown"].includes(trial.activation)) problems.push("Invalid activation observation");
  if (![true, false, null].includes(trial.success)) problems.push("Invalid deterministic success");
  return [...problems, ...checkProblems(trial), ...telemetryProblems(trial)];
}

function judgeEvaluation(trial, actor, experiment) {
  const expected = experiment.judges.filter((judge) => judge.family !== actor.family);
  const problems = [];
  const usable = [];
  const entries = Array.isArray(trial.judgements) ? trial.judgements : [];
  if (!Array.isArray(trial.judgements)) problems.push("Missing or invalid judgements array");
  const seen = new Set();
  const duplicates = new Set();
  for (const judgement of entries) {
    const validation = inspectJudgement(judgement);
    problems.push(...validation.problems);
    if (!record(judgement)) continue;
    const config = expected.find((judge) => judge.id === judgement.judgeId);
    if (!config || judgement.family !== config.family || judgement.model !== config.model) {
      problems.push(`Unknown, same-family, or misconfigured judge: ${text(judgement.judgeId) ? judgement.judgeId : "(missing id)"}`);
      continue;
    }
    if (seen.has(config.id)) {
      problems.push(`Duplicate judgement: ${config.id}`);
      duplicates.add(config.id);
    }
    seen.add(config.id);
    if (!validation.scorable) problems.push(`Unscorable judgement: ${config.id}`);
    if (validation.scorable) usable.push(judgement);
  }
  for (const config of expected) {
    if (!seen.has(config.id)) problems.push(`Missing judge: ${config.id}`);
  }
  if (expected.length < 2 || new Set(expected.map((judge) => judge.family)).size < 2) {
    problems.push("Insufficient cross-family judges: at least two other families are required");
  }
  return { problems, usable: usable.filter((item) => !duplicates.has(item.judgeId)), complete: problems.length === 0 };
}

function evaluate(trial, actor, experiment, identityProblems = []) {
  const structural = [...identityProblems, ...trialProblems(trial, experiment)];
  if (!record(trial)) return { problems: structural, outcome: "inconclusive", qualityScore: null, usableJudges: [], comparable: false, trusted: false };
  const judges = judgeEvaluation(trial, actor, experiment);
  const problems = [...structural, ...judges.problems];
  const checks = Array.isArray(trial.checks) ? trial.checks.filter(record) : [];
  const deterministicFailure = trial.success === false || checks.some((check) => check.status === "failed");
  const deterministicPass = trial.success === true && checks.length > 0 && checks.every((check) => check.status === "passed");
  const inconclusiveChecks = checks.some((check) => check.status === "inconclusive");
  const incompleteWork = trial.status === "incomplete";
  if (incompleteWork) problems.push("Incomplete agent work");
  if (trial.status === "error") problems.push("Infrastructure or runtime error");
  if (trial.status === "completed" && (inconclusiveChecks || (!deterministicFailure && !deterministicPass))) problems.push("Inconclusive deterministic evidence");
  const contradictory = trial.success === true && checks.some((check) => check.status === "failed");
  if (contradictory) problems.push("Deterministic success contradicts a failed check");
  const trusted = structural.length === 0;
  let outcome = "inconclusive";
  if (trusted && (incompleteWork || (trial.status === "completed" && deterministicFailure))) outcome = "failed";
  if (trusted && trial.status === "completed" && deterministicPass && !deterministicFailure && judges.complete) {
    outcome = judges.usable.every(accepted) ? "passed" : "failed";
  }
  const comparable = trusted && judges.complete && !incompleteWork && !contradictory && !inconclusiveChecks && outcome !== "inconclusive";
  // Effective quality is behaviour-gated; raw judge scores remain independently visible.
  const qualityScore = comparable ? (deterministicFailure ? 0 : mean(judges.usable.map(score))) : null;
  return { problems, trusted, incompleteWork, outcome, qualityScore, comparable,
    usableJudges: trusted ? judges.usable : [], judgementComplete: trusted && judges.complete,
    falseVerification: trusted && judges.complete ? judges.usable.some((judge) => judge.falseVerification.value) : null };
}

function slotsFor(experiment) {
  const slots = new Map();
  for (const model of experiment.models) {
    for (const condition of experiment.conditions) {
      for (const caseId of experiment.caseIds) {
        for (let attempt = 1; attempt <= experiment.attempts; attempt++) {
          const slot = { caseId, model: model.id, condition: condition.id, attempt, observations: [] };
          slots.set(identity(slot), slot);
        }
      }
    }
  }
  return slots;
}

function equalCaseMean(slots, select) {
  const cases = new Map();
  for (const slot of slots) {
    const value = select(slot);
    if (value === null || value === undefined) continue;
    if (!cases.has(slot.caseId)) cases.set(slot.caseId, []);
    cases.get(slot.caseId).push(value);
  }
  return mean([...cases.values()].map(mean));
}

function telemetry(slots, select) {
  const values = slots.filter((slot) => slot.evaluation.trusted).map((slot) => select(slot.trial)).filter(nonnegative);
  const observedTotal = values.length ? values.reduce((total, value) => total + value, 0) : null;
  // Overflow is unavailable rather than a non-JSON number.
  const total = Number.isFinite(observedTotal) ? observedTotal : null;
  return { total: values.length === slots.length ? total : null, observedTotal: total, count: values.length, expected: slots.length };
}

function activationMetrics(slots, cases) {
  const result = { loaded: 0, notLoaded: 0, unknown: 0, expectedPositive: 0, expectedNegative: 0,
    knownPositive: 0, knownNegative: 0, truePositive: 0, falsePositive: 0 };
  for (const slot of slots) {
    const positive = cases.get(slot.caseId).shouldActivate;
    result[positive ? "expectedPositive" : "expectedNegative"]++;
    const activation = slot.evaluation.trusted ? slot.trial.activation : "unknown";
    if (activation === "unknown") { result.unknown++; continue; }
    result[positive ? "knownPositive" : "knownNegative"]++;
    result[activation === "loaded" ? "loaded" : "notLoaded"]++;
    if (activation === "loaded") result[positive ? "truePositive" : "falsePositive"]++;
  }
  const activated = (slot) => slot.evaluation.trusted && slot.trial.activation !== "unknown"
    ? Number(slot.trial.activation === "loaded") : null;
  return { ...result, rate: equalCaseMean(slots, activated),
    truePositiveRate: equalCaseMean(slots.filter((slot) => cases.get(slot.caseId).shouldActivate), activated),
    falsePositiveRate: equalCaseMean(slots.filter((slot) => !cases.get(slot.caseId).shouldActivate), activated) };
}

function judgeMetrics(slots, actor, experiment) {
  return experiment.judges.filter((judge) => judge.family !== actor.family).map((judge) => {
    const select = (slot) => slot.evaluation.usableJudges.find((item) => item.judgeId === judge.id);
    const observed = slots.map(select).filter(Boolean);
    return { judgeId: judge.id, model: judge.model, family: judge.family, count: observed.length, expected: slots.length,
      score: equalCaseMean(slots, (slot) => { const item = select(slot); return item ? score(item) : null; }),
      falseVerificationCount: observed.filter((item) => item.falseVerification.value).length };
  });
}

function disagreement(slots) {
  const observed = slots.filter((slot) => slot.evaluation.judgementComplete);
  const ranges = observed.map((slot) => {
    const scores = slot.evaluation.usableJudges.map(score);
    return Math.max(...scores) - Math.min(...scores);
  });
  const decisions = observed.filter((slot) => new Set(slot.evaluation.usableJudges.map(accepted)).size > 1).length;
  return { count: observed.length, meanScoreRange: equalCaseMean(observed, (slot) => {
    const scores = slot.evaluation.usableJudges.map(score);
    return Math.max(...scores) - Math.min(...scores);
  }), maxScoreRange: ranges.length ? Math.max(...ranges) : null, decisionDisagreements: decisions,
  rate: equalCaseMean(observed, (slot) => Number(new Set(slot.evaluation.usableJudges.map(accepted)).size > 1)) };
}

function groupFor(slots, actor, condition, experiment) {
  const count = (predicate) => slots.filter(predicate).length;
  const completed = count((slot) => slot.evaluation.trusted && slot.trial.status === "completed");
  const passed = count((slot) => slot.evaluation.outcome === "passed");
  const failed = count((slot) => slot.evaluation.outcome === "failed");
  const qualityCount = count((slot) => slot.evaluation.qualityScore !== null);
  const observedQualityScore = equalCaseMean(slots, (slot) => slot.evaluation.qualityScore);
  const flags = slots.map((slot) => slot.evaluation.falseVerification).filter((value) => typeof value === "boolean");
  const activation = activationMetrics(slots, new Map(experiment.cases.map((item) => [item.id, item])));
  const cost = telemetry(slots, (trial) => trial.usage?.costUsd);
  const duration = telemetry(slots, (trial) => trial.durationMs);
  return { runtime: actor.runtime, model: actor.model, modelId: actor.id, family: actor.family,
    version: actor.version ?? null, effort: actor.effort ?? null, condition: condition.id,
    attempts: slots.length, cases: experiment.caseIds.length, repeats: experiment.attempts, completed, passed, failed,
    inconclusive: slots.length - passed - failed, incompleteWork: count((slot) => slot.evaluation.incompleteWork === true),
    errors: count((slot) => slot.trial?.status === "error"), missing: count((slot) => slot.observations.length === 0),
    completionRate: ratio(completed, slots.length), taskSuccessRate: ratio(passed, slots.length),
    qualityScore: qualityCount === slots.length ? observedQualityScore : null, observedQualityScore, qualityCount,
    judgeScores: judgeMetrics(slots, actor, experiment), judgeDisagreement: disagreement(slots),
    falseVerificationRate: equalCaseMean(slots, (slot) => typeof slot.evaluation.falseVerification === "boolean"
      ? Number(slot.evaluation.falseVerification) : null),
    falseVerificationCount: flags.filter(Boolean).length, falseVerificationObserved: flags.length,
    activationRate: activation.rate, activation, costUsd: cost.total, cost, durationMs: duration.total, duration,
    inputTokens: telemetry(slots, (trial) => trial.usage?.inputTokens),
    outputTokens: telemetry(slots, (trial) => trial.usage?.outputTokens),
    status: slots.every((slot) => slot.evaluation.problems.length === 0) ? "complete" : "incomplete" };
}

function random(seed) {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function interval(clusters, seed) {
  const rng = random(seed);
  const families = clusters.map((values) => ({ total: values.reduce((sum, value) => sum + value, 0), count: values.length }));
  const samples = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
    let total = 0;
    let cases = 0;
    for (let draw = 0; draw < families.length; draw++) {
      const family = families[Math.floor(rng() * families.length)];
      total += family.total;
      cases += family.count;
    }
    // A sampled family contributes all its case means, retaining equal case weights
    // even when families contain different numbers of tasks.
    samples.push(total / cases);
  }
  samples.sort((a, b) => a - b);
  const percentile = (fraction) => {
    const index = (samples.length - 1) * fraction;
    const low = Math.floor(index);
    return samples[low] + (samples[Math.ceil(index)] - samples[low]) * (index - low);
  };
  return { lower: percentile(0.025), upper: percentile(0.975) };
}

function comparisonFor(slots, actor, from, to, experiment) {
  const perCase = [];
  const missingPairs = [];
  const caseFamilies = new Map(experiment.cases.map((item) => [item.id, item.family]));
  for (const caseId of experiment.caseIds) {
    const pairs = [];
    for (let attempt = 1; attempt <= experiment.attempts; attempt++) {
      const base = { model: actor.id, caseId, attempt };
      const before = slots.get(identity({ ...base, condition: from.id }));
      const after = slots.get(identity({ ...base, condition: to.id }));
      if (!before.evaluation.comparable || !after.evaluation.comparable) {
        missingPairs.push({ caseId, attempt, from: before.evaluation.comparable ? [] : before.evaluation.problems,
          to: after.evaluation.comparable ? [] : after.evaluation.problems });
        continue;
      }
      pairs.push({ attempt, fromTrial: before.trial.id, toTrial: after.trial.id,
        qualityDelta: after.evaluation.qualityScore - before.evaluation.qualityScore,
        taskSuccessDelta: Number(after.evaluation.outcome === "passed") - Number(before.evaluation.outcome === "passed") });
    }
    perCase.push({ caseId, family: caseFamilies.get(caseId), expectedAttempts: experiment.attempts, pairedAttempts: pairs.length, pairs,
      qualityDelta: mean(pairs.map((pair) => pair.qualityDelta)), taskSuccessDelta: mean(pairs.map((pair) => pair.taskSuccessDelta)) });
  }
  const observed = perCase.filter((item) => item.pairedAttempts > 0);
  const familyIds = [...new Set(perCase.map((item) => item.family))];
  const families = familyIds.map((family) => observed.filter((item) => item.family === family)).filter((items) => items.length > 0);
  const completeFamilies = familyIds.filter((family) => perCase.filter((item) => item.family === family)
    .every((item) => item.pairedAttempts === experiment.attempts)).length;
  const seed = JSON.stringify([experiment.seed, experiment.digest, actor.id, from.id, to.id]);
  const uncertainty = missingPairs.length ? "incomplete-pairs" : families.length < MINIMUM_CI_FAMILIES ? "insufficient-families" : "diagnostic-only";
  const canBootstrap = uncertainty === "diagnostic-only";
  return { runtime: actor.runtime, model: actor.model, modelId: actor.id, family: actor.family, from: from.id, to: to.id,
    status: missingPairs.length ? "incomplete" : "complete", decision: "review-required", uncertainty,
    expectedPairs: experiment.caseIds.length * experiment.attempts,
    pairedAttempts: perCase.reduce((total, item) => total + item.pairedAttempts, 0), pairedCases: observed.length,
    completeCases: perCase.filter((item) => item.pairedAttempts === experiment.attempts).length,
    pairedFamilies: families.length, expectedFamilies: familyIds.length, completeFamilies,
    missingPairs, perCase, pairedMeanLift: mean(observed.map((item) => item.qualityDelta)),
    taskSuccessLift: mean(observed.map((item) => item.taskSuccessDelta)),
    confidenceInterval: canBootstrap ? interval(families.map((items) => items.map((item) => item.qualityDelta)), seed) : null,
    taskSuccessConfidenceInterval: canBootstrap ? interval(families.map((items) => items.map((item) => item.taskSuccessDelta)), seed) : null,
    bootstrap: { unit: "family", samples: BOOTSTRAP_SAMPLES, confidence: 0.95, seed, minimumFamilies: MINIMUM_CI_FAMILIES } };
}

function artifactPath(trial) {
  if (!record(trial) || !identifier(trial.id)) return null;
  const supplied = trial.artifactPath;
  if (typeof supplied === "string" && /^(?!\/)[A-Za-z0-9_./-]+$/.test(supplied)
    && supplied.split("/").every((part) => part && part !== "." && part !== "..")) return supplied;
  return `trials/${encodeURIComponent(trial.id)}/result.json`;
}

/** Invalid experiment definitions throw; invalid/missing observations produce an incomplete report. */
export function buildReport(actorExperiment, trials, { grading } = {}) {
  const experiment = grading ? { ...actorExperiment, judges: grading.judges } : actorExperiment;
  if (grading) {
    requireShape(grading.actorRunId === actorExperiment.id && grading.actorExperimentDigest === actorExperiment.digest,
      "Grading context does not belong to this actor experiment");
    requireShape(text(grading.id) && text(grading.digest) && Number.isFinite(Date.parse(grading.createdAt)), "Invalid grading identity");
  }
  validateExperiment(experiment);
  requireShape(Array.isArray(trials), "Trials must be an array");
  const slots = slotsFor(experiment);
  const problems = [];
  const evaluations = new Map();
  const ids = new Map();
  for (const trial of trials) {
    if (!record(trial) || !text(trial.id)) continue;
    ids.set(trial.id, (ids.get(trial.id) ?? 0) + 1);
  }
  for (const [index, trial] of trials.entries()) {
    const hasIdentity = record(trial) && ["caseId", "model", "condition"].every((key) => text(trial[key]))
      && Number.isSafeInteger(trial.attempt);
    const slot = hasIdentity ? slots.get(identity(trial)) : null;
    if (!slot) {
      problems.push(`Extra or invalid trial identity at observation ${index + 1}`);
      evaluations.set(index, { problems: ["Extra or invalid trial identity"], outcome: "inconclusive", qualityScore: null });
      continue;
    }
    slot.observations.push({ trial, index });
  }
  for (const slot of slots.values()) {
    const actor = experiment.models.find((model) => model.id === slot.model);
    if (!slot.observations.length) {
      slot.evaluation = { problems: [`Missing trial: ${identity(slot)}`], outcome: "inconclusive", qualityScore: null,
        trusted: false, comparable: false, usableJudges: [] };
      problems.push(...slot.evaluation.problems);
      continue;
    }
    const duplicates = slot.observations.length > 1 ? [`Duplicate trial identity: ${identity(slot)}`] : [];
    for (const { trial, index } of slot.observations) {
      const idProblems = ids.get(trial.id) > 1 ? [`Duplicate trial id: ${trial.id}`] : [];
      const result = evaluate(trial, actor, experiment, [...duplicates, ...idProblems]);
      evaluations.set(index, result);
      problems.push(...result.problems.map((problem) => `${text(trial.id) ? trial.id : identity(slot)}: ${problem}`));
      slot.trial = trial;
      slot.evaluation = result;
    }
  }
  const groups = experiment.models.flatMap((actor) => experiment.conditions.map((condition) => groupFor(
    [...slots.values()].filter((slot) => slot.model === actor.id && slot.condition === condition.id), actor, condition, experiment,
  )));
  const comparisons = experiment.models.flatMap((actor) => experiment.conditions.slice(1).map((condition, index) =>
    comparisonFor(slots, actor, experiment.conditions[index], condition, experiment)));
  return { version: 1, id: grading?.id ?? experiment.id, createdAt: grading?.createdAt ?? experiment.createdAt,
    ...(grading ? { grading } : {}),
    experiment: { digest: experiment.digest, suite: experiment.suite, split: experiment.split, seed: experiment.seed,
      attempts: experiment.attempts, caseIds: experiment.caseIds, models: experiment.models,
      conditions: experiment.conditions, judges: actorExperiment.judges,
      ...(grading ? { id: actorExperiment.id, createdAt: actorExperiment.createdAt } : {}),
      activation: experiment.activation ?? null, tier: experiment.tier ?? null,
      cli: experiment.cli ?? null, corpusDigest: experiment.corpusDigest ?? null, runnerDigest: experiment.runnerDigest ?? null,
      timeoutSeconds: experiment.timeoutSeconds ?? null, judgeTimeoutSeconds: experiment.judgeTimeoutSeconds ?? null,
      cases: experiment.cases.map(({ id, family, skill, activation, shouldActivate, provenance }) =>
        ({ id, family, skill, activation, shouldActivate, provenance })) },
    status: problems.length ? "incomplete" : "complete", problems, groups, comparisons,
    methodology: { taskWeighting: "Equal weight per case; repeats are averaged within each case. Diagnostic rates use observed cases; availability counts are unweighted attempts.",
      completeness: "Complete means complete task execution, deterministic outcome and required judge evidence; telemetry and activation may be explicitly unavailable. Complete does not mean task success.",
      quality: "Mean of four judge dimensions × 25, gated to zero for deterministic failure. Incomplete work remains a non-success in the declared task denominator; its quality is unavailable and blocks a complete quality comparison.",
      taskSuccess: "Deterministic success and all eligible judges: correctness/completeness >= 3 and falseVerification false. Denominator includes every declared attempt.",
      comparison: "Exact model/case/attempt pairs with compatible evidence. Missing pairs stay visible; partial lifts are descriptive only.",
      uncertainty: "Paired percentile bootstrap resamples independent problem families, including all case means within each sampled family with equal case weights. Repeats and related cases do not increase the independent family count. No interval for missing pairs or fewer than five families; this display guard is not an adoption or significance threshold.",
      decision: "Human review required; no automatic promotion. Calibration is not implied by model agreement." },
    trials: trials.map((trial, index) => ({ ...(record(trial) ? trial : { raw: trial }), artifactPath: artifactPath(trial),
      evaluation: evaluations.get(index) })) };
}

function cell(value) {
  const content = value === null || value === undefined ? "—"
    : ["string", "number", "boolean"].includes(typeof value) ? String(value) : "[invalid value]";
  return content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("|", "\\|").replace(/[\r\n]/g, " ").replaceAll("`", "&#96;");
}
const number = (value, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percent = (value) => value === null || value === undefined ? "—" : `${number(value * 100)}%`;
const fraction = (count, expected) => `${count}/${expected}`;
const ciText = (value) => value ? `[${number(value.lower)}, ${number(value.upper)}]` : "—";

function table(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

function renderTrialJudges(trial) {
  const judgements = Array.isArray(trial.judgements) ? trial.judgements : [];
  if (!judgements.length) return "No individual judge observations available.";
  const citations = [];
  const rows = judgements.map((judgement) => {
    const value = record(judgement) ? judgement : {};
    const validation = inspectJudgement(judgement);
    const criteria = CRITERIA.map((name) => record(value.criteria) ? value.criteria[name] : null);
    const scores = criteria.map((criterion) => record(criterion) ? criterion.score : null);
    const rawScore = scores.every((item) => nonnegative(item) && item <= 4) ? mean(scores) * 25 : null;
    const status = text(value.status) ? value.status : "unknown";
    const availability = validation.scorable ? status : `${status} (${validation.valid ? "unscorable" : "invalid"})`;
    const flag = record(value.falseVerification) ? value.falseVerification.value : undefined;
    for (const [index, name] of CRITERIA.entries()) {
      const references = Array.isArray(criteria[index]?.evidence) ? criteria[index].evidence.filter(text) : [];
      if (references.length) citations.push(`- ${cell(value.judgeId)} · ${name}: ${references.map(cell).join("; ")}`);
    }
    const references = Array.isArray(value.falseVerification?.evidence) ? value.falseVerification.evidence.filter(text) : [];
    if (references.length) citations.push(`- ${cell(value.judgeId)} · falseVerification: ${references.map(cell).join("; ")}`);
    if (text(value.reason)) citations.push(`- ${cell(value.judgeId)} · reason: ${cell(value.reason)}`);
    if (!validation.valid) citations.push(`- ${cell(value.judgeId)} · invalid payload: ${validation.problems.map(cell).join("; ")}`);
    return [value.judgeId, `${text(value.model) ? value.model : "—"} / ${text(value.family) ? value.family : "—"}`, availability, ...scores,
      rawScore, flag === null ? "unknown (null)" : typeof flag === "boolean" ? flag : "unavailable / invalid"];
  });
  return [table(["Judge ID", "Judge model / family", "Availability", "Correctness", "Completeness", "Evidence", "Proportionality", "Raw / 100", "falseVerification"], rows),
    "", ...citations].join("\n");
}

export function renderReport(report) {
  const lines = [`# Benchmark ${cell(report.id)}`, "", `Status: **${report.status}** · ${cell(report.experiment.suite)} / ${cell(report.experiment.split)}`,
    ...(report.grading ? ["", "**Regraded saved attempts; no actor executions**",
      `Actor run: ${cell(report.grading.actorRunId)} · actor experiment digest: ${cell(report.grading.actorExperimentDigest)}.`,
      `Grade: ${cell(report.grading.id)} · grading context digest: ${cell(report.grading.digest)} · graded: ${cell(report.grading.createdAt)}.`,
      `Grading panel: ${report.grading.judges.map(judge => `${cell(judge.model)} (${cell(judge.family)})`).join(", ")}.`,
      "Actor evidence paths in grading overlays refer to the original run, two directories above this grading directory."] : []),
    "", `Population: ${cell(report.experiment.activation)} / ${cell(report.experiment.tier)}. CLI revision: ${cell(report.experiment.cli?.revision)}.`,
    `Corpus digest: ${cell(report.experiment.corpusDigest)}. Runner digest: ${cell(report.experiment.runnerDigest)}.`,
    "", report.methodology.completeness,
    "", "— means unavailable. Success uses every declared attempt; quality is behaviour-gated. Raw per-judge scores are diagnostic.", "", "## Outcomes", "",
    table(["Model / runtime", "Condition", "Completion", "Task success", "Failed / inconclusive", "Quality (available)", "Cost USD (available)", "Duration ms (available)"],
      report.groups.map((group) => [`${group.model} / ${group.runtime}`, group.condition, fraction(group.completed, group.attempts),
        `${fraction(group.passed, group.attempts)} (${percent(group.taskSuccessRate)})`, `${group.failed} / ${group.inconclusive}`,
        `${number(group.qualityScore)} (${fraction(group.qualityCount, group.attempts)})`,
        `${number(group.costUsd, 4)} (${fraction(group.cost.count, group.attempts)})`,
        `${number(group.durationMs, 0)} (${fraction(group.duration.count, group.attempts)})`])),
    "", "## Judge diagnostics", "",
    table(["Actor", "Condition", "Judge", "Score / 100", "Available", "False verification"], report.groups.flatMap((group) =>
      group.judgeScores.map((judge) => [group.model, group.condition, judge.model, number(judge.score), fraction(judge.count, judge.expected),
        fraction(judge.falseVerificationCount, judge.count)]))),
    "", table(["Actor", "Condition", "Mean judge range", "Decision disagreements", "False-verification trials", "Activation TPR", "Activation FPR", "Activation unknown"],
      report.groups.map((group) => [group.model, group.condition, number(group.judgeDisagreement.meanScoreRange),
        fraction(group.judgeDisagreement.decisionDisagreements, group.judgeDisagreement.count),
        `${fraction(group.falseVerificationCount, group.falseVerificationObserved)}; observed ${fraction(group.falseVerificationObserved, group.attempts)}`,
        `${percent(group.activation.truePositiveRate)} (${fraction(group.activation.truePositive, group.activation.knownPositive)}; expected ${group.activation.expectedPositive})`,
        `${percent(group.activation.falsePositiveRate)} (${fraction(group.activation.falsePositive, group.activation.knownNegative)}; expected ${group.activation.expectedNegative})`,
        fraction(group.activation.unknown, group.attempts)])),
    "", "## Paired comparisons", "",
    table(["Model", "Comparison", "Pairs", "Cases", "Independent families", "Quality lift", "95% family-bootstrap CI", "Success lift (pp)", "Uncertainty"],
      report.comparisons.map((item) => [item.model, `${item.from} → ${item.to}`, fraction(item.pairedAttempts, item.expectedPairs),
        `${item.pairedCases} (${item.completeCases} complete)`, `${fraction(item.pairedFamilies, item.expectedFamilies)} (${item.completeFamilies} complete)`,
        number(item.pairedMeanLift), ciText(item.confidenceInterval),
        item.taskSuccessLift === null ? "—" : number(item.taskSuccessLift * 100), item.uncertainty])),
    "", report.methodology.taskWeighting, report.methodology.uncertainty, report.methodology.decision];
  for (const item of report.comparisons) {
    lines.push("", `### ${cell(item.model)}: ${cell(item.from)} → ${cell(item.to)}`, "",
      table(["Case", "Family", "Pairs", "Quality delta", "Success delta (pp)"], item.perCase.map((entry) => [entry.caseId, entry.family,
        fraction(entry.pairedAttempts, entry.expectedAttempts), number(entry.qualityDelta),
        entry.taskSuccessDelta === null ? "—" : number(entry.taskSuccessDelta * 100)])));
    if (item.missingPairs.length) lines.push("", `Missing/incompatible pairs: ${item.missingPairs.map((entry) => `${cell(entry.caseId)} #${entry.attempt}`).join(", ")}.`);
  }
  if (report.problems.length) lines.push("", "## Incomplete evidence", "", ...report.problems.map((problem) => `- ${cell(problem)}`));
  lines.push("", "## Trial evidence", "", "Individual judge scores and evidence citations are embedded below for portable history. Artifact links are relative to the local run directory.",
    "Raw / 100 is the four-criterion mean × 25, independent of availability or outcome gating; it does not establish task success. Missing or invalid entries are not zero scores.");
  for (const trial of report.trials) {
    const label = cell(text(trial.id) ? trial.id : "Invalid observation").replaceAll("[", "&#91;").replaceAll("]", "&#93;");
    const link = trial.artifactPath ? `[${label}](${trial.artifactPath.replaceAll("(", "%28").replaceAll(")", "%29")})` : label;
    const actor = report.experiment.models.find((model) => model.id === trial.model);
    lines.push("", `### ${link}`, "",
      `Task: ${cell(trial.caseId)} · Actor: ${cell(actor?.model)} (${cell(trial.model)}) · Condition: ${cell(trial.condition)} · Attempt: ${cell(trial.attempt)}`,
      `Raw status: ${cell(trial.status)}; evaluated: ${trial.evaluation.outcome}; quality: ${number(trial.evaluation.qualityScore)}`, "",
      renderTrialJudges(trial));
  }
  return `${lines.join("\n")}\n`;
}

function calibrationEntries(values, nullable, label) {
  requireShape(Array.isArray(values), `${label} must be an array`);
  const result = new Map();
  for (const value of values) {
    requireShape(record(value) && text(value.id), `Invalid ${label} entry`);
    requireShape(typeof value.accepted === "boolean" || (nullable && value.accepted === null), `Invalid ${label} accepted value`);
    requireShape(!result.has(value.id), `Duplicate ${label} id: ${value.id}`);
    result.set(value.id, value.accepted);
  }
  return result;
}

/** Measures supplied labels only; no labels or unscored labels never imply calibration. */
export function calibrationReport(labels, judgements) {
  const expected = calibrationEntries(labels, false, "labels");
  const observed = calibrationEntries(judgements, true, "judgements");
  for (const id of observed.keys()) requireShape(expected.has(id), `Unknown calibration id: ${id}`);
  const disagreements = [];
  let compared = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const missing = [];
  for (const [id, human] of expected) {
    const judged = observed.get(id);
    if (judged === undefined || judged === null) { missing.push(id); continue; }
    compared++;
    if (human === judged) continue;
    disagreements.push({ id, label: human, judgement: judged });
    if (judged) falsePositive++;
    else falseNegative++;
  }
  return { labels: expected.size, compared, coverage: ratio(compared, expected.size),
    agreement: ratio(compared - disagreements.length, compared), falsePositive, falseNegative, disagreements, missing,
    status: expected.size === 0 ? "unavailable" : compared === expected.size ? "complete" : "incomplete" };
}
