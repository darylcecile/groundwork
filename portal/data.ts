import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { catalogue, catalogueIssues, configPath, loadConfig } from "../lib/config.mjs";
import { assess, context, coverage, ensure, object, statuses, validateAssessment, validateCheck, validatePlan } from "../lib/model.mjs";
import type { CatalogueResponse, Check, Counts, EvidenceFile, GuideResponse, Measurement, Observation, Report, RunResponse, RunSummary, RunsResponse, Stage, Storage, Trial } from "./types";

// The shared JavaScript assessment's empty-array defaults otherwise infer never[] in TypeScript.
const assessSaved = assess as (value: Partial<Report>) => Pick<Report, "status">;

export class DataError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) { super(message); }
}

const storages: Storage[] = ["groundwork", "verify"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

export function relativeFile(path: string) {
  return path.length > 0 && !isAbsolute(path) && !/[\\\0]/.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== "..");
}

// Resolve both boundaries on every read: a replaced storage directory must not escape the project.
export function containedFile(root: string, path: string) {
  if (!relativeFile(path)) throw new DataError("Invalid file path.");
  if (realpathSync(root) !== root) throw new DataError("The directory was replaced by a symbolic link.");
  const target = realpathSync(resolve(root, path));
  if (!target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) throw new DataError("The file leaves its directory.");
  return target;
}

function directory(root: string, path: string) {
  const target = containedFile(root, path);
  if (target !== join(root, path) || !statSync(target).isDirectory()) {
    throw new DataError(`Expected a directory without symbolic links: ${path}`);
  }
  return target;
}

export function runDirectory(root: string, storage: string, id: string) {
  if (!storages.includes(storage as Storage) || !validId(id)) throw new DataError("Invalid run identifier.");
  try { return directory(root, `.${storage}/runs/${id}`); }
  catch (error) {
    if (missing(error)) throw new DataError("Run not found.", 404);
    throw error;
  }
}

export function evidencePath(root: string, storage: string, id: string, path: string) {
  const base = runDirectory(root, storage, id);
  try {
    const file = containedFile(base, path);
    if (!statSync(file).isFile()) throw new DataError("Not a regular file.");
    return file;
  } catch (error) {
    if (missing(error)) throw new DataError("File not found.", 404);
    throw error;
  }
}

