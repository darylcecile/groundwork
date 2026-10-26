import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { portalHealth, portalPorts, portalURL } from "../lib/portal.mjs";

test("the distributed CLI installs its skills and serves the bundled portal without build dependencies", async () => {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-package-"));
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const home = join(root, "home");
  let server;
  mkdirSync(home);
  const env = { ...process.env, GROUNDWORK_PORTAL: "0", HOME: home, COPILOT_HOME: join(home, ".copilot"), XDG_CONFIG_HOME: join(home, ".config") };
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
    const scope = join(realpathSync(home), ".cache", "groundwork", "portal");
    mkdirSync(scope, { recursive: true });
    server = spawn(process.execPath, [join(packaged, "portal/dist/server.js"), scope], {
      cwd: home, env, stdio: "ignore",
    });
    let port;
    const deadline = Date.now() + 3000;
    while (!port) {
      const ports = portalPorts(scope);
      const health = await Promise.all(ports.map(port => portalHealth(scope, port)));
      port = ports.find((_, index) => health[index]?.pid === server.pid);
      if (port) break;
      if (server.exitCode !== null || Date.now() >= deadline) throw new Error("The distributed portal did not start");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const url = portalURL(port);
    const pageResponse = await fetch(url);
    expect(pageResponse.headers.get("Content-Type")).toContain("text/html");
    const page = await pageResponse.text();
    expect(page).toContain("/assets/app.js");
    for (const asset of ["app.js", "app.css"]) {
      const response = await fetch(`${url}/assets/${asset}`);
      expect(response.ok).toBe(true);
      expect(response.headers.get("Content-Type")).toContain(asset.endsWith("css") ? "text/css" : "javascript");
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    async function register(root) {
      const response = await fetch(`${url}/api/projects`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root }),
      });
      expect(response.ok).toBe(true);
      return (await response.json()).project;
    }
    const registered = await register(project);
    const second = join(root, "another-project");
    mkdirSync(second);
    const another = await register(second);
    const projects = await fetch(`${url}/api/projects`).then(response => response.json());
    expect(projects.projects.map(item => item.id).sort()).toEqual([registered.id, another.id].sort());
    const catalogue = await fetch(`${url}/api/projects/${registered.id}/catalogue`).then(response => response.json());
    expect(catalogue.behaviours.find(item => item.id === "saving").dependsOn).toEqual(["storage"]);
    expect(catalogue.behaviours.find(item => item.id === "storage").consumers).toEqual(["saving"]);
    const empty = await fetch(`${url}/api/projects/${another.id}/runs`).then(response => response.json());
    expect(empty.project.root).toBe(realpathSync(second));
    expect(empty.runs).toEqual([]);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "close");
      server.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
