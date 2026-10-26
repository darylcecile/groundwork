import { afterEach, expect, test } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../skills/verify-work/verify.mjs", import.meta.url));
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "verify-work-"));
  directories.push(directory);
  return directory;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function invoke(root, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GROUNDWORK_PORTAL: "0", ...env } });
  return { code: result.status, output: result.stdout + result.stderr };
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function project(checks = {}) {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  expect(invoke(root, ["init"]).code).toBe(0);
  setChecks(root, checks);
  return root;
}

function setChecks(root, checks) {
  write(root, ".groundwork/verify.json", JSON.stringify({ checks }));
}

function saved(root) {
  const id = readFileSync(join(root, ".groundwork", "latest"), "utf8").trim();
  const directory = join(root, ".groundwork", "runs", id);
  return { directory, data: JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) };
}

test("fresh project setup keeps owned files under .groundwork and is repeatable", () => {
  const root = temporaryDirectory();
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readdirSync(root).sort()).toEqual([".groundwork", "AGENTS.md"]);
  expect(readdirSync(join(root, ".groundwork")).sort()).toEqual([".gitignore", "VERIFY.md", "verify.json"]);
  const ignores = readFileSync(join(root, ".groundwork/.gitignore"), "utf8");
  expect(ignores).toBe("/runs/\n/latest\n/plans/\n/tasks/\n/tmp/\n");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("`.groundwork/VERIFY.md`");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("`.groundwork/verify.json`");
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readdirSync(root).sort()).toEqual([".groundwork", "AGENTS.md"]);
  expect(readFileSync(join(root, ".groundwork/.gitignore"), "utf8")).toBe(ignores);
  git(root, "init", "--quiet");
  setChecks(root, { clean: { command: "true", expect: "Verification keeps project files namespaced" } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  expect(readdirSync(root).sort()).toEqual([".git", ".groundwork", "AGENTS.md"]);
  const changes = git(root, "status", "--porcelain", "--untracked-files=all");
  expect(changes).toContain(".groundwork/verify.json");
  expect(changes).toContain(".groundwork/VERIFY.md");
  expect(changes).not.toContain(".groundwork/runs/");
  expect(changes).not.toContain(".groundwork/latest");
});

const oldProjectInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Read `VERIFY.md` for this project's behaviour guide and use `verify.json` for repeatable checks.\n";
const oldGlobalInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Follow its workflow in normal chat, using the project's `VERIFY.md` and `verify.json` when present. Set up project verification files when I ask to adopt the framework.\n";

test("project setup migrates legacy files, preserves content and instruction links, and is repeatable", () => {
  const root = temporaryDirectory();
  const shared = join(temporaryDirectory(), "instructions.md");
  writeFileSync(shared, `Keep our existing architecture.\n\n${oldProjectInstruction}\n## Other rules\nPreserve these.\n`);
  symlinkSync(shared, join(root, "AGENTS.md"));
  write(root, ".gitignore", "dist/\n/.verify/\n");
  write(root, "VERIFY.md", "Our existing behaviour guide.\n");
  write(root, "verify.json", JSON.stringify({ checks: { existing: { command: "true", expect: "Existing contract" } } }));
  write(root, ".verify/runs/previous/check/output.log", "Keep the original evidence.\n");
  write(root, ".verify/latest", "previous\n");
  write(root, ".verify/plan.json", '{"goal":"Keep this plan"}\n');
  write(root, ".verify/notes.txt", "Keep custom content.\n");
  write(root, ".groundwork/scripts/custom.mjs", "// Keep reusable scripts\n");
  const config = readFileSync(join(root, "verify.json"), "utf8");
  expect(invoke(root, ["init"]).code).toBe(0);
  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  const ignores = readFileSync(join(root, ".gitignore"), "utf8");
  expect(instructions).toStartWith("Keep our existing architecture.");
  expect(ignores).toBe("dist/\n/.verify/\n");
  expect(instructions).toEndWith("## Other rules\nPreserve these.\n");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(instructions).toContain("`.groundwork/verify.json`");
  expect(realpathSync(join(root, "AGENTS.md"))).toBe(shared);
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(instructions);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ignores);
  expect(readFileSync(join(root, ".groundwork/verify.json"), "utf8")).toBe(config);
  expect(readFileSync(join(root, ".groundwork/VERIFY.md"), "utf8")).toBe("Our existing behaviour guide.\n");
  expect(readFileSync(join(root, ".groundwork/runs/previous/check/output.log"), "utf8")).toBe("Keep the original evidence.\n");
  expect(readFileSync(join(root, ".groundwork/latest"), "utf8")).toBe("previous\n");
  expect(readFileSync(join(root, ".groundwork/plan.json"), "utf8")).toBe('{"goal":"Keep this plan"}\n');
  expect(readFileSync(join(root, ".groundwork/notes.txt"), "utf8")).toBe("Keep custom content.\n");
  expect(readFileSync(join(root, ".groundwork/scripts/custom.mjs"), "utf8")).toBe("// Keep reusable scripts\n");
  expect(readFileSync(join(root, ".groundwork/.gitignore"), "utf8")).toEndWith("/plan.json\n");
  for (const path of ["verify.json", "VERIFY.md", ".verify"]) expect(existsSync(join(root, path))).toBe(false);
});

