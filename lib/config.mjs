import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, matchesGlob, relative, sep } from "node:path";
import { ensure, object, text, safePath, readJSON } from "./model.mjs";
import { groundworkPath, pathExists } from "./layout.mjs";

const checkFields = [
  "command", "expect", "required", "artifacts", "paths", "covers", "kind", "setup",
  "cleanup", "result", "repeat", "metrics", "compare", "context",
];
const kinds = ["command", "ui", "api", "workflow", "agent", "performance", "constraint"];

function fields(value, allowed, label) {
  ensure(object(value), `${label} must be an object.`);
  for (const key of Object.keys(value)) ensure(allowed.includes(key), `${label}: unknown field "${key}".`);
}

function list(value, predicate, message) {
  const items = value === undefined ? [] : value;
  ensure(Array.isArray(items) && items.every(predicate), message);
  return [...items];
}

function localFile(value) {
  return safePath(value) && !value.includes("\0") && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function context(value, label) {
  if (value === undefined) return {};
  ensure(object(value), `${label} must be an object of declared non-secret scalar metadata.`);
  for (const [key, item] of Object.entries(value)) {
    ensure(text(key), `${label}: metadata names must be nonempty strings.`);
    ensure(item === null || typeof item === "string" || typeof item === "boolean" || Number.isFinite(item),
      `${label}.${key} must be a string, finite number, boolean, or null.`);
  }
  return { ...value };
}

function guideReference(value, label) {
  const message = `${label} must be a safe relative Markdown file, optionally followed by #anchor.`;
  ensure(text(value), message);
  const [file, fragment, ...extra] = value.split("#");
  ensure(localFile(file) && /\.(md|markdown)$/i.test(file) && extra.length === 0, message);
  if (fragment === undefined) return { file };
  ensure(text(fragment) && !/\s/.test(fragment), message);
  try {
    return { file, anchor: decodeURIComponent(fragment) };
  } catch {
    throw new Error(message);
  }
}

function metrics(value, label) {
  if (value === undefined) return {};
  ensure(object(value), `${label} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([name, metric]) => {
    const location = `${label}.${name}`;
    ensure(text(name), `${label}: metric names must be nonempty strings.`);
    fields(metric, ["unit", "min", "max", "maxRegressionPercent", "direction"], location);
    ensure(text(metric.unit), `${location}.unit must be a nonempty string.`);
    for (const key of ["min", "max", "maxRegressionPercent"]) {
      ensure(metric[key] === undefined || Number.isFinite(metric[key]), `${location}.${key} must be a finite number.`);
    }
    ensure(metric.min === undefined || metric.max === undefined || metric.min <= metric.max, `${location}: min must not exceed max.`);
    ensure(metric.maxRegressionPercent === undefined || metric.maxRegressionPercent >= 0, `${location}.maxRegressionPercent must be nonnegative.`);
    ensure(metric.direction === undefined || ["lower", "higher"].includes(metric.direction), `${location}.direction must be lower or higher.`);
    return [name, { ...metric }];
  }));
}

function entries(value, type, label) {
  if (value === undefined) return {};
  ensure(object(value), `${label} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([id, entry]) => {
    const location = `${label}.${id}`;
    ensure(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id), `${label}: entry IDs must use letters, numbers, dots, dashes, underscores, or colons.`);
    fields(entry, ["description", "paths", "guide", type === "behaviour" ? "entry" : "checks"], location);
    ensure(text(entry.description), `${location}.description must be a nonempty string.`);
    const paths = list(entry.paths, text, `${location}.paths must be an array of nonempty glob strings.`);
    if (entry.guide !== undefined) guideReference(entry.guide, `${location}.guide`);
    if (type === "behaviour") {
      ensure(entry.entry === undefined || typeof entry.entry === "string", `${location}.entry must be a string.`);
      return [id, { ...entry, paths }];
    }
    ensure(Array.isArray(entry.checks) && entry.checks.length > 0 && entry.checks.every(text), `${location}.checks must be a nonempty array of check IDs.`);
    return [id, { ...entry, paths, checks: [...new Set(entry.checks)] }];
  }));
}

export function configPath(root) {
  const canonical = groundworkPath(root, "verify.json");
  const legacy = join(root, "verify.json");
  return pathExists(canonical) || !pathExists(legacy) ? canonical : legacy;
}

