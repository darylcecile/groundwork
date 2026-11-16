import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogue, catalogueIssues, configPath, hasConfig, loadConfig, parseConfig, selectChecks } from "../lib/config.mjs";

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
  return { command: "bun .groundwork/scripts/scenario.mjs", expect: "The requested behaviour holds", ...options };
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

test("plan bindings join named and changed selections while required checks and invariants remain active", () => {
  const config = parseConfig({
    checks: {
      required: check({ required: true, paths: ["build/**"] }),
      manual: check({ paths: ["manual/**"] }),
      editor: check({ covers: ["editing"] }),
      persistence: check({ paths: ["storage/**"] }),
      integrity: check({ paths: ["internal/**"] }),
      unrelated: check({ paths: ["other/**"] }),
    },
    behaviours: { editing: { description: "Edit a document", paths: ["editor/**"] } },
    invariants: { durable: { description: "Stored data stays valid", checks: ["integrity"] } },
  });
  const plan = { goal: "Edit and save a document", requirements: [
    { id: "save", expect: "Changes survive restarting", checks: ["persistence"], behaviours: ["editing"] },
  ] };
  for (const options of [{ names: ["manual"] }, { changedPaths: ["manual/driver.mjs"] }]) {
    const selection = selectChecks(config, { ...options, plan });
    expect(selection.names).toEqual(["required", "manual", "editor", "persistence", "integrity"]);
    expect(selection.reasons.persistence.join(" ")).toContain("plan requirement: save");
    expect(selection.reasons.editor.join(" ")).toContain("plan behaviour: editing");
    expect(selection.invariants).toEqual(["durable"]);
    expect(selection.omitted).toEqual(["unrelated"]);
  }
  expect(selectChecks(config, { plan }).names).toEqual(Object.keys(config.checks));
  expect(() => selectChecks(config, { plan: { goal: "Save", requirements: [
    { id: "save", expect: "Save works", checks: ["missing"] },
  ] } })).toThrow("Unknown planned check: missing (requirement save)");
});

test("catalogue searches descriptions, IDs, paths, and entry points and merges invariant coverage", () => {
  const config = parseConfig({
    checks: {
      journey: check({ covers: ["save-document", "durable"] }),
      storage: check(),
    },
    behaviours: {
      "save-document": { description: "Preserve draft contents", paths: ["src/editor/**"], entry: "/workspace", guide: ".groundwork/VERIFY.md#saving" },
      importing: { description: "Import an existing file" },
    },
    invariants: { durable: { description: "Saved changes survive restart", checks: ["journey", "storage"] } },
  });
  for (const query of ["SAVE-DOCUMENT", "DRAFT", "SRC/EDITOR", "/WORKSPACE"]) {
    const rows = catalogue(config, query);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "save-document", type: "behaviour", checks: ["journey"], guide: ".groundwork/VERIFY.md#saving" });
  }
  expect(catalogue(config, "durable")[0]).toMatchObject({ type: "invariant", checks: ["journey", "storage"] });
  expect(catalogue(config, "import")[0].checks).toEqual([]);
  expect(catalogue(config, "no match")).toEqual([]);
});

test("behaviour dependencies default to empty, preserve declared order, and allow forward references and cycles", () => {
  const value = {
    checks: {},
    behaviours: {
      saving: { description: "Save a document", dependsOn: ["storage", "session", "storage"] },
      storage: { description: "Store a document", dependsOn: ["saving"] },
      session: { description: "Identify the workspace", dependsOn: [] },
      importing: { description: "Import a document" },
      own: { description: "Use an explicitly declared ID", dependsOn: ["constructor"] },
      constructor: { description: "An own catalogue entry" },
    },
  };
  const config = parseConfig(value);
  expect(config.behaviours.saving.dependsOn).toEqual(["storage", "session"]);
  expect(config.behaviours.storage.dependsOn).toEqual(["saving"]);
  expect(config.behaviours.session.dependsOn).toEqual([]);
  expect(config.behaviours.importing.dependsOn).toEqual([]);
  expect(config.behaviours.own.dependsOn).toEqual(["constructor"]);
  expect(catalogue(config, "saving")[0].dependsOn).toEqual(["storage", "session"]);
  expect(parseConfig(config)).toEqual(config);
  expect(value.behaviours.saving.dependsOn).toEqual(["storage", "session", "storage"]);
});

