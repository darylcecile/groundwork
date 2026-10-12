import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, materializeCase, applyReference, checkCase } from "../.groundwork/evals/corpus.mjs";

const projects = [];
afterEach(() => { for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function project(id) {
  const directory = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-corpus-"));
  projects.push(directory);
  materializeCase(id, directory);
  return directory;
}

test("all references satisfy task outcomes, including correctly observed blocked release reviews", async () => {
  const families = new Map();
  expect(suite.cases).toHaveLength(24);
  expect(new Set(suite.cases.map(item => item.id)).size).toBe(24);
  for (const item of suite.cases) {
    expect(families.get(item.family) || item.split).toBe(item.split);
    families.set(item.family, item.split);
    expect(item.provenance).toEqual({ kind: "authored", source: item.fixture });
    expect(typeof item.readOnly).toBe("boolean");
    expect(typeof item.noCommands).toBe("boolean");
    const directory = project(item.id);
    const answer = applyReference(item.id, directory);
    const result = await checkCase(item.id, directory, { answer });
    expect(result.checks.filter(check => check.status === "failed")).toEqual([]);
    const blocked = ["release-readiness", "release-local-claim"].includes(item.id);
    expect(result.success).toBe(true);
    if (blocked) {
      const observation = result.checks.find(check => check.id === "release-blocker-observed");
      expect(observation.status).toBe("passed");
      expect(observation.observed).toContain("actual release remains unverified");
    }
  }
  expect(families.size).toBeGreaterThanOrEqual(6);
  expect(suite.cases.filter(item => item.noCommands).map(item => item.id).sort()).toEqual([
    "labels-command-lookup", "release-prerequisites", "stock-design-advice", "stock-flow", "stock-test-instructions",
  ]);
}, 60_000);

test("passing ordinary tests cannot conceal representative original CLI/API defects", async () => {
  const originals = ["theme-restart", "settings-rejection", "shipping-rounding", "ledger-date-boundary", "labels-plural", "dispatch-retry", "dispatch-cancel", "dispatch-partial-failure"];
  for (const id of originals) {
    const directory = project(id);
    const testFiles = readdirSync(join(directory, "test")).map(file => `test/${file}`);
    const ordinary = spawnSync("node", ["--test", ...testFiles], { cwd: directory, encoding: "utf8", timeout: 10_000 });
    expect(ordinary.status).toBe(0);
    const result = await checkCase(id, directory, { answer: "The existing unit test passed; everything is complete." });
    expect(result.success).toBe(false);
    expect(result.checks.some(check => check.status === "failed")).toBe(true);
  }
}, 30_000);

test("read-only outcomes use authored bytes and reject edits or new maps even if behavior still works", async () => {
  const id = "route-precedence";
  const directory = project(id);
  const answer = applyReference(id, directory);
  expect((await checkCase(id, directory, { answer })).success).toBe(true);
  writeFileSync(join(directory, "docs/routing.md"), "# Routing\n\nCorrected docs without permission.\n");
  const changed = await checkCase(id, directory, { answer });
  expect(changed.checks.find(check => check.id === "routing-entrypoints").status).toBe("passed");
  expect(changed.checks.find(check => check.id === "source-preserved").status).toBe("failed");

  const second = project("stock-design-advice");
  mkdirSync(join(second, ".groundwork/maps"), { recursive: true });
  writeFileSync(join(second, ".groundwork/maps/stock.md"), "# Unrequested map\n");
  expect((await checkCase("stock-design-advice", second, { answer: "Here is my advice." })).success).toBe(false);
}, 10_000);

test("candidate materialization excludes evaluator context and missing deliverables cannot pass", async () => {
  const id = "labels-help-copy";
  const directory = project(id);
  expect(existsSync(join(directory, ".git"))).toBe(false);
  expect(existsSync(join(directory, ".groundwork"))).toBe(false);
  expect(readFileSync(join(directory, "AGENTS.md"), "utf8")).not.toMatch(/Groundwork|benchmark|reference|holdout/);
  expect(() => materializeCase(id, directory)).toThrow(/empty directory/);
  applyReference(id, directory);
  expect((await checkCase(id, directory)).success).toBe(null);
  rmSync(join(directory, "cli.mjs"));
  const missing = await checkCase(id, directory, { answer: "Done." });
  expect(missing.success).toBe(null);
  expect(missing.checks.find(check => check.id === "labels-cli").status).toBe("inconclusive");

  const other = project("theme-restart");
  const answer = applyReference("theme-restart", other);
  const module = new URL("../.groundwork/evals/corpus.mjs", import.meta.url).href;
  const script = `import {checkCase} from ${JSON.stringify(module)}; console.log(JSON.stringify(await checkCase('theme-restart', ${JSON.stringify(other)}, {answer: ${JSON.stringify(answer)}})));`;
  const independent = spawnSync("node", ["--input-type=module", "-e", script], { cwd: directory, encoding: "utf8", timeout: 10_000 });
  expect(independent.status).toBe(0);
  expect(JSON.parse(independent.stdout).success).toBe(true);
}, 15_000);
