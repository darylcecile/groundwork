import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensure(value, message) {
  if (!value) throw new Error(message);
}

export const readJSON = path => JSON.parse(readFileSync(path, "utf8"));
export const digest = value => createHash("sha256").update(typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value)).digest("hex");

export function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function files(root, prefix = "") {
  const result = [];
  for (const entry of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${entry}` : entry;
    const stat = lstatSync(join(root, path));
    ensure(!stat.isSymbolicLink(), `Symbolic links are not supported in frozen inputs: ${path}`);
    if (stat.isDirectory()) result.push(...files(root, path));
    else if (stat.isFile()) result.push(path);
  }
  return result;
}

export function inventory(root) {
  return Object.fromEntries(files(root).map(path => [path, digest(readFileSync(join(root, path)))]));
}

export function checkInventory(root, expected) {
  return Object.entries(expected).every(([path, hash]) => {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) return false;
    try { return digest(readFileSync(join(root, path))) === hash; }
    catch { return false; }
  });
}

export function seededRandom(seed) {
  let state = Number.parseInt(digest(String(seed)).slice(0, 8), 16);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function shuffled(values, seed) {
  const result = [...values];
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export async function command(program, args, { cwd, env = process.env, timeoutMs = 120000, log, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    const stop = () => {
      try { process.kill(-processHandle.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") reject(error); }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const receive = data => {
      bytes += data.length;
      if (bytes > maxBytes) { overflow = true; stop(); }
      else output += data.toString();
    };
    processHandle.stdout.on("data", receive);
    processHandle.stderr.on("data", receive);
    processHandle.on("error", error => { clearTimeout(timer); reject(error); });
    processHandle.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        if (log) { mkdirSync(dirname(log), { recursive: true }); writeFileSync(log, output); }
        resolve({ code, signal, output, timedOut, overflow });
      } catch (error) { reject(error); }
    });
  });
}

export async function concurrent(items, limit, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await operation(items[next++]);
  }));
}
