import { expect, test } from "bun:test";
import { buildReport, calibrationReport, renderReport, validateJudgement } from "../.groundwork/scripts/evals/report.mjs";

function experiment(caseCount = 1, attempts = 1) {
  const cases = Array.from({ length: caseCount }, (_, index) => ({ id: `case-${index}`, family: `task-${index}`,
    skill: "implement", activation: "natural", shouldActivate: index % 2 === 0 }));
  return { version: 1, id: "benchmark", createdAt: "2026-10-11T00:00:00Z", digest: "frozen-context", suite: "skills", split: "development",
    seed: 17, attempts, caseIds: cases.map((item) => item.id), cases,
    models: [{ id: "actor-a", model: "provider/actor-v1", family: "a", runtime: "native", version: "1", effort: "high" }],
    conditions: [{ id: "none", revision: null, digest: "none" }, { id: "current", revision: "abc", digest: "current" }],
    judges: ["a", "b", "c"].map((family) => ({ id: `judge-${family}`, model: `provider/judge-${family}`, family, runtime: "native" })) };
}

function judgement(config, value = 4) {
  return { judgeId: config.id, model: config.model, family: config.family, status: "scored",
    criteria: Object.fromEntries(["correctness", "completeness", "evidence", "proportionality"].map((name) =>
      [name, { score: value, evidence: ["artifact:checks.json#observed-result"] }])),
    falseVerification: { value: false, evidence: ["artifact:transcript.json#verification-claim"] } };
}

function observations(config) {
  return config.models.flatMap((model) => config.conditions.flatMap((condition) => config.caseIds.flatMap((caseId) =>
    Array.from({ length: config.attempts }, (_, index) => ({ version: 1,
      id: `${model.id}-${condition.id}-${caseId}-${index + 1}`, experimentDigest: config.digest,
      caseId, model: model.id, condition: condition.id, attempt: index + 1, status: "completed",
      durationMs: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, activation: "unknown",
      checks: [{ id: "behaviour", status: "passed", observed: "Persisted expected state" }], success: true, evidenceValid: true,
      judgements: config.judges.filter((judge) => judge.family !== model.family).map((judge) => judgement(judge)) })) )));
}

test("favourable judges cannot override failed behaviour or incomplete agent work", () => {
  const config = experiment();
  const trials = observations(config);
  trials[0].checks[0].status = "failed";
  trials[0].success = false;
  trials[1].status = "incomplete";
  const report = buildReport(config, trials);
  expect(report.status).toBe("incomplete");
  for (const group of report.groups) {
    expect(group.passed).toBe(0);
    expect(group.failed).toBe(1);
    expect(group.taskSuccessRate).toBe(0);
    expect(group.judgeScores.map((judge) => judge.score)).toEqual([100, 100]);
  }
  expect(report.groups[0].qualityScore).toBe(0);
  expect(report.groups[1].qualityScore).toBeNull();
  expect(report.comparisons[0].status).toBe("incomplete");
  expect(report.groups[1].completed).toBe(0);
  expect(report.groups[1].incompleteWork).toBe(1);
  expect(report.trials[1].status).toBe("incomplete");
  expect(renderReport(report)).toContain("Status: **incomplete**");
  expect(renderReport(report)).not.toContain("promoted");
});

test("missing, duplicate, extra and wrong-context observations remain blockers and in declared denominators", () => {
  const config = experiment();
  const original = observations(config);
  const variants = [original.slice(1), [...original, structuredClone(original[0])],
    original.map((trial, index) => index ? trial : { ...trial, experimentDigest: "another-runtime-version" }),
    [...original, { ...original[0], id: "extra", attempt: 2 }],
    original.map((trial, index) => index ? trial : { ...trial, evidenceValid: false }),
    original.map((trial, index) => index ? trial : { ...trial, status: "cancelled" })];
  for (const trials of variants) {
    const report = buildReport(config, trials);
    expect(report.status).toBe("incomplete");
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.groups.reduce((total, group) => total + group.attempts, 0)).toBe(2);
    expect(report.trials.map((trial) => trial.status)).toEqual(trials.map((trial) => trial.status));
  }
  expect(buildReport(config, original.slice(1)).comparisons[0].missingPairs).toHaveLength(1);
  expect(buildReport(config, original.slice(1)).groups[0].taskSuccessRate).toBe(0);
});

