import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogue, catalogueIssues, loadConfig, parseConfig, selectChecks } from "../lib/config.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-config-"));
  directories.push(directory);
  return directory;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function check(options = {}) {
  return { command: "bun scenario.mjs", expect: "The requested behaviour holds", ...options };
}

test("legacy checks remain conservative for changed files and selective for named runs", () => {
  const config = parseConfig({ checks: {
    required: check({ required: true }),
    feature: check(),
    other: check(),
  } });
  expect(selectChecks(config).names).toEqual(["required", "feature", "other"]);
  const named = selectChecks(config, { names: ["feature", "feature"] });
  expect(named.names).toEqual(["required", "feature"]);
  expect(named.omitted).toEqual(["other"]);
  expect(named.reasons.required).toContain("required");
  expect(named.reasons.feature).toContain("explicit selection");
  const changed = selectChecks(config, { changedPaths: ["src/feature.mjs"] });
  expect(changed.names).toEqual(["required", "feature", "other"]);
  expect(changed.unmappedPaths).toEqual(["src/feature.mjs"]);
  expect(changed.reasons.other).toContain("unscoped check");
  expect(catalogue(config)).toEqual([]);
  expect(() => selectChecks(config, { names: ["missing"] })).toThrow("Unknown check: missing");
});

test("changed paths select direct and catalogue coverage, union explicit checks, and report unmapped files", () => {
  const config = parseConfig({
    checks: {
      build: check({ paths: ["build/**"], required: true }),
      editor: check({ covers: ["editing"] }),
      client: check({ paths: ["client/**"] }),
      manual: check({ paths: ["manual/**"] }),
      unused: check({ paths: ["other/**"] }),
    },
    behaviours: {
      editing: { description: "Edit a document", paths: ["src/editor/**"] },
      planned: { description: "Import a document", paths: ["src/import/**"] },
    },
  });
  const result = selectChecks(config, {
    names: ["manual"],
    changedPaths: ["src/editor/view.mjs", "client/api.mjs", "src/import/parse.mjs", "notes.txt"],
  });
  expect(result.names).toEqual(["build", "editor", "client", "manual"]);
  expect(result.omitted).toEqual(["unused"]);
  expect(result.reasons.editor).toContain("behaviour: editing");
  expect(result.reasons.client).toContain("changed path: client/api.mjs");
  expect(result.unmappedPaths).toEqual(["notes.txt"]);
  expect(catalogue(config, "planned")[0].checks).toEqual([]);
});

test("scoped invariants enforce linked checks while global invariants survive unrelated and empty changes", () => {
  const config = parseConfig({
    checks: {
      editor: check({ paths: ["src/editor/**"] }),
      access: check(),
      audit: check({ covers: ["access-boundary"] }),
      integrity: check({ paths: ["storage/**"] }),
    },
    invariants: {
      "access-boundary": { description: "Changes respect access rules", paths: ["server/**"], checks: ["access"] },
      "data-integrity": { description: "Stored records stay valid", checks: ["integrity"] },
    },
  });
  const unrelated = selectChecks(config, { names: ["editor"], changedPaths: ["docs/notes.md"] });
  expect(unrelated.names).toEqual(["editor", "integrity"]);
  expect(unrelated.omitted).toEqual(["access", "audit"]);
  expect(unrelated.invariants).toEqual(["data-integrity"]);
  const scoped = selectChecks(config, { names: ["editor"], changedPaths: ["server/routes.mjs"] });
  expect(scoped.names).toEqual(["editor", "access", "audit", "integrity"]);
  expect(scoped.invariants).toEqual(["access-boundary", "data-integrity"]);
  expect(scoped.reasons.access).toContain("invariant: access-boundary");
  expect(scoped.reasons.integrity).toContain("invariant: data-integrity");
  expect(selectChecks(config, { changedPaths: [] }).names).toEqual(["integrity"]);
  const named = selectChecks(config, { names: ["editor"] });
  expect(named.names).toEqual(["editor", "access", "audit", "integrity"]);
  expect(named.invariants).toEqual(["access-boundary", "data-integrity"]);
});

test("a check's direct paths and covered behaviour paths both select it", () => {
  const config = parseConfig({
    checks: { editor: check({ paths: ["shared/**"], covers: ["editing"] }) },
    behaviours: { editing: { description: "Edit a document", paths: ["editor/**"] } },
  });
  expect(selectChecks(config, { changedPaths: ["shared/model.mjs"] }).names).toEqual(["editor"]);
  expect(selectChecks(config, { changedPaths: ["editor/view.mjs"] }).names).toEqual(["editor"]);
  expect(selectChecks(config, { changedPaths: ["other/view.mjs"] }).omitted).toEqual(["editor"]);
});

