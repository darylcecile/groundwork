import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogueIssues, configFiles, loadConfig } from "../lib/config.mjs";
import { evidenceStore } from "../lib/store.mjs";
import { parseRecord, renderRecord } from "../lib/report.mjs";

const cli = fileURLToPath(new URL("../skills/verify-work/verify.mjs", import.meta.url));
const realBun = realpathSync(process.execPath);
const directories = [];
let previousStateHome;

beforeEach(() => {
  previousStateHome = process.env.GROUNDWORK_STATE_HOME;
  process.env.GROUNDWORK_STATE_HOME = temporaryDirectory();
});

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.GROUNDWORK_STATE_HOME;
  else process.env.GROUNDWORK_STATE_HOME = previousStateHome;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "verify-work-")));
  directories.push(directory);
  return directory;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function invoke(root, args, env = {}) {
  const result = spawnSync(realBun, [cli, ...args], { cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(realBun)}:${process.env.PATH}`, GROUNDWORK_PORTAL: "0", ...env } });
  return { code: result.status, output: result.stdout + result.stderr };
}

function snapshot(root) {
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name);
    const info = lstatSync(path);
    return info.isDirectory() ? snapshot(path) : [[path, info.mtimeMs, readFileSync(path, "utf8")]];
  });
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
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks }));
}

function saved(root) {
  const storage = evidenceStore(root);
  const id = readFileSync(storage.latest, "utf8").trim();
  const directory = join(storage.runs, id);
  return { directory, data: JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) };
}

function fakeGitHub({ head = "a".repeat(40), comments = [], statuses = [], denied = false } = {}) {
  const root = temporaryDirectory();
  const statePath = join(root, "github.json");
  const url = "https://github.example/example/project/pull/7";
  writeFileSync(statePath, JSON.stringify({ head, comments, statuses, denied, calls: [], url }));
  write(root, "gh", `#!${realBun}
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.TEST_GITHUB_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const body = args.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : undefined;
state.calls.push({ args, body });
const save = () => writeFileSync(file, JSON.stringify(state));
function send(data, status = 200) {
  save();
  if (args.includes("--include")) process.stdout.write("HTTP/2.0 " + status + " Response\\r\\nContent-Type: application/json\\r\\n\\r\\n");
  console.log(JSON.stringify(data));
  if (status >= 400) { console.error("gh: " + data.message + " (HTTP " + status + ")"); process.exit(1); }
  process.exit(0);
}
if (state.denied) send({ message: "GitHub is unavailable" }, 401);
if (args[0] === "pr" && args[1] === "view") send({ number: 7, headRefOid: state.head, url: state.url });
if (args[0] !== "api" || args[args.indexOf("--hostname") + 1] !== "github.example") send({ message: "Explicit host is required" }, 400);
const method = args[args.indexOf("--method") + 1];
const path = args.find(arg => arg.startsWith("/repos/"));
if (method === "GET" && path === "/repos/example/project/pulls/7") send({ number: 7, html_url: state.url, head: { sha: state.head } });
if (method === "GET" && path === "/repos/example/project/commits/" + state.head + "/statuses?per_page=100") send([state.statuses]);
if (path?.includes("/artifacts")) send({ message: "Not Found" }, 404);
if (method === "GET" && path === "/repos/example/project/issues/7/comments?per_page=100") {
  if (!args.includes("--paginate") || !args.includes("--slurp")) send({ message: "Pagination required" }, 400);
  send([state.comments.slice(0, 1), state.comments.slice(1)]);
}
const author = { id: 41, login: "publisher", type: "User" };
if (method === "POST" && path?.startsWith("/repos/example/project/statuses/")) send({ creator: author }, 201);
if (method === "POST" && path === "/repos/example/project/issues/7/comments") {
  const comment = { id: state.comments.length + 1, body: body.body, user: author, html_url: state.url + "#issuecomment-" + (state.comments.length + 1) };
  state.comments.push(comment);
  send(comment, 201);
}
if (method === "PATCH" && path?.startsWith("/repos/example/project/issues/comments/")) {
  const comment = state.comments.find(item => item.id === Number(path.split("/").at(-1)));
  if (!comment) send({ message: "Unknown comment" }, 404);
  comment.body = body.body;
  send(comment);
}
send({ message: "Unexpected request: " + args.join(" ") }, 400);
`);
  chmodSync(join(root, "gh"), 0o755);
  return { url, env: { PATH: `${root}:${dirname(realBun)}:${process.env.PATH}`, TEST_GITHUB_STATE: statePath },
    state: () => JSON.parse(readFileSync(statePath, "utf8")) };
}

test("fresh project setup keeps owned files under .groundwork and is repeatable", () => {
  const root = temporaryDirectory();
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readdirSync(root).sort()).toEqual([".groundwork", "AGENTS.md"]);
  expect(readdirSync(join(root, ".groundwork")).sort()).toEqual([".gitignore", "VERIFY.md", "guides", "verify.d"]);
  const ignores = readFileSync(join(root, ".groundwork/.gitignore"), "utf8");
  expect(ignores).toBe("/plans/\n/tasks/\n/tmp/\n");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("`.groundwork/VERIFY.md`");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("`.groundwork/verify.d/`");
  expect(loadConfig(root).checks).toEqual({});
  const initialized = snapshot(root);
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(snapshot(root)).toEqual(initialized);
  git(root, "init", "--quiet");
  setChecks(root, { clean: { command: "true", expect: "Verification keeps project files namespaced" } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  expect(readdirSync(root).sort()).toEqual([".git", ".groundwork", "AGENTS.md"]);
  const changes = git(root, "status", "--porcelain", "--untracked-files=all");
  expect(changes).toContain(".groundwork/verify.d/feature.json");
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
  const config = loadConfig(root);
  expect(invoke(root, ["init"]).code).toBe(0);
  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  const ignores = readFileSync(join(root, ".gitignore"), "utf8");
  expect(instructions).toStartWith("Keep our existing architecture.");
  expect(ignores).toBe("dist/\n");
  expect(instructions).toEndWith("## Other rules\nPreserve these.\n");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(instructions).toContain("`.groundwork/verify.d/`");
  expect(realpathSync(join(root, "AGENTS.md"))).toBe(shared);
  expect(invoke(root, ["init"]).code).toBe(0);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(instructions);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(ignores);
  expect(loadConfig(root)).toEqual(config);
  expect(readFileSync(join(root, ".groundwork/guides/project.md"), "utf8")).toBe("Our existing behaviour guide.\n");
  expect(readFileSync(join(root, ".groundwork/VERIFY.md"), "utf8")).toContain("guides/project.md");
  expect(readFileSync(join(evidenceStore(root).runs, "previous/check/output.log"), "utf8")).toBe("Keep the original evidence.\n");
  expect(readFileSync(evidenceStore(root).latest, "utf8")).toBe("previous\n");
  expect(readFileSync(join(root, ".groundwork/plan.json"), "utf8")).toBe('{"goal":"Keep this plan"}\n');
  expect(readFileSync(join(root, ".groundwork/notes.txt"), "utf8")).toBe("Keep custom content.\n");
  expect(readFileSync(join(root, ".groundwork/scripts/custom.mjs"), "utf8")).toBe("// Keep reusable scripts\n");
  expect(readFileSync(join(root, ".groundwork/.gitignore"), "utf8")).toEndWith("/plan.json\n");
  for (const path of ["verify.json", "VERIFY.md", ".verify", ".groundwork/verify.json"]) expect(existsSync(join(root, path))).toBe(false);
});

test.each(["verify.json", ".groundwork/verify.json", ".verify/verify.json"])("verification automatically migrates executable guide references and catalogue bindings from %s", configPath => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  const check = { command: "grep -q 'Shared context' VERIFY.md && bun scripts/check.mjs", setup: "test -f docs/guide.md", expect: "Keep the guide-backed check working", paths: ["VERIFY.md"], covers: ["guide"] };
  write(root, configPath, JSON.stringify({ checks: { check }, behaviours: {
    guide: { description: "Moved guide", guide: "VERIFY.md#journey" },
    other: { description: "Other guide", guide: "docs/guide.md#journey" },
  }, invariants: { preserved: { description: "Moved invariant guide", guide: "VERIFY.md", checks: ["check"] } } }));
  write(root, "VERIFY.md", "# Guide\n\nShared context.\n\n## Journey\nCustom text.\n");
  write(root, "docs/guide.md", "# Journey\n");
  write(root, "scripts/check.mjs", 'console.log("Guide-backed check passed");\n');
  const previous = loadConfig(root);
  const result = invoke(root, ["verify"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("Guide-backed check passed");
  const config = loadConfig(root);
  expect(config.checks.check).toEqual({ ...previous.checks.check,
    command: "grep -q 'Shared context' .groundwork/guides/project.md && bun scripts/check.mjs", paths: [".groundwork/guides/project.md"] });
  expect(readFileSync(join(root, config.behaviours.guide.guide.split("#")[0]), "utf8")).toContain("Custom text.");
  expect(config.behaviours.other.guide).toBe("docs/guide.md#journey");
  expect(config.invariants.preserved.guide).toBe(".groundwork/guides/project.md");
  expect(catalogueIssues(config, root)).toEqual([]);
  expect(invoke(root, ["view", "guide"]).code).toBe(0);
  expect(invoke(root, ["view", "report"]).code).toBe(0);
  expect(existsSync(join(root, configPath))).toBe(false);
});

test.each(["VERIFY.md", ".groundwork/VERIFY.md", ".verify/VERIFY.md"])("guide discovery migrates %s even before any checks were configured", path => {
  const root = temporaryDirectory();
  write(root, path, "# Project context\n\nKeep this setup.\n\n## Saving\nSave, restart, and read the value.\n");
  expect(invoke(root, ["view", "guide"]).code).toBe(0);
  expect(loadConfig(root).checks).toEqual({});
  expect(readFileSync(join(root, ".groundwork/guides/project.md"), "utf8")).toContain("Keep this setup.");
  const guides = readdirSync(join(root, ".groundwork/guides")).map(name => readFileSync(join(root, ".groundwork/guides", name), "utf8"));
  expect(guides.some(guide => guide.includes("Save, restart, and read the value."))).toBe(true);
  const migrated = snapshot(root);
  expect(invoke(root, ["view", "guide"]).code).toBe(0);
  expect(snapshot(root)).toEqual(migrated);
});

test.each(["scripts/check.mjs", "guides/custom.md"])("migration refuses an authored %s collision while preserving source content and evidence", path => {
  const root = temporaryDirectory();
  write(root, "verify.json", '{"checks":{}}\n');
  write(root, "VERIFY.md", "Old guide\n");
  write(root, "AGENTS.md", oldProjectInstruction);
  write(root, ".verify/runs/old/check/output.log", "Old evidence\n");
  write(root, ".verify/latest", "old\n");
  write(root, `.verify/${path}`, "Keep the original.\n");
  const destination = `.groundwork/${path}`;
  write(root, destination, "Keep the destination.\n");
  const result = invoke(root, ["init"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("Migration collision");
  expect(readFileSync(join(root, destination), "utf8")).toBe("Keep the destination.\n");
  expect(readFileSync(join(root, "verify.json"), "utf8")).toBe('{"checks":{}}\n');
  expect(readFileSync(join(root, "VERIFY.md"), "utf8")).toBe("Old guide\n");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(oldProjectInstruction);
  expect(readFileSync(join(root, `.verify/${path}`), "utf8")).toBe("Keep the original.\n");
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

test("migration keeps useful ignore rules active and exposes verification inputs", () => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, "verify.json", JSON.stringify({ checks: { original: { command: "true", expect: "Original check passes" } } }));
  write(root, "VERIFY.md", "Original guide\n");
  write(root, ".verify/.gitignore", "# Private fixture data\n*\n/private-data/\n");
  write(root, ".verify/scripts/check.mjs", "console.log('Reusable helper');\n");
  expect(invoke(root, ["init"]).code).toBe(0);
  write(root, ".groundwork/private-data/value.txt", "Private fixture data");
  expect(git(root, "check-ignore", ".groundwork/private-data/value.txt")).toBe(".groundwork/private-data/value.txt");
  const changes = git(root, "status", "--porcelain", "--untracked-files=all");
  for (const path of ["verify.d/", "VERIFY.md", "guides/project.md", "scripts/check.mjs"]) expect(changes).toContain(`.groundwork/${path}`);
  expect(existsSync(join(root, ".groundwork/legacy-verify.gitignore"))).toBe(false);
  expect(existsSync(join(root, ".verify"))).toBe(false);
  expect(invoke(root, ["verify"]).code).toBe(0);
  writeFileSync(configFiles(root)[0], JSON.stringify({ checks: { original: { command: "false", expect: "Original check passes" } } }));
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
  expect(readFileSync(join(evidenceStore(root).runs, "old/output.log"), "utf8")).toBe("old");
  expect(readFileSync(join(evidenceStore(root).runs, "new/output.log"), "utf8")).toBe("new");
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

test("init preserves colliding legacy run IDs and custom files while moving all evidence outside the checkout", () => {
  const root = temporaryDirectory();
  write(root, ".groundwork/runs/same/output.log", "Current evidence\n");
  write(root, ".groundwork/latest", "same\n");
  write(root, ".verify/runs/same/output.log", "Historical evidence\n");
  write(root, ".verify/latest", "same\n");
  write(root, ".verify/notes.txt", "Custom notes\n");
  expect(invoke(root, ["init"]).code).toBe(0);
  const storage = evidenceStore(root);
  const retained = readdirSync(storage.runs).map(id => readFileSync(join(storage.runs, id, "output.log"), "utf8"));
  expect(retained.sort()).toEqual(["Current evidence\n", "Historical evidence\n"]);
  expect(readFileSync(join(storage.runs, readFileSync(storage.latest, "utf8").trim(), "output.log"), "utf8")).toBe("Current evidence\n");
  expect(readFileSync(join(root, ".groundwork/notes.txt"), "utf8")).toBe("Custom notes\n");
  expect(existsSync(join(root, ".groundwork/runs"))).toBe(false);
  expect(existsSync(join(root, ".verify"))).toBe(false);
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
  expect(instructions).toContain("`.groundwork/VERIFY.md` and `.groundwork/verify.d/`");
  expect(instructions.match(/## Verification workflow/g)).toHaveLength(1);
  expect(realpathSync(join(home, ".agents/skills/verify-work"))).toBe(realpathSync(dirname(cli)));
  expect(invoke(home, ["install"], env).code).toBe(0);
  expect(readFileSync(shared, "utf8")).toBe(instructions);
  expect(realpathSync(join(home, ".config/opencode/AGENTS.md"))).toBe(shared);
  expect(existsSync(join(home, ".groundwork"))).toBe(false);
});

test("help leaves an unrelated directory untouched", () => {
  const root = temporaryDirectory();
  write(root, "README.md", "An unrelated project.\n");
  const before = snapshot(root);
  expect(invoke(root, ["help"]).code).toBe(0);
  expect(snapshot(root)).toEqual(before);
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
  const failedRecord = parseRecord(readFileSync(join(before.directory, "report.md"), "utf8"));
  expect(failedRecord.record.status).toBe("failed");
  expect(failedRecord.record.run.id).toBe(before.data.id);
  expect(failedRecord.record.checks[0].status).toBe("failed");
  expect(readFileSync(join(before.directory, "theme-persists/output.log"), "utf8")).toContain("Theme after restart: light");
  write(root, "app.mjs", readFileSync(join(root, "app.mjs"), "utf8").replace('theme: "light"', "theme: process.argv[3]"));
  const success = invoke(root, ["verify", "theme-persists"]);
  expect(success.code).toBe(0);
  const after = saved(root);
  expect(after.data.checks[0].status).toBe("passed");
  const passedRecord = parseRecord(readFileSync(join(after.directory, "report.md"), "utf8"));
  expect(passedRecord.record.status).toBe("passed");
  expect(passedRecord.record.run.source).toEqual(after.data.source);
  expect(passedRecord.record.run.runner.runtime).toBe("bun");
  expect(passedRecord.record.checks[0].receipt.disposition).toBe("executed");
  expect(after.data.source.dirty).toBe(true);
  expect(after.data.source.fingerprint).not.toBe(before.data.source.fingerprint);
  expect(after.directory).not.toBe(before.directory);
  expect(readFileSync(join(after.directory, "theme-persists/artifacts/observation.json"), "utf8")).toContain('"actual":"dark"');
  expect(existsSync(join(before.directory, "result.json"))).toBe(true);
  expect(invoke(root, ["view", "report"]).code).toBe(0);
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Fix persistence without changing verified content");
  expect(invoke(root, ["view", "report"]).code).toBe(0);
  write(root, "app.mjs", `${readFileSync(join(root, "app.mjs"), "utf8")}\nconsole.error("Changed again");\n`);
  const stale = invoke(root, ["view", "report"]);
  expect(stale.code).toBe(2);
  expect(stale.output).toContain("Source changed");
});

test.each(["nested", ".groundwork", ".groundwork/scripts", ".groundwork/config", ".verify", ".verify/scripts", ".verify/config"])("named selection from %s includes required checks and discloses omitted checks", cwd => {
  const root = project({
    required: { command: "bun -e 'console.error(\"Required failure\"); process.exit(1)'", expect: "Required check passes", required: true },
    feature: { command: "bun .groundwork/scripts/check.mjs", expect: "Run from the project directory" },
    unrelated: { command: "false", expect: "Another feature works" },
  });
  write(root, "value.txt", "project-relative input");
  write(root, ".groundwork/scripts/check.mjs", 'import { readFileSync } from "node:fs"; console.log(process.cwd(), readFileSync("value.txt", "utf8"));');
  mkdirSync(join(root, cwd), { recursive: true });
  write(root, ".groundwork/config/verify.json", "This is not the project's check configuration");
  const result = invoke(join(root, cwd), ["verify", "feature"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("Not selected: unrelated");
  const { data, directory } = saved(root);
  expect(data.checks.map(check => check.name)).toEqual(["required", "feature"]);
  expect(data.checks.find(check => check.name === "feature").status).toBe("passed");
  expect(readFileSync(join(directory, "feature/output.log"), "utf8")).toContain(root);
  expect(readFileSync(join(directory, "feature/output.log"), "utf8")).toContain("project-relative input");
});

test("report viewing migrates legacy evidence without blessing its historical source identity", () => {
  const root = temporaryDirectory();
  const executions = join(temporaryDirectory(), "executions.txt");
  git(root, "init", "--quiet");
  write(root, "verify.json", JSON.stringify({ checks: { legacy: {
    command: `printf 'executed\\n' >> '${executions}'`, expect: "Legacy checks run",
  } } }));
  expect(invoke(root, ["verify"]).code).toBe(0);
  const previous = saved(root);
  delete previous.data.source.identityVersion;
  writeFileSync(join(previous.directory, "result.json"), JSON.stringify(previous.data));
  mkdirSync(join(root, ".verify/runs"), { recursive: true });
  renameSync(previous.directory, join(root, ".verify/runs", previous.data.id));
  renameSync(evidenceStore(root).latest, join(root, ".verify/latest"));
  const historical = invoke(join(root, ".verify"), ["view", "report"]);
  expect(historical.code).toBe(2);
  expect(historical.output).toContain("Historical source identity");
  expect(saved(root).data.source).toEqual(previous.data.source);
  expect(existsSync(join(root, ".verify/runs"))).toBe(false);
  const projectState = snapshot(join(root, ".groundwork"));
  const evidenceState = snapshot(evidenceStore(root).directory);
  expect(invoke(root, ["view", "report"]).code).toBe(2);
  expect(snapshot(join(root, ".groundwork"))).toEqual(projectState);
  expect(snapshot(evidenceStore(root).directory)).toEqual(evidenceState);
  expect(readFileSync(executions, "utf8")).toBe("executed\n");
  writeFileSync(configFiles(root)[0], JSON.stringify({ checks: { legacy: { command: "false", expect: "Legacy checks run" } } }));
  expect(invoke(root, ["verify"]).code).toBe(1);
  expect(saved(root).data.id).not.toBe(previous.data.id);
  expect(invoke(root, ["view", "report"]).code).toBe(1);
  expect(existsSync(join(previous.directory, "result.json"))).toBe(true);
  expect(invoke(root, ["view", "report", previous.data.id]).output).toContain("Historical source identity");
});

test("named verification schedules plan-bound checks and behaviours, retaining selection reasons", () => {
  const root = project();
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks: {
    chosen: { command: "true", expect: "The requested check runs" },
    bound: { command: "true", expect: "The bound requirement holds" },
    journey: { command: "true", expect: "The planned behaviour works", covers: ["saving"] },
    unrelated: { command: "false", expect: "An unrelated check" },
  }, behaviours: { saving: { description: "Save a document" } } }));
  const planPath = ".groundwork/plans/task.json";
  write(root, planPath, JSON.stringify({ goal: "Verify the requested outcome", requirements: [
    { id: "bound-outcome", expect: "The bound requirement holds", checks: ["bound"] },
    { id: "save-document", expect: "Saving works", behaviours: ["saving"] },
  ] }));
  expect(invoke(root, ["verify", "chosen", "--plan", planPath]).code).toBe(0);
  const { data } = saved(root);
  expect(data.checks.map(check => check.name)).toEqual(["chosen", "bound", "journey"]);
  expect(data.coverage.map(item => item.status)).toEqual(["verified", "verified"]);
  expect(data.selection.reasons.bound.join(" ")).toContain("bound-outcome");
  expect(data.selection.reasons.journey.join(" ")).toContain("save-document");
  write(root, planPath, JSON.stringify({ goal: "Invalid plan", requirements: [] }));
  expect(invoke(root, ["verify", "chosen", "--plan", planPath]).code).toBe(2);
  expect(saved(root).data.id).toBe(data.id);
});

test.each([
  [".verify/plan.json", ".", ".verify/plan.json"],
  [".verify/plan.json", ".verify", "plan.json"],
  [".groundwork/runs/previous/plan.json", ".", ".groundwork/runs/previous/plan.json"],
])("verification captures %s from %s before migration moves its input", (path, cwd, argument) => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, ".verify/verify.json", JSON.stringify({ checks: {
    chosen: { command: "true", expect: "The requested check runs" },
    bound: { command: "bun driver.mjs", expect: "The supplied requirement is exercised", covers: ["saving"] },
    unrelated: { command: "false", expect: "An unrelated check" },
  }, behaviours: { saving: { description: "Save a document" } } }));
  write(root, "value.txt", "saved value");
  write(root, "driver.mjs", `import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.env.GROUNDWORK_PLAN, "utf8"));