export function parseConfig(value, root) {
  const source = root ? configPath(root) : ".groundwork/verify.json";
  fields(value, ["checks", "behaviours", "invariants", "context"], source);
  ensure(object(value.checks), `${source}.checks must be an object.`);
  const checks = Object.fromEntries(Object.entries(value.checks).map(([id, check]) => {
    const location = `${source}.checks.${id}`;
    ensure(/^[a-z0-9][a-z0-9._-]*$/.test(id), `Invalid check name: ${id}`);
    fields(check, checkFields, location);
    ensure(text(check.command) && text(check.expect), `${location}: command and expect must be nonempty strings.`);
    ensure(check.required === undefined || typeof check.required === "boolean", `${location}.required must be a boolean.`);
    const artifacts = list(check.artifacts, localFile, `${location}.artifacts must be safe relative file paths within VERIFY_ARTIFACTS.`);
    const paths = list(check.paths, text, `${location}.paths must be an array of nonempty glob strings.`);
    const covers = list(check.covers, text, `${location}.covers must be an array of catalogue IDs.`);
    ensure(check.kind === undefined || kinds.includes(check.kind), `${location}.kind must be one of: ${kinds.join(", ")}.`);
    for (const key of ["setup", "cleanup"]) {
      ensure(check[key] === undefined || text(check[key]), `${location}.${key} must be a nonempty command string.`);
    }
    ensure(check.result === undefined || localFile(check.result), `${location}.result must be a safe relative file path within VERIFY_ARTIFACTS.`);
    ensure(check.repeat === undefined || (Number.isSafeInteger(check.repeat) && check.repeat > 0), `${location}.repeat must be a positive safe integer.`);
    ensure(check.compare === undefined || ["regression", "measurement"].includes(check.compare), `${location}.compare must be regression or measurement.`);
    const measurements = metrics(check.metrics, `${location}.metrics`);
    ensure(Object.keys(measurements).length === 0 || check.result !== undefined, `${location}: metrics require a result file.`);
    ensure(check.compare !== "measurement" || Object.values(measurements).some(metric => metric.maxRegressionPercent !== undefined),
      `${location}: measurement comparison requires a metric with maxRegressionPercent.`);
    return [id, {
      ...check, required: check.required ?? false, artifacts, paths, covers,
      kind: check.kind ?? "command", repeat: check.repeat ?? 1,
      metrics: measurements, context: context(check.context, `${location}.context`),
    }];
  }));
  const behaviours = entries(value.behaviours, "behaviour", `${source}.behaviours`);
  const invariants = entries(value.invariants, "invariant", `${source}.invariants`);
  for (const [id, invariant] of Object.entries(invariants)) {
    ensure(!Object.hasOwn(behaviours, id), `Duplicate catalogue ID in behaviours and invariants: ${id}`);
    for (const name of invariant.checks) ensure(Object.hasOwn(checks, name), `${id}: unknown check reference: ${name}`);
  }
  for (const [id, check] of Object.entries(checks)) {
    for (const covered of check.covers) {
      ensure(Object.hasOwn(behaviours, covered) || Object.hasOwn(invariants, covered), `${id}: unknown catalogue reference: ${covered}`);
    }
  }
  for (const [id, invariant] of Object.entries(invariants)) {
    for (const name of invariant.checks) checks[name].covers = [...new Set([...checks[name].covers, id])];
  }
  return { checks, behaviours, invariants, context: context(value.context, `${source}.context`) };
}

export function loadConfig(root) {
  return parseConfig(readJSON(configPath(root)), root);
}

export function catalogue(config, query = "") {
  ensure(typeof query === "string", "Catalogue query must be a string.");
  const search = query.trim().toLowerCase();
  const rows = [];
  for (const [type, group] of [["behaviour", config.behaviours], ["invariant", config.invariants]]) {
    for (const [id, entry] of Object.entries(group)) {
      if (![id, entry.description, ...entry.paths, entry.entry ?? ""].some(value => value.toLowerCase().includes(search))) continue;
      const checks = Object.entries(config.checks).flatMap(([name, check]) =>
        check.covers.includes(id) || (type === "invariant" && entry.checks.includes(name)) ? [name] : []);
      rows.push({ id, type, ...entry, paths: [...entry.paths], checks });
    }
  }
  return rows;
}