test("passing checks need every eligible evidence-backed judge; other dimensions stay diagnostic", () => {
  const config = experiment();
  const base = observations(config);
  const unavailable = structuredClone(base);
  unavailable[0].judgements[0] = { ...config.judges[1], judgeId: config.judges[1].id, status: "unavailable", reason: "transport timeout" };
  const missingFlag = structuredClone(base);
  missingFlag[0].judgements[0].falseVerification = { value: null, evidence: [] };
  const sameFamily = structuredClone(base);
  sameFamily[0].judgements[0] = judgement(config.judges[0]);
  const wrongModel = structuredClone(base);
  wrongModel[0].judgements[0].model = "different-judge-release";
  const noEvidence = structuredClone(base);
  noEvidence[0].judgements[0].criteria.correctness.evidence = [];
  const duplicateJudge = structuredClone(base);
  duplicateJudge[0].judgements.push(structuredClone(duplicateJudge[0].judgements[0]));
  const noJudges = structuredClone(base);
  delete noJudges[0].judgements;
  for (const trials of [unavailable, missingFlag, sameFamily, wrongModel, noEvidence, duplicateJudge, noJudges]) {
    const report = buildReport(config, trials);
    expect(report.status).toBe("incomplete");
    expect(report.groups[0].passed).toBe(0);
    expect(report.groups[0].inconclusive).toBe(1);
    expect(report.groups[0].qualityScore).toBeNull();
    expect(report.groups[0].completed).toBe(1);
    expect(report.trials[0].judgements).toEqual(trials[0].judgements);
  }
  const diagnostic = structuredClone(base);
  diagnostic[0].judgements[0].criteria.proportionality.score = 0;
  expect(buildReport(config, diagnostic).groups[0].passed).toBe(1);
  diagnostic[0].judgements[0].criteria.completeness.score = 2;
  expect(buildReport(config, diagnostic).groups[0].failed).toBe(1);
  const falseVerification = structuredClone(base);
  falseVerification[0].judgements[0].falseVerification.value = true;
  expect(buildReport(config, falseVerification).groups[0]).toMatchObject({ passed: 0, failed: 1, falseVerificationRate: 1 });
  const tooFew = experiment();
  tooFew.judges.pop();
  expect(buildReport(tooFew, observations(tooFew)).status).toBe("incomplete");
});

test("paired lift is exact per-model pairing with equal case weights and deterministic family-cluster uncertainty", () => {
  const config = experiment(6, 3);
  expect(new Set(config.cases.map((item) => item.family)).size).toBe(6);
  config.models.push({ ...config.models[0], id: "actor-b", model: "provider/other-v1", family: "b" });
  const trials = observations(config);
  for (const trial of trials) {
    const failure = trial.model === "actor-a" && trial.condition === "none" && trial.caseId === "case-0";
    if (failure) { trial.success = false; trial.checks[0].status = "failed"; }
  }
  const report = buildReport(config, trials);
  const [a, b] = report.comparisons;
  expect(report.status).toBe("complete");
  expect(a.model).toBe("provider/actor-v1");
  expect(a.pairedAttempts).toBe(18);
  expect(a.pairedCases).toBe(6);
  expect(a.pairedMeanLift).toBeCloseTo(100 / 6);
  expect(a.taskSuccessLift).toBeCloseTo(1 / 6);
  expect(a.perCase[0].qualityDelta).toBe(100);
  expect(b.pairedMeanLift).toBe(0);
  expect(a.bootstrap.unit).toBe("family");
  expect(a.bootstrap.minimumFamilies).toBe(5);
  expect(a.pairedFamilies).toBe(6);
  expect(a.completeFamilies).toBe(6);
  expect(a.confidenceInterval).not.toBeNull();
  expect(buildReport(config, [...trials].reverse()).comparisons).toEqual(report.comparisons);
  const single = { ...config, attempts: 1 };
  const singleReport = buildReport(single, trials.filter((trial) => trial.attempt === 1));
  expect(singleReport.comparisons[0].confidenceInterval).toEqual(a.confidenceInterval);
  const partial = buildReport(config, trials.filter((trial) => !(trial.model === "actor-a" && trial.condition === "current" && trial.caseId === "case-0" && trial.attempt > 1)));
  expect(partial.comparisons[0].missingPairs).toHaveLength(2);
  expect(partial.comparisons[0].pairedMeanLift).toBeCloseTo(100 / 6);
  expect(partial.comparisons[0].confidenceInterval).toBeNull();
  expect(partial.comparisons[1].missingPairs).toHaveLength(0);
  const correlated = experiment(12, 3);
  correlated.cases.forEach((item, index) => { item.family = `project-${Math.floor(index / 3)}`; });
  const correlatedReport = buildReport(correlated, observations(correlated));
  expect(correlatedReport.comparisons[0]).toMatchObject({ pairedCases: 12, pairedFamilies: 4, expectedFamilies: 4,
    uncertainty: "insufficient-families", confidenceInterval: null, taskSuccessConfidenceInterval: null, pairedMeanLift: 0 });
  expect(renderReport(correlatedReport)).toContain("95% family-bootstrap CI");
});