if (plan.requirements[0].id !== "saved-outcome" || readFileSync("value.txt", "utf8") !== "saved value") process.exit(1);
console.log("Saved requirement exercised from the project root");\n`);
  const plan = { goal: "Keep the supplied verification scope", requirements: [
    { id: "saved-outcome", expect: "The saved value is observable", checks: ["bound"], behaviours: ["saving"] },
  ] };
  write(root, path, JSON.stringify(plan));
  const result = invoke(join(root, cwd), ["verify", "chosen", "--plan", argument]);
  expect(result.code).toBe(0);
  const { data, directory } = saved(root);
  expect(data.plan).toEqual(plan);
  expect(data.checks.map(check => check.name)).toEqual(["chosen", "bound"]);
  expect(data.coverage.map(item => [item.id, item.status])).toEqual([["saved-outcome", "verified"]]);
  expect(JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"))).toEqual(plan);
  expect(readFileSync(join(directory, "bound/output.log"), "utf8")).toContain("Saved requirement exercised from the project root");
  expect(existsSync(join(root, path))).toBe(false);
  expect(existsSync(join(root, ".verify"))).toBe(false);
});

test("fragment-only project discovery runs its check from a nested directory", () => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks: {
    feature: { command: "true", expect: "The fragment's check runs" },
  } }));
  mkdirSync(join(root, "nested"));
  expect(invoke(join(root, "nested"), ["verify", "feature"]).code).toBe(0);
  expect(saved(root).data.checks[0].name).toBe("feature");
});

test("reusable checks survive a content-only commit and --fresh forces a new execution", () => {
  const root = project({ check: { command: "bun .groundwork/scripts/check.mjs", expect: "The source assertion passes", reuse: true } });
  const executions = join(temporaryDirectory(), "executions.txt");
  write(root, ".groundwork/scripts/check.mjs", 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.TEST_EXECUTIONS, "executed\\n"); console.log("Assertion passed");');
  const env = { TEST_EXECUTIONS: executions };
  expect(invoke(root, ["verify"], env).code).toBe(0);
  const first = saved(root).data;
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Commit the already verified content");
  expect(invoke(root, ["verify"], env).code).toBe(0);
  expect(saved(root).data.checks[0].receipt.disposition).toBe("reused");
  expect(saved(root).data.source.fingerprint).toBe(first.source.fingerprint);
  expect(readFileSync(executions, "utf8")).toBe("executed\n");
  expect(invoke(root, ["verify", "--fresh"], env).code).toBe(0);
  expect(saved(root).data.checks[0].receipt.disposition).toBe("executed");
  expect(readFileSync(executions, "utf8")).toBe("executed\nexecuted\n");
});

test("view report rechecks declared environment and ignored-file inputs for reusable checks", () => {
  const root = project({ check: { command: "bun .groundwork/scripts/check.mjs", expect: "The declared fixture matches its environment",
    reuse: { env: ["TEST_MODE"], files: [".fixture/value.txt"] } } });
  write(root, ".gitignore", ".fixture/\n");
  write(root, ".fixture/value.txt", "ready");
  write(root, ".groundwork/scripts/check.mjs", `import { readFileSync } from "node:fs";
