import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkInventory, digest, ensure, inventory } from "./util.mjs";

export function materializeTrial(runDirectory, experiment, trial, destination) {
  const condition = experiment.conditions.find(item => item.id === trial.condition);
  ensure(condition && experiment.caseIds.includes(trial.caseId), "Trial is outside the frozen experiment.");
  const common = join(runDirectory, "inputs/cli");
  ensure(checkInventory(common, experiment.cli.files) && digest(inventory(common)) === experiment.cli.digest,
    "The pinned Groundwork CLI inputs changed.");
  const fixture = join(runDirectory, "inputs/projects", trial.caseId);
  ensure(digest(inventory(fixture)) === digest(experiment.fixtures[trial.caseId]), "The frozen project fixture changed.");
  ensure(!existsSync(destination), "Trial inputs require a fresh directory.");
  mkdirSync(destination, { recursive: true });
  cpSync(fixture, join(destination, "project"), { recursive: true });
  const target = join(destination, "groundwork");
  cpSync(common, target, { recursive: true });
  rmSync(join(target, "skills"), { recursive: true });
  if (condition.id !== "none") {
    const source = join(runDirectory, "inputs", condition.id);
    ensure(digest(inventory(source)) === condition.digest, "The frozen skill inputs changed.");
    cpSync(join(source, "skills"), join(target, "skills"), { recursive: true });
  }
  const executable = "skills/verify-work/verify.mjs";
  mkdirSync(join(target, "skills/verify-work"), { recursive: true });
  writeFileSync(join(target, executable), readFileSync(join(common, executable)), { mode: 0o755 });
  const hashes = inventory(destination);
  return { directory: destination, digest: digest(hashes), files: hashes };
}