test("behaviour dependencies reject malformed lists, self-links, and targets outside the behaviour catalogue", () => {
  const value = {
    checks: { integrity: check() },
    behaviours: { saving: { description: "Save a document" }, storage: { description: "Store a document" } },
    invariants: { durable: { description: "Stored data survives", checks: ["integrity"] } },
  };
  for (const dependsOn of [null, "storage", {}, [null], [42], [""], [" "], ["storage", false]]) {
    expect(() => parseConfig({ ...value, behaviours: {
      ...value.behaviours, saving: { ...value.behaviours.saving, dependsOn },
    } })).toThrow("dependsOn must be an array of nonempty behaviour IDs");
  }
  for (const target of ["missing", "durable", "constructor", "Storage"]) {
    expect(() => parseConfig({ ...value, behaviours: {
      ...value.behaviours, saving: { ...value.behaviours.saving, dependsOn: [target] },
    } })).toThrow(`saving.dependsOn: unknown behaviour reference: ${target}`);
  }
  expect(() => parseConfig({ ...value, behaviours: {
    saving: { ...value.behaviours.saving, dependsOn: ["saving"] },
  } })).toThrow("saving.dependsOn cannot reference itself");
  expect(() => parseConfig({ ...value, invariants: {
    durable: { ...value.invariants.durable, dependsOn: ["storage"] },
  } })).toThrow('unknown field "dependsOn"');
});

test("dependency metadata does not change check selection, invariant enforcement, or unmapped coverage", () => {
  const value = {
    checks: {
      editor: check({ covers: ["editing"] }),
      storage: check({ covers: ["storage"] }),
      integrity: check(),
    },
    behaviours: {
      editing: { description: "Edit a document", paths: ["src/editor/**"] },
      storage: { description: "Store a document", paths: ["src/storage/**"] },
      planned: { description: "Import a document", paths: ["src/import/**"] },
    },
    invariants: { durable: { description: "Stored data survives", checks: ["integrity"] } },
  };
  const config = parseConfig(value);
  const linked = parseConfig({ ...value, behaviours: {
    ...value.behaviours,
    editing: { ...value.behaviours.editing, dependsOn: ["storage"] },
    planned: { ...value.behaviours.planned, dependsOn: ["editing"] },
  } });
  for (const options of [{}, { names: ["editor"] }, { changedPaths: [] },
    { changedPaths: ["src/editor/view.mjs"] }, { changedPaths: ["src/storage/model.mjs"] },
    { changedPaths: ["src/import/read.mjs"] }, { changedPaths: ["notes.txt"] }]) {
    expect(selectChecks(linked, options)).toEqual(selectChecks(config, options));
  }
  expect(selectChecks(linked, { changedPaths: ["src/editor/view.mjs"] }).names).toEqual(["editor", "integrity"]);
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
  write(root, ".groundwork/verify.json", JSON.stringify({
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
  write(root, ".groundwork/verify.json", "{not json}");
  expect(() => loadConfig(root)).toThrow("verify.json");
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: { timing: check({ repeat: "3" }) } }));
  expect(() => loadConfig(root)).toThrow("repeat must be a positive safe integer");
});