if (readFileSync(".fixture/value.txt", "utf8") !== process.env.TEST_MODE) process.exit(1);
console.log("The declared fixture matches the environment");\n`);
  const env = { TEST_MODE: "ready" };
  expect(invoke(root, ["verify"], env).code).toBe(0);
  expect(invoke(root, ["view", "report"], env).code).toBe(0);
  const changedEnvironment = invoke(root, ["view", "report"], { TEST_MODE: "different" });
  expect(changedEnvironment.code).toBe(2);
  expect(changedEnvironment.output).toContain("Receipt inputs changed for check");
  expect(invoke(root, ["view", "report"], env).code).toBe(0);
  write(root, ".fixture/value.txt", "different");
  const changedFile = invoke(root, ["view", "report"], env);
  expect(changedFile.code).toBe(2);
  expect(changedFile.output).toContain("Receipt inputs changed for check");
});

test("verification reports its own run when another run replaces latest before it finishes", () => {
  const root = project({
    outer: { command: "bun .groundwork/scripts/start-another.mjs", expect: "The outer assertion passes" },
    inner: { command: "false", expect: "The newer run fails" },
  });
  write(root, ".groundwork/scripts/start-another.mjs", `import { spawnSync } from "node:child_process";
const inner = spawnSync(process.execPath, [${JSON.stringify(cli)}, "verify", "inner"], { env: process.env });
if (inner.status !== 1) process.exit(2);
console.log("Outer assertion passed");\n`);
  const result = invoke(root, ["verify", "outer"]);
  expect(result.code).toBe(0);
  const ownId = result.output.match(/^Run: (.+)$/m)[1];
  expect(saved(root).data.id).not.toBe(ownId);
  expect(saved(root).data.checks[0].name).toBe("inner");
  expect(invoke(root, ["view", "report"]).code).toBe(1);
  expect(invoke(root, ["view", "report", ownId]).code).toBe(0);
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
  const config = readFileSync(join(root, ".groundwork/verify.d/feature.json"), "utf8");
  write(root, ".groundwork/verify.d/feature.json", `${config}\n`);
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
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({
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

test.each([".groundwork/verify.d/feature.json", ".groundwork/verify.json", "verify.json", ".verify/verify.json"])("navigation discovers %s inside metadata directories, migrates once, and remains read-only", configPath => {
  const root = temporaryDirectory();
  const config = JSON.stringify({
    checks: { forbidden: { command: "printf ran > executed", expect: "Run only when requested", required: true, covers: ["saving"] } },
    behaviours: { saving: { description: "Save a document", guide: "docs/map.md#saving" } },
  });
  write(root, configPath, config);
  write(root, "docs/map.md", "# Saving\n");
  write(root, ".groundwork/latest", "previous\n");
  write(root, ".groundwork/runs/previous/result.json", "Retain this exact evidence.\n");
  write(root, ".verify/config/verify.json", "Not the project config");
  mkdirSync(join(root, "src/nested"), { recursive: true });
  const first = invoke(join(root, ".verify/config"), ["map", "saving"]);
  expect(first.code).toBe(0);
  expect(first.output).toContain("Narrative guide: docs/map.md#saving");
  expect(loadConfig(root).checks.forbidden.command).toBe("printf ran > executed");
  const store = evidenceStore(root);
  expect(readFileSync(store.latest, "utf8")).toBe("previous\n");
  expect(readFileSync(join(store.runs, "previous/result.json"), "utf8")).toBe("Retain this exact evidence.\n");
  for (const path of ["executed", "verify.json", ".verify", ".groundwork/verify.json", ".groundwork/runs", ".groundwork/latest"]) {
    expect(existsSync(join(root, path))).toBe(false);
  }
  const projectState = snapshot(root);
  const evidenceState = snapshot(store.directory);
  for (const cwd of ["src/nested", ".groundwork/config"]) {
    for (const args of [["map", "saving"], ["view", "guide", "saving"]]) {
      const result = invoke(join(root, cwd), args);
      expect(result.code).toBe(0);
      expect(result.output).toContain("docs/map.md#saving");
      expect(snapshot(root)).toEqual(projectState);
      expect(snapshot(store.directory)).toEqual(evidenceState);
    }
  }
});

test("feature maps explain empty and unmapped catalogues without initializing a project", () => {
  const root = temporaryDirectory();
  expect(invoke(root, ["map"]).code).toBe(2);
  expect(readdirSync(root)).toEqual([]);
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks: {} }));
  const empty = invoke(root, ["map"]);
  expect(empty.code).toBe(0);
  expect(empty.output).toContain("No behaviours recorded");
  expect(empty.output).toContain(".groundwork/verify.d/<feature>.json");
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks: {}, behaviours: {
    planned: { description: "Import a document", entry: " \n ", paths: [] },
  } }));
  const before = snapshot(root);
  const unmapped = invoke(root, ["map", "planned"]);
  expect(unmapped.code).toBe(0);
  expect(unmapped.output).toContain("Used by (recorded): none recorded");
  expect(unmapped.output).toContain("Depends on (recorded): none recorded");
  expect(unmapped.output).toContain("Entry: not recorded");
  expect(unmapped.output).toContain("Implementation paths: not mapped");
  expect(unmapped.output).toContain("Covering checks: not mapped");
  expect(unmapped.output).toContain("Narrative guide: not recorded");
  expect(snapshot(root)).toEqual(before);
});

test("feature lookup prefers exact IDs, supports unique ID or description queries, and rejects ambiguity and flags", () => {
  const root = temporaryDirectory();
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({
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
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks: {}, behaviours: {
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
  write(root, ".groundwork/verify.d/feature.json", JSON.stringify({ checks: {}, behaviours: {
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
  const child = spawn(realBun, [cli, "verify"], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${dirname(realBun)}:${process.env.PATH}`, GROUNDWORK_PORTAL: "0" } });
  let output = "";
  let progressRecord;
  child.stdout.on("data", chunk => {
    output += chunk;
    if (progressRecord === undefined && /^READY$/m.test(output)) {
      progressRecord = parseRecord(readFileSync(join(saved(root).directory, "report.md"), "utf8"));
      child.kill("SIGTERM");
    }
  });
  await once(child, "close");
  expect(saved(root).directory).not.toBe(previous.directory);
  expect(progressRecord.record.status).toBe("inconclusive");
  expect(progressRecord.record.run.finishedAt).toBeNull();
  const interruptedRecord = parseRecord(readFileSync(join(saved(root).directory, "report.md"), "utf8"));
  expect(interruptedRecord.record.status).toBe("inconclusive");
  expect(interruptedRecord.record.run.finishedAt).toBeNull();
  const result = invoke(root, ["view", "report"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("selected run did not finish");
});

