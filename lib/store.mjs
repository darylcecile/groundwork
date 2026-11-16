import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ensure, object, within } from "./model.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const runId = value => /^[a-zA-Z0-9_-]+$/.test(value);

function existing(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function canonical(path) {
  path = resolve(path);
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

function gitPath(root, flag) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", flag], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? canonical(result.stdout.trim()) : null;
}

// Repository evidence is shared by worktrees; each checkout keeps its own latest pointer.
export function evidenceStore(root) {
  const workspace = canonical(root);
  const common = gitPath(workspace, "--git-common-dir");
  const checkout = common && gitPath(workspace, "--show-toplevel");
  const namespace = hash(JSON.stringify(checkout ? [common, relative(checkout, workspace)] : [workspace]));
  const home = resolve(process.env.GROUNDWORK_STATE_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "groundwork"));
  const directory = join(home, "repositories", namespace);
  return { directory, runs: join(directory, "runs"), receipts: join(directory, "receipts"),
    latest: join(directory, "workspaces", hash(workspace), "latest") };
}

function directory(path) {
  const info = existing(path);
  ensure(!info || info.isDirectory(), `Expected an evidence directory without a symbolic link: ${path}`);
  return info;
}

function treeHash(root) {
  const entries = [];
  function visit(path, name) {
    let info = lstatSync(path);
    if (info.isSymbolicLink()) {
      info = statSync(within(root, path));
      ensure(info.isFile(), `Cannot migrate this evidence file type safely: ${path}`);
    }
    ensure(info.isDirectory() || info.isFile(), `Cannot migrate this evidence file type safely: ${path}`);
    entries.push([name, info.isDirectory() ? "directory" : hash(readFileSync(path))]);
    if (info.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
  }
  visit(root, "");
  return hash(JSON.stringify(entries));
}

function availableName(directory, name) {
  let candidate = name;
  for (let suffix = 2; existing(join(directory, candidate)); suffix++) candidate = `${name}-${suffix}`;
  return candidate;
}

function importRun(store, source, originalId) {
  const fingerprint = treeHash(source);
  const original = join(store.runs, originalId);
  if (existing(original) && treeHash(original) === fingerprint) return { id: originalId, fingerprint };
  const staged = mkdtempSync(join(store.directory, ".import-"));
  try {
    cpSync(source, staged, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: true });
    ensure(treeHash(staged) === fingerprint && treeHash(source) === fingerprint,
      `Evidence changed while migrating ${source}; the original was retained.`);
    let id = originalId;
    if (existing(original)) {
      if (treeHash(original) === fingerprint) return { id, fingerprint };
      const reportPath = join(staged, "result.json");
      let report = null;
      const bytes = existing(reportPath)?.isFile() ? readFileSync(reportPath) : null;
      try { report = bytes && JSON.parse(bytes.toString()); } catch { /* Preserve unreadable historical reports too. */ }
      const local = object(report) && [1, 2].includes(report.version) && report.id === originalId && Array.isArray(report.checks);
      const archived = local ? availableName(staged, "legacy-result.json") : null;
      if (archived) writeFileSync(join(staged, archived), bytes, { flag: "wx" });
      const provenance = availableName(staged, "migration.json");
      // The sidecar records the original directory/ID and, when rewritten, the byte-exact report archive.
      writeFileSync(join(staged, provenance), `${JSON.stringify({ originalId, source, report: archived }, null, 2)}\n`, { flag: "wx" });
      const base = `${originalId}-import-${fingerprint.slice(0, 12)}`;
      for (let suffix = 0; ; suffix++) {
        id = suffix ? `${base}-${suffix}` : base;
        if (local) writeFileSync(reportPath, `${JSON.stringify({ ...report, id }, null, 2)}\n`);
        const destination = join(store.runs, id);
        if (!existing(destination)) break;
        if (treeHash(destination) === treeHash(staged)) return { id, fingerprint };
      }
    }
    const destination = join(store.runs, id);
    try { renameSync(staged, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || treeHash(destination) !== treeHash(staged)) throw error;
    }
    return { id, fingerprint };
  } finally { rmSync(staged, { recursive: true, force: true }); }
}

function preserve(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    ensure(existing(path)?.isFile() && readFileSync(path).equals(bytes), `Migration collision at ${path}; the original was retained.`);
  }
}

export function prepareEvidenceStore(root) {
  root = canonical(root);
  const store = evidenceStore(root);
  const destination = canonical(store.directory);
  for (const name of [".groundwork", ".verify"]) {
    const runtime = canonical(join(root, name, "runs"));
    ensure(destination !== runtime && !destination.startsWith(`${runtime}${sep}`) && !runtime.startsWith(`${destination}${sep}`),
      `Evidence store overlaps legacy runtime storage: ${store.directory} and ${runtime}`);
  }
  for (const path of [store.directory, store.runs, store.receipts, dirname(store.latest)]) {
    directory(path);
    mkdirSync(path, { recursive: true });
  }
  const imported = [];
  const pointers = [];
  for (const name of [".groundwork", ".verify"]) {
    const legacy = join(root, name);
    if (!directory(legacy)) continue;
    const runs = join(legacy, "runs");
    const ids = new Map();
    if (directory(runs)) {
      for (const id of readdirSync(runs).sort()) {
        const path = join(runs, id);
        if (!existing(path).isDirectory()) continue;
        ensure(runId(id), `Invalid legacy run identifier: ${path}`);
        const saved = importRun(store, path, id);
        ids.set(id, saved.id);
        imported.push({ path, fingerprint: saved.fingerprint });
      }
    }
    const pointer = join(legacy, "latest");
    const info = existing(pointer);
    if (!info) continue;
    ensure(info.isFile(), `Expected a latest pointer without a symbolic link: ${pointer}`);
    const bytes = readFileSync(pointer);
    const previous = bytes.toString().trim();
    const id = runId(previous) ? ids.get(previous) : null;
    // Both legacy pointers survive, including a lower-priority one and original whitespace.
    preserve(join(dirname(store.latest), "legacy", name.slice(1), id || "orphan", hash(bytes)), bytes);
    pointers.push({ path: pointer, original: bytes, bytes: id ? (id === previous ? bytes : Buffer.from(`${id}\n`)) : null });
  }
  const latest = existing(store.latest);
  ensure(!latest || latest.isFile(), `Expected a latest pointer without a symbolic link: ${store.latest}`);
  const candidate = pointers.find(pointer => pointer.bytes);
  if (!latest && candidate) {
    try { writeFileSync(store.latest, candidate.bytes, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  // Delete generated inputs only after every run and pointer has been preserved successfully.
  for (const { path, fingerprint } of imported) ensure(treeHash(path) === fingerprint,
    `Evidence changed while migrating ${path}; the original was retained.`);
  for (const pointer of pointers) ensure(readFileSync(pointer.path).equals(pointer.original),
    `Latest pointer changed while migrating ${pointer.path}; the original was retained.`);
  for (const pointer of pointers) unlinkSync(pointer.path);
  for (const { path } of imported) rmSync(path, { recursive: true });
  for (const name of [".groundwork", ".verify"]) {
    const runs = join(root, name, "runs");
    if (existing(runs) && readdirSync(runs).length === 0) rmdirSync(runs);
  }
  return store;
}
