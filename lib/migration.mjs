import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configFiles, configPath, parseConfig, parseConfigDocument } from "./config.mjs";
import { guideMigrationMarker, planGuideMigration } from "./guide-migration.mjs";
import { directory, existing, pathExists, planInstructions, planLayout, regularFile } from "./layout.mjs";
import { ensure, readJSON } from "./model.mjs";
import { prepareEvidenceStore } from "./store.mjs";

const bases = [".groundwork/verify.json", "verify.json", ".verify/verify.json"];
const guidePaths = [".groundwork/VERIFY.md", "VERIFY.md", ".verify/VERIFY.md"];
const groups = ["checks", "behaviours", "invariants", "context"];
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const portable = path => path.normalize("NFD").toLowerCase();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fileTokens = paths => new RegExp(`(^|[\\s'\"=<>|;&(])(\\./)?(${paths.map(escape).join("|")})(?=$|[\\s'\"<>|;&)])`, "g");

function relocatedPath(path, relocations) {
  const file = path.replace(/^\.\//, "");
  if (relocations.has(file)) return relocations.get(file);
  const directory = [...relocations.keys()].filter(source => source.endsWith("/") && file.startsWith(source))
    .sort((a, b) => b.length - a.length)[0];
  return directory ? `${relocations.get(directory)}${file.slice(directory.length)}` : path;
}

function rewriteCommand(command, relocations, guides) {
  if (typeof command !== "string") return command;
  const paths = [...relocations.keys(), ...guidePaths].sort((a, b) => b.length - a.length);
  return command.replace(fileTokens(paths), (match, before, dot, path) => {
    const target = relocations.get(path) ?? guides.relocate(path);
    return `${before}${dot ?? ""}${target}`;
  });
}

function rewriteDocument(value, relocations, guides) {
  for (const group of ["checks", "behaviours", "invariants"]) {
    for (const entry of Object.values(value[group] ?? {})) {
      if (entry.paths) entry.paths = entry.paths.flatMap(path => {
        const file = path.replace(/^\.\//, "");
        if (bases.includes(file) && !relocations.has(file)) return path;
        if (!guidePaths.includes(file) || !guides.references.has(file)) return relocatedPath(path, relocations);
        return [...new Set([...guides.references].filter(([source]) => source === file || source.startsWith(`${file}#`))
          .map(([, target]) => target.split("#")[0]))];
      });
    }
  }
  for (const check of Object.values(value.checks ?? {})) {
    for (const field of ["command", "setup", "cleanup"]) {
      if (check[field] !== undefined) check[field] = rewriteCommand(check[field], relocations, guides);
    }
    if (check.reuse && typeof check.reuse === "object" && check.reuse.files) {
      check.reuse.files = check.reuse.files.map(path => {
        if (bases.includes(path.replace(/^\.\//, "")) && !relocations.has(path.replace(/^\.\//, ""))) return path;
        const relocated = relocatedPath(path, relocations);
        return relocated === path ? guides.relocate(path) : relocated;
      });
    }
  }
  for (const group of ["behaviours", "invariants"]) {
    for (const entry of Object.values(value[group] ?? {})) {
      if (entry.guide) entry.guide = guides.relocate(entry.guide);
    }
  }
  return value;
}

function planConfiguration(root, files, guides, relocations, initialize, wholeBase) {
  const base = configPath(root);
  const merged = { checks: {}, behaviours: {}, invariants: {}, context: {} };
  const owners = Object.fromEntries(groups.map(group => [group, new Map()]));
  const documents = [];
  const retired = [];
  const duplicates = [];
  const deletes = new Set(bases.filter(path => pathExists(join(root, path))).reverse());
  for (const path of files) {
    regularFile(path);
    const source = relative(root, path).split(sep).join("/");
    const value = readJSON(path);
    const original = structuredClone(value);
    parseConfigDocument(value, source, path !== base);
    for (const group of groups) {
      const hadEntries = Object.keys(value[group] ?? {}).length > 0;
      for (const [id, item] of Object.entries(value[group] ?? {})) {
        if (owners[group].has(id)) {
          duplicates.push({ group, id, item, source });
          delete value[group][id];
        } else {
          owners[group].set(id, source);
          Object.defineProperty(merged[group], id, { value: item, enumerable: true });
        }
      }
      if (hadEntries && !Object.keys(value[group]).length) delete value[group];
    }
    if (path === base && !wholeBase) {
      for (const group of ["checks", "behaviours", "invariants"]) {
        for (const [id, item] of Object.entries(value[group] ?? {})) {
          documents.push({ name: `${group === "checks" ? "check" : group === "behaviours" ? "behaviour" : "invariant"}-${id.replace(/:/g, "-")}.json`,
            value: { [group]: { [id]: item } }, base: true });
        }
      }
      if (value.context) documents.push({ name: "project.json", value: { context: value.context }, base: true });
    } else if (Object.keys(value).length) {
      documents.push({ source, name: path === base ? "project.json" : basename(path), value, original,
        content: readFileSync(path, "utf8"), base: path === base });
    } else {
      deletes.add(source);
      retired.push({ source, original });
    }
  }
  if (!documents.length && (files.length || initialize)) documents.push({ name: "project.json", value: { checks: {} } });

  // Retain existing feature filenames unless their ordering would move checks ahead of the old base.
  const reserved = new Set(documents.filter(item => item.source && !item.base).map(item => portable(item.name)));
  let index = 0;
  for (const item of documents) {
    if (!item.source || item.base) {
      const name = `${String(++index).padStart(4, "0")}-${item.name}`;
      let candidate = name;
      for (let suffix = 2; reserved.has(portable(candidate)); suffix++) candidate = name.replace(/\.json$/, `-${suffix}.json`);
      item.name = candidate;
      reserved.add(portable(candidate));
    }
    item.target = `.groundwork/verify.d/${item.name}`;
  }
  const orderedEntries = (items, group) => Object.keys(Object.assign({}, ...items.map(item => item.value[group])));
  const ordered = [...documents].sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
  const collisions = new Set(documents.map(item => portable(item.target))).size !== documents.length;
  if (collisions || groups.some(group => !isDeepStrictEqual(orderedEntries(ordered, group), Object.keys(merged[group])))) {
    documents.forEach((item, index) => {
      item.target = `.groundwork/verify.d/${String(index + 1).padStart(6, "0")}-${item.name.replace(/^\d+-/, "")}`;
    });
  }
  const moves = new Map(relocations);
  for (const item of documents) {
    if (item.source && item.source !== item.target) moves.set(item.source, item.target);
  }
  for (const { source, original } of retired) {
    const destinations = new Set(groups.flatMap(group => Object.keys(original[group] ?? {}).map(id =>
      documents.find(document => Object.hasOwn(document.value[group] ?? {}, id))?.target)).filter(Boolean));
    if (destinations.size === 1) moves.set(source, [...destinations][0]);
  }
  for (const [from, to] of moves) guides.references.set(from, to);
  function relocateConfigInputs(entry) {
    for (const [object, field] of [[entry, "paths"], [entry.reuse, "files"]]) {
      const inputs = object?.[field];
      if (!inputs?.some(path => bases.includes(path.replace(/^\.\//, "")))) continue;
      object[field] = [...new Set(inputs.flatMap(path => bases.includes(path.replace(/^\.\//, ""))
        ? documents.filter(document => document.base).map(document => document.target) : path))];
    }
  }
  const writes = new Map();
  for (const item of documents) {
    rewriteDocument(item.value, moves, guides);
    for (const group of ["checks", "behaviours", "invariants"]) {
      for (const entry of Object.values(item.value[group] ?? {})) {
        relocateConfigInputs(entry);
      }
    }
    writes.set(item.target, item.original && isDeepStrictEqual(item.original, item.value) ? item.content : json(item.value));
    if (item.source && item.source !== item.target) deletes.add(item.source);
  }
  for (const { group, id, item, source } of duplicates) {
    rewriteDocument({ [group]: { [id]: item } }, moves, guides);
    if (group !== "context") relocateConfigInputs(item);
    ensure(isDeepStrictEqual(merged[group][id], item),
      `Conflicting ${group} definition "${id}" in ${owners[group].get(id)} and ${source}. The agent must reconcile these active definitions before retrying; no metadata was changed.`);
  }
  parseConfig(merged);
  return { writes, deletes };
}

function prune(root, path) {
  const absolute = join(root, path);
  if (!existing(absolute)?.isDirectory()) return;
  for (const name of readdirSync(absolute)) {
    if (existing(join(absolute, name))?.isDirectory()) prune(root, `${path}/${name}`);
  }
  if (!readdirSync(absolute).length) rmdirSync(absolute);
}

export function prepareProject(root, { initialize = false } = {}) {
  root = resolve(root);
  if (!initialize) {
    const obsolete = [...bases, "VERIFY.md", ".verify", ".groundwork/legacy-verify.gitignore", ".groundwork/runs", ".groundwork/latest"];
    const bootstrap = join(root, ".groundwork/VERIFY.md");
    const fragments = join(root, ".groundwork/verify.d");
    if (!obsolete.some(path => pathExists(join(root, path))) && existing(join(root, ".groundwork"))?.isDirectory() &&
      existing(bootstrap)?.isFile() && existing(fragments)?.isDirectory() &&
      readFileSync(bootstrap, "utf8").trimStart().startsWith(guideMigrationMarker) &&
      readdirSync(fragments).some(name => name.endsWith(".json"))) return { changed: false };
  }
  const sources = guidePaths.filter(path => pathExists(join(root, path)));
  const files = configFiles(root);
  const legacyRuntime = [".groundwork", ".verify"].some(namespace =>
    ["runs", "latest"].some(name => pathExists(join(root, namespace, name))));
  const metadata = bases.some(path => pathExists(join(root, path))) || sources.length || files.length || pathExists(join(root, ".verify"));
  if (!initialize && !metadata && !legacyRuntime) return { changed: false };
  directory(root);
  for (const path of [...bases, ...sources]) regularFile(join(root, path));
  const layout = planLayout(root, { initialize: initialize || bases.some(path => pathExists(join(root, path))) || pathExists(join(root, ".verify")) });
  const guideSources = sources.map(path => ({ path, content: readFileSync(join(root, path), "utf8") }));
  const activeBase = relative(root, configPath(root)).split(sep).join("/");
  let wholeBase = false;
  const consumes = (check, path) => ["command", "setup", "cleanup"].some(field =>
    typeof check[field] === "string" && fileTokens([path]).test(check[field])) ||
    check.reuse?.files?.some(file => file.replace(/^\.\//, "") === path);
  for (const path of files) {
    const value = readJSON(path);
    parseConfigDocument(value, path, path !== configPath(root));
    for (const check of Object.values(value.checks ?? {})) {
      if (consumes(check, activeBase)) wholeBase = true;
      for (const source of guideSources) if (consumes(check, source.path)) source.split = false;
    }
  }
  const guides = initialize || files.length || sources.length ? planGuideMigration(root, guideSources)
    : { writes: new Map(), deletes: new Set(), references: new Map(), relocate: reference => reference, rewriteMarkdown: text => text };
  for (const [from, to] of layout.relocations) guides.references.set(from, to);
  for (const path of bases) if (pathExists(join(root, path))) guides.references.set(path, ".groundwork/verify.d/");
  const config = planConfiguration(root, files, guides, layout.relocations, initialize || sources.length > 0, wholeBase);
  for (const [path, content] of guides.writes) guides.writes.set(path, guides.rewriteMarkdown(content, path, path));
  const writes = new Map();
  for (const [path, content] of [...layout.writes, ...guides.writes, ...config.writes]) {
    ensure(!writes.has(path) || Buffer.from(writes.get(path)).equals(Buffer.from(content)),
      `Migration collision at ${path}. The agent must reconcile the conflicting content before retrying; no metadata was changed.`);
    writes.set(path, content);
  }
  const deletes = new Set([...layout.deletes, ...guides.deletes, ...config.deletes]);
  const agents = join(root, "AGENTS.md");
  const target = pathExists(agents) ? relative(root, realpathSync(agents)).split(sep).join("/") : "AGENTS.md";
  const instructionSource = target === ".." || target.startsWith("../") ? "AGENTS.md" : target;
  const instructionPath = layout.relocations.get(instructionSource) ?? instructionSource;
  const retargetInstructions = instructionPath !== instructionSource && existing(agents)?.isSymbolicLink();
  const instructions = planInstructions(root, { initialize,
    rewriteMarkdown: text => guides.rewriteMarkdown(text, instructionSource, instructionPath) });
  if (instructions !== null) writes.set(instructionPath, instructions);

  // Relink incoming Markdown references, leaving generated history and dependency trees alone.
  function markdown(path) {
    if (!existing(join(root, path))?.isDirectory()) return;
    for (const name of readdirSync(join(root, path))) {
      if ([".git", "node_modules", ".verify"].includes(name) ||
        (path === ".groundwork" && ["runs", "plans", "tasks", "tmp"].includes(name))) continue;
      const file = path ? `${path}/${name}` : name;
      const info = existing(join(root, file));
      if (info.isDirectory()) markdown(file);
      else if (info.isFile() && /\.(md|markdown)$/i.test(name) && file !== "AGENTS.md" && !deletes.has(file) && !writes.has(file)) {
        const previous = readFileSync(join(root, file), "utf8");
        const next = guides.rewriteMarkdown(previous, file, file);
        if (next !== previous) writes.set(file, next);
      }
    }
  }
  if (guides.references.size) markdown("");
  for (const [from, to] of layout.relocations) {
    if (to === instructionPath && instructions !== null) continue;
    if (/\.(md|markdown)$/i.test(from) && existing(join(root, from))?.isFile()) {
      writes.set(to, guides.rewriteMarkdown(readFileSync(join(root, from), "utf8"), from, to));
    }
  }

  const targets = new Set();
  for (const [path, content] of writes) {
    ensure(!targets.has(portable(path)), `Migration collision at ${path}: destinations differ only in case.`);
    targets.add(portable(path));
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) directory(join(root, parent));
    if (path !== "AGENTS.md") regularFile(join(root, path));
    deletes.delete(path);
    if (pathExists(join(root, path)) && readFileSync(join(root, path)).equals(Buffer.from(content)) &&
      (!layout.modes.has(path) || (existing(join(root, path)).mode & 0o777) === (layout.modes.get(path) & 0o777))) writes.delete(path);
  }
  // A contradictory active definition or destination has already failed before evidence or metadata changes.
  if (legacyRuntime) prepareEvidenceStore(root);
  for (const [path, content] of writes) {
    if (path === ".groundwork/VERIFY.md") continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, { mode: layout.modes.get(path) });
    if (layout.modes.has(path)) chmodSync(join(root, path), layout.modes.get(path));
  }
  if (retargetInstructions) {
    unlinkSync(agents);
    symlinkSync(relative(root, join(root, instructionPath)), agents);
  }
  // Retire old configuration references before replacing the canonical source guide with its bootstrap.
  for (const path of config.deletes) {
    if (deletes.has(path) && pathExists(join(root, path))) unlinkSync(join(root, path));
  }
  if (writes.has(".groundwork/VERIFY.md")) {
    mkdirSync(join(root, ".groundwork"), { recursive: true });
    writeFileSync(join(root, ".groundwork/VERIFY.md"), writes.get(".groundwork/VERIFY.md"));
  }
  for (const path of deletes) if (pathExists(join(root, path))) unlinkSync(join(root, path));
  for (const path of layout.directories) prune(root, path);
  return { changed: legacyRuntime || writes.size > 0 || deletes.size > 0 };
}