test.each(["verify.json", ".groundwork/verify.json"])("migration updates moved catalogue guide references in %s without rewriting commands or other guides", configPath => {
  const root = temporaryDirectory();
  const check = { command: "cat VERIFY.md && bun scripts/check.mjs", setup: "echo verify.json", expect: "Keep commands", paths: ["VERIFY.md"], covers: ["guide"] };
  write(root, configPath, JSON.stringify({ checks: { check }, behaviours: {
    guide: { description: "Moved guide", guide: "VERIFY.md#journey" },
    other: { description: "Other guide", guide: "docs/guide.md#journey" },
  }, invariants: { preserved: { description: "Moved invariant guide", guide: "VERIFY.md", checks: ["check"] } } }));
  write(root, "VERIFY.md", "# Guide\n\n## Journey\nCustom text.\n");
  write(root, "docs/guide.md", "# Journey\n");
  expect(invoke(root, ["init"]).code).toBe(0);
  const config = JSON.parse(readFileSync(join(root, ".groundwork/verify.json"), "utf8"));
  expect(config.checks.check).toEqual(check);
  expect(config.behaviours.guide.guide).toBe(".groundwork/VERIFY.md#journey");
  expect(config.behaviours.other.guide).toBe("docs/guide.md#journey");
  expect(config.invariants.preserved.guide).toBe(".groundwork/VERIFY.md");
  expect(invoke(root, ["view", "guide"]).code).toBe(0);
});