test("local init, verification and saved reports work while GitHub is unavailable", () => {
  const root = temporaryDirectory();
  const github = fakeGitHub({ denied: true });
  git(root, "init", "--quiet");
  expect(invoke(root, ["init"], github.env).code).toBe(0);
  setChecks(root, { check: { command: "printf 'Local assertion passed\\n'", expect: "Verify locally" } });
  expect(invoke(root, ["verify"], github.env).code).toBe(0);
  const run = saved(root);
  expect(parseRecord(readFileSync(join(run.directory, "report.md"), "utf8")).record.status).toBe("passed");
  expect(invoke(root, ["view", "report", run.data.id], github.env).code).toBe(0);
  expect(github.state().calls).toEqual([]);
});

test("historical saved results without report.md can still be viewed without being rewritten", () => {
  const root = project({ check: { command: "true", expect: "A historical check passes" } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  const { directory, data } = saved(root);
  const historical = { version: 1, id: data.id, startedAt: data.startedAt, finishedAt: data.finishedAt,
    source: data.source, checks: data.checks, omitted: data.omitted };
  writeFileSync(join(directory, "result.json"), JSON.stringify(historical));
  rmSync(join(directory, "report.md"));
  const before = snapshot(directory);
  expect(invoke(root, ["view", "report", data.id]).code).toBe(0);
  expect(snapshot(directory)).toEqual(before);
});

test("publishing uses the explicit run and accepts the same verified dirty content after a commit", () => {
  const executions = join(temporaryDirectory(), "executions.txt");
  const root = project({
    pass: { command: `printf 'executed\\n' >> '${executions}'`, expect: "The requested check passes", reuse: true },
    fail: { command: "false", expect: "A separate later attempt fails" },
  });
  write(root, "value.txt", "before");
  write(root, ".groundwork/decisions/local.md", "# Keep verification local\n");
  const plan = ".groundwork/plans/task.json";
  write(root, plan, JSON.stringify({ goal: "Publish the verified change", decisions: [".groundwork/decisions/local.md"],
    requirements: [{ id: "outcome", expect: "The requested check passes", checks: ["pass"] }] }));
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Initial project");
  write(root, "value.txt", "after");
  expect(invoke(root, ["verify", "pass", "--plan", plan]).code).toBe(0);
  const selected = saved(root);
  const frozen = parseRecord(readFileSync(join(selected.directory, "report.md"), "utf8")).record;
  expect(selected.data.source.dirty).toBe(true);
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Commit verified content");
  const head = git(root, "rev-parse", "HEAD");
  expect(head).not.toBe(selected.data.source.revision);
  expect(invoke(root, ["verify", "fail"]).code).toBe(1);
  const newer = saved(root);
  const github = fakeGitHub({ head });
  const store = snapshot(evidenceStore(root).directory);
  expect(invoke(root, ["publish", "pr", "7"], github.env).output).toContain("explicit --run");
  expect(github.state().calls).toEqual([]);
  const published = invoke(root, ["publish", "pr", "7", "--run", selected.data.id], github.env);
  expect(published.code).toBe(0);
  const remote = parseRecord(github.state().comments[0].body);
  expect(remote.record).toEqual(frozen);
  expect(remote.publication).toMatchObject({ headSha: head, status: "passed", sourceMatches: true });
  expect(github.state().comments[0].body).toContain(`/blob/${head}/.groundwork/decisions/local.md`);
  expect(github.state().calls.filter(call => call.body?.state).map(call => call.body.state)).toEqual(["pending", "success"]);
  expect(readFileSync(executions, "utf8")).toBe("executed\n");
  expect(snapshot(evidenceStore(root).directory)).toEqual(store);
  expect(saved(root).data.id).toBe(newer.data.id);
  const failed = invoke(root, ["publish", "pr", "--run", newer.data.id], github.env);
  expect(failed.code).toBe(1);
  expect(parseRecord(github.state().comments[1].body).publication.status).toBe("failed");
  expect(github.state().calls.filter(call => call.body?.state).at(-1).body.state).toBe("failure");
});

test.each(["source", "environment", "ignored input", "evidence"])("publication reassesses changed %s without rewriting or rerunning the saved success", changed => {
  const executions = join(temporaryDirectory(), "executions.txt");
  const root = project({ check: { command: `printf 'executed\\n' >> '${executions}'`, expect: "Retain applicable verification",
    reuse: { env: ["TEST_MODE"], files: [".fixture/value.txt"] } } });
  write(root, ".gitignore", ".fixture/\n");
  write(root, ".fixture/value.txt", "ready");
  write(root, "value.txt", "original");
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Verification inputs");
  expect(invoke(root, ["verify"], { TEST_MODE: "ready" }).code).toBe(0);
  const run = saved(root);
  const report = readFileSync(join(run.directory, "report.md"), "utf8");
  const result = readFileSync(join(run.directory, "result.json"), "utf8");
  if (changed === "source") write(root, "value.txt", "changed");
  if (changed === "ignored input") write(root, ".fixture/value.txt", "changed");
  if (changed === "evidence") rmSync(join(run.directory, run.data.checks[0].log));
  const github = fakeGitHub({ head: git(root, "rev-parse", "HEAD") });
  const published = invoke(root, ["publish", "pr", github.url, "--run", run.data.id],
    { ...github.env, TEST_MODE: changed === "environment" ? "changed" : "ready" });
  expect(published.code).toBe(2);
  const remote = parseRecord(github.state().comments[0].body);
  expect(remote.record.status).toBe("passed");
  expect(remote.publication.status).toBe("inconclusive");
  expect(remote.publication.assessment.problems.join(" ")).toContain(changed === "source" ? "Source changed"
    : changed === "evidence" ? "Evidence is missing" : "Receipt inputs changed");
  expect(github.state().calls.filter(call => call.body?.state).at(-1).body.state).toBe("error");
  expect(readFileSync(join(run.directory, "report.md"), "utf8")).toBe(report);
  expect(readFileSync(join(run.directory, "result.json"), "utf8")).toBe(result);
  expect(readFileSync(executions, "utf8")).toBe("executed\n");
});

test("publication retains an unsatisfied required review even when the command passes", () => {
  const root = project({ check: { command: "true", expect: "The assertion passes" } });
  write(root, ".groundwork/plans/task.json", JSON.stringify({ goal: "Review the checked outcome", requirements: [
    { id: "reviewed", expect: "The outcome has been reviewed", checks: ["check"], review: true },
  ] }));
  git(root, "add", ".");
  git(root, "-c", "user.name=Verification Test", "-c", "user.email=verify@example.test", "commit", "-qm", "Project checks");
  expect(invoke(root, ["verify", "--plan", ".groundwork/plans/task.json"]).code).toBe(2);
  const run = saved(root);
  const github = fakeGitHub({ head: git(root, "rev-parse", "HEAD") });
  expect(invoke(root, ["publish", "pr", "7", "--run", run.data.id], github.env).code).toBe(2);
  const remote = parseRecord(github.state().comments[0].body);
  expect(remote.record.checks[0].status).toBe("passed");
  expect(remote.publication.status).toBe("inconclusive");
  expect(remote.publication.assessment.coverage[0]).toMatchObject({ id: "reviewed", status: "unverified" });
  expect(remote.publication.assessment.coverage[0].reason).toContain("review observation");
});

test.each([["passed", 0], ["failed", 1], ["inconclusive", 2], ["historical", 2]])("view pr reads %s published history by URL outside an adopted project", (outcome, code) => {
  const projectRoot = project({ check: { command: "true", expect: "The source assertion passes" } });
  write(projectRoot, ".groundwork/decisions/local.md", "# Keep the requested outcome\n");
  write(projectRoot, ".groundwork/plans/task.json", JSON.stringify({ goal: "Keep the requested outcome", decisions: [".groundwork/decisions/local.md"], requirements: [
    { id: "outcome", expect: "The requested outcome holds", checks: ["check"] },
  ] }));
  expect(invoke(projectRoot, ["verify", "--plan", ".groundwork/plans/task.json"]).code).toBe(0);
  const template = parseRecord(readFileSync(join(saved(projectRoot).directory, "report.md"), "utf8")).record;
  const head = "a".repeat(40);
  function comment(id, status, current, startedAt) {
    const record = { ...template, status: status === "failed" ? "failed" : "passed", run: { ...template.run, id, startedAt,
      source: { ...template.run.source, revision: "b".repeat(40) } } };
    const publication = { repository: "example/project", pullRequest: 7, headSha: current ? head : "c".repeat(40),
      publisher: { id: 41, login: "publisher" }, status, sourceMatches: true, publishedAt: startedAt, assessment: { status, coverage: template.coverage,
        problems: status === "inconclusive" ? ["Declared inputs need a fresh local verification."] : [] } };
    return { id, user: { id: 41, login: "publisher" }, body: renderRecord(record, { publication }),
      html_url: `https://github.example/example/project/pull/7#${id}` };
  }
  const historical = comment("historical", "passed", false, "2026-11-16T12:03:00Z");
  const comments = outcome === "historical" ? [historical] : [
    { id: 0, body: "An ordinary review comment." },
    comment("older-green", "passed", true, "2026-11-16T12:01:00Z"), historical,
    comment("latest-attempt", outcome, true, "2026-11-16T12:02:00Z"),
  ];
  const github = fakeGitHub({ head, comments });
  const root = temporaryDirectory();
  write(root, "README.md", "An unadopted directory.\n");
  const before = snapshot(root);
  const evidence = snapshot(process.env.GROUNDWORK_STATE_HOME);
  const viewed = invoke(root, ["view", "pr", github.url], github.env);
  expect(viewed.code).toBe(code);
  expect(viewed.output).toContain(`Current PR head: ${head}`);
  expect(viewed.output).toContain(`Tested revision: ${"b".repeat(40)}`);
  expect(viewed.output).toContain("HISTORICAL");
  expect(viewed.output).toContain("Decision: .groundwork/decisions/local.md");
  expect(viewed.output).toContain("PASSED check: The source assertion passes");
  expect(viewed.output).toContain(`EXECUTED: ${template.checks[0].receipt.reason}`);
  if (outcome !== "historical") expect(viewed.output).toContain(`${outcome.toUpperCase()} — latest published attempt for this PR head: latest-attempt`);
  if (outcome === "inconclusive") expect(viewed.output).toContain("Declared inputs need a fresh local verification");
  expect(github.state().calls.filter(call => call.args[0] === "api").every(call => call.args[call.args.indexOf("--method") + 1] === "GET")).toBe(true);
  expect(snapshot(root)).toEqual(before);
  expect(snapshot(process.env.GROUNDWORK_STATE_HOME)).toEqual(evidence);
});

test("view pr reports a newer pending or unsuccessful publication alongside the retained passing record", () => {
  const root = project({ check: { command: "true", expect: "The original assertion passes", reuse: true } });
  expect(invoke(root, ["verify"]).code).toBe(0);
  expect(invoke(root, ["verify"]).code).toBe(0);
  const record = parseRecord(readFileSync(join(saved(root).directory, "report.md"), "utf8")).record;
  expect(record.checks[0].receipt.disposition).toBe("reused");
  const head = "a".repeat(40);
  const publication = { repository: "example/project", pullRequest: 7, headSha: head, status: "passed", sourceMatches: true,
    publisher: { id: 41, login: "publisher" }, assessment: { status: "passed", coverage: [], problems: [] } };
  const comment = { id: 1, user: { id: 41, login: "publisher" }, body: renderRecord(record, { publication }) };
  for (const [state, code] of [["pending", 2], ["error", 2], ["failure", 1]]) {
    const github = fakeGitHub({ head, comments: [comment], statuses: [
      { context: "groundwork/verification", state, description: "Latest publication attempt" },
      { context: "groundwork/verification", state: "success", description: "Earlier completed publication" },
    ] });
    const viewed = invoke(temporaryDirectory(), ["view", "pr", github.url], github.env);
    expect(viewed.code).toBe(code);
    expect(viewed.output).toContain(`${state === "failure" ? "FAILED" : "INCONCLUSIVE"} — latest published attempt for this PR head: ${record.run.id}`);
    expect(viewed.output).toContain(`Latest publication status: ${state.toUpperCase()} — Latest publication attempt`);
    expect(viewed.output).toContain(`CURRENT PR HEAD · PASSED · ${record.run.id}`);
    expect(viewed.output).toContain("PASSED check: The original assertion passes");
    expect(viewed.output).toContain(`REUSED: ${record.checks[0].receipt.reason}`);
  }
});

test("PR viewing reports a missing or unauthenticated gh without initializing the directory", () => {
  const root = temporaryDirectory();
  const github = fakeGitHub({ denied: true });
  const missing = invoke(root, ["view", "pr", github.url], { PATH: temporaryDirectory() });
  expect(missing.code).toBe(2);
  expect(missing.output).toContain("GitHub CLI (gh) is required");
  const denied = invoke(root, ["view", "pr", github.url], github.env);
  expect(denied.code).toBe(2);
  expect(denied.output).toContain("GitHub is unavailable");
  expect(readdirSync(root)).toEqual([]);
});