test("namespaced configuration takes precedence over legacy fallback and keeps paths project-root-relative", () => {
  const root = temporaryDirectory();
  expect(configPath(root)).toBe(join(root, ".groundwork/verify.json"));
  write(root, "verify.json", JSON.stringify({ checks: { legacy: check() } }));
  expect(configPath(root)).toBe(join(root, "verify.json"));
  expect(Object.keys(loadConfig(root).checks)).toEqual(["legacy"]);
  write(root, ".groundwork/VERIFY.md", "# Saving\n");
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: { current: check({ paths: [".groundwork/scripts/**"], covers: ["saving"] }) },
    behaviours: { saving: { description: "Save a file", paths: ["src/**"], guide: ".groundwork/VERIFY.md#saving" } } }));
  expect(configPath(root)).toBe(join(root, ".groundwork/verify.json"));
  const config = loadConfig(root);
  expect(Object.keys(config.checks)).toEqual(["current"]);
  expect(config.checks.current.command).toBe("bun .groundwork/scripts/scenario.mjs");
  expect(selectChecks(config, { changedPaths: [".groundwork/scripts/scenario.mjs"] }).names).toEqual(["current"]);
  expect(selectChecks(config, { changedPaths: ["src/main.mjs"] }).names).toEqual(["current"]);
  expect(catalogueIssues(config, root)).toEqual([]);
  write(root, ".groundwork/verify.json", "{invalid}");
  expect(() => loadConfig(root)).toThrow(".groundwork/verify.json");
  rmSync(join(root, ".groundwork/verify.json"));
  symlinkSync(join(root, "missing.json"), join(root, ".groundwork/verify.json"));
  expect(configPath(root)).toBe(join(root, ".groundwork/verify.json"));
  expect(() => loadConfig(root)).toThrow(".groundwork/verify.json");
});

test.each([".groundwork/verify.json", "verify.json"])("feature fragments compose with %s and resolve cross-file references after merging", base => {
  const root = temporaryDirectory();
  write(root, base, JSON.stringify({
    context: { fixture: "shared" },
    checks: { base: check({ covers: ["editing"] }) },
    invariants: { durable: { description: "Stored changes survive", checks: ["storage"] } },
  }));
  write(root, ".groundwork/verify.d/z-storage.json", JSON.stringify({
    checks: { storage: check({ covers: ["storage"] }) },
    behaviours: { storage: { description: "Store a document", dependsOn: ["editing"] } },
  }));
  write(root, ".groundwork/verify.d/a-editor.json", JSON.stringify({
    context: { fixture: "shared", data: "small" },
    checks: { editor: check({ covers: ["editing"] }) },
    behaviours: { editing: { description: "Edit a document", dependsOn: ["storage"], paths: ["src/editor/**"], guide: ".groundwork/guides/editor.md#editing" } },
  }));
  write(root, ".groundwork/guides/editor.md", "# Editing\n\nUse the editor.\n");
  write(root, ".groundwork/verify.d/README.md", "Feature fragments live here.\n");
  const config = loadConfig(root);
  expect(hasConfig(root)).toBe(true);
  expect(Object.keys(config.checks)).toEqual(["base", "editor", "storage"]);
  expect(config.checks.storage.covers).toEqual(["storage", "durable"]);
  expect(config.behaviours.editing.dependsOn).toEqual(["storage"]);
  expect(config.context).toEqual({ fixture: "shared", data: "small" });
  expect(selectChecks(config, { changedPaths: ["src/editor/view.mjs"] }).names).toEqual(["base", "editor", "storage"]);
  expect(catalogueIssues(config, root)).toEqual([]);
  expect(catalogue(config, "editing")[0].source).toBe(join(root, ".groundwork/verify.d/a-editor.json"));
  expect(config.provenance.checks.storage).toBe(join(root, ".groundwork/verify.d/z-storage.json"));
  expect(parseConfig(config)).toEqual(config);
});

test("fragment-only adoption is discoverable and canonical config still takes precedence over legacy config", () => {
  const root = temporaryDirectory();
  expect(hasConfig(root)).toBe(false);
  write(root, ".groundwork/verify.d/README.md", "Only JSON files are configuration.\n");
  expect(hasConfig(root)).toBe(false);
  write(root, ".groundwork/verify.d/editor.json", JSON.stringify({ checks: { editor: check() } }));
  expect(hasConfig(root)).toBe(true);
  expect(Object.keys(loadConfig(root).checks)).toEqual(["editor"]);
  write(root, "verify.json", JSON.stringify({ checks: { legacy: check() } }));
  expect(Object.keys(loadConfig(root).checks)).toEqual(["legacy", "editor"]);
  write(root, ".groundwork/verify.json", JSON.stringify({ checks: { current: check() } }));
  expect(Object.keys(loadConfig(root).checks)).toEqual(["current", "editor"]);
  write(root, ".groundwork/verify.json", "{invalid}");
  expect(() => loadConfig(root)).toThrow(".groundwork/verify.json");
});