test.each(["verify.json", "VERIFY.md", "runs/old/check/output.log", "latest", "legacy-verify.gitignore"])("migration preflights a %s collision before moving any files", path => {
  const root = temporaryDirectory();
  write(root, "verify.json", '{"checks":{}}\n');
  write(root, "VERIFY.md", "Old guide\n");
  write(root, "AGENTS.md", oldProjectInstruction);
  write(root, ".verify/runs/old/check/output.log", "Old evidence\n");
  write(root, ".verify/latest", "old\n");
  write(root, ".verify/.gitignore", "*\n");
  const destination = `.groundwork/${path}`;
  write(root, destination, "Keep the destination.\n");
  const result = invoke(root, ["init"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Migration collision");
  expect(readFileSync(join(root, destination), "utf8")).toBe("Keep the destination.\n");
  expect(readFileSync(join(root, "verify.json"), "utf8")).toBe('{"checks":{}}\n');
  expect(readFileSync(join(root, "VERIFY.md"), "utf8")).toBe("Old guide\n");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(oldProjectInstruction);
  expect(readFileSync(join(root, ".verify/runs/old/check/output.log"), "utf8")).toBe("Old evidence\n");
  expect(readFileSync(join(root, ".verify/latest"), "utf8")).toBe("old\n");
  expect(existsSync(join(root, ".groundwork/.gitignore"))).toBe(false);
});

test("migration rejects case-equivalent planned destinations without moving or overwriting source files", () => {
  const root = temporaryDirectory();
  const config = '{"checks":{"original":{"command":"true","expect":"Keep original checks"}}}\n';
  write(root, "verify.json", config);
  write(root, "VERIFY.md", "Original guide\n");
  write(root, ".verify/VERIFY.JSON", "Different legacy data\n");
  const result = invoke(root, ["init"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Migration collision");
  expect(readFileSync(join(root, "verify.json"), "utf8")).toBe(config);
  expect(readFileSync(join(root, "VERIFY.md"), "utf8")).toBe("Original guide\n");
  expect(readFileSync(join(root, ".verify/VERIFY.JSON"), "utf8")).toBe("Different legacy data\n");
  expect(existsSync(join(root, ".groundwork"))).toBe(false);
  expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
});

test("legacy blanket ignore rules are preserved as an inactive file and cannot hide verification inputs", () => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, "verify.json", JSON.stringify({ checks: { original: { command: "true", expect: "Original check passes" } } }));
  write(root, "VERIFY.md", "Original guide\n");
  write(root, ".verify/.gitignore", "# Legacy runtime-only directory\n*\n");
  write(root, ".verify/scripts/check.mjs", "console.log('Reusable helper');\n");
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readFileSync(join(root, ".groundwork/legacy-verify.gitignore"), "utf8")).toBe("# Legacy runtime-only directory\n*\n");
  expect(readFileSync(join(root, ".groundwork/.gitignore"), "utf8")).not.toContain("*");
  const changes = git(root, "status", "--porcelain", "--untracked-files=all");
  for (const path of ["verify.json", "VERIFY.md", "scripts/check.mjs"]) expect(changes).toContain(`.groundwork/${path}`);
  expect(invoke(root, ["verify"]).code).toBe(0);
  setChecks(root, { original: { command: "false", expect: "Original check passes" } });
  const report = invoke(root, ["view", "report"]);
  expect(report.code).toBe(2);
  expect(report.output).toContain("Source changed");
  expect(invoke(root, ["verify"]).code).toBe(1);
});

test("migration merges distinct evidence directories and rejects ambiguous links and planned file collisions", () => {
  const root = temporaryDirectory();
  write(root, ".verify/runs/old/output.log", "old");
  write(root, ".groundwork/runs/new/output.log", "new");
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readFileSync(join(root, ".groundwork/runs/old/output.log"), "utf8")).toBe("old");
  expect(readFileSync(join(root, ".groundwork/runs/new/output.log"), "utf8")).toBe("new");
  const ambiguous = temporaryDirectory();
  write(ambiguous, "verify.json", '{"checks":{}}');
  write(ambiguous, ".verify/verify.json/notes.txt", "This is a directory");
  expect(invoke(ambiguous, ["init"]).code).toBe(2);
  expect(existsSync(join(ambiguous, "verify.json"))).toBe(true);
  expect(existsSync(join(ambiguous, ".groundwork"))).toBe(false);
  const linked = temporaryDirectory();
  write(linked, "verify.json", '{"checks":{}}');
  symlinkSync(root, join(linked, ".groundwork"));
  expect(invoke(linked, ["init"]).code).toBe(2);
  expect(existsSync(join(linked, "verify.json"))).toBe(true);
  expect(lstatSync(join(linked, ".groundwork")).isSymbolicLink()).toBe(true);
});

test("personal install preserves shared instruction symlinks and existing content", () => {
  const home = temporaryDirectory();
  const shared = join(home, "shared.md");
  write(home, "shared.md", `Existing personal rules.\n\n${oldGlobalInstruction}\n## Keep this section\nCustom instructions.\n`);
  for (const target of [".copilot/copilot-instructions.md", ".config/opencode/AGENTS.md"]) {
    mkdirSync(dirname(join(home, target)), { recursive: true });
    symlinkSync(shared, join(home, target));
  }
  const env = { HOME: home, COPILOT_HOME: join(home, ".copilot"), XDG_CONFIG_HOME: join(home, ".config") };
  expect(invoke(home, ["install"], env).code).toBe(0);
  const instructions = readFileSync(shared, "utf8");
  expect(instructions).toStartWith("Existing personal rules.\n");
  expect(instructions).toEndWith("## Keep this section\nCustom instructions.\n");
  expect(instructions).toContain("`.groundwork/VERIFY.md` and `.groundwork/verify.json`");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(realpathSync(join(home, ".agents/skills/verify-work"))).toBe(realpathSync(dirname(cli)));
  expect(invoke(home, ["install"], env).code).toBe(0);
  expect(readFileSync(shared, "utf8")).toBe(instructions);
  expect(realpathSync(join(home, ".config/opencode/AGENTS.md"))).toBe(shared);
});

