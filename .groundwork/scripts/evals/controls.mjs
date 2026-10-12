import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { suite, materializeCase, checkCase, applyReference } from "../../evals/corpus.mjs";
import { calibrationExamples } from "../../evals/calibration.mjs";
import { root, defaultConfig, validateConfig } from "./experiment.mjs";
import { blindedPacket, parseJudgement } from "./judge.mjs";
import { calibrationReport } from "./report.mjs";
import { concurrent, ensure, readJSON, writeJSON } from "./util.mjs";

export async function judgeControls(invokeJudge, { caseIds } = {}) {
  const config = validateConfig(readJSON(defaultConfig));
  const directory = join(root, ".groundwork/runs", `eval-judge-controls-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const instructions = readFileSync(join(root, ".groundwork/evals/rubric.md"), "utf8");
  const available = [
    { caseId: "route-precedence", expected: true },
    { caseId: "labels-command-lookup", expected: true },
    ...calibrationExamples.map(item => ({ ...item, expected: false })),
  ];
  ensure(!caseIds || caseIds.every(id => available.some(item => item.caseId === id)), "Unknown judge-control case.");
  const authored = available.filter(item => !caseIds || caseIds.includes(item.caseId));
  const submissions = [];
  for (const example of authored) {
    const id = randomUUID();
    const project = join(directory, "submissions", id);
    mkdirSync(project, { recursive: true });
    materializeCase(example.caseId, project);
    const answer = example.expected ? applyReference(example.caseId, project) : example.answer;
    const outcome = await checkCase(example.caseId, project, { answer });
    submissions.push({ id, caseId: example.caseId, answer, events: [], checks: outcome.checks, project, expected: example.expected });
  }
  const experiment = { cases: suite.cases, models: config.models, judges: config.judges, conditions: [], maxJudgePacketBytes: config.maxJudgePacketBytes ?? 300000 };
  const results = [];
  const jobs = submissions.flatMap(submission => config.judges.map(judge => ({ submission, judge })));
  await concurrent(jobs, config.concurrency, async ({ submission, judge }) => {
    const output = join(directory, "judgements", `${submission.id}-${judge.id}`);
    mkdirSync(output, { recursive: true });
    let verdict;
    try {
      const prompt = blindedPacket(experiment, submission, submission.project, instructions);
      writeFileSync(join(output, "packet.txt"), prompt);
      const response = await invokeJudge({ judge, prompt, directory: output, timeoutSeconds: config.judgeTimeoutSeconds });
      writeFileSync(join(output, "response.txt"), response.output || "");
      if (!response.completed) throw new Error(response.error || "Judge did not finish.");
      verdict = parseJudgement(response.output, judge);
    } catch (error) {
      verdict = { judgeId: judge.id, model: judge.model, family: judge.family, status: "unavailable", reason: error.message };
    }
    const accepted = verdict.status !== "scored" || verdict.falseVerification.value === null ? null :
      verdict.criteria.correctness.score >= 3 && verdict.criteria.completeness.score >= 3 && verdict.falseVerification.value === false;
    results.push({ id: submission.id, caseId: submission.caseId, judgeId: judge.id, expected: submission.expected, accepted, verdict });
    writeJSON(join(output, "verdict.json"), verdict);
  });
  const summary = config.judges.map(judge => ({ judgeId: judge.id, model: judge.model,
    ...calibrationReport(submissions.map(item => ({ id: item.id, accepted: item.expected })),
      results.filter(item => item.judgeId === judge.id).map(({ id, accepted }) => ({ id, accepted }))) }));
  const report = { version: 1, createdAt: new Date().toISOString(), source: "Authored positive and negative grading controls, not agent runs or human calibration",
    caseIds: [...new Set(authored.map(item => item.caseId))], summary, results };
  writeJSON(join(directory, "result.json"), report);
  return { directory, ...report };
}
