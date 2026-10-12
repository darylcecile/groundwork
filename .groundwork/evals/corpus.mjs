import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { definitions } from "./cases.mjs";
import { fixtureFiles } from "./fixtures.mjs";
import { outcomeChecks } from "./checks.mjs";

export const suite = {
  id: "groundwork-skills-v1",
  version: 1,
  cases: definitions.map(({ id, family, split, skill, activation, shouldActivate, smoke, readOnly, noCommands, prompt, fixture, provenance, rubric, reference }) =>
    ({ id, family, split, skill, activation, shouldActivate, smoke, readOnly, noCommands, prompt, fixture, provenance, rubric, reference })),
};

function definition(id) {
  const found = definitions.find(item => item.id === id);
  if (!found) throw new Error(`Unknown Groundwork evaluation case: ${id}`);
  return found;
}

function writeFiles(directory, files) {
  const root = resolve(directory);
  for (const [path, bytes] of Object.entries(files)) {
    const full = join(root, path);
    // Fixture paths are authored, but reject symlink redirection in an edited candidate.
    let ancestor = full;
    while (ancestor !== dirname(root)) {
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error(`Refusing symlink fixture path: ${ancestor}`);
      ancestor = dirname(ancestor);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
}

export function materializeCase(id, directory) {
  const spec = definition(id);
  if (existsSync(directory) && readdirSync(directory).length) throw new Error("Materialize into an empty directory to avoid overwriting project work");
  writeFiles(directory, fixtureFiles(spec.fixtureKey, spec.variant));
}

export async function checkCase(id, directory, options = {}) {
  return outcomeChecks(definition(id), resolve(directory), options);
}

export function applyReference(id, directory) {
  const spec = definition(id);
  if (!existsSync(directory)) throw new Error("Materialize the candidate project before applying a reference");
  if (!spec.readOnly) {
    const original = fixtureFiles(spec.fixtureKey, spec.variant);
    const corrected = fixtureFiles(spec.fixtureKey, spec.variant, true);
    writeFiles(directory, Object.fromEntries(Object.entries(corrected).filter(([path, bytes]) => original[path] !== bytes)));
  }
  return spec.answer || spec.reference.split("\n\n").slice(1).join("\n\n");
}
