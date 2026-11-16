import { loadConfig } from "./config.mjs";
import { assess, context as validateContext, ensure, object, refreshEvidence, statuses,
  statusOf, strings, text, validateAssessment, validateCheck, validatePlan } from "./model.mjs";
import { receiptRecipe } from "./receipts.mjs";
import { source as identifySource } from "./runner.mjs";

const marker = "<!-- groundwork-record:v1\n";
const copy = value => JSON.parse(JSON.stringify(value));
const pick = (value, names) => Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, value[name]]));

/** Validate authoritative local result.json, including historical V1 runs. */
export function validateLocalRun(value, id) {
  ensure(object(value) && [1, 2].includes(value.version) && value.id === id && text(value.startedAt) &&
    (value.finishedAt === null || text(value.finishedAt)) && object(value.source) &&
    (value.source.revision === null || text(value.source.revision)) &&
    /^[a-f0-9]{64}$/.test(value.source.fingerprint) && typeof value.source.dirty === "boolean" &&
    Array.isArray(value.omitted) && value.omitted.every(text) && Array.isArray(value.checks) &&
    value.checks.length > 0, "Invalid saved verification report.");
  for (const check of value.checks) validateCheck(check);
  if (value.version === 2) validateAssessment(value);
  return value;
}

/**
 * Reassess retained results without writing the frozen run. `root` scopes recipes;
 * `sourceRoot` scopes the run source (the repository for a nested PR project).
 * `sourceExcluded`/`checkExcluded` are the original exclusions in those scopes.
 * Optional config/context/env supply the current recipe inputs.
 * Returns assessment, ISO checkedAt, currentSource, the full problems list, and
 * boolean applicability: completion/source/inputs/evidence still apply, regardless
 * of the passed or failed verdict. Existing assessment problems remain verdict gates.
 */
export function reassessRun({ root, directory, source, finishedAt, assessment, config, context,
  env = process.env, sourceRoot = root, sourceExcluded = [], checkExcluded = [] }) {
  const issues = [];
  if (!finishedAt) issues.push("The selected run did not finish.");
  const currentSource = identifySource(sourceRoot, sourceExcluded);
  if (!source?.identityVersion || source.identityVersion !== currentSource.identityVersion) {
    issues.push("Historical source identity; this run is inapplicable to current content matching. Verify the affected behaviour again.");
  } else if (currentSource.fingerprint !== source.fingerprint) issues.push("Source changed since this run; verify the affected behaviour again.");
  const receipts = assessment.checks.filter(check => text(check.receipt?.key));
  if (receipts.length) {
    try {
      const currentConfig = config ?? loadConfig(root);
      const currentContext = context ?? { ...currentConfig.context, runnerPlatform: process.platform, runnerArchitecture: process.arch };
      const checkSource = root === sourceRoot && JSON.stringify(checkExcluded) === JSON.stringify(sourceExcluded)
        ? currentSource : identifySource(root, checkExcluded);
      for (const check of receipts) {
        ensure(Object.hasOwn(currentConfig.checks, check.name), `The current recipe for ${check.name} is unavailable.`);
        const recipe = receiptRecipe({ root, name: check.name, check: currentConfig.checks[check.name], source: checkSource,
          context: currentContext, plan: assessment.plan || null, env });
        ensure(recipe.key === check.receipt.key, `Receipt inputs changed for ${check.name}; verify the affected behaviour again.`);
      }
    } catch (error) { issues.push(`Saved receipt is inapplicable: ${error.message}`); }
  }
  const retained = refreshEvidence(directory, assessment.checks, assessment.observations || []);
  issues.push(...retained.problems);
  const problems = [...(assessment.problems || []), ...issues];
  return { assessment: assess({ plan: assessment.plan || null, ...retained, problems, context: assessment.context || {} }),
    checkedAt: new Date().toISOString(), currentSource, applicability: issues.length === 0, problems };
}

/**
 * Compact record V1 (a summary, never a reusable receipt):
 * - version: schema version; status: caller's outer verdict, retaining assessment failure/incompleteness.
 * - run: caller-normalized kind (local/pr), id, startedAt/finishedAt (ISO or null),
 *   source (identityVersion/fingerprint/revision/dirty, or null before identification),
 *   selection (names/omitted/reasons/invariants/unmappedPaths/uncoveredBehaviours),
 *   context (scalar workload values), runner (caller-owned identity), and optional PR metadata.
 * - plan: frozen goal and requirement bindings (id/expect/checks/behaviours/review),
 *   with optional decisions: project-relative Markdown documentation references.
 * - checks: name/command/expect/status/reason/covers, reasons for selection, requirement IDs,
 *   exitCode/durationMs/log/logHash/artifacts, optional trialSummary/comparison, and receipt
 *   provenance (disposition/reason/id/key/run/startedAt/recordedAt/source/reusable/
 *   nonReusableReason/executionDurationMs); rich trials remain in result.json.
 * - observations: id/covers/status/observed/kind/evidence and producer/check/trial provenance.
 * - coverage: requirement id/expect/status/checks/observations/evidence/reason plus review obligation.
 * - stages: named outer lifecycle status with optional command/reason/log/exitCode/durationMs/skipped.
 * - gaps: all assessment problems, incomplete-run, coverage, selection, and stage gaps.
 */