export function selectChecks(config, { names = [], changedPaths = null } = {}) {
  ensure(Array.isArray(names) && names.every(text), "Requested checks must be an array of check IDs.");
  ensure(changedPaths === null || (Array.isArray(changedPaths) && changedPaths.every(text)), "Changed paths must be an array of nonempty paths or null.");
  const available = Object.keys(config.checks);
  for (const name of names) ensure(Object.hasOwn(config.checks, name), `Unknown check: ${name}. Available: ${available.join(", ") || "none"}`);
  const rows = catalogue(config);
  const changed = changedPaths === null ? null : [...new Set(changedPaths)];
  const matches = (path, patterns) => patterns.some(pattern => matchesGlob(path, pattern));
  const affected = patterns => changed?.some(path => matches(path, patterns));
  const active = rows.filter(row => row.type === "invariant" && (changed === null || row.paths.length === 0 || affected(row.paths)));
  const reasons = Object.fromEntries(available.flatMap(name => {
    const check = config.checks[name];
    const why = [];
    if (names.length === 0 && changed === null) why.push("all checks");
    if (names.includes(name)) why.push("explicit selection");
    if (check.required) why.push("required");
    if (changed !== null) {
      const covered = rows.filter(row => row.checks.includes(name));
      if (check.paths.length === 0 && covered.every(row => row.paths.length === 0)) why.push("unscoped check");
      for (const path of changed) if (matches(path, check.paths)) why.push(`changed path: ${path}`);
      for (const row of covered) if (affected(row.paths)) why.push(`${row.type}: ${row.id}`);
    }
    for (const row of active) if (row.checks.includes(name)) why.push(`invariant: ${row.id}`);
    return why.length ? [[name, [...new Set(why)]]] : [];
  }));
  return {
    names: available.filter(name => Object.hasOwn(reasons, name)),
    omitted: available.filter(name => !Object.hasOwn(reasons, name)),
    reasons,
    unmappedPaths: changed?.filter(path => !Object.values(config.checks).some(check => matches(path, check.paths)) &&
      !rows.some(row => matches(path, row.paths))) ?? [],
    invariants: active.map(row => row.id),
    uncoveredBehaviours: rows.filter(row => row.type === "behaviour" && !row.checks.length &&
      (changed === null || affected(row.paths))).map(row => row.id),
  };
}

function markdownAnchors(markdown) {
  const anchors = new Set();
  const headings = new Set();
  let fence = null;
  let previous = "";
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      previous = "";
      continue;
    }
    for (const tag of line.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
      for (const attribute of tag[0].matchAll(/\s(id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi)) {
        if (attribute[1].toLowerCase() === "id" || tag[1].toLowerCase() === "a") anchors.add(attribute[2] ?? attribute[3] ?? attribute[4]);
      }
    }
    const atx = line.match(/^ {0,3}#{1,6}(?:[\t ]+|$)(.*?)(?:[\t ]+#+[\t ]*)?$/);
    const heading = atx?.[1] ?? (previous.trim() && /^ {0,3}(?:=+|-+)[\t ]*$/.test(line) ? previous.trim() : null);
    previous = heading === null ? line : "";
    if (heading === null) continue;
    const explicit = heading.match(/\s*\{#([^\s{}]+)\}\s*$/);
    if (explicit) {
      anchors.add(explicit[1]);
      continue;
    }
    const base = heading.trim().toLowerCase().replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/\s/g, "-");
    let anchor = base;
    for (let suffix = 1; headings.has(anchor); suffix++) anchor = `${base}-${suffix}`;
    headings.add(anchor);
    anchors.add(anchor);
  }
  return anchors;
}

export function catalogueIssues(config, root, ids) {
  ensure(ids === undefined || (Array.isArray(ids) && ids.every(text)), "Catalogue entry IDs must be an array of nonempty strings.");
  const issues = [];
  for (const row of catalogue(config)) {
    if (row.guide === undefined || (ids !== undefined && !ids.includes(row.id))) continue;
    try {
      const { file, anchor } = guideReference(row.guide, `${row.id}.guide`);
      const target = realpathSync(join(root, file));
      ensure(safePath(relative(realpathSync(root), target).split(sep).join("/")), "Guide resolves outside the project.");
      ensure(statSync(target).isFile(), "Guide is not a file.");
      if (anchor !== undefined && !markdownAnchors(readFileSync(target, "utf8")).has(anchor)) {
        issues.push(`${row.id}: missing guide anchor #${anchor} in ${file}.`);
      }
    } catch (error) {
      issues.push(`${row.id}: cannot read guide ${row.guide}: ${error.message}`);
    }
  }
  return issues;
}
