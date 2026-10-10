import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensure, object, readJSON } from "./model.mjs";

export const runtimePaths = ["runs/", "latest", "plans/", "tasks/", "tmp/"];
export const runtimeExclusions = ["**/.verify/**", ...[...runtimePaths, "plan.json"].map(path =>
  `**/.groundwork/${path}${path.endsWith("/") ? "**" : ""}`)];

export const groundworkPath = (root, ...parts) => join(root, ".groundwork", ...parts);

function existing(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export const pathExists = path => existing(path) !== null;

function directory(path) {
  const info = existing(path);
  ensure(!info || info.isDirectory(), `Expected a directory, without a symbolic link: ${path}`);
  return info;
}

function file(path) {
  const info = existing(path);
  ensure(!info || info.isFile(), `Expected a regular file, without a symbolic link: ${path}`);
  return info;
}

function migration(root) {
  const moves = new Map();
  const targets = new Set();
  const directories = [];
  function plan(from, to) {
    const info = existing(from);
    if (!info) return;
    ensure(!info.isSymbolicLink(), `Cannot migrate a symbolic link safely: ${from}`);
    // Keep migrated layouts portable across case-insensitive and normalization-insensitive filesystems.
    const key = to.normalize("NFD").toLowerCase();
    ensure(!targets.has(key), `Migration collision at ${to}; keep or move the conflicting files before running init.`);
    targets.add(key);
    if (info.isDirectory()) {
      directory(to);
      for (const name of readdirSync(from)) plan(join(from, name), join(to, name));
      directories.push({ from, to });
      return;
    }
    ensure(info.isFile(), `Cannot migrate this file type: ${from}`);
    ensure(!existing(to),
      `Migration collision at ${to}; keep or move the conflicting files before running init.`);
    moves.set(to, from);
  }
  directory(groundworkPath(root));
  for (const name of ["verify.json", "VERIFY.md"]) {
    file(join(root, name));
    file(groundworkPath(root, name));
    plan(join(root, name), groundworkPath(root, name));
  }
  const legacy = join(root, ".verify");
  if (directory(legacy)) {
    for (const name of ["verify.json", "VERIFY.md", ".gitignore"]) file(join(legacy, name));
    for (const name of readdirSync(legacy)) {
      const destination = name.toLowerCase() === ".gitignore" ? "legacy-verify.gitignore" : name;
      plan(join(legacy, name), groundworkPath(root, destination));
    }
    directories.push({ from: legacy, to: groundworkPath(root) });
  }
  return { moves, directories };
}

function updatedGuides(path) {
  const config = readJSON(path);
  ensure(object(config), `${path} must be an object.`);
  let changed = false;
  for (const group of [config.behaviours, config.invariants]) {
    if (!object(group)) continue;
    for (const entry of Object.values(group)) {
      if (!object(entry) || typeof entry.guide !== "string" || !/^VERIFY\.md(?:#|$)/.test(entry.guide)) continue;
      entry.guide = `.groundwork/${entry.guide}`;
      changed = true;
    }
  }
  return changed ? `${JSON.stringify(config, null, 2)}\n` : null;
}

export function initializeLayout(root, guide) {
  const { moves, directories } = migration(root);
  const configPath = groundworkPath(root, "verify.json");
  const configSource = moves.get(configPath) || (file(configPath) ? configPath : null);
  const config = moves.get(groundworkPath(root, "VERIFY.md")) === join(root, "VERIFY.md") && configSource
    ? updatedGuides(configSource) : null;
  const ignorePath = groundworkPath(root, ".gitignore");
  file(ignorePath);
  const previous = existing(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const rules = runtimePaths.map(path => `/${path}`);
  if (moves.has(groundworkPath(root, "plan.json"))) rules.push("/plan.json");
  const missing = rules.filter(rule => !previous.split(/\r?\n/).includes(rule));

  mkdirSync(groundworkPath(root), { recursive: true });
  for (const { to } of directories) mkdirSync(to, { recursive: true });
  for (const [to, from] of moves) {
    mkdirSync(dirname(to), { recursive: true });
    // Unlike rename, linking refuses to replace a destination created after preflight.
    linkSync(from, to);
    unlinkSync(from);
    console.log(`Moved ${from} to ${to}`);
  }
  for (const { from } of directories) rmdirSync(from);
  if (config !== null) writeFileSync(configPath, config);
  for (const [path, content] of [[configPath, `${JSON.stringify({ checks: {} }, null, 2)}\n`],
    [groundworkPath(root, "VERIFY.md"), guide]]) {
    if (existing(path)) continue;
    writeFileSync(path, content, { flag: "wx" });
    console.log(`Created ${path}`);
  }
  if (missing.length) writeFileSync(ignorePath, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