test("catalogue searches descriptions, IDs, paths, and entry points and merges invariant coverage", () => {
  const config = parseConfig({
    checks: {
      journey: check({ covers: ["save-document", "durable"] }),
      storage: check(),
    },
    behaviours: {
      "save-document": { description: "Preserve draft contents", paths: ["src/editor/**"], entry: "/workspace", guide: "VERIFY.md#saving" },
      importing: { description: "Import an existing file" },
    },
    invariants: { durable: { description: "Saved changes survive restart", checks: ["journey", "storage"] } },
  });
  for (const query of ["SAVE-DOCUMENT", "DRAFT", "SRC/EDITOR", "/WORKSPACE"]) {
    const rows = catalogue(config, query);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "save-document", type: "behaviour", checks: ["journey"], guide: "VERIFY.md#saving" });
  }
  expect(catalogue(config, "durable")[0]).toMatchObject({ type: "invariant", checks: ["journey", "storage"] });
  expect(catalogue(config, "import")[0].checks).toEqual([]);
  expect(catalogue(config, "no match")).toEqual([]);
});

test("guide inspection finds stale files and anchors without executing checks and supports scoped inspection", () => {
  const root = temporaryDirectory();
  write(root, "docs/guide.md", [
    "# Verification", "", "## Save draft", "", "## Save draft", "",
    "Restart safely", "--------------", "", '<a id="explicit-anchor"></a>', "",
    "## Advanced save {#custom-anchor}", "", "```md", "## Example only", "```", "",
  ].join("\n"));
  const config = parseConfig({
    checks: { forbidden: check({ command: `touch "${join(root, "executed")}"`, covers: ["heading"] }) },
    behaviours: {
      heading: { description: "Save a draft", guide: "docs/guide.md#save-draft" },
      repeated: { description: "Save again", guide: "docs/guide.md#save-draft-1" },
      restart: { description: "Restart", guide: "docs/guide.md#restart-safely" },
      explicit: { description: "Explicit anchor", guide: "docs/guide.md#explicit-anchor" },
      custom: { description: "Custom heading anchor", guide: "docs/guide.md#custom-anchor" },
      file: { description: "Whole guide", guide: "docs/guide.md" },
      stale: { description: "Removed section", guide: "docs/guide.md#removed" },
      example: { description: "Not an actual heading", guide: "docs/guide.md#example-only" },
      missing: { description: "Removed file", guide: "docs/missing.md" },
    },
  }, root);
  const issues = catalogueIssues(config, root);
  expect(issues).toHaveLength(3);
  expect(issues.join("\n")).toContain("stale: missing guide anchor #removed");
  expect(issues.join("\n")).toContain("example: missing guide anchor #example-only");
  expect(issues.join("\n")).toContain("missing: cannot read guide docs/missing.md");
  expect(catalogueIssues(config, root, ["heading", "explicit"])).toEqual([]);
  expect(catalogueIssues(config, root, ["stale"])).toHaveLength(1);
  expect(catalogueIssues(config, root, [])).toEqual([]);
  expect(existsSync(join(root, "executed"))).toBe(false);
});

test("guide references cannot escape the project through a symbolic link", () => {
  const root = temporaryDirectory();
  const outside = temporaryDirectory();
  write(outside, "guide.md", "# Outside\n");
  symlinkSync(join(outside, "guide.md"), join(root, "guide.md"));
  const config = parseConfig({ checks: {}, behaviours: { outside: { description: "Outside guide", guide: "guide.md#outside" } } });
  expect(catalogueIssues(config, root).join("\n")).toContain("outside the project");
});

test("loading validates persisted JSON and preserves declared measurement context", () => {
  const root = temporaryDirectory();
  write(root, "verify.json", JSON.stringify({
    context: { fixture: "small", workers: 2, remote: false, revision: null },
    checks: { timing: check({
      kind: "performance", setup: "bun seed.mjs", cleanup: "bun reset.mjs", repeat: 3,
      result: "result.json", artifacts: ["trace.json"], compare: "measurement",
      metrics: { duration: { unit: "ms", min: 0, max: 100, maxRegressionPercent: 5, direction: "lower" } },
      context: { fixture: "large" },
    }) },
  }));
  const config = loadConfig(root);
  expect(config.context).toEqual({ fixture: "small", workers: 2, remote: false, revision: null });
  expect(config.checks.timing.context).toEqual({ fixture: "large" });
  expect(parseConfig(config)).toEqual(config);
  expect(selectChecks(config, { changedPaths: ["benchmark.mjs"] }).names).toEqual(["timing"]);
  write(root, "verify.json", "{not json}");
  expect(() => loadConfig(root)).toThrow("verify.json");
  write(root, "verify.json", JSON.stringify({ checks: { timing: check({ repeat: "3" }) } }));
  expect(() => loadConfig(root)).toThrow("repeat must be a positive safe integer");
});