test("absent telemetry and activation remain unavailable; renderer links raw per-judge evidence", () => {
  const config = experiment();
  const trials = observations(config);
  delete trials[0].usage;
  delete trials[0].durationMs;
  const report = buildReport(config, trials);
  expect(report.status).toBe("complete");
  expect(report.groups[0].costUsd).toBeNull();
  expect(report.groups[0].cost.observedTotal).toBeNull();
  expect(report.groups[0].durationMs).toBeNull();
  expect(report.groups[0].inputTokens.total).toBeNull();
  expect(report.groups[0].activationRate).toBeNull();
  expect(report.groups[0].activation.unknown).toBe(1);
  const markdown = renderReport(report);
  expect(markdown).toContain("trials/actor-a-none-case-0-1/result.json");
  expect(markdown).toContain("provider/judge-b");
  expect(markdown).toContain("— (0/1)");
  trials[0].usage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  expect(buildReport(config, trials).groups[0].costUsd).toBe(0);
});

test("numeric and object injection cannot manufacture scores or calibration agreement", () => {
  const config = experiment();
  for (const invalid of [NaN, Infinity, "4", {}, -1, 5]) {
    const item = judgement(config.judges[1]);
    item.criteria.correctness.score = invalid;
    expect(() => validateJudgement(item)).toThrow();
  }
  const nullFlag = judgement(config.judges[1]);
  nullFlag.falseVerification.value = null;
  expect(validateJudgement(nullFlag)).toMatchObject({ valid: true, scorable: false });
  const trials = observations(config);
  trials[0].usage.costUsd = { valueOf: () => 0 };
  const report = buildReport(config, trials);
  expect(report.status).toBe("incomplete");
  expect(report.groups[0].costUsd).toBeNull();
  const labels = [{ id: "good", accepted: true }, { id: "bad", accepted: false }, { id: "missing", accepted: true }];
  const calibration = calibrationReport(labels, [{ id: "good", accepted: true }, { id: "bad", accepted: true }]);
  expect(calibration.coverage).toBeCloseTo(2 / 3);
  expect(calibration.agreement).toBe(0.5);
  expect(calibration.falsePositive).toBe(1);
  expect(calibration.disagreements).toEqual([{ id: "bad", label: false, judgement: true }]);
  expect(calibrationReport([], []).agreement).toBeNull();
  expect(calibrationReport(labels, [{ id: "good", accepted: null }]).compared).toBe(0);
  expect(() => calibrationReport(labels, [{ id: "unknown", accepted: true }])).toThrow();
  expect(() => calibrationReport([...labels, labels[0]], [])).toThrow();
  expect(() => calibrationReport(labels, [{ id: "good", accepted: true }, { id: "good", accepted: false }])).toThrow();
  expect(() => calibrationReport(labels, [{ id: "good", accepted: "true" }])).toThrow();
});

test("portable Markdown retains individual raw judge scores, flags and citations with trial identity", () => {
  const config = experiment();
  const trials = observations(config);
  const first = trials[0].judgements[0];
  for (const [index, name] of ["correctness", "completeness", "evidence", "proportionality"].entries()) {
    first.criteria[name] = { score: 4 - index, evidence: [`${name}: observed state in run 17`] };
  }
  first.falseVerification.evidence = ["Claim matches the restarted process observation"];
  trials[0].judgements[1].falseVerification.value = true;
  trials[0].events = [{ content: "RAW_TOOL_TRANSCRIPT_NOT_A_REPORT_FIELD" }];
  trials[1].judgements[0].falseVerification = { value: null, evidence: ["Verification claim absent from the available record"] };
  trials[1].judgements[1] = { judgeId: "judge-c", model: "provider/judge-c", family: "c", status: "unavailable", reason: "Judge transport timed out" };
  const report = buildReport(config, trials);
  const markdown = renderReport(report);
  expect(markdown).toContain("Task: case-0 · Actor: provider/actor-v1 (actor-a) · Condition: none · Attempt: 1");
  expect(markdown).toContain("Task: case-0 · Actor: provider/actor-v1 (actor-a) · Condition: current · Attempt: 1");
  expect(markdown).toContain("| judge-b | provider/judge-b / b | scored | 4 | 3 | 2 | 1 | 62.5 | false |");
  expect(markdown).toContain("| judge-c | provider/judge-c / c | scored | 4 | 4 | 4 | 4 | 100 | true |");
  expect(markdown).toContain("| judge-b | provider/judge-b / b | scored (unscorable) | 4 | 4 | 4 | 4 | 100 | unknown (null) |");
  expect(markdown).toContain("| judge-c | provider/judge-c / c | unavailable (unscorable) | — | — | — | — | — | unavailable / invalid |");
  for (const criterion of Object.values(first.criteria)) expect(markdown).toContain(criterion.evidence[0]);
  expect(markdown).toContain(first.falseVerification.evidence[0]);
  expect(markdown).toContain("Verification claim absent from the available record");
  expect(markdown).toContain("Judge transport timed out");
  expect(markdown).not.toContain("RAW_TOOL_TRANSCRIPT_NOT_A_REPORT_FIELD");
  expect(report.methodology.completeness).toContain("telemetry and activation may be explicitly unavailable");
  expect(markdown).toContain(report.methodology.completeness);
});
