import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensure, object, readJSON, safePath, text } from "./model.mjs";

function metadata(root) {
  const value = readJSON(join(root, "package.json"));
  ensure(object(value) && text(value.name) && !value.name.startsWith("-"), "Groundwork's package name is unavailable.");
  return value;
}

export function bundledSkills(root) {
  const directory = join(root, "skills");
  const skills = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const file = join(path, "SKILL.md");
    if (!existsSync(file)) continue;
    ensure(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) && entry.name.length <= 64, `Use a lowercase kebab-case skill directory name: ${entry.name}`);
    const frontmatter = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    ensure(frontmatter, `Missing skill frontmatter: ${file}`);
    let info;
    try { info = Bun.YAML.parse(frontmatter[1]); }
    catch (error) { throw new Error(`Invalid skill frontmatter in ${file}: ${error.message}`); }
    ensure(object(info) && info.name === entry.name && text(info.description), `Skill ${entry.name} needs a matching name and a nonempty description.`);
    skills.push({ id: entry.name, path });
  }
  ensure(skills.length > 0, "No bundled skills were found.");
  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

function existingLink(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function ownedLink(destination, id, packageName) {
  const target = resolve(dirname(destination), readlinkSync(destination));
  if (basename(target) !== id || basename(dirname(target)) !== "skills") return false;
  try { return metadata(resolve(target, "../..")).name === packageName; }
  catch { return false; }
}

export function installSkills(root) {
  const packageName = metadata(root).name;
  const directory = join(homedir(), ".agents", "skills");
  const links = bundledSkills(root).map(skill => {
    const destination = join(directory, skill.id);
    const existing = existingLink(destination);
    let current = false;
    if (existing?.isSymbolicLink()) {
      try { current = realpathSync(destination) === realpathSync(skill.path); } catch {}
    }
    ensure(!existing || current || (existing.isSymbolicLink() && ownedLink(destination, skill.id, packageName)),
      `A different skill already exists at ${destination}. Keep it or move it before installing this one.`);
    return { ...skill, destination, replace: Boolean(existing) && !current, current };
  });
  mkdirSync(directory, { recursive: true });
  for (const skill of links) {
    if (skill.current) continue;
    if (skill.replace) unlinkSync(skill.destination);
    symlinkSync(skill.path, skill.destination, "dir");
    console.log(`Registered ${skill.id}`);
  }
  return links.map(skill => skill.id);
}

function execute(command, args, { capture = false, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd: homedir(), env: process.env, encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  ensure(result.status === 0, `${label} failed: ${result.error?.message || result.signal || `exit ${result.status}`}`);
  return result.stdout?.trim() || "";
}

export function updatePackage(root) {
  const info = metadata(root);
  if (existsSync(join(root, ".git"))) {
    ensure(object(info.bin) && safePath(info.bin.groundwork), "Groundwork's CLI entry point is unavailable.");
    console.log(`Using the current linked checkout: ${root}`);
    console.log("Registering its bundled skills. Update this checkout with Git when needed.");
    execute(process.execPath, [join(root, info.bin.groundwork), "install"], { label: "Skill registration" });
    return;
  }
  const repository = typeof info.repository === "string" ? info.repository : info.repository?.url;
  ensure(text(repository), "Groundwork's update repository is unavailable.");
  const url = repository.replace(/^git\+/, "").split("#")[0];
  console.log(`Checking the latest ${info.name} commit...`);
  const remote = execute("git", ["ls-remote", "--exit-code", url, "HEAD"], { capture: true, label: "Package update lookup" });
  const revision = remote.split(/\s+/)[0];
  ensure(/^[a-f0-9]{40,64}$/.test(revision), "The update repository did not return a commit.");
  const dependency = `${/^(https?|ssh):\/\//.test(url) ? "git+" : ""}${url}#${revision}`;
  console.log(`Installing ${info.name} at ${revision.slice(0, 12)}...`);
  execute(process.execPath, ["remove", "--global", info.name], { label: "Package replacement" });
  try {
    execute(process.execPath, ["add", "--global", dependency], { label: "Package update" });
  } catch (error) {
    throw new Error(`${error.message}\nTo finish installing Groundwork, run: bun add --global ${dependency}`);
  }
  const bin = execute(process.execPath, ["pm", "bin", "--global"], { capture: true, label: "Bun global binary lookup" });
  ensure(isAbsolute(bin), "Bun did not return an absolute global binary directory.");
  const cli = join(bin, "groundwork");
  ensure(existsSync(cli) && statSync(cli).isFile(), `The updated Groundwork executable was not found at ${cli}.`);
  execute(cli, ["install"], { label: "Updated skill registration" });
  console.log("Groundwork is up to date.");
}
