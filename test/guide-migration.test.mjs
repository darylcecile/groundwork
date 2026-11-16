import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { catalogueIssues, markdownAnchors, parseConfig } from "../lib/config.mjs";
import { planGuideMigration, rewriteMarkdown } from "../lib/guide-migration.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-guide-"));
  directories.push(root);
  return root;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function guide(plan, source, anchor) {
  return plan.writes.get(plan.references.get(`${source}#${anchor}`).split("#")[0]);
}

function inspectReferences(root, plan) {
  for (const [path, content] of plan.writes) write(root, path, content);
  const behaviours = Object.fromEntries([...plan.references].map(([old, guide], index) => [String(index), { description: old, guide }]));
  expect(catalogueIssues(parseConfig({ checks: {}, behaviours }), root)).toEqual([]);
}

test("substantive sections become bounded guides even without catalogue references", () => {
  const root = temporaryDirectory();
  const sections = ["Run checks", "Runtime/persistence", "Authentication", "Stage clarification", "Planner", "Factory actions", "Interface", "Evidence limits"];
  const content = "# Factory UI verification\n\nKeep the development server running.\n\n" + sections.map((title, index) =>
    `## ${title}\n\nAuthored instructions ${index}, including their caveat.\n\n\`\`\`sh\nbun run check-${index}\n\`\`\`\n\n`).join("");
  const source = ".groundwork/VERIFY.md";
  const plan = planGuideMigration(root, [{ path: source, content }]);
  expect(plan.references.get(source)).toBe(".groundwork/guides/project.md");
  const projectLink = plan.writes.get(source).match(/\[Project context\]\(([^)]+)\)/)[1];
  const projectPath = posix.join(posix.dirname(source), decodeURIComponent(projectLink));
  const project = plan.writes.get(projectPath);
  expect(project).toContain("# Factory UI verification\n\nKeep the development server running.\n\n");
  const links = [...project.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)$/gm)];
  expect(links.map(link => link[1])).toEqual(sections);
  const destinations = new Set();
  links.forEach(([, title, href], index) => {
    const [file, anchor] = href.split("#").map(decodeURIComponent);
    const destination = posix.join(posix.dirname(projectPath), file);
    destinations.add(destination);
    const output = plan.writes.get(destination);
    expect(markdownAnchors(output).has(anchor)).toBe(true);
    expect(output).toContain(`## ${title}\n\nAuthored instructions ${index}, including their caveat.`);
    expect(output).toContain(`\`\`\`sh\nbun run check-${index}\n\`\`\``);
  });
  expect(destinations.size).toBe(sections.length);
  inspectReferences(root, plan);
});

test("heading-only containers expand into journeys while preamble, definitions and caveats survive", () => {
  const root = temporaryDirectory();
  const source = "VERIFY.md";
  const content = [
    "# Verification", "", "Shared context applies to every journey.", "", "## Journeys", "",
    "[source]: src/main.mjs", '  "Implementation source"', "", "### Save a draft", "",
    "Use [source] and [restart](#restart). Keep unsaved changes until confirmation.", "",
    "### Restart", "", "Restart and inspect [source].", "", "## Evidence limits", "",
    "A passing unit test does not establish a live deployment.", "",
  ].join("\n");
  const plan = planGuideMigration(root, [{ path: source, content }]);
  const project = plan.writes.get(".groundwork/guides/project.md");
  expect(project).toContain("Shared context applies to every journey.");
  expect(project).toContain("## Journeys");
  const save = guide(plan, source, "save-a-draft");
  expect(save).toContain("Use [source] and [restart](restart.md#restart). Keep unsaved changes until confirmation.");
  expect(save).toContain('[source]: ../../src/main.mjs\n  "Implementation source"');
  expect(guide(plan, source, "restart")).toContain("Restart and inspect [source].");
  expect(guide(plan, source, "evidence-limits")).toContain("A passing unit test does not establish a live deployment.");
  expect(plan.deletes.has(source)).toBe(true);
  inspectReferences(root, plan);
});

