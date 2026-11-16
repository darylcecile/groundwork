import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { catalogueIssues, hasConfig, loadConfig, selectChecks } from "../lib/config.mjs";
import { planGuideMigration } from "../lib/guide-migration.mjs";
import { prepareProject } from "../lib/migration.mjs";
import { evidenceStore } from "../lib/store.mjs";

const directories = [];
let previousStateHome;

function temporaryDirectory() {
  const root = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-migration-")));
  directories.push(root);
  return root;
}

beforeEach(() => {
  previousStateHome = process.env.GROUNDWORK_STATE_HOME;
  process.env.GROUNDWORK_STATE_HOME = join(temporaryDirectory(), "state");
});

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.GROUNDWORK_STATE_HOME;
  else process.env.GROUNDWORK_STATE_HOME = previousStateHome;
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(root) {
  const files = [];
  function visit(path) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const file = path ? `${path}/${name}` : name;
      const info = lstatSync(join(root, file));
      if (info.isDirectory()) visit(file);
      else files.push([file, info.mtimeMs, readFileSync(join(root, file), "utf8")]);
    }
  }
  visit("");
  return files;
}

function rawConfig(root) {
  const merged = { checks: {}, behaviours: {}, invariants: {}, context: {} };
  for (const name of readdirSync(join(root, ".groundwork/verify.d")).sort()) {
    const value = JSON.parse(readFileSync(join(root, ".groundwork/verify.d", name), "utf8"));
    for (const group of Object.keys(merged)) Object.assign(merged[group], value[group]);
  }
  return merged;
}

const check = options => ({ command: "true", expect: "The project contract holds", ...options });

test.each(["verify.json", ".groundwork/verify.json", ".verify/verify.json"])("automatically splits %s without changing raw checks, catalogue bindings or execution order", path => {
  const root = temporaryDirectory();
  const config = {
    checks: {
      zebra: check({ required: true, covers: ["editing", "saving"], paths: ["src/**"], kind: "workflow", reuse: { env: ["MODE"], files: ["fixture.json"], revision: true } }),
      alpha: check({ covers: ["saving"], setup: "printf setup", cleanup: "printf cleanup", result: "result.json", artifacts: ["proof.txt"], repeat: 2,
        metrics: { latency: { unit: "ms", max: 30, direction: "lower", maxRegressionPercent: 5 } }, compare: "measurement", context: { workload: "small" } }),
    },
    behaviours: {
      editing: { description: "Edit a document", paths: ["src/editor/**"], dependsOn: ["saving"] },
      saving: { description: "Save a document", entry: "save" },
    },
    invariants: { durable: { description: "Data survives", checks: ["alpha"], paths: ["src/storage/**"] } },
    context: { platform: "fixture", parallel: false },
  };
  write(root, path, config);
  const original = loadConfig(root);
  const before = snapshot(root);
  expect(hasConfig(root)).toBe(true);
  expect(snapshot(root)).toEqual(before);
  expect(prepareProject(root).changed).toBe(true);
  expect(rawConfig(root)).toEqual(config);
  expect(loadConfig(root)).toEqual(original);
  expect(selectChecks(loadConfig(root)).names).toEqual(["zebra", "alpha"]);
  const fragments = readdirSync(join(root, ".groundwork/verify.d")).sort().map(name => JSON.parse(readFileSync(join(root, ".groundwork/verify.d", name), "utf8")));
  expect(fragments.filter(value => value.checks).map(value => Object.keys(value.checks))).toEqual([["zebra"], ["alpha"]]);
  expect(fragments.find(value => value.context)).toEqual({ context: config.context });
  expect(existsSync(join(root, path))).toBe(false);
  expect(existsSync(process.env.GROUNDWORK_STATE_HOME)).toBe(false);
  for (const [file] of snapshot(root)) utimesSync(join(root, file), 1, 1);
  const stable = snapshot(root);
  expect(prepareProject(root)).toEqual({ changed: false });
  expect(snapshot(root)).toEqual(stable);
});

