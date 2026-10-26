import { lstatSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

function stamp(path: string) {
  try {
    const info = lstatSync(path);
    return `${info.ino}:${info.mtimeMs}:${info.size}:${info.isSymbolicLink()}`;
  } catch { return "missing"; }
}

function treeStamp(path: string): string {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return stamp(path);
    return `${stamp(path)}[${readdirSync(path).sort().map(name => `${name}:${treeStamp(join(path, name))}`).join("|")}]`;
  } catch { return "unavailable"; }
}

export function watchProject(root: string, intervalMs = 1500) {
  const listeners = new Set<() => void>();
  const watched = new Map<string, { identity: string; watcher: FSWatcher | null; snapshot: string }>();
  const tracked = new Map<string, string>();
  const fileStamp = (path: string) => {
    try {
      const target = realpathSync(path);
      if (!target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return "outside";
      return `${target}:${stamp(target)}`;
    } catch { return "missing"; }
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const change = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { for (const listener of listeners) listener(); }, 75);
  };
  let legacyConfig = stamp(join(root, "verify.json"));
  let wasAvailable: boolean | undefined;
  const update = () => {
    let available = false;
    try { available = realpathSync(root) === root; } catch { /* The project may have been removed. */ }
    if (wasAvailable !== undefined && wasAvailable !== available) change();
    wasAvailable = available;
    if (!available) {
      for (const entry of watched.values()) entry.watcher?.close();
      watched.clear();
      return;
    }
    for (const name of [".groundwork", ".verify"]) {
      const path = join(root, name);
      let identity = "missing";
      try {
        const info = lstatSync(path);
        if (info.isDirectory() && !info.isSymbolicLink()) identity = String(info.ino);
      } catch { /* The next poll notices a newly created storage directory. */ }
      let current = watched.get(path);
      if (current?.identity !== identity) {
        if (current) { current.watcher?.close(); change(); }
        current = { identity, watcher: null, snapshot: "" };
        watched.set(path, current);
        if (identity !== "missing") {
          try {
            current.watcher = watch(path, { recursive: true }, change);
            const entry = current;
            current.watcher.on("error", () => { entry.watcher?.close(); entry.watcher = null; change(); });
          } catch { /* Poll this small storage tree on platforms without recursive watching. */ }
        }
      }
      if (current && !current.watcher && identity !== "missing") {
        const snapshot = treeStamp(path);
        if (current.snapshot && current.snapshot !== snapshot) change();
        current.snapshot = snapshot;
      }
    }
    const next = stamp(join(root, "verify.json"));
    if (next !== legacyConfig) { legacyConfig = next; change(); }
    for (const [path, previous] of tracked) {
      const current = fileStamp(path);
      if (current !== previous) { tracked.set(path, current); change(); }
    }
  };
  update();
  const poll = setInterval(update, intervalMs);
  return {
    track(path: string) { const file = join(root, path); if (!tracked.has(file)) tracked.set(file, fileStamp(file)); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { clearInterval(poll); clearTimeout(debounce); for (const entry of watched.values()) entry.watcher?.close(); listeners.clear(); tracked.clear(); },
  };
}