test("repeated, explicit and setext anchors relocate with outgoing and incoming links, preserving code samples", () => {
  const root = temporaryDirectory();
  const source = ".groundwork/VERIFY.md";
  const sample = '````md\n## Example only\n[do not rewrite](VERIFY.md#save)\n```\n<a id="example-anchor"></a>\n````';
  const content = [
    "# Verification", "", "[second save](#save-1)", "", "## Save", "",
    "[restart](#restart-safely) · [custom](#custom-id) · [named](#named)", "",
    "![screen](../images/save%20draft.png) and [implementation](../src/save.mjs?raw=1#main)", "",
    '[upstream](https://example.com/VERIFY.md#save) and `literal [save](VERIFY.md#save)`', "",
    sample, "", "## Save", "", "Save again, preserving the original repeated anchor.", "",
    '<a name="named"></a>', "", "Restart safely", "--------------", "", "Confirm the persisted state.", "",
    "## Advanced save {#custom-id}", "", '<img src="../images/custom.png">', "",
    '<a href="#save-1">Return to the second save</a>', "",
  ].join("\n");
  const plan = planGuideMigration(root, [{ path: source, content }]);
  const first = guide(plan, source, "save");
  expect(first).toContain("[restart](restart-safely.md#restart-safely)");
  expect(first).toContain("[custom](advanced-save.md#custom-id)");
  expect(first).toContain("![screen](../../images/save%20draft.png)");
  expect(first).toContain("[implementation](../../src/save.mjs?raw=1#main)");
  expect(first).toContain("[upstream](https://example.com/VERIFY.md#save)");
  expect(first).toContain("`literal [save](VERIFY.md#save)`");
  expect(first).toContain(sample);
  const secondTarget = plan.references.get(`${source}#save-1`);
  expect(markdownAnchors(guide(plan, source, "save-1")).has("save-1")).toBe(true);
  expect(guide(plan, source, "custom-id")).toContain('<img src="../../images/custom.png">');
  expect(guide(plan, source, "custom-id")).toContain(`href="${secondTarget.replace(".groundwork/guides/", "")}"`);
  expect(guide(plan, source, "named")).toContain("Restart safely\n--------------\n\nConfirm the persisted state.");
  const incoming = '[second](../.groundwork/VERIFY.md#save-1) and [whole](../.groundwork/VERIFY.md)';
  expect(plan.rewriteMarkdown(incoming, "docs/README.md", "docs/README.md")).toBe(
    `[second](../${secondTarget}) and [whole](../.groundwork/guides/project.md)`);
  inspectReferences(root, plan);
});

test("reference destinations, nested parentheses, angle paths and HTML links rebase without touching examples", () => {
  const references = new Map([["VERIFY.md#flow", ".groundwork/guides/flow.md#flow"]]);
  const content = [
    '[flow](VERIFY.md#flow "Guide")', '![drawing](images/flow(1).png)', "[manual](<docs/my guide.md>)", "",
    '[source]:', '  src/main.mjs', '  "Read source"', "", '<a href="VERIFY.md#flow">Flow</a>', "",
    '    [code](VERIFY.md#flow)', '`[inline](VERIFY.md#flow)`', '<pre>[sample](VERIFY.md#flow)</pre>', "",
    '~~~md', '[fenced](VERIFY.md#flow)', '~~~', "", '[url](https://example.com/x(y))', "",
  ].join("\n");
  const output = rewriteMarkdown(content, "README.md", "docs/moved.md", references);
  expect(output).toContain('[flow](../.groundwork/guides/flow.md#flow "Guide")');
  expect(output).toContain('![drawing](../images/flow\\(1\\).png)');
  expect(output).toContain("[manual](<my%20guide.md>)");
  expect(output).toContain('[source]:\n  ../src/main.mjs\n  "Read source"');
  expect(output).toContain('<a href="../.groundwork/guides/flow.md#flow">Flow</a>');
  for (const example of ['    [code](VERIFY.md#flow)', '`[inline](VERIFY.md#flow)`', '<pre>[sample](VERIFY.md#flow)</pre>', '~~~md\n[fenced](VERIFY.md#flow)\n~~~', '[url](https://example.com/x(y))']) {
    expect(output).toContain(example);
  }
});

test("duplicate nested heading links keep their original destination within each new guide", () => {
  const root = temporaryDirectory();
  const source = "VERIFY.md";
  const plan = planGuideMigration(root, [{ path: source, content: [
    "# Verification", "", "## First", "", "First workflow.", "", "### Details", "", "First details.", "",
    "## Second", "", "Second workflow.", "", "### Details", "", "Second details.", "",
    "### Details", "", "Third details.", "",
  ].join("\n") }]);
  const second = guide(plan, source, "second");
  expect(second).toContain('<a id="details-1"></a>\n\n### Details\n\nSecond details.');
  expect(second).toContain('<a id="details-2"></a>\n\n### Details\n\nThird details.');
  inspectReferences(root, plan);
});

