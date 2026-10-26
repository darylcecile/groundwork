import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const portalService = "groundwork-portal";
export const portalProtocol = 2;
export const ciVariables = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD",
  "BUILDKITE", "CIRCLECI", "TRAVIS", "APPVEYOR", "TEAMCITY_VERSION", "JENKINS_URL", "BUILD_ID",
  "BITBUCKET_BUILD_NUMBER", "CODEBUILD_BUILD_ID", "DRONE", "SEMAPHORE", "NETLIFY", "VERCEL"];
const enabled = value => Boolean(value && !["0", "false", "no", "off"].includes(value.trim().toLowerCase()));

export function shouldStartPortal(env = process.env) {
  return env.GROUNDWORK_PORTAL !== "0" && !env.GROUNDWORK_EVIDENCE_DIR && !ciVariables.some(key => enabled(env[key]));
}

export function portalStateDirectory() {
  return resolve(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "groundwork/portal");
}

export function portalPorts(scope = portalStateDirectory()) {
  const base = 40000 + createHash("sha256").update(scope).digest().readUInt32BE(0) % 15000;
  return Array.from({ length: 8 }, (_, index) => base + index);
}

export const portalURL = port => `http://127.0.0.1:${port}`;

function removePortalOwner(lock, owner) {
  try { unlinkSync(join(lock, owner)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  try { rmdirSync(lock); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
}

function retireStoppedOwner(lock) {
  let entries;
  try { entries = readdirSync(lock); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (entries.length !== 1) return;
  const owner = entries[0];
  const match = /^(\d+)-[a-f0-9-]{36}$/.exec(owner);
  if (!match || Number(match[1]) <= 1) return;
  try { process.kill(Number(match[1]), 0); }
  catch (error) { if (error.code === "ESRCH") removePortalOwner(lock, owner); }
}

// Publish an already-populated directory atomically. A stale owner's unique marker
// can be removed without removing a successor's marker, even during concurrent recovery.
export function claimPortal(scope) {
  mkdirSync(scope, { recursive: true });
  const lock = join(scope, "daemon.lock");
  const pending = mkdtempSync(join(scope, ".daemon-"));
  const owner = `${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(join(pending, owner), "", { mode: 0o600 });
    try { renameSync(pending, lock); }
    catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      retireStoppedOwner(lock);
      return null;
    }
  } finally { rmSync(pending, { recursive: true, force: true }); }
  let released = false;
  return {
    preferredPort() {
      try { return Number(readFileSync(join(scope, "port"), "utf8").trim()); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    },
    recordPort(port) {
      const temporary = join(scope, `.port-${owner}`);
      try {
        writeFileSync(temporary, `${port}\n`, { mode: 0o600 });
        renameSync(temporary, join(scope, "port"));
      } finally { rmSync(temporary, { force: true }); }
    },
    release() {
      if (released) return;
      released = true;
      removePortalOwner(lock, owner);
    },
  };
}

export function portalBuild(path) {
  const entry = realpathSync(path);
  const hash = createHash("sha256").update(entry).update("\0").update(readFileSync(entry));
  for (const asset of ["public/index.html", "public/assets/app.js", "public/assets/app.css"]) {
    hash.update(`\0${asset}\0`);
    try {
      const content = readFileSync(join(dirname(entry), asset));
      hash.update("present\0").update(content);
    }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("missing\0");
    }
  }
  return hash.digest("hex");
}

export async function portalHealth(scope, port) {
  try {
    const response = await fetch(`${portalURL(port)}/api/health`, { signal: AbortSignal.timeout(200), redirect: "error" });
    if (!response.ok) return null;
    const value = await response.json();
    return value.service === portalService && value.scope === scope && value.protocol === portalProtocol &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && /^[a-f0-9]{64}$/.test(value.build) ? value : null;
  } catch { return null; }
}

export async function probePortal(scope, port) { return Boolean(await portalHealth(scope, port)); }

async function runningPortal(scope, ports, build) {
  const matches = await Promise.all(ports.map(port => portalHealth(scope, port)));
  return ports.find((_, index) => matches[index]?.build === build);
}

async function launchPortal(scope, entry, ports, build) {
  const previous = await Promise.all(ports.map(port => portalHealth(scope, port)));
  const preferred = ports.find((_, index) => previous[index] && previous[index].build !== build);
  for (const health of previous) {
    if (!health || health.pid <= 1 || health.pid === process.pid || health.build === build) continue;
    try { process.kill(health.pid, "SIGTERM"); } catch { /* A stopped or inaccessible process cannot block the CLI. */ }
  }
  mkdirSync(scope, { recursive: true });
  const child = spawn(process.execPath, [entry, scope, ...(preferred ? [String(preferred)] : [])], { cwd: scope, detached: true, stdio: "ignore" });
  let failed = false;
  child.once("error", () => { failed = true; });
  child.unref();
  const deadline = Date.now() + 2500;
  while (!failed && Date.now() < deadline) {
    const port = await runningPortal(scope, ports, build);
    if (port) return port;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

export async function ensurePortal(directory) {
  if (!shouldStartPortal()) return null;
  try {
    const root = realpathSync(directory);
    const entry = fileURLToPath(new URL("../portal/dist/server.js", import.meta.url));
    if (!existsSync(entry)) return null;
    const build = portalBuild(entry);
    const scope = portalStateDirectory();
    const ports = portalPorts(scope);
    const port = await runningPortal(scope, ports, build) || await launchPortal(scope, entry, ports, build);
    if (!port) return null;
    const response = await fetch(`${portalURL(port)}/api/projects`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root }), signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const { project } = await response.json();
    if (project?.root !== root || project.available !== true || !/^[a-f0-9]{24}$/.test(project.id)) return null;
    const url = `${portalURL(port)}/?project=${project.id}`;
    return url;
  } catch { return null; } // Viewing evidence must never change a command's result or exit status.
}