test("a real persistence failure becomes a passing run after a fix, with both sets of evidence retained", () => {
  const root = project({
    "theme-persists": { command: "bun .groundwork/scripts/scenario.mjs", expect: "Dark theme survives a new application process", artifacts: ["observation.json"] },
  });
  write(root, "app.mjs", `import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.STATE_FILE;
if (process.argv[2] === "set") writeFileSync(file, JSON.stringify({ theme: "light" }));
else console.log(JSON.parse(readFileSync(file, "utf8")).theme);
`);
  write(root, ".groundwork/scripts/scenario.mjs", `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const env = { ...process.env, STATE_FILE: join(process.env.VERIFY_ARTIFACTS, "state.json") };
const set = spawnSync(process.execPath, ["app.mjs", "set", "dark"], { env });
if (set.status !== 0) process.exit(2);
const read = spawnSync(process.execPath, ["app.mjs", "get"], { env, encoding: "utf8" });
if (read.status !== 0) process.exit(2);
const actual = read.stdout.trim();
writeFileSync(join(process.env.VERIFY_ARTIFACTS, "observation.json"), JSON.stringify({ expected: "dark", actual }));
console.log("Theme after restart:", actual);
process.exit(actual === "dark" ? 0 : 1);
`);
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Broken persistence fixture");
  const failure = invoke(root, ["verify", "theme-persists"]);
  expect(failure.code).toBe(1);
  const before = saved(root);
  expect(before.data.checks[0].status).toBe("failed");
  expect(readFileSync(join(before.directory, "theme-persists/output.log"), "utf8")).toContain("Theme after restart: light");
  write(root, "app.mjs", readFileSync(join(root, "app.mjs"), "utf8").replace('theme: "light"', "theme: process.argv[3]"));
  const success = invoke(root, ["verify", "theme-persists"]);
  expect(success.code).toBe(0);
  const after = saved(root);
  expect(after.data.checks[0].status).toBe("passed");
  expect(after.data.source.dirty).toBe(true);
  expect(after.data.source.fingerprint).not.toBe(before.data.source.fingerprint);
  expect(after.directory).not.toBe(before.directory);
  expect(readFileSync(join(after.directory, "theme-persists/artifacts/observation.json"), "utf8")).toContain('"actual":"dark"');
  expect(existsSync(join(before.directory, "result.json"))).toBe(true);
  expect(invoke(root, ["view", "report"]).code).toBe(0);
  write(root, "app.mjs", `${readFileSync(join(root, "app.mjs"), "utf8")}\nconsole.error("Changed again");\n`);
  const stale = invoke(root, ["view", "report"]);
  expect(stale.code).toBe(2);
  expect(stale.output).toContain("Source changed");
});