test("existing guides coexist deterministically and repeating migration preserves the active layout", () => {
  const root = temporaryDirectory();
  write(root, ".groundwork/guides/project.md", "# Existing context\n\nKeep this context.\n");
  write(root, ".groundwork/guides/SAVE.md", "# Existing save\n\nKeep this journey.\n");
  write(root, ".verify/guides/restart.md", "# Existing restart\n");
  const sources = [
    { path: "VERIFY.md", content: "# Root context\n\n## Save\n\nRoot save.\n" },
    { path: ".verify/VERIFY.md", content: "# Earlier context\n\n## Restart\n\nRestart journey.\n" },
  ];
  const plan = planGuideMigration(root, sources);
  expect([...plan.writes]).toEqual([...planGuideMigration(root, [...sources].reverse()).writes]);
  expect(plan.references.get("VERIFY.md#save")).toMatch(/^\.groundwork\/guides\/save-[a-f0-9]{8}\.md#save$/);
  expect(plan.references.get(".verify/VERIFY.md#restart")).toMatch(/^\.groundwork\/guides\/restart-[a-f0-9]{8}\.md#restart$/);
  expect(plan.writes.get(".groundwork/VERIFY.md")).toContain("[Project context](guides/project.md)");
  inspectReferences(root, plan);
  expect(readFileSync(join(root, ".groundwork/guides/project.md"), "utf8")).toBe("# Existing context\n\nKeep this context.\n");
  expect(readFileSync(join(root, ".groundwork/guides/SAVE.md"), "utf8")).toBe("# Existing save\n\nKeep this journey.\n");
  const repeated = planGuideMigration(root, [".groundwork/VERIFY.md"]);
  expect([...repeated.writes]).toEqual([]);
  expect([...repeated.deletes]).toEqual([]);
});

test("unsplittable authored guidance remains active project context and subsystem maps retain their boundaries", () => {
  const root = temporaryDirectory();
  const content = "# Verification\n\nUse the real service; mocks do not establish recovery.\n\n```sh\nbun verify.mjs\n```\n";
  const map = "# Storage\n\n## Writes\n\nOne subsystem.\n\n## Recovery\n\nThe same subsystem.\n";
  write(root, ".groundwork/maps/storage.md", map);
  const plan = planGuideMigration(root, [{ path: "VERIFY.md", content }, { path: ".groundwork/maps/storage.md", content: map }]);
  expect(plan.writes.get(".groundwork/guides/project.md")).toBe(content);
  expect(plan.relocate("VERIFY.md#verification")).toBe(".groundwork/guides/project.md#verification");
  expect(plan.relocate(".groundwork/maps/storage.md#recovery")).toBe(".groundwork/maps/storage.md#recovery");
  inspectReferences(root, plan);
  expect(readFileSync(join(root, ".groundwork/maps/storage.md"), "utf8")).toBe(map);
});

test("declared whole-document inputs relocate to one active intact guide", () => {
  const root = temporaryDirectory();
  const content = "# Required verification\n\n## Build\n\nRun the build.\n\n## Smoke\n\nExercise the running service.\n";
  const plan = planGuideMigration(root, [{ path: "VERIFY.md", content, split: false }]);
  const target = plan.relocate("VERIFY.md");
  expect(plan.writes.get(target)).toBe(content);
  expect(plan.relocate("VERIFY.md#build")).toBe(`${target}#build`);
  expect(plan.relocate("VERIFY.md#smoke")).toBe(`${target}#smoke`);
  inspectReferences(root, plan);
});

test.each(["one section", "all outputs"])("reuses matching guide bytes after writing %s and preserves differing authored guides", stagedFiles => {
  const root = temporaryDirectory();
  const existingProject = "# Team context\n\nKeep our shared setup.\n";
  const existingSave = "## Save\n\nA separately authored journey.\n";
  write(root, ".groundwork/guides/project.md", existingProject);
  write(root, ".groundwork/guides/save.md", existingSave);
  const source = { path: "VERIFY.md", content: "# Verification\n\nShared context.\n\n## Save\n\nSave, then [restart](#restart).\n\n## Restart\n\nRestart, then [save](#save).\n" };
  const staged = planGuideMigration(root, [source]);
  const outputs = [...staged.writes];
  for (const [path, content] of stagedFiles === "one section" ? outputs.slice(0, 1) : outputs) write(root, path, content);
  const sources = stagedFiles === "one section" ? [source] : [source,
    { path: ".groundwork/VERIFY.md", content: staged.writes.get(".groundwork/VERIFY.md") }];
  const recovered = planGuideMigration(root, sources);
  expect([...recovered.writes]).toEqual(outputs);
  for (const [source, target] of staged.references) expect(recovered.references.get(source)).toBe(target);
  expect(readFileSync(join(root, ".groundwork/guides/project.md"), "utf8")).toBe(existingProject);
  expect(readFileSync(join(root, ".groundwork/guides/save.md"), "utf8")).toBe(existingSave);
});

test("recovers canonical section links after writing the bootstrap before deleting a legacy guide", () => {
  const root = temporaryDirectory();
  const sources = [
    { path: ".groundwork/VERIFY.md", content: "# Canonical\n\n## Setup\n\nStart the service.\n" },
    { path: "VERIFY.md", content: "# Root\n\n## Smoke\n\nUse [setup](.groundwork/VERIFY.md#setup).\n" },
  ];
  for (const { path, content } of sources) write(root, path, content);
  const staged = planGuideMigration(root, sources);
  for (const [path, content] of staged.writes) write(root, path, content);
  const recovered = planGuideMigration(root, sources.map(({ path }) => ({ path, content: readFileSync(join(root, path), "utf8") })));
  const smoke = staged.relocate("VERIFY.md#smoke");
  expect(recovered.relocate(".groundwork/VERIFY.md#setup")).toBe(staged.relocate(".groundwork/VERIFY.md#setup"));
  expect(recovered.relocate("VERIFY.md#smoke")).toBe(smoke);
  expect(recovered.writes.get(smoke.split("#")[0])).toContain("[setup](setup.md#setup)");
  for (const [path, content] of recovered.writes) expect(content).toBe(readFileSync(join(root, path), "utf8"));
});

test("structured relocation uses Unicode filesystem paths while Markdown links use URLs", () => {
  const root = temporaryDirectory();
  const plan = planGuideMigration(root, [{ path: "VERIFY.md", content: "# Verification\n\n## Résumé\n\nReview the résumé.\n" }]);
  for (const [path, content] of plan.writes) write(root, path, content);
  const relocated = plan.relocate("VERIFY.md#r%C3%A9sum%C3%A9");
  expect(relocated.split("#")[0]).toBe(".groundwork/guides/résumé.md");
  const config = parseConfig({ checks: {}, behaviours: { resume: { description: "Review a résumé", guide: relocated } } });
  expect(catalogueIssues(config, root)).toEqual([]);
  expect(plan.rewriteMarkdown("[Résumé](VERIFY.md#résumé)", "README.md")).toBe(
    "[Résumé](.groundwork/guides/r%C3%A9sum%C3%A9.md#r%C3%A9sum%C3%A9)");
});

test("standalone anchors travel with the following H2 or journey heading", () => {
  const root = temporaryDirectory();
  const source = "VERIFY.md";
  const plan = planGuideMigration(root, [{ path: source, content: [
    "# Verification", "", "## Setup", "", "Start the service.", "",
    '<a id="access-check"></a>', '<a name="sign-in"></a>', "", "## Authentication", "", "Sign in and inspect access.", "",
    "## Journeys", "", '<a id="persist"></a>', "### Save", "", "Save and restart the service.", "",
  ].join("\n") }]);
  for (const anchor of ["access-check", "sign-in"]) {
    expect(guide(plan, source, anchor)).toContain("## Authentication\n\nSign in and inspect access.");
  }
  expect(guide(plan, source, "persist")).toContain("### Save\n\nSave and restart the service.");
  inspectReferences(root, plan);
});

test("rebases nested list links and images while retaining indented and fenced code examples", () => {
  const content = [
    "- Runtime", "    [Guide](docs/runtime.md)", "    ![Overview](images/overview.png)",
    "    - [Source](src/main.mjs)", "      ![State](images/state.png)", "",
    "          [nested code](src/example.mjs)", "", "    - Evidence", "      ```md", "      [fenced](src/example.mjs)", "      ```", "",
    "Outside the list.", "", "    [standalone code](src/example.mjs)", "",
  ].join("\n");
  const output = rewriteMarkdown(content, "VERIFY.md", ".groundwork/guides/runtime.md");
  expect(output).toContain("    [Guide](../../docs/runtime.md)");
  expect(output).toContain("    ![Overview](../../images/overview.png)");
  expect(output).toContain("    - [Source](../../src/main.mjs)");
  expect(output).toContain("      ![State](../../images/state.png)");
  expect(output).toContain("          [nested code](src/example.mjs)");
  expect(output).toContain("      ```md\n      [fenced](src/example.mjs)\n      ```");
  expect(output).toContain("    [standalone code](src/example.mjs)");
});
