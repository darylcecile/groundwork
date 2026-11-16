import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensure } from "./model.mjs";

export const runtimePaths = ["runs/", "latest", "plans/", "tasks/", "tmp/"];
export const runtimeExclusions = ["**/.verify/**", ...[...runtimePaths, "plan.json"].map(path =>
  `**/.groundwork/${path}${path.endsWith("/") ? "**" : ""}`)];

export const groundworkPath = (root, ...parts) => join(root, ".groundwork", ...parts);

export function existing(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export const pathExists = path => existing(path) !== null;

export function regularFile(path) {
  const info = existing(path);
  ensure(!info || info.isFile(), `Expected a regular file, without a symbolic link: ${path}`);
  return info;
}

export function directory(path) {
  const info = existing(path);
  ensure(!info || info.isDirectory(), `Expected a directory, without a symbolic link: ${path}`);
  return info;
}

function ignoreRules(content, { legacy = false } = {}) {
  return content.split(/\r?\n/).filter(line => {
    const rule = line.trim().replace(/^\//, "");
    return !/^(?:runs(?:\/\*\*?|\/)?|latest)$/.test(rule) &&
      !(legacy && ["*", "**", "*/", "**/", "!.gitignore", "!/.gitignore"].includes(rule));
  });
}

// Custom files retain their namespace-relative locations; generated runs are handled by the store.
export function planLayout(root, { initialize = false } = {}) {
  directory(groundworkPath(root));
  const legacy = directory(join(root, ".verify"));
  const writes = new Map();
  const deletes = new Set();
  const relocations = new Map();
  const modes = new Map();
  const directories = new Set();
  function collect(from, to) {
    const info = existing(join(root, from));
    ensure(!info.isSymbolicLink(), `Cannot migrate a symbolic link safely: ${from}. The agent must resolve its target before retrying.`);
    if (info.isDirectory()) {
      directory(join(root, to));
      relocations.set(from, to);
      relocations.set(`${from}/`, `${to}/`);
      for (const name of readdirSync(join(root, from)).sort()) collect(`${from}/${name}`, `${to}/${name}`);
      directories.add(from);
      return;
    }
    ensure(info.isFile(), `Cannot migrate this file type: ${from}`);
    if (from.startsWith(".verify/verify.d/") && from.endsWith(".json")) return;
    regularFile(join(root, to));
    const bytes = readFileSync(join(root, from));
    ensure((!writes.has(to) || writes.get(to).equals(bytes)) &&
      (!pathExists(join(root, to)) || readFileSync(join(root, to)).equals(bytes)),
      `Migration collision between ${from} and ${to}. The agent must reconcile the conflicting content before retrying; neither file was overwritten.`);
    writes.set(to, bytes);
    modes.set(to, info.mode);
    deletes.add(from);
    relocations.set(from, to);
  }
  if (legacy) {
    relocations.set(".verify", ".groundwork");
    relocations.set(".verify/", ".groundwork/");
    for (const name of readdirSync(join(root, ".verify")).sort()) {
      if (["verify.json", "VERIFY.md", ".gitignore", "runs", "latest"].includes(name)) continue;
      ensure(!["verify.json", "verify.md"].includes(name.toLowerCase()), `Migration collision at .verify/${name}: metadata paths differ only in case.`);
      collect(`.verify/${name}`, `.groundwork/${name}`);
    }
    directories.add(".verify");
  }
  for (const namespace of [".verify", ".groundwork"]) {
    const runs = join(root, namespace, "runs");
    if (existing(runs)?.isDirectory()) {
      for (const name of readdirSync(runs)) {
        if (!existing(join(runs, name)).isDirectory()) collect(`${namespace}/runs/${name}`, `.groundwork/notes/${name}`);
      }
      directories.add(`${namespace}/runs`);
    }
  }

  const ignorePath = ".groundwork/.gitignore";
  regularFile(join(root, ignorePath));
  const previous = pathExists(join(root, ignorePath)) ? readFileSync(join(root, ignorePath), "utf8") : "";
  let rules = ignoreRules(previous);
  for (const path of [".verify/.gitignore", ".groundwork/legacy-verify.gitignore"]) {
    if (!regularFile(join(root, path))) continue;
    rules.push(...ignoreRules(readFileSync(join(root, path), "utf8"), { legacy: true }));
    deletes.add(path);
  }
  if (initialize) {
    for (const rule of ["/plans/", "/tasks/", "/tmp/"]) if (!rules.includes(rule)) rules.push(rule);
    if ((pathExists(groundworkPath(root, "plan.json")) || writes.has(".groundwork/plan.json")) && !rules.includes("/plan.json")) rules.push("/plan.json");
  }
  const next = `${rules.join("\n").replace(/^\n+|\n+$/g, "")}\n`;
  if (next.trim() && next !== previous) writes.set(ignorePath, next);
  else if (!next.trim() && previous) deletes.add(ignorePath);

  const rootIgnore = join(root, ".gitignore");
  if (regularFile(rootIgnore)) {
    const before = readFileSync(rootIgnore, "utf8");
    const after = before.split(/\r?\n/).flatMap(line => {
      if (/^\/?(?:\*\*\/)?\.verify(?:\/(?:\*|\*\*)?)?\/?$/.test(line)) return [];
      if (/^\/?(?:\.verify|\.groundwork)\/(?:runs(?:\/\*\*?|\/)?|latest)$/.test(line)) return [];
      return [line.replace(/^(\/?|!\/?)\.verify\//, "$1.groundwork/")];
    }).join("\n");
    if (after !== before) writes.set(".gitignore", after);
  }
  return { writes, deletes, relocations, directories, modes };
}

export const projectInstruction = "## Verification workflow\n\nUse the `verify-work` skill for implementation tasks. Read `.groundwork/VERIFY.md` for project context and discover guides and checks with `groundwork view guide`. Checks live in `.groundwork/verify.d/`.\n";

export function planInstructions(root, { initialize = false, rewriteMarkdown } = {}) {
  const path = join(root, "AGENTS.md");
  const previous = pathExists(path) ? readFileSync(path, "utf8") : "";
  let next = rewriteMarkdown ? rewriteMarkdown(previous, { from: "AGENTS.md", to: "AGENTS.md" }) : previous;
  next = next.replace(/`(?:\.\/)?(?:\.verify\/|\.groundwork\/)?verify\.json`/g, "`.groundwork/verify.d/`")
    .replace(/`(?:\.\/)?(?:\.verify\/)?VERIFY\.md`/g, "`.groundwork/VERIFY.md`");
  if (initialize && !/^## Verification workflow\s*$/m.test(next)) {
    next += `${next && !next.endsWith("\n") ? "\n" : ""}${next ? "\n" : ""}${projectInstruction}`;
  }
  return next === previous ? null : next;
}
