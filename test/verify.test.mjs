import { afterEach, expect, test } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
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
  write(root, "verify.json", JSON.stringify({ checks }));
}

function saved(root) {
  const id = readFileSync(join(root, ".verify", "latest"), "utf8").trim();
  const directory = join(root, ".verify", "runs", id);
  return { directory, data: JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) };
}

test("project setup preserves existing files and is repeatable", () => {
  const root = temporaryDirectory();
  write(root, "AGENTS.md", "Keep our existing architecture.");
  write(root, ".gitignore", "dist/\n");
  write(root, "VERIFY.md", "Our existing behaviour guide.\n");
  setChecks(root, { existing: { command: "true", expect: "Existing contract" } });
  const config = readFileSync(join(root, "verify.json"), "utf8");
  expect(invoke(root, ["init"]).code).toBe(0);
  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  const ignores = readFileSync(join(root, ".gitignore"), "utf8");
  expect(instructions).toStartWith("Keep our existing architecture.");
  expect(ignores).toStartWith("dist/\n");
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(instructions);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ignores);
  expect(readFileSync(join(root, "verify.json"), "utf8")).toBe(config);
  expect(readFileSync(join(root, "VERIFY.md"), "utf8")).toBe("Our existing behaviour guide.\n");
});

test("personal install preserves shared instruction symlinks and existing content", () => {
  const home = temporaryDirectory();
  const shared = join(home, "shared.md");
  write(home, "shared.md", "Existing personal rules.\n");
  for (const target of [".copilot/copilot-instructions.md", ".config/opencode/AGENTS.md"]) {
    mkdirSync(dirname(join(home, target)), { recursive: true });
    symlinkSync(shared, join(home, target));
  }
  const env = { HOME: home, COPILOT_HOME: join(home, ".copilot"), XDG_CONFIG_HOME: join(home, ".config") };
  expect(invoke(home, ["install"], env).code).toBe(0);
  const instructions = readFileSync(shared, "utf8");
  expect(instructions).toStartWith("Existing personal rules.\n");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(realpathSync(join(home, ".agents/skills/verify-work"))).toBe(realpathSync(dirname(cli)));
  expect(invoke(home, ["install"], env).code).toBe(0);
  expect(readFileSync(shared, "utf8")).toBe(instructions);
  expect(realpathSync(join(home, ".config/opencode/AGENTS.md"))).toBe(shared);
});