const fileKinds: [EvidenceFile["type"], string[]][] = [
  ["image", [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"]],
  ["video", [".mp4", ".webm", ".mov", ".m4v", ".ogv"]],
  ["audio", [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]],
  ["pdf", [".pdf"]],
  ["text", [".txt", ".log", ".json", ".jsonl", ".md", ".markdown", ".csv", ".tsv", ".yaml", ".yml", ".xml", ".html", ".htm", ".svg", ".js", ".mjs", ".ts", ".tsx", ".css", ".sh"]],
];

export function fileType(path: string): EvidenceFile["type"] {
  return fileKinds.find(([, extensions]) => extensions.includes(extname(path).toLowerCase()))?.[0] || "file";
}

function filesIn(base: string, problems: string[], prefix = ""): EvidenceFile[] {
  const files: EvidenceFile[] = [];
  const location = prefix ? containedFile(base, prefix) : base;
  for (const entry of readdirSync(location, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    try {
      const target = containedFile(base, path);
      const info = statSync(target);
      if (info.isDirectory() && !entry.isSymbolicLink()) files.push(...filesIn(base, problems, path));
      if (info.isFile()) files.push({ path, name: entry.name, size: info.size, modifiedAt: info.mtimeMs, type: fileType(path) });
    } catch (error) { problems.push(`${path}: ${message(error)}`); }
  }
  return files;
}

function optionalFields(value: object, texts: string[], numbers: string[] = []) {
  const record = value as Record<string, unknown>;
  ensure(texts.every(key => record[key] == null || typeof record[key] === "string") &&
    numbers.every(key => record[key] == null || Number.isFinite(record[key])), "Invalid saved result metadata.");
}

function sourceIdentity(value: Report["source"]) {
  if (value === undefined) return;
  ensure(object(value) && (value.revision === null || typeof value.revision === "string") &&
    typeof value.fingerprint === "string" && typeof value.dirty === "boolean", "Invalid saved source identity.");
}

function trials(values: Trial[] = []): Trial[] {
  ensure(Array.isArray(values), "Invalid saved trials.");
  return values.map((trial, index) => {
    ensure(object(trial) && statuses.includes(trial.status), "Invalid saved trial.");
    optionalFields(trial, ["phase", "log", "reason"], ["index", "exitCode", "durationMs"]);
    sourceIdentity(trial.source);
    context(trial.context);
    const stages = trial.stages || [];
    ensure(Array.isArray(stages) && stages.every(stage => object(stage) && typeof stage.phase === "string" && statuses.includes(stage.status)), "Invalid saved trial stages.");
    for (const stage of stages) optionalFields(stage, ["log", "command", "reason"], ["exitCode", "durationMs"]);
    ensure(Array.isArray(trial.artifacts || []) && (trial.artifacts || []).every(item => object(item) && typeof item.path === "string"), "Invalid saved trial artifacts.");
    return { ...trial, index: trial.index ?? index + 1, phase: trial.phase || "candidate", stages,
      observations: observations(trial.observations), artifacts: trial.artifacts || [],
      measurements: measurements(trial.measurements), metrics: measurements(trial.metrics), problems: problems(trial.problems) };
  });
}

function observations(values: Observation[] = []): Observation[] {
  validateAssessment({ plan: null, checks: [], observations: values, problems: [], status: "inconclusive" });
  for (const value of values) optionalFields(value, ["producer", "check"], ["trial"]);
  return values;
}

function problems(values: string[] = []) {
  ensure(Array.isArray(values) && values.every(value => typeof value === "string"), "Invalid saved problems.");
  return values;
}

function measurements(values: Measurement[] = []): Measurement[] {
  ensure(Array.isArray(values) && values.every(value => object(value) && typeof value.name === "string" &&
    (value.status === undefined || statuses.includes(value.status)) && (value.unit === undefined || typeof value.unit === "string")), "Invalid saved measurements.");
  for (const value of values) optionalFields(value, ["reason"], ["value", "min", "max", "baseline", "candidate", "regressionPercent", "maxRegressionPercent"]);
  return values;
}

function checks(values: Check[]): Check[] {
  return values.map(check => {
    validateCheck(check);
    optionalFields(check, ["reason", "kind"]);
    context(check.context);
    if (check.comparison) measurements(check.comparison.measurements);
    return { ...check, covers: check.covers || [], artifacts: check.artifacts || [], observations: observations(check.observations),
      trials: trials(check.trials), baseline: trials(check.baseline), measurements: measurements(check.measurements), problems: problems(check.problems) };
  });
}

interface Saved extends Report {
  version: number;
  id?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  verification?: Report;
  repository?: string;
  pullRequest?: number;
  planning?: Stage;
  setup?: Stage;
  agent?: { summary?: string; execution?: Stage; gaps: string[]; checks: { claim: string; status: string; observed: string; evidence: string[]; covers?: string[] }[] };
}

function prStages(value: Saved): Stage[] {
  return Object.entries({ planning: value.planning, setup: value.setup, checks: value.checks, agent: value.agent?.execution })
    .flatMap(([phase, stage]) => {
      if (!stage) return [];
      ensure(object(stage) && "status" in stage && statuses.includes(stage.status), "Invalid saved PR stage.");
      optionalFields(stage, ["log", "command", "reason"], ["exitCode", "durationMs"]);
      return [{ ...stage, phase } as Stage];
    });
}

function normalized(value: Saved, kind: RunSummary["kind"]): Report {
  ensure(object(value) && [1, 2].includes(value.version), "Invalid saved report version.");
  if (kind === "pr" && value.version === 1) return legacyPR(value);
  const saved = kind === "pr" ? value.verification : value;
  ensure(object(saved), "Missing saved verification assessment.");
  if (!saved) throw new Error("Missing saved verification assessment.");
  if (value.version === 2) validateAssessment(saved);
  ensure(Array.isArray(saved.checks), "Invalid saved checks.");
  const retainedChecks = checks(saved.checks);
  const retainedObservations = observations(saved.observations);
  const plan = saved.plan ? validatePlan(saved.plan) : null;
  const retainedProblems = [...new Set([...problems(saved.problems), ...problems(value.problems), ...problems(value.agent?.gaps)])];
  const selection = value.selection;
  if (selection !== undefined) {
    ensure(object(selection), "Invalid saved check selection.");
    for (const list of [selection.names, selection.omitted, selection.unmappedPaths, selection.uncoveredBehaviours]) problems(list);
    if (selection.reasons !== undefined) {
      ensure(object(selection.reasons), "Invalid saved check selection reasons.");
      for (const list of Object.values(selection.reasons)) problems(list);
    }
  }
  const status = value.status || assessSaved({ plan, checks: retainedChecks, observations: retainedObservations, problems: retainedProblems }).status;
  ensure(statuses.includes(status), "Invalid saved status.");
  return { status, source: value.source, plan, checks: retainedChecks, observations: retainedObservations,
    coverage: coverage(plan, retainedChecks, retainedObservations), problems: retainedProblems, context: context(saved.context),
    omitted: problems(value.omitted || selection?.omitted), selection,
    ...(kind === "pr" ? { stages: prStages(value) } : {}) };
}

function legacyPR(value: Saved): Report {
  ensure(statuses.includes(value.status) && object(value.agent) && Array.isArray(value.agent?.checks), "Invalid saved PR report.");
  optionalFields(value.agent!, ["summary"]);
  // Version 1 PR reports stored configured checks as a single stage rather than a check array.
  const stage = value.checks as unknown as Stage;
  ensure(object(stage) && statuses.includes(stage.status) && typeof stage.log === "string", "Invalid saved PR checks.");
  const observations = value.agent!.checks.map((check, index) => {
    ensure(object(check) && typeof check.claim === "string" && typeof check.observed === "string" && Array.isArray(check.evidence) &&
      check.evidence.every(path => typeof path === "string") && statuses.includes(check.status), "Invalid saved PR observation.");
    return { id: `agent.${index + 1}`, status: check.status, observed: `${check.claim}: ${check.observed}`, covers: problems(check.covers),
      kind: "review", producer: "agent", evidence: check.evidence.map(path => ({ path })) };
  });
  return { status: value.status, source: value.source, plan: null, coverage: [], observations,
    problems: [...problems(value.problems), ...problems(value.agent?.gaps)], stages: prStages(value),
    context: value.agent?.summary ? { agentSummary: value.agent.summary } : {}, checks: [{ name: "configured-checks",
      command: "", expect: "Configured project checks", status: stage.status, log: stage.log!,
      durationMs: stage.durationMs || 0, exitCode: stage.exitCode ?? null, covers: [], artifacts: [], observations: [],
      trials: [], baseline: [], measurements: [], problems: [] }] };
}

function counts(checks: Check[]): Counts {
  return { passed: checks.filter(check => check.status === "passed").length,
    failed: checks.filter(check => check.status === "failed").length,
    inconclusive: checks.filter(check => check.status !== "passed" && check.status !== "failed").length, total: checks.length };
}

function loadRun(root: string, storage: Storage, id: string) {
  const summary: RunSummary = { id, storage, kind: id.startsWith("pr-") ? "pr" : "local", goal: null,
    status: "inconclusive", startedAt: null, finishedAt: null, checks: counts([]) };
  try {
    const base = runDirectory(root, storage, id);
    const path = containedFile(base, "result.json");
    if (!statSync(path).isFile()) throw new Error("Result is not a regular file.");
    const value: Saved = JSON.parse(readFileSync(path, "utf8"));
    ensure(object(value), "Invalid saved report.");
    summary.kind = value.verification || value.repository !== undefined ? "pr" : "local";
    sourceIdentity(value.source);
    if (summary.kind === "local") {
      ensure(value.id === id && typeof value.startedAt === "string" &&
        (value.finishedAt === null || typeof value.finishedAt === "string"), "Invalid saved run identity or timestamps.");
      summary.startedAt = value.startedAt || null;
      summary.finishedAt = value.finishedAt || null;
    }
    const report = normalized(value, summary.kind);
    summary.goal = report.plan?.goal || null;
    // PR envelopes have no completion timestamps. Preserve their saved verdict without inventing dates.
    summary.status = summary.kind === "local" && !summary.finishedAt ? "unfinished" : report.status;
    summary.checks = counts(report.checks);
    return { summary, report };
  } catch (error) {
    summary.error = message(error);
    return { summary, report: null };
  }
}

function latestRun(root: string, runs: RunSummary[], problems: string[]) {
  for (const storage of storages) {
    let base: string;
    try {
      base = directory(root, `.${storage}`);
      lstatSync(join(base, "latest"));
    } catch (error) {
      if (missing(error)) continue;
      problems.push(`.${storage}/latest: ${message(error)}`);
      return null;
    }
    try {
      const path = containedFile(base, "latest");
      if (!statSync(path).isFile()) throw new Error("Latest pointer is not a regular file.");
      const id = readFileSync(path, "utf8").trim();
      if (!validId(id)) {
        problems.push(`.${storage}/latest has an invalid run identifier.`);
        return null;
      }
      if (!runs.some(run => run.storage === storage && run.id === id)) problems.push(`.${storage}/latest does not name an available run.`);
      return `${storage}:${id}`;
    } catch (error) {
      problems.push(`.${storage}/latest: ${message(error)}`);
      return null;
    }
  }
  return null;
}

export function readRuns(root: string): RunsResponse {
  const runs: RunSummary[] = [];
  const problems: string[] = [];
  for (const storage of storages) {
    try {
      const base = directory(root, `.${storage}/runs`);
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) runs.push(loadRun(root, storage, entry.name).summary);
      }
    } catch (error) { if (!missing(error)) problems.push(`.${storage}/runs: ${message(error)}`); }
  }
  runs.sort((a, b) => (b.startedAt || b.id).localeCompare(a.startedAt || a.id));
  return { project: { name: basename(root), root }, latest: latestRun(root, runs, problems), runs, problems };
}

export function readRun(root: string, storage: string, id: string): RunResponse {
  const base = runDirectory(root, storage, id);
  const { summary, report } = loadRun(root, storage as Storage, id);
  const problems = summary.error ? [summary.error] : [];
  let files: EvidenceFile[] = [];
  try { files = filesIn(base, problems).sort((a, b) => a.path.localeCompare(b.path)); }
  catch (error) { problems.push(message(error)); }
  return { summary, report, files, problems };
}

function projectConfig(root: string) {
  const path = containedFile(root, relative(root, configPath(root)).split(sep).join("/"));
  if (!statSync(path).isFile()) throw new DataError("The project configuration is not a regular file.");
  return loadConfig(root);
}

export function readCatalogue(root: string): CatalogueResponse {
  try {
    const config = projectConfig(root);
    const rows = catalogue(config);
    const behaviours = rows.filter(row => row.type === "behaviour").map(row => ({
      id: row.id, description: row.description, paths: row.paths, entry: row.entry, guide: row.guide,
      checks: row.checks, dependsOn: row.dependsOn,
      consumers: Object.entries(config.behaviours).flatMap(([id, entry]) => entry.dependsOn.includes(row.id) ? [id] : []),
    }));
    const invariants = rows.filter(row => row.type === "invariant").map(row => ({
      id: row.id, description: row.description, paths: row.paths, guide: row.guide, checks: row.checks,
    }));
    const checks = Object.entries(config.checks).map(([id, check]) => ({ id, expect: check.expect,
      command: check.command, kind: check.kind, required: check.required, covers: check.covers }));
    return { behaviours, invariants, checks, problems: catalogueIssues(config, root, rows.map(row => row.id)) };
  } catch (error) {
    if (missing(error)) {
      try { lstatSync(configPath(root)); }
      catch (absent) {
        if (missing(absent)) return { behaviours: [], invariants: [], checks: [],
          problems: ["No project verification configuration found. Run groundwork init to create one."] };
      }
    }
    throw new DataError(`Could not read the project catalogue: ${message(error)}`);
  }
}

export function readGuide(root: string, requested: string): GuideResponse {
  const path = requested.split("#")[0] || "";
  if (!/\.(md|markdown)$/i.test(path)) throw new DataError("Only project Markdown documents can be previewed here.");
  const file = containedFile(root, path);
  if (!statSync(file).isFile()) throw new DataError("Guide not found.", 404);
  return { path, content: readFileSync(file, "utf8") };
}
