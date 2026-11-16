import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess, inspectObservations, validateAssessment, validatePlan, withInvariants } from "../lib/model.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const requirement = { id: "readable", expect: "The editor's content is readable", checks: ["editor"], behaviours: ["editing"], review: true };
const plan = () => validatePlan({ goal: "Keep the editor usable", requirements: [requirement] });
const check = (status = "passed") => ({ name: "editor", command: "bun test", expect: "The editor works", covers: ["editing"],
  status, exitCode: status === "passed" ? 0 : 1, durationMs: 1, log: "editor/output.log", artifacts: [] });

function observations(options = {}, producer = "driver") {
  const root = mkdtempSync(join(process.env.VERIFY_TEST_TMPDIR || tmpdir(), "groundwork-model-"));
  directories.push(root);
  writeFileSync(join(root, "review.md"), "The editor content was inspected at narrow and wide sizes.\n");
  return inspectObservations([{ kind: "review", status: "passed", covers: ["readable"],
    observed: "Content remains readable", evidence: ["review.md"], ...options }], root, { producer }).observations;
}

test("review obligations survive frozen-plan persistence and invariant augmentation", () => {
  const value = { goal: "Review the editor", requirements: [{ ...requirement }] };
  const frozen = validatePlan(value);
  value.requirements[0].review = false;
  const saved = validatePlan(JSON.parse(JSON.stringify(frozen)));
  const augmented = withInvariants(saved, { invariants: {
    integrity: { description: "Stored data remains valid", checks: ["storage"] },
  } }, ["integrity"]);
  expect(augmented.requirements[0].review).toBe(true);
  expect(() => { augmented.requirements[0].review = false; }).toThrow();
  expect(augmented.requirements[1].checks).toEqual(["storage"]);
  for (const review of ["true", null, [], {}]) {
    expect(() => validatePlan({ ...value, requirements: [{ ...requirement, review }] })).toThrow("Invalid verification requirement");
  }
});

test("passing automation needs evidence-backed review explicitly covering the requirement", () => {
  for (const recorded of [[], observations({ kind: "assertion" }), observations({ covers: ["unrelated"] }),
    observations({ covers: ["editing"] }), observations({ evidence: ["missing.md"] })]) {
    const result = assess({ plan: plan(), checks: [check()], observations: recorded });
    expect(result.status).toBe("inconclusive");
    expect(result.coverage[0].status).toBe("unverified");
  }
  const result = assess({ plan: plan(), checks: [check()], observations: observations() });
  expect(result.status).toBe("passed");
  expect(result.coverage[0]).toMatchObject({ status: "verified", checks: ["editor"] });
  expect(result.coverage[0].evidence).toContain("review.md");
  expect(validateAssessment(JSON.parse(JSON.stringify(result))).plan.requirements[0].review).toBe(true);
  const optional = validatePlan({ goal: "Verify the editor", requirements: [{ ...requirement, review: false }] });
  expect(assess({ plan: optional, checks: [check()] }).status).toBe("passed");
});

test("requirements sharing a behaviour each need their own explicit review coverage", () => {
  const shared = { checks: ["editor"], behaviours: ["editing"] };
  const task = validatePlan({ goal: "Keep the editor accessible", requirements: [
    { ...shared, id: "layout", expect: "Editor controls remain visible at narrow widths", review: true },
    { ...shared, id: "contrast", expect: "Editor text has readable contrast", review: true },
    { ...shared, id: "editing-controls", expect: "Editor controls respond to input" },
  ] });
  const result = assess({ plan: task, checks: [check()], observations: observations({
    covers: ["layout", "editing"], observed: "All controls were visible at narrow widths",
  }) });
  expect(result.status).toBe("inconclusive");
  expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "layout", status: "verified" },
    { id: "contrast", status: "unverified" },
    { id: "editing-controls", status: "verified" },
  ]);
});

test("agent assertions and measurements do not satisfy explicit review obligations", () => {
  for (const [kind, status] of [["assertion", "unverified"], ["measurement", "unverified"], ["review", "verified"], [undefined, "verified"]]) {
    const recorded = observations({ kind }, "agent");
    expect(recorded[0].kind).toBe(kind ?? "review");
    expect(assess({ plan: plan(), checks: [check()], observations: recorded }).coverage[0].status).toBe(status);
  }
});

test("review obligations preserve failure precedence and do not replace missing planned checks", () => {
  const automatedFailure = assess({ plan: plan(), checks: [check("failed")] });
  expect(automatedFailure.status).toBe("failed");
  expect(automatedFailure.coverage[0].status).toBe("failed");
  const reviewFailure = assess({ plan: plan(), checks: [check()], observations: observations({ status: "failed" }) });
  expect(reviewFailure.status).toBe("failed");
  expect(reviewFailure.coverage[0].status).toBe("failed");
  const missingCheck = assess({ plan: plan(), observations: observations() });
  expect(missingCheck.status).toBe("inconclusive");
  expect(missingCheck.coverage[0]).toMatchObject({ status: "unverified", reason: "Planned checks did not run: editor" });
});
