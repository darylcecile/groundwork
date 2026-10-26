import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

async function bundle(entry: string, target: "browser" | "bun"): Promise<Record<string, string>> {
  const result = await Bun.build({
    entrypoints: [join(root, entry)], target, minify: true,
    splitting: target === "browser",
    naming: { entry: target === "browser" ? "app.js" : "server.js", chunk: "chunk-[hash].js" },
    define: target === "browser" ? { "process.env.NODE_ENV": '"production"' } : {},
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
  return Object.fromEntries(await Promise.all(result.outputs.map(async file => [basename(file.path), await file.text()] as const)));
}

async function styles() {
  const child = Bun.spawn([process.execPath, join(root, "node_modules/.bin/tailwindcss"),
    "-i", join(root, "portal/ui/styles.css"), "--minify"], {
    cwd: root, stdout: "pipe", stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Could not build the portal styles");
  return output;
}

async function licenses() {
  const names = new Set<string>();
  async function collect(name: string) {
    if (names.has(name) || name.startsWith("@types/")) return;
    names.add(name);
    const manifest = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies || {})) await collect(dependency);
  }
  for (const name of ["hono", "react", "react-dom", "tailwindcss", "marked", "@xyflow/react", "@dagrejs/dagre"]) await collect(name);
  return (await Promise.all([...names].sort().map(async name => {
    const directory = join(root, "node_modules", name);
    const file = (await readdir(directory)).find(path => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(path));
    if (!file) throw new Error(`License notice missing for ${name}`);
    return `${name}\n${await readFile(join(directory, file), "utf8")}`;
  }))).join("\n\n");
}

const [client, server, css, html, notices] = await Promise.all([
  bundle("portal/ui/main.tsx", "browser"), bundle("portal/server.ts", "bun"), styles(),
  readFile(join(root, "portal/index.html"), "utf8"), licenses(),
]);
const outputs: Record<string, string> = {
  ...Object.fromEntries(Object.entries(client).map(([name, content]) => [`public/assets/${name}`, content])),
  "public/assets/app.css": css,
  "public/index.html": html, ...server, "THIRD_PARTY_LICENSES.txt": notices,
};
const assets = join(root, "portal/dist/public/assets");
for (const name of await readdir(assets).catch(() => [])) {
  if (!/^chunk-.*\.js$/.test(name) || `public/assets/${name}` in outputs) continue;
  if (check) throw new Error(`Unused bundle ${name}. Run bun run build:portal.`);
  await unlink(join(assets, name));
}
for (const [name, content] of Object.entries(outputs)) {
  const path = join(root, "portal/dist", name);
  if (check) {
    const saved = await readFile(path, "utf8").catch(() => null);
    if (saved !== content) throw new Error(`${name} is out of date. Run bun run build:portal.`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
console.log(check ? "Portal build is up to date." : "Built portal server and browser assets.");
