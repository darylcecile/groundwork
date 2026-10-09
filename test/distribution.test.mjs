import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture() {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-distribution-"));
  directories.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), COPILOT_HOME: join(home, ".copilot"),
    BUN_INSTALL: join(root, "bun"), BUN_INSTALL_GLOBAL_DIR: join(root, "global"), BUN_INSTALL_BIN: join(root, "bin"),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  };
  write(join(home, ".bunfig.toml"), `[install]\nglobalDir = ${JSON.stringify(env.BUN_INSTALL_GLOBAL_DIR)}\nglobalBinDir = ${JSON.stringify(env.BUN_INSTALL_BIN)}\n[install.cache]\ndir = ${JSON.stringify(join(root, "cache"))}\n`);
  write(join(env.BUN_INSTALL_GLOBAL_DIR, "package.json"), '{"dependencies":{}}\n');
  function command(program, args, cwd = home) {
    const result = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: 20000 });
    return { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
  }
  function run(program, args, cwd = home) {
    const result = command(program, args, cwd);
    if (result.code !== 0) throw new Error(`${program} failed: ${result.output}`);
    return result.stdout.trim();
  }
  return { root, home, env, run, command };
}

function bundle(root, name = "bundle") {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  for (const path of ["package.json", "lib", "skills"]) cpSync(join(repository, path), join(directory, path), { recursive: true });
  return directory;
}

function skill(directory, id, description = "Use for a focused verification task.") {
  write(join(directory, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n`);
}

const cli = directory => join(directory, "skills/verify-work/verify.mjs");
const installedSkill = (home, id) => join(home, ".agents", "skills", id);

test("install discovers every bundled skill and preserves unrelated personal skills", () => {
  const value = fixture();
  const source = bundle(value.root);
  skill(source, "review-work");
  write(join(source, "skills/shared/readme.md"), "Supporting files, not a skill.");
  write(join(installedSkill(value.home, "personal-work"), "SKILL.md"), "Personal content\n");
  value.run(process.execPath, [cli(source), "install"]);
  for (const id of ["verify-work", "review-work"]) expect(realpathSync(installedSkill(value.home, id))).toBe(realpathSync(join(source, "skills", id)));
  expect(existsSync(installedSkill(value.home, "shared"))).toBe(false);
  const instructions = readFileSync(join(value.home, ".copilot/copilot-instructions.md"), "utf8");
  value.run(process.execPath, [cli(source), "install"]);
  expect(readFileSync(join(value.home, ".copilot/copilot-instructions.md"), "utf8")).toBe(instructions);
  expect(readFileSync(join(installedSkill(value.home, "personal-work"), "SKILL.md"), "utf8")).toBe("Personal content\n");
});

test("install refuses a conflicting user skill before changing registrations", () => {
  const value = fixture();
  const source = bundle(value.root);
  skill(source, "another-skill");
  const personal = installedSkill(value.home, "verify-work");
  write(join(personal, "SKILL.md"), "Keep my custom skill\n");
  const result = value.command(process.execPath, [cli(source), "install"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("A different skill already exists");
  expect(existsSync(installedSkill(value.home, "another-skill"))).toBe(false);
  expect(lstatSync(personal).isDirectory()).toBe(true);
  expect(readFileSync(join(personal, "SKILL.md"), "utf8")).toBe("Keep my custom skill\n");
});

test("owned skill links move to the new package while an unrelated symlink is preserved", () => {
  const value = fixture();
  const original = bundle(value.root, "original");
  const updated = bundle(value.root, "updated");
  value.run(process.execPath, [cli(original), "install"]);
  value.run(process.execPath, [cli(updated), "install"]);
  expect(realpathSync(installedSkill(value.home, "verify-work"))).toBe(realpathSync(join(updated, "skills/verify-work")));
  expect(existsSync(join(original, "skills/verify-work/SKILL.md"))).toBe(true);
  const foreign = join(value.root, "foreign-skill");
  write(join(foreign, "SKILL.md"), "Different skill source\n");
  symlinkSync(foreign, installedSkill(value.home, "extra-work"));
  skill(updated, "extra-work");
  expect(value.command(process.execPath, [cli(updated), "install"]).code).toBe(2);
  expect(realpathSync(installedSkill(value.home, "extra-work"))).toBe(realpathSync(foreign));
});

test("invalid skill metadata fails before installing any of the bundle", () => {
  const value = fixture();
  const source = bundle(value.root);
  write(join(source, "skills/bad-skill/SKILL.md"), "---\nname: another-name\ndescription: A description\n---\n");
  const result = value.command(process.execPath, [cli(source), "install"]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("matching name and a nonempty description");
  expect(existsSync(installedSkill(value.home, "verify-work"))).toBe(false);
});

test("update uses a linked checkout's current skills and preserves local work", () => {
  const value = fixture();
  const source = bundle(value.root);
  value.run("git", ["init", "--quiet"], source);
  skill(source, "new-work");
  write(join(source, "local-notes.txt"), "Uncommitted work\n");
  const before = value.run("git", ["status", "--porcelain"], source);
  const result = value.command(process.execPath, [cli(source), "update"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("current linked checkout");
  expect(realpathSync(installedSkill(value.home, "new-work"))).toBe(realpathSync(join(source, "skills/new-work")));
  expect(value.run("git", ["status", "--porcelain"], source)).toBe(before);
  expect(readFileSync(join(source, "local-notes.txt"), "utf8")).toBe("Uncommitted work\n");
});

async function gitServer(value) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--verbose", "--listen=127.0.0.1", `--port=${port}`, `--base-path=${value.root}`], {
    cwd: value.root, env: value.env, stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => { daemon.kill(); reject(new Error(`Git server did not start: ${output}`)); }, 5000);
    daemon.once("error", error => { clearTimeout(timeout); reject(error); });
    daemon.once("exit", code => { clearTimeout(timeout); reject(new Error(`Git server exited ${code}: ${output}`)); });
    daemon.stderr.on("data", chunk => {
      output += chunk;
      if (output.includes("Ready to rumble")) { clearTimeout(timeout); resolve(); }
    });
  });
  return { url: `git://127.0.0.1:${port}/source`, async close() {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const closed = once(daemon, "close");
    daemon.kill();
    await closed;
  } };
}