test("invalid configuration boundaries, fields, and references are rejected", () => {
  const cases = [
    [null, "must be an object"],
    [{ checks: [] }, "checks must be an object"],
    [{ checks: {}, behaviours: null }, "behaviours must be an object"],
    [{ checks: {}, invariants: [] }, "invariants must be an object"],
    [{ checks: {}, extra: true }, 'unknown field "extra"'],
    [{ checks: { "Invalid ID": check() } }, "Invalid check name"],
    [{ checks: { run: check({ command: " " }) } }, "command and expect"],
    [{ checks: { run: check({ requred: true }) } }, 'unknown field "requred"'],
    [{ checks: { run: check({ required: "yes" }) } }, "required must be a boolean"],
    [{ checks: { run: check({ paths: [42] }) } }, "paths must be an array"],
    [{ checks: { run: check({ covers: ["missing"] }) } }, "unknown catalogue reference: missing"],
    [{ checks: { run: check({ covers: ["constructor"] }) } }, "unknown catalogue reference: constructor"],
    [{ checks: { run: check({ kind: "unknown" }) } }, "kind must be one of"],
    [{ checks: { run: check({ setup: "" }) } }, "setup must be a nonempty command"],
    [{ checks: { run: check({ cleanup: [] }) } }, "cleanup must be a nonempty command"],
    [{ checks: { run: check({ repeat: 0 }) } }, "repeat must be a positive safe integer"],
    [{ checks: { run: check({ repeat: 1.5 }) } }, "repeat must be a positive safe integer"],
    [{ checks: { run: check({ repeat: Number.MAX_SAFE_INTEGER + 1 }) } }, "repeat must be a positive safe integer"],
    [{ checks: { run: check({ compare: "unknown" }) } }, "compare must be regression or measurement"],
    [{ checks: {}, behaviours: { draft: { description: " " } } }, "description must be a nonempty string"],
    [{ checks: {}, behaviours: { draft: { description: "Draft", checks: [] } } }, 'unknown field "checks"'],
    [{ checks: {}, invariants: { valid: { description: "Valid", checks: [] } } }, "checks must be a nonempty array"],
    [{ checks: {}, invariants: { valid: { description: "Valid", checks: ["missing"] } } }, "unknown check reference: missing"],
    [{ checks: { run: check() }, behaviours: { same: { description: "Behaviour" } }, invariants: { same: { description: "Invariant", checks: ["run"] } } }, "Duplicate catalogue ID"],
    [{ checks: {}, context: { nested: { value: true } } }, "must be a string, finite number, boolean, or null"],
    [{ checks: {}, context: { "": "unnamed" } }, "metadata names must be nonempty strings"],
    [{ checks: { run: check({ context: { samples: [] } }) } }, "must be a string, finite number, boolean, or null"],
    [{ checks: {}, context: { size: Infinity } }, "must be a string, finite number, boolean, or null"],
  ];
  for (const [value, message] of cases) expect(() => parseConfig(value)).toThrow(message);
});

test("artifact, result, and guide paths reject unsafe or non-Markdown references", () => {
  for (const path of ["../outside.txt", "/outside.txt", "folder/../outside.txt", "C:\\outside.txt", "https://example.test/file", "file\0.txt"]) {
    expect(() => parseConfig({ checks: { run: check({ artifacts: [path] }) } })).toThrow("artifacts must be safe relative");
    expect(() => parseConfig({ checks: { run: check({ result: path }) } })).toThrow("result must be a safe relative");
  }
  for (const guide of ["../guide.md#section", "https://example.test/guide.md", "/guide.md", "guide.txt", "guide.md#", "guide.md#bad%ZZ"]) {
    expect(() => parseConfig({ checks: {}, behaviours: { draft: { description: "Draft", guide } } })).toThrow("safe relative Markdown file");
  }
});

test("metric definitions require usable results, finite budgets, and explicit measurement tolerances", () => {
  const cases = [
    [{ metrics: { duration: { unit: "ms" } } }, "metrics require a result file"],
    [{ metrics: [] }, "metrics must be an object"],
    [{ metrics: { duration: { unit: "" } } }, "unit must be a nonempty string"],
    [{ metrics: { duration: { unit: "ms", maximum: 10 } } }, 'unknown field "maximum"'],
    [{ metrics: { duration: { unit: "ms", min: 10, max: 5 } } }, "min must not exceed max"],
    [{ metrics: { duration: { unit: "ms", max: Infinity } } }, "max must be a finite number"],
    [{ metrics: { duration: { unit: "ms", maxRegressionPercent: -1 } } }, "maxRegressionPercent must be nonnegative"],
    [{ metrics: { duration: { unit: "ms", direction: "smaller" } } }, "direction must be lower or higher"],
    [{ compare: "measurement", result: "result.json", metrics: { duration: { unit: "ms", max: 100 } } }, "measurement comparison requires a metric with maxRegressionPercent"],
  ];
  for (const [options, message] of cases) expect(() => parseConfig({ checks: { timing: check(options) } })).toThrow(message);
});