test("named selection includes required checks and discloses omitted checks", () => {
  const root = project({
    required: { command: "bun -e 'console.error(\"Required failure\"); process.exit(1)'", expect: "Required check passes", required: true },
    feature: { command: "bun .groundwork/scripts/check.mjs", expect: "Run from the project directory" },
    unrelated: { command: "false", expect: "Another feature works" },
  });
  write(root, "value.txt", "project-relative input");
  write(root, ".groundwork/scripts/check.mjs", 'import { readFileSync } from "node:fs"; console.log(process.cwd(), readFileSync("value.txt", "utf8"));');
  mkdirSync(join(root, "nested"));
  write(root, ".groundwork/config/verify.json", "This is not the project's check configuration");
  for (const cwd of ["nested", ".groundwork", ".groundwork/scripts", ".groundwork/config"]) {
    const result = invoke(join(root, cwd), ["verify", "feature"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Not selected: unrelated");
    const { data, directory } = saved(root);
    expect(data.checks.map(check => check.name)).toEqual(["required", "feature"]);
    expect(data.checks.find(check => check.name === "feature").status).toBe("passed");
    expect(readFileSync(join(directory, "feature/output.log"), "utf8")).toContain(root);
    expect(readFileSync(join(directory, "feature/output.log"), "utf8")).toContain("project-relative input");
  }
});

test("legacy config runs write new evidence under .groundwork and old latest remains readable until replaced", () => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, "verify.json", JSON.stringify({ checks: { legacy: { command: "true", expect: "Legacy checks run" } } }));
  expect(invoke(root, ["verify"]).code).toBe(0);
  const previous = saved(root);
  expect(existsSync(join(root, ".verify"))).toBe(false);
  expect(existsSync(join(root, ".gitignore"))).toBe(false);
  renameSync(join(root, ".groundwork"), join(root, ".verify"));
  expect(invoke(root, ["view", "report"]).code).toBe(0);
  write(root, "verify.json", JSON.stringify({ checks: { legacy: { command: "false", expect: "Legacy checks run" } } }));
  expect(invoke(root, ["verify"]).code).toBe(1);
  expect(saved(root).data.id).not.toBe(previous.data.id);
  expect(invoke(root, ["view", "report"]).code).toBe(1);
  expect(readFileSync(join(root, ".verify/latest"), "utf8").trim()).toBe(previous.data.id);
  expect(readdirSync(join(root, ".verify/runs"))).toEqual([previous.data.id]);
});

