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
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
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
  const child = spawn(process.execPath, [cli, "verify"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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