test("duplicate fragment definitions and context conflicts identify both source files", () => {
  const conflicts = [
    [{ checks: { editor: check() } }, { checks: { editor: check() } }, "Duplicate checks ID"],
    [{ behaviours: { editing: { description: "Edit" } } }, { behaviours: { editing: { description: "Edit" } } }, "Duplicate behaviours ID"],
    [{ invariants: { durable: { description: "Save", checks: ["editor"] } } }, { invariants: { durable: { description: "Save", checks: ["editor"] } } }, "Duplicate invariants ID"],
    [{ behaviours: { editing: { description: "Edit" } } }, { invariants: { editing: { description: "Edit safely", checks: ["editor"] } } }, "Duplicate catalogue ID"],
    [{ context: { fixture: "small" } }, { context: { fixture: "large" } }, 'Conflicting context key "fixture"'],
  ];
  for (const [first, second, message] of conflicts) {
    const root = temporaryDirectory();
    write(root, ".groundwork/verify.json", JSON.stringify({ checks: { editor: check() }, ...first }));
    write(root, ".groundwork/verify.d/editor.json", JSON.stringify(second));
    let error;
    try { loadConfig(root); } catch (caught) { error = caught; }
    expect(error?.message).toContain(message);
    expect(error?.message).toContain(join(root, ".groundwork/verify.json"));
    expect(error?.message).toContain(join(root, ".groundwork/verify.d/editor.json"));
  }
});

test("fragment errors retain the owning path for malformed values and unresolved references", () => {
  const root = temporaryDirectory();
  const fragment = ".groundwork/verify.d/editor.json";
  for (const [content, message] of [
    ["{invalid}", "Cannot read"],
    [JSON.stringify({ checks: { editor: check({ covers: ["missing"] }) } }), "unknown catalogue reference: missing"],
    [JSON.stringify({ behaviours: { editor: { description: "Edit", dependsOn: ["missing"] } } }), "unknown behaviour reference: missing"],
    [JSON.stringify({ invariants: { durable: { description: "Save", checks: ["missing"] } } }), "unknown check reference: missing"],
    [JSON.stringify({ checks: { editor: check({ reuse: { unknown: true } }) } }), 'unknown field "unknown"'],
  ]) {
    write(root, fragment, content);
    let error;
    try { loadConfig(root); } catch (caught) { error = caught; }
    expect(error?.message).toContain(message);
    expect(error?.message).toContain(join(root, fragment));
  }
});

test("reuse declarations normalize opt-in inputs and reject unusable or unknown bindings", () => {
  const config = parseConfig({ checks: {
    absent: check(), disabled: check({ reuse: false }), enabled: check({ reuse: true }),
    inputs: check({ reuse: { env: ["MODE", "REGION", "MODE"], files: ["ignored/data.json", "bun.lock", "bun.lock"], revision: true } }),
  } });
  expect(config.checks.absent.reuse).toBe(false);
  expect(config.checks.disabled.reuse).toBe(false);
  expect(config.checks.enabled.reuse).toEqual({ env: [], files: [], revision: false });
  expect(config.checks.inputs.reuse).toEqual({ env: ["MODE", "REGION"], files: ["bun.lock", "ignored/data.json"], revision: true });
  expect(parseConfig(config)).toEqual(config);
  for (const reuse of [null, "true", [], { unknown: true }, { env: "MODE" }, { env: [""] }, { revision: "true" }, { files: [42] },
    ...["../outside", "/absolute", "C:\\outside", "https://example.test/data", "file\0.json", "src/**", "src/?.json", "src/[ab].json", "src/{a,b}.json"].map(path => ({ files: [path] }))]) {
    expect(() => parseConfig({ checks: { editor: check({ reuse }) } })).toThrow(".checks.editor.reuse");
  }
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