test("a Git package update fetches new skills and runs the updated installer, while failed updates do not register skills", async () => {
  const value = fixture();
  const source = bundle(value.root, "source");
  write(join(source, ".gitignore"), ".DS_Store\n");
  value.run("git", ["init", "--quiet", "--initial-branch=main"], source);
  function commit(message) {
    value.run("git", ["add", "."], source);
    value.run("git", ["-c", "user.name=Groundwork Test", "-c", "user.email=groundwork@example.test", "commit", "-qm", message], source);
  }
  commit("Initial package");
  const server = await gitServer(value);
  try {
    expect(value.run(process.execPath, ["pm", "bin", "--global"])).toBe(value.env.BUN_INSTALL_BIN);
    value.run(process.execPath, ["add", "--global", `${server.url}#main`]);
    const executable = join(value.env.BUN_INSTALL_BIN, "groundwork");
    value.run(executable, ["install"]);
    expect(existsSync(installedSkill(value.home, "new-work"))).toBe(false);
    skill(source, "new-work");
    write(cli(source), readFileSync(cli(source), "utf8").replace(
      "const skills = installSkills(packageRoot);",
      'writeFileSync(join(home, "updated-installer.txt"), "updated installer ran");\n  const skills = installSkills(packageRoot);',
    ));
    commit("Add another skill without changing the package version");
    const consumer = join(value.root, "consumer");
    write(join(consumer, "package.json"), '{"name":"consumer","dependencies":{}}\n');
    const consumerBefore = readFileSync(join(consumer, "package.json"), "utf8");
    value.run(executable, ["update"], consumer);
    expect(readFileSync(join(value.home, "updated-installer.txt"), "utf8")).toBe("updated installer ran");
    expect(readFileSync(join(installedSkill(value.home, "new-work"), "SKILL.md"), "utf8")).toContain("name: new-work");
    expect(readFileSync(join(consumer, "package.json"), "utf8")).toBe(consumerBefore);
    const installed = join(value.env.BUN_INSTALL_GLOBAL_DIR, "node_modules/@darylcecile/groundwork");
    skill(installed, "not-registered");
    renameSync(join(source, ".git"), join(source, "unavailable-git"));
    const failed = value.command(executable, ["update"], consumer);
    expect(failed.code).toBe(2);
    expect(failed.output).toContain("Package update failed");
    expect(existsSync(installedSkill(value.home, "not-registered"))).toBe(false);
  } finally {
    await server.close();
  }
}, 30000);