export function makeRecord({ run, assessment = assess({}), status = assessment.status, stages = [] }) {
  validateAssessment(assessment);
  const evaluated = assess(assessment);
  const metadata = { ...run, startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null,
    source: run.source ?? null, selection: run.selection ?? null, context: run.context ?? evaluated.context, runner: run.runner ?? null };
  const incomplete = metadata.finishedAt === null ? ["The selected run did not finish."] : [];
  const plan = evaluated.plan ? validatePlan(evaluated.plan) : null;
  const coverage = evaluated.coverage.map((item, index) => ({ ...item,
    ...(plan.requirements[index].review === undefined ? {} : { review: plan.requirements[index].review }) }));
  const record = {
    version: 1, run: metadata, status: statusOf([status, evaluated.status], incomplete), plan,
    checks: evaluated.checks.map(check => ({
      ...pick(check, ["name", "command", "expect", "status", "exitCode", "durationMs", "log", "logHash", "artifacts", "trialSummary", "comparison"]),
      reason: check.reason ?? null, covers: check.covers || [], reasons: metadata.selection?.reasons?.[check.name] || [],
      requirements: coverage.filter(item => item.checks.includes(check.name)).map(item => item.id),
      ...(check.receipt ? { receipt: pick(check.receipt, ["disposition", "reason", "id", "key", "run", "startedAt", "recordedAt", "source",
        "reusable", "nonReusableReason", "executionDurationMs"]) } : {}),
    })),
    observations: evaluated.observations.map(observation => pick(observation,
      ["id", "covers", "status", "observed", "kind", "evidence", "producer", "check", "trial"])),
    coverage, stages,
    gaps: [...new Set([...evaluated.problems, ...incomplete,
      ...coverage.filter(item => item.status !== "verified").map(item => `${item.id}: ${item.reason || item.status}`),
      ...stages.filter(stage => stage.status !== "passed").map(stage => `${stage.name}: ${stage.reason || stage.status}`),
      ...(metadata.selection?.unmappedPaths?.length ? [`Unmapped changed paths: ${metadata.selection.unmappedPaths.join(", ")}`] : []),
      ...(metadata.selection?.uncoveredBehaviours?.length ? [`Behaviours without mapped checks: ${metadata.selection.uncoveredBehaviours.join(", ")}`] : []),
    ])],
  };
  return validateRecord(copy(record));
}

/** Validate the public summary shape, not its authenticity or evidence freshness. */
export function validateRecord(record) {
  ensure(object(record) && record.version === 1 && statuses.includes(record.status) && object(record.run) &&
    ["local", "pr"].includes(record.run.kind) && text(record.run.id) &&
    (record.run.startedAt === null || text(record.run.startedAt)) &&
    (record.run.finishedAt === null || text(record.run.finishedAt)) &&
    (record.run.selection === null || object(record.run.selection)) &&
    (record.run.runner === null || object(record.run.runner)) && strings(record.gaps) &&
    Array.isArray(record.coverage) && Array.isArray(record.stages), "Invalid verification record.");
  const source = record.run.source;
  ensure(source === null || (object(source) && (source.revision === null || text(source.revision)) &&
    /^[a-f0-9]{64}$/.test(source.fingerprint) && typeof source.dirty === "boolean"), "Invalid record source.");
  validateContext(record.run.context);
  validateAssessment({ ...record, problems: record.gaps, context: record.run.context });
  ensure(record.status !== "passed" || (source !== null && text(record.run.startedAt) && text(record.run.finishedAt) &&
    (record.checks.length > 0 || record.observations.length > 0)), "A passing record needs a completed run, source, and verification scope.");
  for (const check of record.checks) {
    ensure(strings(check.reasons) && strings(check.requirements) && strings(check.covers) &&
      (check.reason === null || text(check.reason)), "Invalid record check bindings.");
    if (check.receipt !== undefined) ensure(object(check.receipt) && ["executed", "reused"].includes(check.receipt.disposition) &&
      text(check.receipt.reason), "Invalid record receipt provenance.");
  }
  for (const item of record.coverage) ensure(object(item) && text(item.id) && text(item.expect) &&
    ["verified", "failed", "unverified"].includes(item.status) && strings(item.checks) && strings(item.observations) &&
    strings(item.evidence) && (item.reason === null || text(item.reason)) &&
    (item.review === undefined || typeof item.review === "boolean"), "Invalid record coverage.");
  for (const stage of record.stages) ensure(object(stage) && text(stage.name) && statuses.includes(stage.status) &&
    (stage.command === undefined || text(stage.command)) && (stage.reason === undefined || stage.reason === null || text(stage.reason)),
  "Invalid record stage.");
  return record;
}

