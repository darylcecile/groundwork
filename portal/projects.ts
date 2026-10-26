import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { DataError } from "./data";
import type { Project, ProjectsResponse } from "./types";

type SavedProject = Omit<Project, "available">;

function projectFor(root: string): SavedProject {
  return { id: createHash("sha256").update(root).digest("hex").slice(0, 24), name: basename(root) || root, root };
}

function available(root: string) {
  try {
    accessSync(root, constants.R_OK | constants.X_OK);
    return realpathSync(root) === root && statSync(root).isDirectory();
  } catch { return false; }
}

export function createProjects(scope: string) {
  const path = join(scope, "projects.json");
  const projects = new Map<string, SavedProject>();
  const problems: string[] = [];
  let writable = true;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(saved.projects)) throw new Error("Expected a project list.");
    for (const entry of saved.projects) {
      if (typeof entry?.root !== "string" || !isAbsolute(entry.root) || resolve(entry.root) !== entry.root) {
        problems.push("An invalid saved project was skipped.");
        writable = false;
        continue;
      }
      const project = projectFor(entry.root);
      projects.set(project.id, project);
    }
  } catch (error) {
    let absent = false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { lstatSync(path); }
      catch (missing) { absent = (missing as NodeJS.ErrnoException).code === "ENOENT"; }
    }
    if (!absent) {
      writable = false;
      problems.push(`Could not read the project list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function save(project: SavedProject) {
    if (!writable) throw new DataError("The saved project list could not be fully read. Registration cannot overwrite it.");
    mkdirSync(scope, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ projects: [...projects.values(), project] }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }

  return {
    list(): ProjectsResponse {
      const entries = [...projects.values()].map(project => ({ ...project, available: available(project.root) }));
      return { projects: entries, problems: [...problems, ...entries.filter(project => !project.available).map(project => `Project unavailable: ${project.root}`)] };
    },
    get(id: string): Project {
      const project = projects.get(id);
      if (!project) throw new DataError("Project not found.", 404);
      if (!available(project.root)) throw new DataError(`Project unavailable: ${project.root}`, 404);
      return { ...project, available: true };
    },
    register(root: unknown) {
      if (typeof root !== "string" || !isAbsolute(root)) throw new DataError("An absolute project directory is required.");
      let canonical: string;
      try { canonical = realpathSync(root); }
      catch { throw new DataError("The project directory is unavailable."); }
      if (!available(canonical)) throw new DataError("The project directory is unavailable.");
      const project = projectFor(canonical);
      if (!projects.has(project.id)) { save(project); projects.set(project.id, project); }
      return { ...project, available: true };
    },
  };
}
