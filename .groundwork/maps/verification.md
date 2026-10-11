# Local verification flow

## Scope and source basis

- **Question:** how local project discovery, configuration/catalogue selection, execution, and saved reports connect. PR verification is included only as a consumer of the shared flow; installation, distribution, and PR comment publishing are outside this map.
- **Inspected:** 2026-10-11; revision `3cacfb17f5037e29e9965204e91a2d7b58871b0c`, plus the working tree described below.
- **Relevant working-tree changes:** the new `skills/explore/` skill/template and edits to `.groundwork/VERIFY.md`, `skills/verify-work/SKILL.md`, `skills/verify-work/project.md`, `skills/verify-work/references/verification.md`, and `pr-verification/prompts/{plan,verify}.md` add map discovery, maintenance, and evidence guidance. README, workflow, contribution, and implementation-skill documentation also integrate exploration. The runtime modules and assertion sources cited below had no local changes at inspection. The subsequent `.groundwork/verify.json` edit links the existing `catalogue` entry to this map without changing check bindings. These documentation/configuration changes participate in source freshness.
- **Source basis:** the [CLI](../../skills/verify-work/verify.mjs), [layout](../../lib/layout.mjs), [configuration](../../lib/config.mjs), [assessment model](../../lib/model.mjs), [runner](../../lib/runner.mjs), and shared portions of the [PR wrapper](../../pr-verification/scripts/verify.mjs). Assertion sources are identified under [Verification options and gaps](#verification-options-and-gaps).
- **Evidence limits:** the flow below is **source read**, unless labelled otherwise. The only CLI interaction observed was read-only catalogue discovery, recorded under [Runtime observations](#runtime-observations). No verification run, saved report, baseline comparison, or live PR agent was exercised for this map. Test assertions were read, not run.

## Behaviour and entrypoints

Groundwork resolves a configured project, selects its project-owned checks, combines an optional task plan with active invariants, and runs checks against identified source. It retains logs, observations, and artifacts, then assesses both execution and requirement coverage. A later report view reassesses the saved evidence and source freshness without rerunning the checks.

The installed `groundwork` entry is `skills/verify-work/verify.mjs` ([package.json — `bin`](../../package.json)). Local entrypoints are `init [directory]`, `view guide [query]`, `verify [check ...] [--plan file] [--changed ref] [--base ref]`, and `view report`. Names passed to `verify` are **check IDs**, not behaviour IDs.

Existing journeys remain in the guide: [Adopt a project](../VERIFY.md#adopt-a-project), [Plan and select verification](../VERIFY.md#plan-and-select-verification), [Verify a behaviour and review evidence](../VERIFY.md#verify-a-behaviour-and-review-evidence), and [Exercise a driver and compare revisions](../VERIFY.md#exercise-a-driver-and-compare-revisions). Relevant catalogue IDs are `adoption`, `catalogue`, `coverage`, `drivers`, and invariant `complete-evidence` ([.groundwork/verify.json](../verify.json)).

## Code ownership and state

| Owner | Responsibility and state |
| --- | --- |
| [skills/verify-work/verify.mjs — `projectRoot`, `options`, `guide`, `run`, `report`](../../skills/verify-work/verify.mjs) | Local command dispatch, project discovery, option parsing, run identity, signal handling, incremental `result.json` writes, `.groundwork/latest`, and report presentation. |
| [lib/layout.mjs — `initializeLayout`, `groundworkPath`, `runtimeExclusions`](../../lib/layout.mjs) | Canonical storage paths, preservation/migration of legacy files, and the shared list of runtime paths excluded from source matching. |
| [lib/config.mjs — `configPath`, `parseConfig`, `catalogue`, `selectChecks`, `catalogueIssues`](../../lib/config.mjs) | Configuration validation/defaults, catalogue/check relationships, selection reasons and gaps, and guide file/anchor validation. Normalized configuration lives in memory for the invocation. |
| [lib/model.mjs — `validatePlan`, `withInvariants`, `coverage`, `assess`, `capture`, `refreshEvidence`](../../lib/model.mjs) | Frozen requirement objects, invariant requirements, evidence validity/hashes, comparison/measurement assessment, and status rules. Assessment derives coverage; it does not determine whether a project's assertion actually proves the prose expectation. |
| [lib/runner.mjs — `source`, `changedFiles`, `executeCommand`, `trial`, `runChecks`](../../lib/runner.mjs) | Git source snapshots, Bash child processes, per-trial lifecycle/evidence, optional baseline worktree lifetime, repeated outcomes, and progress callbacks. Drivers own application state, isolation, and assertions. |
| [pr-verification/scripts/verify.mjs](../../pr-verification/scripts/verify.mjs) | Separate PR orchestration around the same config, runner, and model; owns PR context, planning/agent stages, and its report envelope. |

## Flow

```text
cwd → projectRoot → loadConfig
                    ├─ view guide → catalogue → guide-reference issues
                    └─ verify → changedFiles? → selectChecks
                         → task plan + active invariants → initial result + latest
                         → runChecks → trial logs/artifacts/observations
                         → assess + incremental saves → report
latest → saved result → source check + refreshEvidence → assess → display/exit
```

### Project discovery

`projectRoot()` starts at the invocation directory, except that a path inside `.groundwork/` starts above its last `.groundwork` component. It walks upward to the first configuration, checking each directory before stopping at a `.git` boundary or filesystem root. Thus `.groundwork/config/verify.json` is not accidentally treated as the adopted project's configuration when invoked there ([skills/verify-work/verify.mjs, lines 74–85](../../skills/verify-work/verify.mjs)).

`configPath(root)` prefers `.groundwork/verify.json`; root `verify.json` is a fallback only when the canonical path is absent. An invalid canonical file or dangling symlink does not trigger legacy fallback ([lib/config.mjs — `configPath`, `loadConfig`](../../lib/config.mjs); [test/config.test.mjs, lines 197–219](../../test/config.test.mjs)). `init` uses its explicit directory/current directory rather than this upward discovery. It creates missing guide/configuration files and preserves or migrates existing content through `initializeLayout`; the initial empty `checks` object is not an executable verification scenario.

`verify` and `view report` require Git for `source()`. Guide inspection itself does not. Check commands execute from the discovered project root, but a local `--plan` input is resolved against the **invocation cwd** with `resolve(requested.plan)` ([skills/verify-work/verify.mjs — `run`, line 175](../../skills/verify-work/verify.mjs)).

### Catalogue and selection

`parseConfig` rejects unknown fields and invalid references, supplies check defaults, and adds each invariant's ID to its enforcing checks' `covers`. Behaviours may have no checks; configured invariants must name existing checks. See [lib/config.mjs, lines 95–140](../../lib/config.mjs) and the [configuration reference](../../skills/verify-work/references/verification.md#project-configuration).

`view guide [query]` searches IDs, descriptions, paths, and behaviour entrypoints case-insensitively. It prints matching entries and checks, then validates those entries' `guide` files/anchors. It executes no check command. Validation checks a safe project-relative Markdown target, including realpath containment and headings/explicit anchors; it does **not** recursively check Markdown links or establish the map's factual accuracy ([lib/config.mjs — `catalogue`, `markdownAnchors`, `catalogueIssues`](../../lib/config.mjs); [CLI — `guide`](../../skills/verify-work/verify.mjs)).

For execution, `selectChecks` unions these reasons, preserving configuration check order:

1. All checks when neither names nor `--changed` are supplied; otherwise explicitly named checks.
2. Every `required` check.
3. With `--changed`, direct check-path matches and matches against covered catalogue paths. Checks without direct or covered catalogue scope remain conservative selections.
4. Checks covering active invariants. Without `--changed`, all invariants are active even for a named run. With it, unscoped invariants remain active and scoped invariants activate on matching paths.

`changedFiles(root, ref)` resolves a commit and compares it to the working tree, also including non-ignored untracked files. Runtime paths are excluded; selection patterns use `node:path.matchesGlob`. This selects work; it does not perform the separate `--base` comparison. Returned `reasons`, `omitted`, `invariants`, `unmappedPaths`, and `uncoveredBehaviours` are retained in the report. Unmapped paths and uncovered behaviours are planning signals, not automatic failure conditions ([lib/config.mjs — `selectChecks`, lines 161–196](../../lib/config.mjs); [lib/runner.mjs — `changedFiles`](../../lib/runner.mjs)).

**A local task plan does not schedule its checks.** Selection happens before `validatePlan` and `withInvariants`. A plan-bound check omitted by selection leaves required coverage unverified. Stale catalogue references relevant to selected checks/active invariants enter assessment as problems; commands can still run, but a passing claim cannot result while those problems remain ([CLI — `run`, lines 169–184](../../skills/verify-work/verify.mjs)).

### Plan and run snapshot

`validatePlan` freezes the goal and requirement bindings. `withInvariants` appends required `invariant:<id>` entries and rejects collisions with those active invariant requirement IDs. It can create a plan consisting only of invariants when no task plan was supplied ([lib/model.mjs, lines 41–67](../../lib/model.mjs)).

Once validation and initial source capture succeed, `run` creates a version-2 result under `.groundwork/runs/<timestamp_uuid>/result.json` with pending checks and `finishedAt: null`, then updates `.groundwork/latest` **before execution**. `runChecks` saves `plan.json`, exposes it to drivers, detects changes/removal during execution, and restores the original snapshot. Its callback saves after each aggregated check, including the retained trials; this is not a per-trial transactional checkpoint ([CLI — `run`, lines 178–213](../../skills/verify-work/verify.mjs); [lib/runner.mjs — `runChecks`, lines 184–259](../../lib/runner.mjs)).

An interrupted initialized run supersedes the previous latest run and remains unfinished. Errors before initialization—such as invalid options, configuration, selection, or plan—return exit `2` without creating a new latest report. These are distinct paths.

### Execution and comparison

`runChecks` processes selected checks serially. Each trial receives a fresh `artifacts/` directory, source fingerprint, plan path, and declared context. Optional setup, exercise `command`, and optional cleanup run in separate Bash processes with `-e` and `pipefail`, all from the candidate project root. Shell exports from setup do not persist into the exercise. Failed setup skips exercise; cleanup is attempted in `finally` with no abort signal ([lib/runner.mjs — `executeCommand`, `trial`](../../lib/runner.mjs)).

Drivers receive `GROUNDWORK_EVIDENCE_DIR`/legacy `VERIFY_ARTIFACTS`, `GROUNDWORK_PROJECT_DIR`, `GROUNDWORK_SOURCE_DIR`, phase, trial number, and `GROUNDWORK_PLAN`; the full contract is in [Driver lifecycle and evidence](../../skills/verify-work/references/verification.md#driver-lifecycle-and-evidence). Structured results contribute observations, measurements, and context. Declared artifacts and observation evidence must be nonempty files contained within that trial's evidence directory, including through symlinks. An observation cannot cite its result file directly or through a symbolic-link alias. Evidence and logs are hashed; contradictory declared context or source changes during the trial prevent a clean pass ([lib/model.mjs — `capture`, `inspectObservations`, `inspectDriver`](../../lib/model.mjs); [lib/runner.mjs — `trial`, lines 127–168](../../lib/runner.mjs)).

Exercise exit `0` passes the process stage; `2`, unavailable commands (`126`/`127`), interruption, and launch failures are inconclusive. Other nonzero exercise exits fail. Nonzero setup/cleanup outcomes are inconclusive. `statusOf` gives recorded failures priority over incompleteness. Repetition retains all requested candidate outcomes; a later success cannot erase an earlier failure.

For `--base`, at least one selected check must declare `compare`. A temporary detached worktree provides baseline source; **both phases use the candidate's driver and cwd**, so the driver must target `GROUNDWORK_SOURCE_DIR`. Non-comparison checks run only on the candidate. Regression comparison requires a usable baseline assertion failure and candidate success; measurement comparison uses matching context, declared units/budgets, and median samples. Checkout/cleanup problems remain report problems; baseline removal is attempted in `finally` ([lib/runner.mjs — `baselineCheckout`, `runChecks`](../../lib/runner.mjs); [lib/model.mjs — `compareTrials`](../../lib/model.mjs)). See the existing [comparison journey](../VERIFY.md#exercise-a-driver-and-compare-revisions).

### Saved report reassessment

`report()` chooses `.groundwork/latest`, falling back to `.verify/latest` only when the canonical pointer is absent. It validates the saved version-1 or version-2 report, flags unfinished runs and changed source, rechecks retained logs/artifacts/observations with `refreshEvidence`, then calls `assess`. It prints this reassessment and returns its exit code; it does not rewrite the saved result or rerun commands ([CLI — `validateReport`, `report`, lines 87–136](../../skills/verify-work/verify.mjs)).

Coverage links requirements to explicitly bound checks, catalogue coverage, and evidence-backed observations. Missing explicit checks or required behaviour coverage stays **unverified**. Overall status is **passed / 0** only when checks, observations, required coverage, and problems allow it; **failed / 1** takes priority when a failure remains recorded; otherwise status is **inconclusive / 2**. Thus source/evidence staleness prevents reuse of a success, but does not erase a recorded check failure ([lib/model.mjs — `statusOf`, `coverage`, `assess`, `refreshEvidence`, `exitCode`](../../lib/model.mjs)).

### Shared PR flow

The [PR wrapper](../../pr-verification/scripts/verify.mjs) supplies an explicit repository/project directory rather than local upward discovery. It reuses `configPath`/`loadConfig`, `changedFiles`/`selectChecks`, catalogue validation, `withInvariants`, `runChecks`, source fingerprints, `refreshEvidence`, and `assess` (lines 43–179).

- Its suggested changed selection uses `HEAD^1` when available. Unlike local `--plan`, PR planning also adds checks explicitly bound in requirements or covering their behaviours. A workflow command block becomes a synthetic configured check; required, plan-bound, and active invariant checks are still added.
- Shared drivers run after PR setup. Agent observations are subsequently normalized through `inspectObservations` and merged into the same requirement assessment. The final PR verdict additionally requires completed planning, setup/checks, and agent verification ([pr-verification/scripts/report.mjs — `inspectAgent`, `verdict`](../../pr-verification/scripts/report.mjs)).
- PR output defaults to the selected project's `.groundwork/runs/pr-<uuid>/`; the reusable workflow overrides it with runner-temporary storage. PR `result.json` is a separate envelope with a nested `verification` assessment. It does **not** update local `.groundwork/latest` or use the CLI report format ([wrapper, lines 11–30](../../pr-verification/scripts/verify.mjs); [.github/workflows/verify.yml — verification output and evidence upload](../../.github/workflows/verify.yml)).

Continue with [Final PR verification](../VERIFY.md#final-pr-verification) for that journey.

## Constraints and change impact

- **Shared contracts:** config fields/catalogue IDs, driver results, assessment statuses, and evidence records are consumed by both local and PR orchestration. Changes in `lib/config.mjs`, `lib/model.mjs`, or `lib/runner.mjs` need both caller paths considered; the local and PR outer result formats are not interchangeable.
- **Source boundary:** `source()` hashes Git revision, project-scoped tracked changes, and non-ignored untracked content (symlinks contribute their link target text). `runtimeExclusions` omits legacy `.verify/` and `.groundwork/{runs,latest,plans,tasks,tmp,plan.json}` runtime paths. Tracked or non-ignored untracked guides, maps, configuration, reusable scripts, and supporting configs remain source inputs. Editing this map can therefore invalidate a prior passing result ([lib/runner.mjs — `source`](../../lib/runner.mjs); [lib/layout.mjs — `runtimeExclusions`](../../lib/layout.mjs)). Ignored untracked inputs and external services require explicitly recorded context and appropriate new observations.
- **Coverage is a binding contract:** `coverage` checks IDs/statuses/evidence, not semantic correspondence between an assertion and the task's prose. The project owns that correspondence. Preserve existing `covers` and invariant `checks` bindings; a new map link provides navigation, not a new enforcing assertion.
- **Extension points:** add project-owned commands/drivers and supported config fields rather than application logic in the shared runner. `kind` is descriptive metadata, not a separate executor. Keep catalogue `paths` and `guide` project-root-relative; Markdown links inside this map are relative to this file.
- **Cancellation boundary:** the local CLI handles SIGINT/SIGTERM through an abort controller, and `executeCommand` sends SIGTERM to the child process group on non-Windows platforms. Cleanup runs without that signal. There is no local timeout/escalation in these functions; hard termination or noncooperative processes can prevent graceful completion ([CLI — `run`](../../skills/verify-work/verify.mjs); [lib/runner.mjs — `executeCommand`, `trial`](../../lib/runner.mjs)).

## Verification options and gaps

The current catalogue has one required check, **`tests`**, running `bun test`; it covers the mapped behaviours and enforces configured invariant `complete-evidence` ([.groundwork/verify.json](../verify.json)). These are existing options, not passed observations from this mapping task.

| Behaviour or constraint | Existing journey / assertion source | Check ID | What it asserts / remaining gap |
| --- | --- | --- | --- |
| Discovery, canonical precedence, project-root commands, legacy reports | [Adoption journey](../VERIFY.md#adopt-a-project); [test/config.test.mjs, lines 197–219](../../test/config.test.mjs); [test/verify.test.mjs, lines 286–324](../../test/verify.test.mjs) | `tests` | Canonical config wins; nested and `.groundwork/` invocation uses project-root commands; legacy latest remains readable until replaced. The read-only observation below exercises only this repository's guide lookup. |
| Catalogue, changed/named selection, active invariants | [Selection journey](../VERIFY.md#plan-and-select-verification); [test/config.test.mjs, lines 28–173](../../test/config.test.mjs); [test/runner.test.mjs, lines 127–175](../../test/runner.test.mjs) | `tests` | Selection unions, scoped/global invariants, unmapped signals, guide search, stale anchors/files, and symlink containment. Link validation does not establish a map's source accuracy. |
| Requirement coverage and frozen plans | [test/runner.test.mjs, lines 78–125](../../test/runner.test.mjs) | `tests` | Missing outcomes and partial multi-behaviour coverage remain unverified; a driver cannot shrink the plan; invalid requirements stop execution. |
| Lifecycle, repetition, comparisons, trial evidence isolation | [Driver journey](../VERIFY.md#exercise-a-driver-and-compare-revisions); [test/runner.test.mjs, lines 204–358](../../test/runner.test.mjs) | `tests` | Real local HTTP observation/cleanup, retained mixed outcomes, baseline/candidate targeting, worktree removal, unavailable or nonreproducing baseline, measurement regression/context mismatch, and evidence aliases. No current runtime observation from this task. |
| Saved success cannot conceal missing/stale evidence or interruption | [Evidence journey](../VERIFY.md#verify-a-behaviour-and-review-evidence); [test/verify.test.mjs, lines 240–284 and 326–411](../../test/verify.test.mjs); [test/runner.test.mjs, lines 324–371](../../test/runner.test.mjs) | `tests` | Fail/fix evidence retention, source/runtime exclusions, missing or altered evidence, unfinished latest, and version-1 compatibility. The interruption assertion checks latest/report status, not lifecycle cleanup after cancellation. |
| PR consumption of shared config/assessment | [PR journey](../VERIFY.md#final-pr-verification); [pr-verification/test/verification.test.mjs, lines 96–187 and 204–225](../../pr-verification/test/verification.test.mjs) | `tests` | Failed checks survive positive agent reports, incomplete plans remain incomplete, canonical/legacy catalogue input enforces an invariant, nested project output/cwd works, and missing evidence/source changes block success. These fixtures use a fake Copilot executable, not live agent verification. |

The package assertion also discovers bundled skills and reads their direct Markdown references, so the new `explore` skill/template participates when packaged ([test/package.test.mjs, lines 19–36](../../test/package.test.mjs)). It does not assert the factual contents of project maps or recursively validate their links.

## Runtime observations

**Runtime observed — initial mapping pass, 2026-10-11:** macOS, Bun `1.3.14`, revision and documentation changes identified above, before the catalogue-link edit. From the project's `.groundwork/` directory, this read-only command completed successfully:

```sh
bun ../skills/verify-work/verify.mjs view guide catalogue
```

Retained stdout excerpt (evidence is inline in this map):

```text
catalogue (behaviour) — Discover behaviours and enforce applicable project invariants
  Entry: groundwork view guide / groundwork verify --changed <ref>
  Guide: .groundwork/VERIFY.md#plan-and-select-verification
  Paths: lib/config.mjs, test/config.test.mjs, .groundwork/verify.json
  Checks: tests
```

This observed discovery from `.groundwork/`, loading of the real catalogue, and resolution of its then-current guide anchor. It did not exercise check selection/execution, write a run, or refresh saved evidence. The catalogue now links to this map; rerun the command to inspect its current target.

**Document validation — same environment/date:** a read-only Bun script checked the map's 24 unique Markdown link targets with filesystem inspection and `lib/config.mjs`'s `parseConfig`/`catalogueIssues` for Markdown anchors. It also validated the proposed `catalogue` guide `.groundwork/maps/verification.md#catalogue-and-selection` using an in-memory configuration change. Result: `uniqueLinksChecked: 24`, `problems: []`; no configuration file was edited. This is link validation, not execution evidence for the mapped behaviours.

## Unknowns and refresh triggers

- **Runtime gap:** full execution, saved-report reassessment, cancellation cleanup, and baseline/PR behaviour remain source-derived here. The table identifies existing verification paths; targeted fixture execution or a real project run would provide new observations. No existing run evidence was reused.
- **Environment gap:** source fingerprints do not establish ignored dependency/data freshness or remote service state. The driver/project must identify relevant context and observations; inspect those before applying a saved passing result to a different environment.
- **Refresh triggers:** recheck discovery on CLI/layout changes; selection on configuration, catalogue paths/bindings, or Git-scope changes; execution/evidence on runner/model or driver-contract changes; and both callers on shared changes. Recheck table claims when assertions change. Guide/map anchors can be validated mechanically, but current source claims and runtime evidence require their own review.
