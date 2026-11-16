import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceStore, prepareEvidenceStore } from "../lib/store.mjs";
import { capture } from "../lib/model.mjs";

const directories = [];
let environment;

beforeEach(() => {
  environment = { GROUNDWORK_STATE_HOME: process.env.GROUNDWORK_STATE_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.GROUNDWORK_STATE_HOME = join(temporaryDirectory(), "state");
});

afterEach(() => {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory() {
  const path = realpathSync(mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-store-")));
  directories.push(path);
  return path;
}

function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function worktrees() {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, "package/source.txt", "Project source\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Store Test", "-c", "user.email=store@example.test", "commit", "-qm", "Initial project");
  const other = join(temporaryDirectory(), "checkout");
  git(root, "worktree", "add", "--quiet", "--detach", other);
  return [root, other];
}

function report(id, version = 2) {
  return { version, id, startedAt: "2026-10-26T12:00:00Z", finishedAt: "2026-10-26T12:01:00Z",
    source: { revision: null, fingerprint: "a".repeat(64), dirty: true }, status: "passed", omitted: [],
    plan: null, checks: [{ name: "check", command: "echo saved", expect: "Retain the observation", status: "passed",
      exitCode: 0, durationMs: 1, log: "check/output.log", artifacts: [] }],
    observations: [], coverage: [], context: {}, problems: [] };
}

function legacyRun(root, storage, id, value, artifact = Buffer.from([0, 128, 255, 10])) {
  const bytes = `${JSON.stringify(value, null, 4)}\n\n`;
  write(root, `${storage}/runs/${id}/result.json`, bytes);
  write(root, `${storage}/runs/${id}/check/output.log`, "Saved output\n");
  write(root, `${storage}/runs/${id}/check/artifacts/proof.bin`, artifact);
  return bytes;
}

test("read-only resolution uses external state roots and canonical non-Git project paths", () => {
  const root = temporaryDirectory();
  const alias = join(temporaryDirectory(), "alias");
  symlinkSync(root, alias);
  const store = evidenceStore(root);
  expect(evidenceStore(alias)).toEqual(store);
  expect(evidenceStore(temporaryDirectory()).directory).not.toBe(store.directory);
  expect(store.directory.startsWith(`${process.env.GROUNDWORK_STATE_HOME}/`)).toBe(true);
  expect(existsSync(process.env.GROUNDWORK_STATE_HOME)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
  delete process.env.GROUNDWORK_STATE_HOME;
  process.env.XDG_STATE_HOME = join(temporaryDirectory(), "xdg-state");
  expect(evidenceStore(root).directory.startsWith(`${process.env.XDG_STATE_HOME}/groundwork/`)).toBe(true);
  delete process.env.XDG_STATE_HOME;
  expect(evidenceStore(root).directory.startsWith(`${join(homedir(), ".local/state/groundwork")}/`)).toBe(true);
});

test("worktrees share persistent runs and receipts while projects and latest pointers stay isolated", () => {
  const [root, other] = worktrees();
  const index = readFileSync(join(root, ".git/index"));
  const first = prepareEvidenceStore(root);
  const second = prepareEvidenceStore(other);
  expect(second.directory).toBe(first.directory);
  expect(second.latest).not.toBe(first.latest);
  expect(evidenceStore(join(root, "package")).directory).toBe(evidenceStore(join(other, "package")).directory);
  expect(evidenceStore(join(root, "package")).directory).not.toBe(first.directory);
  write(first.runs, "first/output.log", "Durable evidence\n");
  write(first.receipts, "check.json", '{"runId":"first"}\n');
  writeFileSync(first.latest, "first\n");
  writeFileSync(second.latest, "unfinished\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { evidenceStore } from ${JSON.stringify(new URL("../lib/store.mjs", import.meta.url).href)};
    const store = evidenceStore(process.cwd());
    console.log(JSON.stringify({ log: readFileSync(join(store.runs, 'first/output.log'), 'utf8'),
      receipt: JSON.parse(readFileSync(join(store.receipts, 'check.json'), 'utf8')), latest: readFileSync(store.latest, 'utf8') }));
  `], { cwd: other, encoding: "utf8", env: process.env });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ log: "Durable evidence\n", receipt: { runId: "first" }, latest: "unfinished\n" });
  expect(readFileSync(first.latest, "utf8")).toBe("first\n");
  expect(readFileSync(join(root, ".git/index"))).toEqual(index);
  expect(git(root, "status", "--porcelain")).toBe("");
  expect(git(other, "status", "--porcelain")).toBe("");
});

test("migration preserves old CLI reports, incomplete attempts, PR envelopes and artifact bytes idempotently", () => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  const fixtures = [
    [".verify", "v1", report("v1", 1)],
    [".groundwork", "unfinished", { ...report("unfinished"), finishedAt: null, status: "inconclusive" }],
    [".groundwork", "pr-v1", { version: 1, repository: "owner/repo", status: "failed", checks: { status: "passed", log: "check/output.log" },
      agent: { checks: [{ claim: "Saved", status: "failed", observed: "Value was lost", evidence: ["check/output.log"] }], gaps: [] }, problems: [] }],
    [".verify", "pr-v2", { version: 2, repository: "owner/repo", pullRequest: 3, verification: report("nested"), status: "passed", problems: [] }],
  ];
  const originals = fixtures.map(([storage, id, value]) => [id, legacyRun(root, storage, id, value)]);
  write(root, ".verify/runs/partial/result.json", "{ unfinished write");
  originals.push(["partial", "{ unfinished write"]);
  mkdirSync(join(root, ".verify/runs/empty"));
  mkdirSync(join(root, ".groundwork/runs/unfinished/empty-artifacts"));
  write(root, ".groundwork/latest", "unfinished\n");
  write(root, ".verify/latest", "v1\r\n");
  for (const path of ["verify.json", "VERIFY.md", ".groundwork/VERIFY.md", ".groundwork/verify.json", ".verify/notes.txt", ".verify/plan.json", ".groundwork/runs/notes.txt"]) {
    write(root, path, `Keep ${path}\n`);
  }
  git(root, "add", ".");
  const index = readFileSync(join(root, ".git/index"));
  const store = prepareEvidenceStore(root);
  for (const [id, bytes] of originals) {
    expect(readFileSync(join(store.runs, id, "result.json"), "utf8")).toBe(bytes);
  }
  for (const [, id] of fixtures) {
    expect(readFileSync(join(store.runs, id, "check/artifacts/proof.bin"))).toEqual(Buffer.from([0, 128, 255, 10]));
    expect(readFileSync(join(store.runs, id, "check/output.log"), "utf8")).toBe("Saved output\n");
  }
  expect(readdirSync(join(store.runs, "empty"))).toEqual([]);
  expect(readdirSync(join(store.runs, "unfinished/empty-artifacts"))).toEqual([]);
  expect(readFileSync(store.latest, "utf8")).toBe("unfinished\n");
  const legacyPointer = join(dirname(store.latest), "legacy/verify/v1");
  expect(readFileSync(join(legacyPointer, readdirSync(legacyPointer)[0]), "utf8")).toBe("v1\r\n");
  expect(readFileSync(join(root, ".git/index"))).toEqual(index);
  for (const [storage, id] of fixtures) expect(existsSync(join(root, storage, "runs", id))).toBe(false);
  expect(existsSync(join(root, ".verify/runs"))).toBe(false);
  for (const path of [".groundwork/latest", ".verify/latest"]) expect(existsSync(join(root, path))).toBe(false);
  for (const path of ["verify.json", "VERIFY.md", ".groundwork/VERIFY.md", ".groundwork/verify.json", ".verify/notes.txt", ".verify/plan.json", ".groundwork/runs/notes.txt"]) {
    expect(readFileSync(join(root, path), "utf8")).toBe(`Keep ${path}\n`);
  }
  expect(prepareEvidenceStore(root)).toEqual(store);
  expect(readdirSync(store.runs).sort()).toEqual([...originals.map(([id]) => id), "empty"].sort());
  expect(readdirSync(store.receipts)).toEqual([]);
});

test("colliding worktree run IDs retain both payloads and local report identity without upgrading freshness", () => {
  const [root, other] = worktrees();
  const firstBytes = legacyRun(root, ".groundwork", "shared", report("shared", 1));
  write(root, ".groundwork/latest", "shared\n");
  const first = prepareEvidenceStore(root);
  const local = { ...report("shared"), finishedAt: null, source: { revision: null, fingerprint: "b".repeat(64), dirty: true } };
  const secondBytes = legacyRun(other, ".groundwork", "shared", local, Buffer.from("Other evidence"));
  write(other, ".groundwork/runs/shared/legacy-result.json", "An existing evidence file\n");
  write(other, ".groundwork/latest", "shared\n");
  const backup = temporaryDirectory();
  cpSync(join(other, ".groundwork"), join(backup, "legacy"), { recursive: true });
  const second = prepareEvidenceStore(other);
  const id = readFileSync(second.latest, "utf8").trim();
  expect(id).not.toBe("shared");
  expect(readFileSync(first.latest, "utf8")).toBe("shared\n");
  expect(readFileSync(join(first.runs, "shared/result.json"), "utf8")).toBe(firstBytes);
  const migrated = JSON.parse(readFileSync(join(second.runs, id, "result.json"), "utf8"));
  expect(migrated).toEqual({ ...local, id });
  const provenance = JSON.parse(readFileSync(join(second.runs, id, "migration.json"), "utf8"));
  expect(provenance.originalId).toBe("shared");
  expect(provenance.source).toBe(join(other, ".groundwork/runs/shared"));
  expect(readFileSync(join(second.runs, id, provenance.report), "utf8")).toBe(secondBytes);
  expect(readFileSync(join(second.runs, id, "legacy-result.json"), "utf8")).toBe("An existing evidence file\n");
  expect(readFileSync(join(second.runs, id, "check/artifacts/proof.bin"), "utf8")).toBe("Other evidence");
  cpSync(join(backup, "legacy"), join(other, ".groundwork"), { recursive: true });
  prepareEvidenceStore(other);
  expect(readdirSync(first.runs).sort()).toEqual(["shared", id].sort());
  expect(readFileSync(second.latest, "utf8").trim()).toBe(id);
  const pr = { version: 2, repository: "owner/repo", pullRequest: 7, status: "inconclusive", verification: report("shared"), problems: [] };
  const prBytes = legacyRun(other, ".verify", "shared", pr);
  write(other, ".verify/runs/shared/migration.json", "Another existing evidence file\n");
  write(other, ".verify/latest", "shared\n");
  prepareEvidenceStore(other);
  const prId = readdirSync(second.runs).find(name => !["shared", id].includes(name));
  expect(readFileSync(join(second.runs, prId, "result.json"), "utf8")).toBe(prBytes);
  expect(readFileSync(join(second.runs, prId, "migration.json"), "utf8")).toBe("Another existing evidence file\n");
  expect(readFileSync(second.latest, "utf8").trim()).toBe(id);
  expect(readdirSync(second.receipts)).toEqual([]);
});

test("migration materializes supported internal file aliases without changing evidence references or report bytes", () => {
  const root = temporaryDirectory();
  const value = report("aliases");
  legacyRun(root, ".verify", "aliases", value);
  const source = join(root, ".verify/runs/aliases");
  const path = "check/artifacts/alias.bin";
  symlinkSync(join(source, "check/artifacts/proof.bin"), join(source, path));
  const reference = capture(source, path, join(source, "check/artifacts"));
  value.checks[0].artifacts = [reference];
  const bytes = `${JSON.stringify(value, null, 4)}\n\n`;
  writeFileSync(join(source, "result.json"), bytes);
  write(root, ".verify/latest", "aliases\n");
  const store = prepareEvidenceStore(root);
  const imported = join(store.runs, "aliases");
  expect(lstatSync(join(imported, path)).isFile()).toBe(true);
  expect(readFileSync(join(imported, path))).toEqual(Buffer.from([0, 128, 255, 10]));
  expect(capture(imported, path)).toEqual(reference);
  expect(readFileSync(join(imported, "result.json"), "utf8")).toBe(bytes);
  expect(readFileSync(store.latest, "utf8")).toBe("aliases\n");
  expect(existsSync(source)).toBe(false);
});

test.each(["escape", "broken", "directory cycle"])("a failed %s import retains generated originals and can resume", kind => {
  const root = temporaryDirectory();
  const original = legacyRun(root, ".groundwork", "complete", report("complete"));
  legacyRun(root, ".verify", "blocked", report("blocked"));
  write(root, ".groundwork/latest", "complete\n");
  write(root, ".verify/latest", "blocked\n");
  const link = join(root, ".verify/runs/blocked/check/artifacts/link");
  write(root, "outside.log", "Outside the run\n");
  const target = kind === "escape" ? join(root, "outside.log")
    : kind === "broken" ? join(root, ".verify/runs/blocked/missing.log") : join(root, ".verify/runs/blocked");
  symlinkSync(target, link);
  expect(() => prepareEvidenceStore(root)).toThrow();
  expect(readFileSync(join(root, ".groundwork/runs/complete/result.json"), "utf8")).toBe(original);
  expect(readFileSync(join(root, ".groundwork/latest"), "utf8")).toBe("complete\n");
  expect(readFileSync(join(root, ".verify/latest"), "utf8")).toBe("blocked\n");
  unlinkSync(link);
  writeFileSync(link, "Preserved artifact\n");
  const store = prepareEvidenceStore(root);
  expect(readdirSync(store.runs).sort()).toEqual(["blocked", "complete"]);
  expect(readFileSync(join(store.runs, "blocked/check/artifacts/link"), "utf8")).toBe("Preserved artifact\n");
  expect(readFileSync(store.latest, "utf8")).toBe("complete\n");
  expect(existsSync(join(root, ".groundwork/runs"))).toBe(false);
  expect(existsSync(join(root, ".verify/runs"))).toBe(false);
});

test("orphan and malformed latest pointers are archived so init and fresh verification can proceed", () => {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  write(root, "verify.json", JSON.stringify({ checks: { fresh: { command: "echo 'Fresh verification'", expect: "Complete a fresh verification" } } }));
  const pointers = [[".groundwork", Buffer.from("missing-run\r\n")], [".verify", Buffer.from("../invalid\0\n")]];
  for (const [storage, bytes] of pointers) write(root, `${storage}/latest`, bytes);
  const store = prepareEvidenceStore(root);
  expect(existsSync(store.latest)).toBe(false);
  for (const [storage, bytes] of pointers) {
    const archive = join(dirname(store.latest), "legacy", storage.slice(1), "orphan");
    expect(readFileSync(join(archive, readdirSync(archive)[0]))).toEqual(bytes);
    expect(existsSync(join(root, storage, "latest"))).toBe(false);
  }
  const cli = fileURLToPath(new URL("../skills/verify-work/verify.mjs", import.meta.url));
  for (const command of ["init", "verify"]) {
    const result = spawnSync(process.execPath, [cli, command], { cwd: root, encoding: "utf8", env: { ...process.env, GROUNDWORK_PORTAL: "0" } });
    expect({ code: result.status, error: result.stderr }).toEqual({ code: 0, error: "" });
  }
  const id = readFileSync(store.latest, "utf8").trim();
  const saved = JSON.parse(readFileSync(join(store.runs, id, "result.json"), "utf8"));
  expect(saved.checks[0]).toMatchObject({ name: "fresh", status: "passed" });
  expect(saved.finishedAt).toBeTruthy();
});

test.each([true, false])("publication races preserve both worktrees (identical payloads: %s)", identical => {
  const [root, other] = worktrees();
  const original = legacyRun(root, ".groundwork", "shared", report("shared"));
  const competing = legacyRun(other, ".groundwork", "shared", report("shared"), identical ? undefined : Buffer.from("Other evidence"));
  for (const path of [root, other]) write(path, ".groundwork/latest", "shared\n");
  const store = evidenceStore(root);
  const rename = fs.renameSync;
  let published = false;
  const race = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (!published && to === join(store.runs, "shared")) {
      published = true;
      prepareEvidenceStore(other);
    }
    return rename(from, to);
  });
  try {
    if (identical) prepareEvidenceStore(root);
    else {
      expect(() => prepareEvidenceStore(root)).toThrow();
      expect(readFileSync(join(root, ".groundwork/runs/shared/result.json"), "utf8")).toBe(original);
      expect(readFileSync(join(root, ".groundwork/latest"), "utf8")).toBe("shared\n");
    }
  } finally { race.mockRestore(); }
  expect(readFileSync(evidenceStore(other).latest, "utf8")).toBe("shared\n");
  expect(readFileSync(join(store.runs, "shared/result.json"), "utf8")).toBe(competing);
  prepareEvidenceStore(root);
  expect(readdirSync(store.runs)).toHaveLength(identical ? 1 : 2);
  const id = readFileSync(store.latest, "utf8").trim();
  expect(JSON.parse(readFileSync(join(store.runs, id, "result.json"), "utf8"))).toEqual({ ...report("shared"), id });
  expect(readFileSync(join(store.runs, id, "check/artifacts/proof.bin"))).toEqual(Buffer.from([0, 128, 255, 10]));
});

test.each([[".groundwork", false], [".verify", false], [".groundwork", true]])("state storage cannot overlap %s/runs (alias: %s)", (storage, alias) => {
  const root = temporaryDirectory();
  const original = legacyRun(root, storage, "saved", report("saved"));
  write(root, `${storage}/latest`, "saved\n");
  const runtime = join(root, storage, "runs");
  let home = runtime;
  if (alias) {
    home = join(temporaryDirectory(), "runtime-alias");
    symlinkSync(runtime, home);
  }
  process.env.GROUNDWORK_STATE_HOME = join(home, "state");
  expect(() => prepareEvidenceStore(root)).toThrow("Evidence store overlaps legacy runtime storage");
  expect(readdirSync(runtime)).toEqual(["saved"]);
  expect(readFileSync(join(runtime, "saved/result.json"), "utf8")).toBe(original);
  expect(readFileSync(join(root, storage, "latest"), "utf8")).toBe("saved\n");
});