test("namespaced scripts and configuration affect report freshness while runtime output is ignored", () => {
  const root = project({ script: { command: "bun .groundwork/scripts/check.mjs", expect: "Run the project-owned script" } });
  write(root, ".groundwork/scripts/check.mjs", 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(".groundwork/tmp", { recursive: true }); writeFileSync(".groundwork/tmp/state.txt", "runtime output");');
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Project-owned verification inputs");
  expect(invoke(root, ["verify"]).code).toBe(0);
  for (const path of ["runs/another/output.log", "plans/task.json", "tasks/task.md", "tmp/state.txt"]) write(root, `.groundwork/${path}`, "Updated runtime output");
  write(root, ".verify/runs/old/output.log", "Old runtime output");
  expect(invoke(root, ["view", "report"]).code).toBe(0);
  const script = readFileSync(join(root, ".groundwork/scripts/check.mjs"), "utf8");
  write(root, ".groundwork/scripts/check.mjs", `${script}\n// Driver changed\n`);
  expect(invoke(root, ["view", "report"]).output).toContain("Source changed");
  expect(invoke(root, ["view", "report"]).code).toBe(2);
  expect(invoke(root, ["verify"]).code).toBe(0);
  const config = readFileSync(join(root, ".groundwork/verify.json"), "utf8");
  write(root, ".groundwork/verify.json", `${config}\n`);
  expect(invoke(root, ["view", "report"]).code).toBe(2);
});

test("an empty setup and unknown checks cannot report success", () => {
  const root = project();
  expect(invoke(root, ["verify"]).code).toBe(2);
  expect(invoke(root, ["verify", "missing"]).code).toBe(2);
  expect(invoke(root, ["view", "report"]).code).toBe(2);
});

test("malformed configuration is rejected before executing commands", () => {
  const root = project({ invalid: { command: "touch executed", expect: "Valid evidence", artifacts: ["../outside.txt"] } });
  expect(invoke(root, ["verify"]).code).toBe(2);
  expect(existsSync(join(root, "executed"))).toBe(false);
});

test("feature maps show declared dependency direction and useful pointers without inferring shared-check or path links", () => {
  const root = temporaryDirectory();
  write(root, "docs/map.md", "# Saving\n");
  write(root, ".groundwork/verify.json", JSON.stringify({
    checks: { journey: { command: "printf ran > executed", expect: "Save a document", covers: ["saving", "unrelated"] } },
    behaviours: {
      saving: { description: "Save\nrévisions", entry: "app save\n<file>", paths: ["src/save/**", "src/shared.mjs", "src/two  spaces.mjs"], guide: "docs/map.md#saving", dependsOn: ["storage", "session"] },
      dashboard: { description: "Save from the dashboard", dependsOn: ["saving"] },
      command: { description: "Save from a command", dependsOn: ["saving"] },
      session: { description: "Identify the workspace" },
      storage: { description: "Store contents", dependsOn: ["codec"] },
      codec: { description: "Encode contents" },
      unrelated: { description: "Share a suite but no recorded link", paths: ["src/save/**"] },
      isolated: { description: "No recorded links" },
    },
    invariants: { durable: { description: "Stored data survives", checks: ["journey"], guide: "docs/missing-invariant.md" } },
  }));
  const overview = invoke(root, ["map"]);
  expect(overview.code).toBe(0);
  expect(overview.output).toContain("Feature map: all behaviours");
  expect(overview.output).toContain("[saving] -> [storage]");
  expect(overview.output).toContain("[dashboard] -> [saving]");
  expect(overview.output).toContain("[storage] -> [codec]");
  expect(overview.output).toContain("[isolated]\n`-- Depends on (recorded): none recorded");
  expect(overview.output.indexOf("\n[session]\n")).toBeLessThan(overview.output.indexOf("\n[storage]\n"));
  const focused = invoke(root, ["map", "saving"]);
  expect(focused.code).toBe(0);
  expect(focused.output).toContain("Feature map: saving");
  expect(focused.output).toContain("+-- Used by (recorded)\n|   +-- [dashboard] -> [saving]\n|   `-- [command] -> [saving]");
  expect(focused.output).toContain("`-- Depends on (recorded)\n    +-- [saving] -> [storage]\n    `-- [saving] -> [session]");
  expect(focused.output).toContain("Description: Save révisions\n  Entry: app save <file>");
  expect(focused.output).toContain("Implementation paths: src/save/**, src/shared.mjs, src/two  spaces.mjs");
  expect(focused.output).toContain("Covering checks: journey");
  expect(focused.output).toContain("Narrative guide: docs/map.md#saving");
  expect(focused.output).toContain("Recorded direct relationships; checks are listed without running them");
  for (const id of ["unrelated", "isolated", "codec", "durable"]) expect(focused.output).not.toContain(`[${id}]`);
  expect(existsSync(join(root, "executed"))).toBe(false);
  expect(existsSync(join(root, ".groundwork/runs"))).toBe(false);
  expect(existsSync(join(root, ".groundwork/latest"))).toBe(false);
});

test.each([".groundwork/verify.json", "verify.json"])("feature maps discover %s from nested directories without Git and preserve project state", configPath => {
  const root = temporaryDirectory();
  const config = JSON.stringify({
    checks: { forbidden: { command: "printf ran > executed", expect: "Run only when requested", required: true, covers: ["saving"] } },
    behaviours: { saving: { description: "Save a document", guide: "docs/map.md#saving" } },
  });
  write(root, configPath, config);
  write(root, "docs/map.md", "# Saving\n");
  write(root, ".groundwork/latest", "previous\n");
  write(root, ".groundwork/runs/previous/result.json", "Retain this exact evidence.\n");
  write(root, ".groundwork/config/verify.json", "Not the project config");
  mkdirSync(join(root, "src/nested"), { recursive: true });
  for (const cwd of ["src/nested", ".groundwork/config"]) {
    const result = invoke(join(root, cwd), ["map", "saving"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Narrative guide: docs/map.md#saving");
  }
  expect(readFileSync(join(root, configPath), "utf8")).toBe(config);
  expect(readFileSync(join(root, "docs/map.md"), "utf8")).toBe("# Saving\n");
  expect(readFileSync(join(root, ".groundwork/latest"), "utf8")).toBe("previous\n");
  expect(readFileSync(join(root, ".groundwork/runs/previous/result.json"), "utf8")).toBe("Retain this exact evidence.\n");
  expect(readdirSync(join(root, ".groundwork/runs"))).toEqual(["previous"]);
  for (const path of ["executed", ".git", "AGENTS.md", ".groundwork/VERIFY.md", ".groundwork/.gitignore"]) {
    expect(existsSync(join(root, path))).toBe(false);
  }
  if (configPath === "verify.json") expect(existsSync(join(root, ".groundwork/verify.json"))).toBe(false);
});

test("feature maps explain empty and unmapped catalogues without initializing a project", () => {
  const root = temporaryDirectory();
  expect(invoke(root, ["map"]).code).toBe(2);
  expect(readdirSync(root)).toEqual([]);
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: {} }));
  const empty = invoke(root, ["map"]);
  expect(empty.code).toBe(0);
  expect(empty.output).toContain("No behaviours recorded");
  expect(empty.output).toContain("Add behaviours to .groundwork/verify.json");
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: {}, behaviours: {
    planned: { description: "Import a document", entry: " \n ", paths: [] },
  } }));
  const unmapped = invoke(root, ["map", "planned"]);
  expect(unmapped.code).toBe(0);
  expect(unmapped.output).toContain("Used by (recorded): none recorded");
  expect(unmapped.output).toContain("Depends on (recorded): none recorded");
  expect(unmapped.output).toContain("Entry: not recorded");
  expect(unmapped.output).toContain("Implementation paths: not mapped");
  expect(unmapped.output).toContain("Covering checks: not mapped");
  expect(unmapped.output).toContain("Narrative guide: not recorded");
  expect(readdirSync(join(root, ".groundwork"))).toEqual(["verify.json"]);
});

