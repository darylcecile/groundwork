import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

test("the distributed CLI installs its skills with references that resolve through their installed paths", () => {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-package-"));
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const home = join(root, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, COPILOT_HOME: join(home, ".copilot"), XDG_CONFIG_HOME: join(home, ".config") };
  function run(command, args, cwd = repository, environment = process.env) {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stdout}${result.stderr}`);
    return result.stdout;
  }
  try {
    run(process.execPath, ["pm", "pack", "--filename", join(root, "groundwork.tgz"), "--quiet"]);
    run("tar", ["-xzf", join(root, "groundwork.tgz"), "-C", root]);
    const packaged = join(root, "package");
    const manifest = JSON.parse(readFileSync(join(packaged, "package.json"), "utf8"));
    run(process.execPath, [join(packaged, manifest.bin.groundwork), "install"], root, env);
    for (const entry of readdirSync(join(packaged, "skills"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(packaged, "skills", entry.name, "SKILL.md"))) continue;
      const skill = join(home, ".agents", "skills", entry.name);
      const instructions = readFileSync(join(skill, "SKILL.md"), "utf8");
      expect(instructions.trim().length).toBeGreaterThan(0);
      const references = [...instructions.matchAll(/\]\(([^)]+)\)/g)]
        .map(match => match[1]).filter(path => !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("#"));
      for (const reference of references) {
        const path = resolve(skill, reference.split("#")[0]);
        expect(path.startsWith(`${skill}${sep}`)).toBe(true);
        expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0);
      }
    }
    const help = run(process.execPath, [join(home, ".agents/skills/verify-work/verify.mjs"), "--help"], root, env);
    expect(help).toContain("groundwork verify");
    expect(help).toContain("groundwork view report");
    expect(help).toContain("groundwork map [feature]");
    const project = join(root, "project");
    mkdirSync(project);
    run(process.execPath, [join(home, ".agents/skills/verify-work/verify.mjs"), "init"], project, env);
    expect(readdirSync(project).sort()).toEqual([".groundwork", "AGENTS.md"]);
    expect(JSON.parse(readFileSync(join(project, ".groundwork/verify.json"), "utf8"))).toEqual({ checks: {} });
    expect(readFileSync(join(project, ".groundwork/VERIFY.md"), "utf8").trim().length).toBeGreaterThan(0);
    writeFileSync(join(project, ".groundwork/verify.json"), JSON.stringify({ checks: {}, behaviours: {
      saving: { description: "Save a document", paths: ["src/save.mjs"], dependsOn: ["storage"] },
      storage: { description: "Store a document" },
    } }));
    const map = run(process.execPath, [join(home, ".agents/skills/verify-work/verify.mjs"), "map", "saving"], project, env);
    expect(map).toContain("Feature map: saving");
    expect(map).toContain("[saving] -> [storage]");
    expect(map).toContain("Implementation paths: src/save.mjs");
    expect(existsSync(join(project, ".groundwork/runs"))).toBe(false);
    expect(existsSync(join(project, ".groundwork/latest"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
