import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepare, loadExperiment, validateSuite } from "../.groundwork/scripts/evals/experiment.mjs";
import { materializeTrial } from "../.groundwork/scripts/evals/workspace.mjs";
import { readJSON } from "../.groundwork/scripts/evals/util.mjs";
import { suite } from "../.groundwork/evals/corpus.mjs";

test("prepared conditions share the fixture and CLI while the no-skill workspace cannot discover Groundwork instructions", () => {
  const parent = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-experiment-"));
  try {
    const { directory, experiment } = prepare({ output: join(parent, "run"), caseIds: ["labels-plural"], models: ["gpt"], attempts: 1 });
    const schedule = readJSON(join(directory, "schedule.json"));
    expect(schedule).toHaveLength(2);
    const paths = {};
    for (const trial of schedule) {
      const path = join(parent, trial.id);
      materializeTrial(directory, experiment, trial, path);
      paths[trial.condition] = path;
    }
    const executable = "groundwork/skills/verify-work/verify.mjs";
    expect(readFileSync(join(paths.none, executable), "utf8")).toBe(readFileSync(join(paths.current, executable), "utf8"));
    expect(readFileSync(join(paths.none, "project/cli.mjs"), "utf8")).toBe(readFileSync(join(paths.current, "project/cli.mjs"), "utf8"));
    expect(existsSync(join(paths.none, "groundwork/skills/verify-work/SKILL.md"))).toBe(false);
    expect(existsSync(join(paths.current, "groundwork/skills/verify-work/SKILL.md"))).toBe(true);
    expect(existsSync(join(paths.current, "project/experiment.json"))).toBe(false);
    writeFileSync(join(directory, "inputs/projects/labels-plural/cli.mjs"), "console.log('unexpected replacement')");
    expect(() => materializeTrial(directory, experiment, schedule[0], join(parent, "changed"))).toThrow("fixture changed");
    const changed = { ...experiment, attempts: 99 };
    writeFileSync(join(directory, "experiment.json"), JSON.stringify(changed));
    expect(() => loadExperiment(directory)).toThrow("frozen experiment changed");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("explicit invocation excludes the absent-skill control and each problem family belongs to one split", () => {
  const parent = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-population-"));
  try {
    const { experiment } = prepare({ output: join(parent, "run"), caseIds: ["theme-restart"], activation: "explicit", attempts: 1 });
    expect(experiment.conditions.map(item => item.id)).toEqual(["current"]);
    expect(experiment.cases.every(item => item.split === "development" && item.activation === "explicit")).toBe(true);
    const leaked = { ...suite.cases[0], id: "leaked-family", split: "holdout" };
    expect(() => validateSuite({ ...suite, cases: [...suite.cases, leaked] })).toThrow("family crosses");
    expect(() => prepare({ split: "all" })).toThrow("exactly one split");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