test("feature lookup prefers exact IDs, supports unique ID or description queries, and rejects ambiguity and flags", () => {
  const root = temporaryDirectory();
  write(root, ".groundwork/verify.json", JSON.stringify({
    checks: { policy: { command: "true", expect: "Release policy holds" } },
    behaviours: {
      save: { description: "Write a document" },
      Save: { description: "Write an archive" },
      "save-copy": { description: "Save a separate copy" },
      publishing: { description: "Deploy a release", entry: "/deployment-control", paths: ["src/outbound/**"] },
    },
    invariants: { "release-policy": { description: "Deploy a release safely", checks: ["policy"] } },
  }));
  for (const id of ["save", "Save"]) {
    const exact = invoke(root, ["map", id]);
    expect(exact.code).toBe(0);
    expect(exact.output).toContain(`Feature map: ${id}\n`);
    expect(exact.output).not.toContain("[save-copy]");
  }
  for (const query of [["PUBLI"], ["deploy", "a", "RELEASE"]]) {
    const unique = invoke(root, ["map", ...query]);
    expect(unique.code).toBe(0);
    expect(unique.output).toContain("Feature map: publishing\n");
  }
  const ambiguous = invoke(root, ["map", "SaVe"]);
  expect(ambiguous.code).toBe(2);
  expect(ambiguous.output).toContain('Ambiguous feature "SaVe"');
  expect(ambiguous.output).toContain("Matching IDs: save, Save, save-copy");
  for (const query of ["missing", "release-policy", "/deployment-control", "src/outbound"]) {
    const missing = invoke(root, ["map", query]);
    expect(missing.code).toBe(2);
    expect(missing.output).toContain(`Unknown feature "${query}"`);
    expect(missing.output).toContain("Run groundwork map");
  }
  for (const args of [["--depth", "2"], ["save", "-x"]]) {
    const invalid = invoke(root, ["map", ...args]);
    expect(invalid.code).toBe(2);
    expect(invalid.output).toContain("Unknown option:");
  }
});

test("cyclic feature maps remain finite and show both direct directions", () => {
  const root = temporaryDirectory();
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: {}, behaviours: {
    first: { description: "First feature", dependsOn: ["second"] },
    second: { description: "Second feature", dependsOn: ["first"] },
  } }));
  for (const args of [["map"], ["map", "first"]]) {
    const result = invoke(root, args);
    expect(result.code).toBe(0);
    expect(result.output.match(/\[first\] -> \[second\]/g)).toHaveLength(1);
    expect(result.output.match(/\[second\] -> \[first\]/g)).toHaveLength(1);
    expect(result.output.split("\n").length).toBeLessThan(60);
  }
});