test("preserves existing feature fragments and their formatting while appending the old base ahead of them", () => {
  const root = temporaryDirectory();
  const fragment = '{ "checks": { "feature": { "command": "true", "expect": "Feature holds" } } }\n';
  write(root, "verify.json", { checks: { base: check() } });
  write(root, ".groundwork/verify.d/feature.json", fragment);
  prepareProject(root);
  expect(readFileSync(join(root, ".groundwork/verify.d/feature.json"), "utf8")).toBe(fragment);
  expect(Object.keys(loadConfig(root).checks)).toEqual(["base", "feature"]);
});

test("renames fragments only when their existing filename order would change serial execution", () => {
  const root = temporaryDirectory();
  write(root, "verify.json", { checks: { zebra: check(), alpha: check() } });
  write(root, ".groundwork/verify.d/0000-feature.json", { checks: { feature: check() } });
  write(root, ".verify/verify.d/aaa-legacy.json", { checks: { legacy: check() } });
  const before = loadConfig(root);
  prepareProject(root);
  expect(loadConfig(root)).toEqual(before);
  expect(Object.keys(loadConfig(root).checks)).toEqual(["zebra", "alpha", "feature", "legacy"]);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("renamed fragments remain reachable by commands, reuse inputs, changed paths and Markdown links", () => {
  const root = temporaryDirectory();
  const current = ".groundwork/verify.d/0000-feature.json";
  const legacy = ".verify/verify.d/legacy.json";
  const legacyValue = { checks: { last: check({ paths: ["src/last/**"] }) } };
  write(root, "verify.json", { checks: { first: check({ paths: ["src/first/**"] }) } });
  write(root, current, { checks: { reader: check({ command: `cat ${legacy}`, paths: [current, legacy], reuse: { files: [current, legacy] } }) } });
  write(root, legacy, legacyValue);
  write(root, "README.md", `[Current](${current}) · [Legacy](${legacy})\n`);
  write(root, "VERIFY.md", `# Project context\n\n[Current](${current})\n\n## Journey\n\n[Legacy](${legacy})\n`);
  prepareProject(root);
  const config = loadConfig(root);
  const currentTarget = relative(root, config.provenance.checks.reader);
  const legacyTarget = relative(root, config.provenance.checks.last);
  const result = spawnSync("bash", ["-ec", config.checks.reader.command], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(legacyValue);
  for (const input of config.checks.reader.reuse.files) expect(lstatSync(join(root, input)).isFile()).toBe(true);
  expect(selectChecks(config, { changedPaths: [legacyTarget] }).names).toEqual(["reader"]);
  expect(selectChecks(config, { changedPaths: [currentTarget] }).names).toEqual(["reader"]);
  expect(readFileSync(join(root, "README.md"), "utf8")).toBe(`[Current](${currentTarget}) · [Legacy](${legacyTarget})\n`);
  expect(readFileSync(join(root, ".groundwork/guides/project.md"), "utf8")).toContain(`[Current](${relative(".groundwork/guides", currentTarget)})`);
  expect(readFileSync(join(root, ".groundwork/guides/journey.md"), "utf8")).toContain(`[Legacy](${relative(".groundwork/guides", legacyTarget)})`);
  write(root, legacy, legacyValue);
  prepareProject(root);
  expect(loadConfig(root)).toEqual(config);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test.each(["verify.json", ".groundwork/verify.json", ".verify/verify.json"])("keeps executable whole-document input %s as one active configuration fragment", path => {
  const root = temporaryDirectory();
  const value = { checks: {
    read: check({ command: `cat ${path}`, paths: [path], reuse: { files: [path] } }),
    other: check({ paths: ["src/other/**"] }),
  }, context: { fixture: "complete document" } };
  write(root, path, value);
  write(root, ".groundwork/verify.d/independent.json", { checks: { independent: check({ paths: ["src/independent/**"] }) } });
  prepareProject(root);
  const config = loadConfig(root);
  const result = spawnSync("bash", ["-ec", config.checks.read.command], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  const consumed = JSON.parse(result.stdout);
  expect(Object.keys(consumed.checks)).toEqual(["read", "other"]);
  expect(consumed.checks.other).toEqual(value.checks.other);
  expect(consumed.context).toEqual(value.context);
  expect(JSON.parse(readFileSync(join(root, config.checks.read.reuse.files[0]), "utf8"))).toEqual(consumed);
  expect(selectChecks(config, { changedPaths: config.checks.read.reuse.files }).names).toEqual(["read"]);
  expect(Object.keys(config.checks)).toEqual(["read", "other", "independent"]);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("canonical base precedence discards shadowed root and .verify bases without parsing invalid copies", () => {
  const root = temporaryDirectory();
  write(root, ".groundwork/verify.json", { checks: { active: check() } });
  write(root, "verify.json", "{ obsolete invalid JSON");
  write(root, ".verify/verify.json", { impossible: "This base was never active" });
  const before = loadConfig(root);
  prepareProject(root);
  expect(loadConfig(root)).toEqual(before);
  expect(Object.keys(loadConfig(root).checks)).toEqual(["active"]);
  expect(readdirSync(root)).toEqual([".groundwork"]);
});

test("collapses identical partial definitions and stops contradictory active definitions before changing metadata or evidence", () => {
  const root = temporaryDirectory();
  write(root, "verify.json", { checks: { shared: check() } });
  write(root, ".groundwork/verify.d/feature.json", { checks: { shared: check(), feature: check() } });
  prepareProject(root);
  expect(Object.keys(loadConfig(root).checks)).toEqual(["shared", "feature"]);

  const conflicting = temporaryDirectory();
  write(conflicting, "verify.json", { checks: { shared: check() } });
  write(conflicting, ".groundwork/verify.d/feature.json", { checks: { shared: check({ command: "false" }) } });
  write(conflicting, "VERIFY.md", "# Existing guide\n\n## Saving\nKeep this journey.\n");
  write(conflicting, ".verify/runs/old/output.log", "Original evidence\n");
  write(conflicting, ".verify/latest", "old\n");
  const before = snapshot(conflicting);
  expect(() => prepareProject(conflicting)).toThrow('Conflicting checks definition "shared"');
  expect(snapshot(conflicting)).toEqual(before);
  expect(existsSync(process.env.GROUNDWORK_STATE_HOME)).toBe(false);
});

test("moves useful .verify files, keeps executable paths working and folds useful ignores into active rules", () => {
  const root = temporaryDirectory();
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  write(root, ".verify/verify.json", { checks: { script: check({
    command: ".verify/scripts/check.sh && test -f '.verify/config/input.txt'",
    paths: [".verify/scripts/**"], covers: ["custom"],
    expect: "Keep the .verify/scripts/check.sh contract", reuse: { files: [".verify/config/input.txt"] },
  }) }, behaviours: { custom: { description: "Custom guide", paths: [".verify/config/**"], guide: ".verify/guides/custom.md" } } });
  write(root, ".verify/scripts/check.sh", "#!/bin/sh\nprintf 'original script ran\\n'\n");
  chmodSync(join(root, ".verify/scripts/check.sh"), 0o755);
  write(root, ".verify/config/input.txt", "Input\n");
  write(root, ".verify/guides/custom.md", "# Custom\n\n[Input](../config/input.txt)\n");
  write(root, ".verify/notes.txt", "Keep custom notes\n");
  write(root, ".verify/.gitignore", "*\n/runs/\n/latest\n/private-data/\n*.local\n");
  write(root, ".groundwork/legacy-verify.gitignore", "/old-scratch/\n");
  write(root, ".groundwork/.gitignore", "/runs/\n/latest\n/custom-output/\n");
  write(root, ".gitignore", "dist/\n/.verify/\n/.verify/cache/\n/.groundwork/runs/\nother/runs/\n");
  prepareProject(root);
  const config = loadConfig(root);
  expect(config.checks.script.command).toBe(".groundwork/scripts/check.sh && test -f '.groundwork/config/input.txt'");
  expect(config.checks.script.expect).toBe("Keep the .verify/scripts/check.sh contract");
  expect(config.checks.script.reuse.files).toEqual([".groundwork/config/input.txt"]);
  const result = spawnSync("bash", ["-ec", config.checks.script.command], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("original script ran\n");
  expect(selectChecks(config, { changedPaths: [".groundwork/scripts/future.sh"] }).names).toEqual(["script"]);
  expect(selectChecks(config, { changedPaths: [".groundwork/config/future/input.txt"] }).names).toEqual(["script"]);
  expect(catalogueIssues(config, root)).toEqual([]);
  expect(readFileSync(join(root, ".groundwork/guides/custom.md"), "utf8")).toContain("[Input](../config/input.txt)");
  expect(readFileSync(join(root, ".groundwork/notes.txt"), "utf8")).toBe("Keep custom notes\n");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("dist/\n/.groundwork/cache/\nother/runs/\n");
  for (const path of [".groundwork/private-data/input", ".groundwork/settings.local", ".groundwork/custom-output/log", ".groundwork/old-scratch/log", ".groundwork/tasks/task.md"]) {
    expect(spawnSync("git", ["check-ignore", "--quiet", path], { cwd: root }).status).toBe(0);
  }
  for (const path of [".groundwork/scripts/check.sh", ".groundwork/guides/custom.md", ".groundwork/verify.d/check.json"]) {
    expect(spawnSync("git", ["check-ignore", "--quiet", path], { cwd: root }).status).toBe(1);
  }
  expect(existsSync(join(root, ".verify"))).toBe(false);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("retains custom symlinked instructions while relinking their obsolete guide and configuration references", () => {
  const root = temporaryDirectory();
  const shared = join(temporaryDirectory(), "instructions.md");
  writeFileSync(shared, "Keep our architecture.\n\n## Verification workflow\n\nRead `VERIFY.md`, use `verify.json`, and see [Saving](VERIFY.md#saving).\n\n## Team rules\nKeep these.\n");
  symlinkSync(shared, join(root, "AGENTS.md"));
  write(root, "VERIFY.md", "# Existing project\n\nShared setup.\n\n## Saving\nSave, restart, and read the value.\n");
  write(root, "verify.json", { checks: { save: check({ covers: ["saving"] }) }, behaviours: {
    saving: { description: "Save changes", guide: "VERIFY.md#saving" },
  } });
  prepareProject(root, { initialize: true });
  const instructions = readFileSync(shared, "utf8");
  expect(realpathSync(join(root, "AGENTS.md"))).toBe(shared);
  expect(instructions).toStartWith("Keep our architecture.");
  expect(instructions).toEndWith("## Team rules\nKeep these.\n");
  expect(instructions).toContain("Read `.groundwork/VERIFY.md`, use `.groundwork/verify.d/`");
  expect(instructions).toContain("[Saving](.groundwork/guides/saving.md#saving)");
  expect(catalogueIssues(loadConfig(root), root)).toEqual([]);
  expect(readFileSync(join(root, ".groundwork/guides/project.md"), "utf8")).toContain("Shared setup.");
  const stable = snapshot(root);
  expect(prepareProject(root, { initialize: true })).toEqual({ changed: false });
  expect(snapshot(root)).toEqual(stable);
});

test("coalesces updates to an in-project instruction target while retaining its AGENTS symlink", () => {
  const root = temporaryDirectory();
  write(root, "instructions.md", "Keep our team rules.\n\nRead `VERIFY.md` and `verify.json`. [Saving](VERIFY.md#saving).\n");
  symlinkSync("instructions.md", join(root, "AGENTS.md"));
  write(root, "VERIFY.md", "# Context\n\nShared setup.\n\n## Saving\nSave the document.\n");
  write(root, "verify.json", { checks: { test: check() } });
  prepareProject(root, { initialize: true });
  const instructions = readFileSync(join(root, "instructions.md"), "utf8");
  expect(instructions).toStartWith("Keep our team rules.");
  expect(instructions).toContain("Read `.groundwork/VERIFY.md` and `.groundwork/verify.d/`");
  expect(instructions).toContain("[Saving](.groundwork/guides/saving.md#saving)");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(instructions).toContain("groundwork view guide");
  expect(lstatSync(join(root, "AGENTS.md")).isSymbolicLink()).toBe(true);
  expect(realpathSync(join(root, "AGENTS.md"))).toBe(join(root, "instructions.md"));
  expect(prepareProject(root, { initialize: true })).toEqual({ changed: false });
});

test("moves a legacy instruction target and retargets AGENTS without keeping conflicting copies", () => {
  const root = temporaryDirectory();
  write(root, ".verify/instructions.md", "Keep our team rules.\n\nUse `verify.json`. [Saving](../VERIFY.md#saving).\n");
  symlinkSync(".verify/instructions.md", join(root, "AGENTS.md"));
  write(root, "VERIFY.md", "# Context\n\nShared setup.\n\n## Saving\nSave the document.\n");
  write(root, "verify.json", { checks: { test: check() } });
  prepareProject(root, { initialize: true });
  const target = join(root, ".groundwork/instructions.md");
  const instructions = readFileSync(target, "utf8");
  expect(instructions).toStartWith("Keep our team rules.");
  expect(instructions).toContain("Use `.groundwork/verify.d/`");
  expect(instructions).toContain("[Saving](guides/saving.md#saving)");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(lstatSync(join(root, "AGENTS.md")).isSymbolicLink()).toBe(true);
  expect(realpathSync(join(root, "AGENTS.md"))).toBe(target);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(instructions);
  expect(existsSync(join(root, ".verify"))).toBe(false);
  const stable = snapshot(root);
  expect(prepareProject(root, { initialize: true })).toEqual({ changed: false });
  expect(snapshot(root)).toEqual(stable);
});

test.each([".groundwork/.gitignore", ".verify/.gitignore"])("preserves ordered repeated custom ignore rules from %s", path => {
  const root = temporaryDirectory();
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  write(root, "verify.json", { checks: { test: check() } });
  write(root, path, "*.local\n!important.local\n*.local\n*.private\n!visible.private\n");
  const ignored = file => spawnSync("git", ["check-ignore", "--quiet", file], { cwd: root }).status;
  expect(ignored(join(dirname(path), "important.local"))).toBe(0);
  expect(ignored(join(dirname(path), "visible.private"))).toBe(1);
  prepareProject(root);
  expect(ignored(".groundwork/important.local")).toBe(0);
  expect(ignored(".groundwork/visible.private")).toBe(1);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("keeps whole-guide execution inputs intact and updates incoming project Markdown links", () => {
  const root = temporaryDirectory();
  const content = "# Project\n\nShared setup.\n\n## Journeys\n\n### Saving\nSave, restart, and read the value.\n\n### Loading\nLoad the existing value.\n";
  write(root, "VERIFY.md", content);
  write(root, "verify.json", { checks: { read: check({ command: "cat VERIFY.md", paths: ["VERIFY.md"], reuse: { files: ["VERIFY.md"] } }) } });
  write(root, "README.md", "[Saving](VERIFY.md#saving)\n\nExample: `cat VERIFY.md`\n");
  write(root, ".github/contributing.md", "[Loading](../VERIFY.md#loading)\n");
  prepareProject(root);
  const migrated = loadConfig(root).checks.read;
  const result = spawnSync("bash", ["-ec", migrated.command], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(content);
  expect(readFileSync(join(root, migrated.reuse.files[0]), "utf8")).toBe(content);
  expect(selectChecks(loadConfig(root), { changedPaths: [migrated.reuse.files[0]] }).names).toEqual(["read"]);
  expect(readFileSync(join(root, "README.md"), "utf8")).toBe("[Saving](.groundwork/guides/project.md#saving)\n\nExample: `cat VERIFY.md`\n");
  expect(readFileSync(join(root, ".github/contributing.md"), "utf8")).toBe("[Loading](../.groundwork/guides/project.md#loading)\n");
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("recovers identical configuration and guide artifacts left before legacy source deletion", () => {
  const root = temporaryDirectory();
  const value = { checks: { existing: check({ reuse: { files: ["verify.json"] } }) } };
  write(root, "verify.json", value);
  prepareProject(root);
  const configState = snapshot(root);
  write(root, "verify.json", value);
  prepareProject(root);
  expect(snapshot(root)).toEqual(configState);

  const content = "# Project\n\nShared context.\n\n## Journey\nExercise the existing flow.\n";
  write(root, "VERIFY.md", content);
  const staged = planGuideMigration(root, [{ path: "VERIFY.md", content }]);
  for (const [path, text] of staged.writes) write(root, path, text);
  const guides = readdirSync(join(root, ".groundwork/guides")).sort();
  prepareProject(root);
  expect(readdirSync(join(root, ".groundwork/guides")).sort()).toEqual(guides);
  expect(guides.some(name => readFileSync(join(root, ".groundwork/guides", name), "utf8").includes("Shared context."))).toBe(true);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("migrates runtime evidence only when present and preserves its report bytes", () => {
  const root = temporaryDirectory();
  write(root, "verify.json", { checks: { test: check() } });
  const historical = '{ "version": 1, "id": "previous", "status": "passed" }\n';
  write(root, ".verify/runs/previous/result.json", historical);
  write(root, ".verify/runs/previous/artifacts/proof.txt", "Original evidence\n");
  write(root, ".verify/runs/notes.txt", "A custom note next to old runs\n");
  write(root, ".verify/latest", "previous\n");
  prepareProject(root);
  const store = evidenceStore(root);
  expect(readFileSync(join(store.runs, "previous/result.json"), "utf8")).toBe(historical);
  expect(readFileSync(join(store.runs, "previous/artifacts/proof.txt"), "utf8")).toBe("Original evidence\n");
  expect(readFileSync(store.latest, "utf8")).toBe("previous\n");
  expect(readFileSync(join(root, ".groundwork/notes/notes.txt"), "utf8")).toBe("A custom note next to old runs\n");
  expect(existsSync(join(root, ".verify"))).toBe(false);
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("unrelated directories stay untouched and explicit initialization produces a repeatable fragment-only project", () => {
  const root = temporaryDirectory();
  write(root, "README.md", "# Another project\n");
  const before = snapshot(root);
  expect(prepareProject(root)).toEqual({ changed: false });
  expect(snapshot(root)).toEqual(before);
  expect(existsSync(process.env.GROUNDWORK_STATE_HOME)).toBe(false);
  expect(prepareProject(root, { initialize: true }).changed).toBe(true);
  expect(hasConfig(root)).toBe(true);
  expect(loadConfig(root).checks).toEqual({});
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("groundwork view guide");
  expect(readFileSync(join(root, ".groundwork/VERIFY.md"), "utf8")).toContain("<!-- groundwork:guide-bootstrap -->");
  const initialized = snapshot(root);
  expect(prepareProject(root, { initialize: true })).toEqual({ changed: false });
  expect(snapshot(root)).toEqual(initialized);
});

test("canonical preparation skips fragment parsing and project traversal while new legacy files still migrate", () => {
  const root = temporaryDirectory();
  const fragment = ".groundwork/verify.d/feature.json";
  const value = { checks: { feature: check() } };
  write(root, fragment, value);
  write(root, "docs/guide.md", "An unrelated document\n");
  expect(prepareProject(root).changed).toBe(true);
  const readFile = fs.readFileSync;
  const readDirectory = fs.readdirSync;
  const reads = spyOn(fs, "readFileSync").mockImplementation((path, ...args) => {
    if (String(path) === join(root, fragment)) throw new Error("Canonical preparation must leave configuration parsing to loadConfig");
    return readFile(path, ...args);
  });
  const walks = spyOn(fs, "readdirSync").mockImplementation((path, ...args) => {
    if (String(path) === root || String(path) === join(root, "docs")) throw new Error("Canonical preparation must not walk project Markdown");
    return readDirectory(path, ...args);
  });
  try { expect(prepareProject(root)).toEqual({ changed: false }); }
  finally { reads.mockRestore(); walks.mockRestore(); }
  expect(prepareProject(root, { initialize: true }).changed).toBe(true);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("groundwork view guide");
  write(root, fragment, "{ incomplete config");
  expect(prepareProject(root)).toEqual({ changed: false });
  expect(() => loadConfig(root)).toThrow();
  write(root, fragment, value);
  write(root, ".verify/notes.txt", "Reintroduced custom notes\n");
  expect(prepareProject(root).changed).toBe(true);
  expect(readFileSync(join(root, ".groundwork/notes.txt"), "utf8")).toBe("Reintroduced custom notes\n");
  expect(prepareProject(root)).toEqual({ changed: false });
});

test("a useful legacy file collision stops conversion without replacing either authored file", () => {
  const root = temporaryDirectory();
  write(root, "verify.json", { checks: { existing: check() } });
  write(root, "VERIFY.md", "Original project guide\n");
  write(root, ".verify/scripts/check.mjs", "Original script\n");
  write(root, ".groundwork/scripts/check.mjs", "Different current script\n");
  const before = snapshot(root);
  expect(() => prepareProject(root)).toThrow("Migration collision");
  expect(snapshot(root)).toEqual(before);
});