const markdown = value => String(value).replace(/\s+/g, " ").replace(/[\\`*_{}\[\]()<>#+.!|]/g, "\\$&").replace(/@/g, "@\u200b");
const link = (label, url) => `[${markdown(label)}](${String(url).replace(/[\s()<>]/g,
  char => char === "(" ? "%28" : char === ")" ? "%29" : encodeURIComponent(char))})`;

/**
 * Render a human report and one complete hidden {record, publication} JSON payload.
 * publication is an optional PR overlay: repository/pullRequest/headSha/testedSha,
 * publishedAt/publisher, status/sourceMatches, and assessment (status/coverage/problems).
 * It is displayed separately and never changes record.status. Optional links.run/evidence are URLs, links.screenshots and
 * links.decisions are URLs or label-to-URL maps. Link availability is not a verdict gate.
 */
export function renderRecord(record, { publication = null, links = {} } = {}) {
  validateRecord(record);
  ensure(publication === null || object(publication), "Invalid record publication.");
  const { run } = record;
  const displayedStatus = statuses.includes(publication?.status) ? publication.status : record.status;
  const overlaid = statuses.includes(publication?.status) && publication.status !== record.status;
  const count = (items, key = "status") => Object.entries(items.reduce((counts, item) =>
    ({ ...counts, [item[key]]: (counts[item[key]] || 0) + 1 }), {})).map(([status, total]) => `${total} ${status}`).join(", ");
  const short = value => markdown(String(value).slice(0, 12));
  const summary = [`## Verification — ${displayedStatus[0].toUpperCase()}${displayedStatus.slice(1)}`, ""];
  if (overlaid) summary.push(`Current publication is **${publication.status}**; the recorded run was **${record.status}** and does not apply as-is.`);
  else summary.push([record.plan && `Requirements: ${count(record.coverage) || "none"}`, `Checks: ${count(record.checks) || "none"}`,
    record.observations.length && `Observations: ${count(record.observations)}`].filter(Boolean).join(" · "));
  const tested = run.source?.revision || publication?.testedSha;
  const commits = publication?.sourceMatches === true && publication.headSha ? [`Commit: ${short(publication.headSha)}`] : [
    run.source || tested ? `Tested ${tested ? short(tested) : "uncommitted source"}${run.source?.dirty ? " + local changes" : ""}` : "Tested source unknown",
    publication?.headSha && `PR ${short(publication.headSha)}`,
    publication?.sourceMatches === false && "source does not match the pushed PR"].filter(Boolean);
  if (commits.length) summary.push("", commits.join(" · "));
  const issues = overlaid ? publication.assessment?.problems || [] : record.status === "passed" ? [] : record.gaps;
  if (issues.length) summary.push("", ...issues.slice(0, 3).map(issue => `- ${markdown(issue.length > 160 ? `${issue.slice(0, 157)}...` : issue)}`),
    ...(issues.length > 3 ? [`- ${issues.length - 3} more in the details below`] : []));
  const lines = [`Run: ${markdown(run.id)} (${run.kind}) · ${markdown(run.startedAt || "not started")} · ${run.finishedAt ? `finished ${markdown(run.finishedAt)}` : "incomplete"}`];
  if (run.source) lines.push(`Source: ${markdown(run.source.revision || "no commit yet")}${run.source.dirty ? " + local changes" : ""} · ${markdown(run.source.fingerprint)}`);
  else lines.push("Source: unavailable");
  if (Object.keys(run.context).length) lines.push(`Context: ${markdown(JSON.stringify(run.context))}`);
  if (run.runner) lines.push(`Runner: ${markdown(JSON.stringify(run.runner))}`);
  if (publication) {
    lines.push("", "### Publication assessment");
    if (statuses.includes(publication.status)) lines.push(`Current publication: **${publication.status}** · recorded run: **${record.status}**`);
    if (publication.headSha) lines.push(`PR commit: ${markdown(publication.headSha)}`);
    if (publication.testedSha) lines.push(`Tested checkout: ${markdown(publication.testedSha)}`);
    if (typeof publication.sourceMatches === "boolean") lines.push(`Source matches pushed PR: ${publication.sourceMatches ? "yes" : "no"}`);
    for (const item of publication.assessment?.coverage || []) lines.push(`- **${markdown(item.status)}: ${markdown(item.id)}** — ${markdown(item.expect)}${item.reason ? ` — ${markdown(item.reason)}` : ""}`);
    for (const problem of publication.assessment?.problems || []) lines.push(`- ${markdown(problem)}`);
  }
  if (record.stages.length) lines.push("", ...record.stages.map(stage => `- **${markdown(stage.name)}:** ${stage.status}${stage.reason ? ` — ${markdown(stage.reason)}` : ""}`));
  if (record.plan) {
    lines.push("", "### Requirement coverage", markdown(record.plan.goal));
    for (const item of record.coverage) lines.push(`- **${item.status}: ${markdown(item.id)}** — ${markdown(item.expect)}${item.review ? " (review required)" : ""}${item.reason ? ` — ${markdown(item.reason)}` : ""}`);
  }
  if (record.checks.length) {
    lines.push("", "### Checks");
    for (const check of record.checks) {
      lines.push(`- **${check.status}: ${markdown(check.name)}** — ${markdown(check.expect)}`,
        `  Command: <code>${check.command.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#10;")}</code>`);
      if (check.reasons.length) lines.push(`  Selected: ${check.reasons.map(markdown).join("; ")}`);
      if (check.requirements.length) lines.push(`  Requirements: ${check.requirements.map(markdown).join(", ")}`);
      if (check.reason) lines.push(`  ${markdown(check.reason)}`);
      if (check.receipt) lines.push(`  ${check.receipt.disposition === "reused" ? "Reused" : "Fresh execution"}: ${markdown(check.receipt.reason)}${check.receipt.id ? ` · receipt ${markdown(check.receipt.id)}` : ""}${check.receipt.run ? ` · run ${markdown(check.receipt.run)}` : ""}${check.receipt.recordedAt ? ` · recorded ${markdown(check.receipt.recordedAt)}` : ""}`);
      if (check.trialSummary) lines.push(`  Trials: ${check.trialSummary.passed}/${check.trialSummary.total} passed; ${check.trialSummary.failed} failed; ${check.trialSummary.inconclusive} inconclusive.`);
      if (check.comparison) lines.push(`  Comparison: ${check.comparison.status} — ${markdown(check.comparison.reason)}`);
      lines.push(`  Evidence: ${[check.log, ...check.artifacts.map(item => item.path)].map(markdown).join(", ")}`);
    }
  }
  if (record.observations.length) {
    lines.push("", "### Observations");
    for (const observation of record.observations) lines.push(`- **${observation.status}: ${markdown(observation.id)}** (${observation.kind}) — ${markdown(observation.observed)}`,
      `  Covers: ${observation.covers.map(markdown).join(", ") || "none"}. Evidence: ${observation.evidence.map(item => markdown(item.path)).join(", ") || "none"}.`);
  }
  if (record.gaps.length) lines.push("", "### Gaps", ...record.gaps.map(gap => `- ${markdown(gap)}`));
  if (run.selection?.omitted?.length) lines.push("", `Not selected: ${run.selection.omitted.map(markdown).join(", ")}`);
  if (record.plan?.decisions?.length) {
    lines.push("", "### Decisions", ...record.plan.decisions.map(path => `- ${links.decisions?.[path] ? link(path, links.decisions[path]) : markdown(path)}`));
  }
  const references = [];
  for (const [slot, label] of [["run", "Run details"], ["evidence", "Retained evidence"], ["screenshots", "Screenshots"], ["decisions", "Decisions"]]) {
    if (text(links[slot])) references.push(link(label, links[slot]));
    else if (slot === "screenshots" && object(links[slot])) references.push(...Object.entries(links[slot]).map(([name, url]) => link(name, url)));
  }
  if (references.length) summary.push("", references.join(" · "));
  summary.push("", "<details><summary>Verification details</summary>", "", ...lines, "", "</details>");
  const payload = JSON.stringify({ record, publication }).replace(/[<>&\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${summary.join("\n")}\n\n${marker}${payload}\n-->\n`;
}

/** Read the sole valid V1 payload; absent, malformed, or ambiguous records return null. */
export function parseRecord(markdown) {
  if (typeof markdown !== "string") return null;
  const start = markdown.indexOf(marker);
  if (start < 0 || markdown.indexOf(marker, start + marker.length) >= 0) return null;
  const end = markdown.indexOf("\n-->", start + marker.length);
  if (end < 0) return null;
  try {
    const payload = JSON.parse(markdown.slice(start + marker.length, end));
    ensure(object(payload) && (payload.publication === null || object(payload.publication)), "Invalid record payload.");
    return { record: validateRecord(payload.record), publication: payload.publication };
  } catch { return null; }
}