test("feature maps retain diagrams while reporting stale guides for exactly the displayed behaviours", () => {
  const root = temporaryDirectory();
  write(root, "docs/map.md", "# Current\n");
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: {}, behaviours: {
    saving: { description: "Save a document", guide: "docs/map.md#old-save", dependsOn: ["storage"] },
    dashboard: { description: "Save from a dashboard", guide: "docs/missing.md", dependsOn: ["saving"] },
    storage: { description: "Store a document", guide: "docs/map.md#old-storage" },
    unrelated: { description: "Unrelated feature", guide: "docs/map.md#old-unrelated" },
    isolated: { description: "An unmapped feature" },
  } }));
  const focused = invoke(root, ["map", "saving"]);
  expect(focused.code).toBe(2);
  expect(focused.output).toContain("[dashboard] -> [saving]");
  expect(focused.output).toContain("[saving] -> [storage]");
  expect(focused.output).toContain("Narrative guide: docs/map.md#old-save");
  expect(focused.output).toContain("saving: missing guide anchor #old-save");
  expect(focused.output).toContain("dashboard: cannot read guide docs/missing.md");
  expect(focused.output).toContain("storage: missing guide anchor #old-storage");
  expect(focused.output).not.toContain("unrelated");
  const overview = invoke(root, ["map"]);
  expect(overview.code).toBe(2);
  expect(overview.output).toContain("[saving] -> [storage]");
  expect(overview.output).toContain("unrelated: missing guide anchor #old-unrelated");
  expect(invoke(root, ["map", "isolated"]).code).toBe(0);
  expect(existsSync(join(root, ".groundwork/latest"))).toBe(false);
});

test("missing fresh evidence cannot reuse a previous run's artifact", () => {
  const root = project({ evidence: { command: "bun -e 'require(\"node:fs\").writeFileSync(process.env.VERIFY_ARTIFACTS + \"/proof.txt\", \"observed\")'", expect: "Capture proof", artifacts: ["proof.txt"] } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  const previous = saved(root);
  setChecks(root, { evidence: { command: "true", expect: "Capture proof", artifacts: ["proof.txt"] } });
  expect(invoke(root, ["verify"]).code).toBe(2);
  expect(saved(root).data.checks[0].status).toBe("inconclusive");
  expect(existsSync(join(previous.directory, "evidence/artifacts/proof.txt"))).toBe(true);
});

test("a saved success becomes inconclusive when its evidence is altered", () => {
  const root = project({ evidence: { command: "bun -e 'require(\"node:fs\").writeFileSync(process.env.VERIFY_ARTIFACTS + \"/proof.txt\", \"observed\")'", expect: "Capture proof", artifacts: ["proof.txt"] } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  const { directory } = saved(root);
  writeFileSync(join(directory, "evidence/artifacts/proof.txt"), "different observation");
  const report = invoke(root, ["view", "report"]);
  expect(report.code).toBe(2);
  expect(report.output).toContain("evidence changed");
});

test("changes made by a command leave its result inconclusive", () => {
  const root = project({ changes: { command: "bun -e 'require(\"node:fs\").writeFileSync(\"changed.txt\", \"new source\")'", expect: "Check unchanged source" } });
  const result = invoke(root, ["verify"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Source changed");
});

test("unavailable observations and malformed saved reports remain inconclusive", () => {
  const root = project({ blocked: { command: "bun -e 'process.exit(2)'", expect: "Environment is available" } });
  expect(invoke(root, ["verify"]).code).toBe(2);
  const { directory } = saved(root);
  writeFileSync(join(directory, "result.json"), JSON.stringify({ version: 1, checks: [] }));
  const result = invoke(root, ["view", "report"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Invalid saved verification report");
});

test("an interrupted attempt replaces an earlier success with an incomplete latest run", async () => {
  const root = project({ check: { command: "true", expect: "Complete the check" } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  const previous = saved(root);
  setChecks(root, { check: { command: "bun -e 'console.log(\"READY\"); setTimeout(() => {}, 200)'", expect: "Complete the check" } });
  const child = spawn(process.execPath, [cli, "verify"], { cwd: root, env: { ...process.env, GROUNDWORK_PORTAL: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk;
    if (/^READY$/m.test(output)) child.kill("SIGTERM");
  });
  await once(child, "close");
  expect(saved(root).directory).not.toBe(previous.directory);
  const result = invoke(root, ["view", "report"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("latest run did not finish");
});