test("a real persistence failure becomes a passing run after a fix, with both sets of evidence retained", () => {
  const root = project({
    "theme-persists": { command: "bun scenario.mjs", expect: "Dark theme survives a new application process", artifacts: ["observation.json"] },
  });
  write(root, "app.mjs", `import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.STATE_FILE;
if (process.argv[2] === "set") writeFileSync(file, JSON.stringify({ theme: "light" }));
else console.log(JSON.parse(readFileSync(file, "utf8")).theme);
`);
  write(root, "scenario.mjs", `import { spawnSync } from "node:child_process";
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
  const failure = invoke(root, ["run", "theme-persists"]);
  expect(failure.code).toBe(1);
  const before = saved(root);
  expect(before.data.checks[0].status).toBe("failed");
  expect(readFileSync(join(before.directory, "theme-persists/output.log"), "utf8")).toContain("Theme after restart: light");
  write(root, "app.mjs", readFileSync(join(root, "app.mjs"), "utf8").replace('theme: "light"', "theme: process.argv[3]"));
  const success = invoke(root, ["run", "theme-persists"]);
  expect(success.code).toBe(0);
  const after = saved(root);
  expect(after.data.checks[0].status).toBe("passed");
  expect(after.data.source.dirty).toBe(true);
  expect(after.data.source.fingerprint).not.toBe(before.data.source.fingerprint);
  expect(after.directory).not.toBe(before.directory);
  expect(readFileSync(join(after.directory, "theme-persists/artifacts/observation.json"), "utf8")).toContain('"actual":"dark"');
  expect(existsSync(join(before.directory, "result.json"))).toBe(true);
  expect(invoke(root, ["report"]).code).toBe(0);
  write(root, "app.mjs", `${readFileSync(join(root, "app.mjs"), "utf8")}\nconsole.error("Changed again");\n`);
  const stale = invoke(root, ["report"]);
  expect(stale.code).toBe(2);
  expect(stale.output).toContain("Source changed");
});

test("named selection includes required checks and discloses omitted checks", () => {
  const root = project({
    required: { command: "bun -e 'console.error(\"Required failure\"); process.exit(1)'", expect: "Required check passes", required: true },
    feature: { command: "bun -e 'console.log(process.cwd())'", expect: "Run from the project directory" },
    unrelated: { command: "false", expect: "Another feature works" },
  });
  mkdirSync(join(root, "nested"));
  const result = invoke(join(root, "nested"), ["run", "feature"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("Not selected: unrelated");
  const { data, directory } = saved(root);
  expect(data.checks.map(check => check.name)).toEqual(["required", "feature"]);
  expect(readFileSync(join(directory, "feature/output.log"), "utf8")).toContain(root);
});

test("an empty setup and unknown checks cannot report success", () => {
  const root = project();
  expect(invoke(root, ["run"]).code).toBe(2);
  expect(invoke(root, ["run", "missing"]).code).toBe(2);
  expect(invoke(root, ["report"]).code).toBe(2);
});

test("malformed configuration is rejected before executing commands", () => {
  const root = project({ invalid: { command: "touch executed", expect: "Valid evidence", artifacts: ["../outside.txt"] } });
  expect(invoke(root, ["run"]).code).toBe(2);
  expect(existsSync(join(root, "executed"))).toBe(false);
});

test("missing fresh evidence cannot reuse a previous run's artifact", () => {
  const root = project({ evidence: { command: "bun -e 'require(\"node:fs\").writeFileSync(process.env.VERIFY_ARTIFACTS + \"/proof.txt\", \"observed\")'", expect: "Capture proof", artifacts: ["proof.txt"] } });
  expect(invoke(root, ["run"]).code).toBe(0);
  const previous = saved(root);
  setChecks(root, { evidence: { command: "true", expect: "Capture proof", artifacts: ["proof.txt"] } });
  expect(invoke(root, ["run"]).code).toBe(2);
  expect(saved(root).data.checks[0].status).toBe("inconclusive");
  expect(existsSync(join(previous.directory, "evidence/artifacts/proof.txt"))).toBe(true);
});

test("a saved success becomes inconclusive when its evidence is altered", () => {
  const root = project({ evidence: { command: "bun -e 'require(\"node:fs\").writeFileSync(process.env.VERIFY_ARTIFACTS + \"/proof.txt\", \"observed\")'", expect: "Capture proof", artifacts: ["proof.txt"] } });
  expect(invoke(root, ["run"]).code).toBe(0);
  const { directory } = saved(root);
  writeFileSync(join(directory, "evidence/artifacts/proof.txt"), "different observation");
  const report = invoke(root, ["report"]);
  expect(report.code).toBe(2);
  expect(report.output).toContain("evidence changed");
});

test("changes made by a command leave its result inconclusive", () => {
  const root = project({ changes: { command: "bun -e 'require(\"node:fs\").writeFileSync(\"changed.txt\", \"new source\")'", expect: "Check unchanged source" } });
  const result = invoke(root, ["run"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Source changed");
});

test("unavailable observations and malformed saved reports remain inconclusive", () => {
  const root = project({ blocked: { command: "bun -e 'process.exit(2)'", expect: "Environment is available" } });
  expect(invoke(root, ["run"]).code).toBe(2);
  const { directory } = saved(root);
  writeFileSync(join(directory, "result.json"), JSON.stringify({ version: 1, checks: [] }));
  const result = invoke(root, ["report"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Invalid saved verification report");
});

test("an interrupted attempt replaces an earlier success with an incomplete latest run", async () => {
  const root = project({ check: { command: "true", expect: "Complete the check" } });
  expect(invoke(root, ["run"]).code).toBe(0);
  const previous = saved(root);
  setChecks(root, { check: { command: "bun -e 'console.log(\"READY\"); setTimeout(() => {}, 200)'", expect: "Complete the check" } });
  const child = spawn(process.execPath, [cli, "run"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk;
    if (/^READY$/m.test(output)) child.kill("SIGTERM");
  });
  await once(child, "close");
  expect(saved(root).directory).not.toBe(previous.directory);
  const result = invoke(root, ["report"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("latest run did not finish");
});
