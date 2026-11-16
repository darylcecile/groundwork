# Local verification flow

## Scope and source basis

- **Question:** how local project discovery, configuration/catalogue selection, execution, and saved reports connect. PR verification is included only as a consumer of the shared flow; installation, distribution, and PR comment publishing are outside this map.
- **Inspected:** 2026-11-16; revision `121dbe9c6169d36c4438330aecf77a95bd2dfd24`, with working-tree changes to storage, receipt reuse, configuration composition, plan selection and their consumers.
- **Source basis:** the [CLI](../../skills/verify-work/verify.mjs), [layout](../../lib/layout.mjs), [evidence store](../../lib/store.mjs), [receipts](../../lib/receipts.mjs), [configuration](../../lib/config.mjs), [terminal map renderer](../../lib/map.mjs), [assessment model](../../lib/model.mjs), [runner](../../lib/runner.mjs), and shared portions of the [PR wrapper](../../pr-verification/scripts/verify.mjs). Assertion sources are identified under [Verification options and gaps](#verification-options-and-gaps).
- **Evidence limits:** this map is source-derived. Runtime observations and their context belong with runs in the external evidence store. Updating this map does not refresh those observations or establish that a check passed.

## Behaviour and entrypoints

Groundwork resolves a configured project, selects its project-owned checks, combines an optional task plan with active invariants, and runs checks against identified source. It retains logs, observations, and artifacts, then assesses both execution and requirement coverage. A later report view reassesses saved evidence, source freshness and receipt identity where present without rerunning checks.

The installed `groundwork` entry is `skills/verify-work/verify.mjs` ([package.json — `bin`](../../package.json)). Local entrypoints are `init [directory]`, `view guide [query]`, `map [feature]`, `verify [check ...] [--plan file] [--changed ref] [--base ref] [--fresh]`, and `view report [id]`. Names passed to `verify` are **check IDs**; a feature in the terminal map is a **behaviour ID**.

CLI invocations outside CI register their project with one user-wide portal through [lib/portal.mjs](../../lib/portal.mjs). The [project registry](../../portal/projects.ts) retains discovery metadata in the user's cache. Its [Hono server](../../portal/server.ts) resolves project-ID-scoped routes and uses the [data adapter](../../portal/data.ts) to read saved external or legacy reports and the merged catalogue. The [React UI](../../portal/ui/main.tsx) provides project selection, receipt/evidence details and an interactive catalogue/map. The portal presents saved statuses and original receipt provenance without the source, evidence or receipt-input reassessment performed by `view report`; project-tagged file events refresh those snapshots. See [Browse the local portal](../VERIFY.md#browse-the-local-portal) for the journey and verification boundaries.

Existing journeys remain in the guide: [Adopt a project](../VERIFY.md#adopt-a-project), [Plan and select verification](../VERIFY.md#plan-and-select-verification), [Verify a behaviour and review evidence](../VERIFY.md#verify-a-behaviour-and-review-evidence), and [Exercise a driver and compare revisions](../VERIFY.md#exercise-a-driver-and-compare-revisions). Relevant catalogue IDs are `adoption`, `catalogue`, `coverage`, `drivers`, and invariant `complete-evidence` ([.groundwork/verify.json](../verify.json)).

## Code ownership and state

| Owner | Responsibility and state |
| --- | --- |
| [skills/verify-work/verify.mjs — `projectRoot`, `options`, `guide`, `map`, `run`, `report`](../../skills/verify-work/verify.mjs) | Local command dispatch, project discovery, option parsing, guide/map reference checks, run identity, signal handling, incremental `result.json` writes and explicit-run report presentation. |
| [lib/layout.mjs — `initializeLayout`, `groundworkPath`, `runtimeExclusions`](../../lib/layout.mjs) | Authored project paths, preservation/migration of legacy files, and runtime exclusions from source matching. |
| [lib/store.mjs — `evidenceStore`, `prepareEvidenceStore`](../../lib/store.mjs) | External repository-scoped runs/receipts, workspace latest pointers and lossless generated-evidence migration. |
| [lib/receipts.mjs — `reusePolicy`, `receiptRecipe`, `reuseReceipt`, `beginReceipt`, `finishReceipt`](../../lib/receipts.mjs) | Input-complete check identity, latest receipt-attempt eligibility, evidence validation and retained-result reuse. |
| [lib/config.mjs — `hasConfig`, `loadConfig`, `catalogue`, `selectChecks`, `catalogueIssues`](../../lib/config.mjs) | Base/fragment composition, cross-file validation/provenance, catalogue/check relationships, plan-aware selection and guide file/anchor validation. Normalized configuration lives in memory for the invocation. |
| [lib/map.mjs — `renderMap`](../../lib/map.mjs) | Behaviour lookup and ASCII rendering of direct dependencies, derived consumers and feature metadata. Returns displayed IDs for guide validation; does not execute checks or write files. |
| [lib/model.mjs — `validatePlan`, `withInvariants`, `coverage`, `assess`, `capture`, `refreshEvidence`](../../lib/model.mjs) | Frozen requirement objects, invariant requirements, evidence validity/hashes, comparison/measurement assessment, and status rules. Assessment derives coverage; it does not determine whether a project's assertion actually proves the prose expectation. |
| [lib/runner.mjs — `source`, `changedFiles`, `executeCommand`, `trial`, `runChecks`](../../lib/runner.mjs) | Git source snapshots, Bash child processes, per-trial lifecycle/evidence, optional baseline worktree lifetime, repeated outcomes, and progress callbacks. Drivers own application state, isolation, and assertions. |
| [pr-verification/scripts/verify.mjs](../../pr-verification/scripts/verify.mjs) | Separate PR orchestration around the same config, runner, and model; owns PR context, planning/agent stages, and its report envelope. |

## Flow

```text
cwd → projectRoot → loadConfig
                    ├─ view guide → catalogue → guide-reference issues
                    ├─ map → declared feature relationships → ASCII view + guide issues
                    └─ verify → task plan + changedFiles? → selectChecks
                         → active invariants → external run + workspace latest
                         → runChecks → matching receipt or fresh trial
                         → assess + incremental saves → report
run ID or workspace latest → saved result → applicability/evidence checks → assess → display/exit
```

### Project discovery

`projectRoot()` starts at the invocation directory, except that a path inside `.groundwork/` starts above its last `.groundwork` component. It walks upward to the first configuration, checking each directory before stopping at a `.git` boundary or filesystem root. Thus `.groundwork/config/verify.json` is not accidentally treated as the adopted project's configuration when invoked there ([skills/verify-work/verify.mjs — `projectRoot`](../../skills/verify-work/verify.mjs)).

`configPath(root)` prefers `.groundwork/verify.json`; root `verify.json` is a fallback only when the canonical path is absent. `hasConfig` also recognizes fragment-only projects. `loadConfig` reads the chosen base followed by sorted `.groundwork/verify.d/*.json` files. An invalid canonical file does not trigger legacy fallback ([lib/config.mjs](../../lib/config.mjs)). `init` uses its explicit directory/current directory rather than upward discovery. It creates missing guide/configuration files and preserves authored content through `initializeLayout`; the initial empty `checks` object is not an executable verification scenario.

`prepareEvidenceStore` imports generated `.groundwork/runs`, `.verify/runs` and latest pointers before removing their originals. It preserves conflicting runs separately and accepts identical concurrent imports. Malformed or orphaned old pointers are archived; they do not block fresh verification. Store overlap with legacy runtime directories is rejected. Storage uses `GROUNDWORK_STATE_HOME`, otherwise `$XDG_STATE_HOME/groundwork`, defaulting to `~/.local/state/groundwork`. The namespace combines the Git common directory with the project's relative location, so matching projects in repository worktrees share evidence while each workspace has its own latest pointer ([lib/store.mjs](../../lib/store.mjs)). Migration preserves historical identity and does not create reusable receipts.

`verify` and `view report` require Git for `source()`. Guide and terminal-map inspection do not. Check commands execute from the discovered project root, but a local `--plan` input is resolved against the **invocation cwd** with `resolve(requested.plan)` ([skills/verify-work/verify.mjs — `run`](../../skills/verify-work/verify.mjs)).

### Catalogue and selection

Configuration parsing rejects unknown fields, supplies check defaults, and validates references after base/fragment composition. Duplicate IDs and conflicting context values identify both source files; catalogue rows retain defining-file provenance. Each invariant's ID is added to its enforcing checks' `covers`. Behaviours may have no checks; invariants must name existing checks. Optional `dependsOn` lists are navigational and do not change selection or check bindings. See [lib/config.mjs](../../lib/config.mjs) and the [configuration reference](../../skills/verify-work/references/verification.md#project-configuration).

`view guide [query]` searches IDs, descriptions, paths, and behaviour entrypoints case-insensitively. It prints matching entries and checks, then validates those entries' `guide` files/anchors. It executes no check command. Validation checks a safe project-relative Markdown target, including realpath containment and headings/explicit anchors; it does **not** recursively check Markdown links or establish the map's factual accuracy ([lib/config.mjs — `catalogue`, `markdownAnchors`, `catalogueIssues`](../../lib/config.mjs); [CLI — `guide`](../../skills/verify-work/verify.mjs)).

For execution, `selectChecks` unions these reasons, preserving configuration check order:

1. All checks when neither names nor `--changed` are supplied; otherwise explicitly named checks.
2. Every `required` check.
3. With `--changed`, direct check-path matches and matches against covered catalogue paths. Checks without direct or covered catalogue scope remain conservative selections.
4. Checks covering active invariants. Without `--changed`, all invariants are active even for a named run. With it, unscoped invariants remain active and scoped invariants activate on matching paths.
5. Explicit plan-bound checks and checks covering the plan's behaviours. Unknown planned check IDs fail validation.

`changedFiles(root, ref)` resolves a commit and compares it to the working tree, also including non-ignored untracked files. Runtime paths are excluded; selection patterns use `node:path.matchesGlob`. This selects work; it does not perform the separate `--base` comparison. Returned `reasons`, `omitted`, `invariants`, `unmappedPaths`, and `uncoveredBehaviours` are retained in the report. Unmapped paths and uncovered behaviours are planning signals, not automatic failure conditions ([lib/config.mjs — `selectChecks`](../../lib/config.mjs); [lib/runner.mjs — `changedFiles`](../../lib/runner.mjs)).

The CLI validates the task plan before selection and passes it to `selectChecks`. `withInvariants` then adds active invariant requirements. Without names or `--changed`, all checks remain selected even with a plan. Stale catalogue references relevant to selected checks/active invariants enter assessment as problems; commands can still run, but a passing claim cannot result while those problems remain ([CLI — `run`](../../skills/verify-work/verify.mjs)).

### Terminal feature maps

The CLI's `map` command loads the same configuration and passes it to [lib/map.mjs — `renderMap`](../../lib/map.mjs). Without a query it displays all behaviour nodes and their recorded direct outgoing edges. A focused query prefers an exact ID, then requires a unique case-insensitive ID/description match. It displays the focus, its direct dependencies and its direct consumers; it does not expand transitively. Cycles therefore remain finite.

Edges come only from behaviour `dependsOn` lists. The renderer uses `catalogue` for descriptions, source/check/guide metadata, and derives consumers by reversing declared edges. Missing links and metadata are labelled as unrecorded/unmapped. Shared paths or covering checks are not dependency evidence. Navigation does not change verification selection, coverage or invariant enforcement.

The CLI validates guides for the displayed IDs with `catalogueIssues` after printing the diagram. A stale guide leaves the diagram visible and returns exit `2`; ambiguous/unknown queries and flags also return `2`. An empty overview returns explanatory guidance and exit `0`. Neither overview nor focused navigation runs a check, initializes a project, or changes its latest-run pointer ([CLI — `map`](../../skills/verify-work/verify.mjs); [test/verify.test.mjs — feature-map scenarios](../../test/verify.test.mjs)).

### Plan and run snapshot

`validatePlan` freezes the goal and requirement bindings. Optional `review: true` requires an evidence-backed `kind: "review"` observation explicitly covering that requirement ID. `withInvariants` appends required `invariant:<id>` entries and rejects collisions with those IDs. It can create an invariant-only plan when no task plan was supplied ([lib/model.mjs](../../lib/model.mjs)).

Once validation and initial source capture succeed, `run` creates a version-2 result in the external store with pending checks and `finishedAt: null`, then updates its workspace's latest pointer **before execution**. `runChecks` saves `plan.json`, exposes it to drivers, detects changes/removal during execution, and restores the original snapshot. Its callback saves completed check results, including trials or reused receipt provenance ([CLI — `run`](../../skills/verify-work/verify.mjs); [lib/runner.mjs — `runChecks`](../../lib/runner.mjs)).

An interrupted initialized run supersedes the previous latest run and remains unfinished. Errors before initialization—such as invalid options, configuration, selection, or plan—return exit `2` without creating a new latest report. These are distinct paths.

### Execution and comparison

Before a trial, the runner evaluates the check's opt-in `reuse` contract. Matching includes whole-source content, normalized check definition, engine/runtime, context, frozen plan, declared environment-value digests and explicit input-file content. The latest matching receipt attempt must be complete with intact evidence; a reusable failure remains failed. Reused evidence is copied into the current run with original provenance. `--fresh`, baseline comparisons, repeated trials and setup/cleanup force execution ([lib/receipts.mjs](../../lib/receipts.mjs)).

`runChecks` processes selected checks serially. Each trial receives a fresh `artifacts/` directory, source fingerprint, plan path, and declared context. Optional setup, exercise `command`, and optional cleanup run in separate Bash processes with `-e` and `pipefail`, all from the candidate project root. Shell exports from setup do not persist into the exercise. Failed setup skips exercise; cleanup is attempted in `finally` with no abort signal ([lib/runner.mjs — `executeCommand`, `trial`](../../lib/runner.mjs)).

Drivers receive `GROUNDWORK_EVIDENCE_DIR`/legacy `VERIFY_ARTIFACTS`, `GROUNDWORK_PROJECT_DIR`, `GROUNDWORK_SOURCE_DIR`, phase, trial number, and `GROUNDWORK_PLAN`; the full contract is in [Driver lifecycle and evidence](../../skills/verify-work/references/verification.md#driver-lifecycle-and-evidence). Structured results contribute observations, measurements, and context. Declared artifacts and observation evidence must be nonempty files contained within that trial's evidence directory, including through symlinks. An observation cannot cite its result file directly or through a symbolic-link alias. Evidence and logs are hashed; contradictory declared context or source changes during the trial prevent a clean pass ([lib/model.mjs — `capture`, `inspectObservations`, `inspectDriver`](../../lib/model.mjs); [lib/runner.mjs — `trial`, lines 127–168](../../lib/runner.mjs)).

Exercise exit `0` passes the process stage; `2`, unavailable commands (`126`/`127`), interruption, and launch failures are inconclusive. Other nonzero exercise exits fail. Nonzero setup/cleanup outcomes are inconclusive. `statusOf` gives recorded failures priority over incompleteness. Repetition retains all requested candidate outcomes; a later success cannot erase an earlier failure.

For `--base`, at least one selected check must declare `compare`. A temporary detached worktree provides baseline source; **both phases use the candidate's driver and cwd**, so the driver must target `GROUNDWORK_SOURCE_DIR`. Non-comparison checks run only on the candidate. Regression comparison requires a usable baseline assertion failure and candidate success; measurement comparison uses matching context, declared units/budgets, and median samples. Checkout/cleanup problems remain report problems; baseline removal is attempted in `finally` ([lib/runner.mjs — `baselineCheckout`, `runChecks`](../../lib/runner.mjs); [lib/model.mjs — `compareTrials`](../../lib/model.mjs)). See the existing [comparison journey](../VERIFY.md#exercise-a-driver-and-compare-revisions).

### Saved report reassessment

`report()` migrates generated legacy evidence, then chooses the requested run ID or the current workspace's latest pointer. A completing invocation supplies its own ID, so another run cannot replace its result through the latest pointer. It validates the saved report, flags unfinished runs and changed source, and rechecks retained logs/artifacts/observations with `refreshEvidence`. For checks with receipt keys, it also recomputes current receipt identity; changed declared environment values, ignored files, engine, runtime or context can make a prior pass inconclusive with unchanged source. Other checks receive source/evidence reassessment only. It calls `assess`, prints the result and returns its exit code without rewriting the saved result or rerunning commands. Historical reports retain their original identity rather than gaining current applicability or reusable receipts ([CLI — `validateReport`, `report`](../../skills/verify-work/verify.mjs)).

Coverage links requirements to explicitly bound checks, catalogue coverage, and evidence-backed observations. Missing explicit checks or required behaviour coverage stays **unverified**. Overall status is **passed / 0** only when checks, observations, required coverage, and problems allow it; **failed / 1** takes priority when a failure remains recorded; otherwise status is **inconclusive / 2**. Source, evidence or receipt-input staleness prevents reuse of a success, but does not erase a recorded check failure ([lib/model.mjs — `statusOf`, `coverage`, `assess`, `refreshEvidence`, `exitCode`](../../lib/model.mjs)).

### Shared PR flow

The [PR wrapper](../../pr-verification/scripts/verify.mjs) supplies an explicit repository/project directory rather than local upward discovery. It reuses configuration composition, plan-aware selection, catalogue validation, invariants, execution/receipts, source fingerprints, evidence refresh and assessment.

- Its suggested changed selection uses `HEAD^1` when available. Like local `--plan`, PR planning adds checks explicitly bound in requirements or covering their behaviours. `PR_VERIFY_CHECKS` overrides ordinary path-based selection, using a matching configured check or a synthetic check. Required, plan-bound and active invariant checks are still added; unrelated path matches do not force extras.
- Shared drivers run after PR setup. The agent handles remaining verification gaps, including unsatisfied review obligations. Valid evidence-backed review explicitly covering a requirement can satisfy it before that phase; complete coverage can skip the agent. Agent observations merge into the same assessment without erasing failures ([pr-verification/scripts/report.mjs — `verificationFrontier`, `inspectAgent`, `verdict`](../../pr-verification/scripts/report.mjs)).
- PR output defaults to the external evidence store; the reusable workflow overrides it with runner-temporary storage. PR `result.json` is a separate envelope with a nested `verification` assessment. It does not update the workspace's local CLI latest pointer or use the CLI report format ([wrapper](../../pr-verification/scripts/verify.mjs); [.github/workflows/verify.yml](../../.github/workflows/verify.yml)).

Continue with [Final PR verification](../VERIFY.md#final-pr-verification) for that journey.

## Feature relationships

The `pr-verification` catalogue behaviour declares direct dependencies on three existing capabilities. The [PR wrapper](../../pr-verification/scripts/verify.mjs) provides source evidence for each connection:

| Depends on | Source basis |
| --- | --- |
| `catalogue` | Loads project configuration, calls `selectChecks`, and validates catalogue references before execution. |
| `coverage` | Builds invariant requirements with `withInvariants` and assesses requirement coverage with `assess`. |
| `drivers` | Executes configured checks through the shared `runChecks` lifecycle. |

The `feature-map` capability also depends directly on `catalogue`: [renderMap](../../lib/map.mjs) reads the normalized behaviour catalogue to produce its graph and verification pointers. This relationship is recorded separately from the PR wrapper's dependencies.

`groundwork map pr-verification` displays the PR dependencies; `groundwork map catalogue` derives both PR verification and feature-map navigation as incoming consumers. The common `tests` check does not create edges between unrelated behaviours. Other catalogue entries currently have no recorded dependencies; this is not a claim that they are independent.

## Constraints and change impact

- **Shared contracts:** config fields/catalogue IDs, driver results, assessment statuses, and evidence records are consumed by both local and PR orchestration. Changes in `lib/config.mjs`, `lib/model.mjs`, or `lib/runner.mjs` need both caller paths considered; the local and PR outer result formats are not interchangeable.
- **Source boundary:** `source()` hashes project-scoped tracked and non-ignored untracked content, retaining the Git revision separately as provenance. Reusable checks can require revision matching. `runtimeExclusions` omits legacy `.verify/` and `.groundwork/{runs,latest,plans,tasks,tmp,plan.json}` runtime paths. Guides, maps, configuration, reusable scripts and supporting configs remain source inputs. Editing this map can invalidate prior applicability ([lib/runner.mjs — `source`](../../lib/runner.mjs); [lib/layout.mjs](../../lib/layout.mjs)). Ignored inputs must be explicitly declared for reuse; changing external state needs appropriate fresh observations.
- **Coverage is a binding contract:** `coverage` checks IDs/statuses/evidence, not semantic correspondence between an assertion and the task's prose. The project owns that correspondence. Preserve existing `covers` and invariant `checks` bindings; a new map link provides navigation, not a new enforcing assertion.
- **Extension points:** add project-owned commands/drivers and supported config fields rather than application logic in the shared runner. `kind` is descriptive metadata, not a separate executor. Keep catalogue `paths` and `guide` project-root-relative; Markdown links inside this map are relative to this file.
- **Cancellation boundary:** the local CLI handles SIGINT/SIGTERM through an abort controller, and `executeCommand` sends SIGTERM to the child process group on non-Windows platforms. Cleanup runs without that signal. There is no local timeout/escalation in these functions; hard termination or noncooperative processes can prevent graceful completion ([CLI — `run`](../../skills/verify-work/verify.mjs); [lib/runner.mjs — `executeCommand`, `trial`](../../lib/runner.mjs)).

## Verification options and gaps

The current catalogue has one required check, **`tests`**, running `bun test`; it covers the mapped behaviours and enforces configured invariant `complete-evidence` ([.groundwork/verify.json](../verify.json)). These are existing options, not passed observations from this mapping task.

| Behaviour or constraint | Existing journey / assertion source | Check ID | What it asserts / remaining gap |
| --- | --- | --- | --- |
| Discovery, canonical precedence, project-root commands, legacy reports | [Adoption journey](../VERIFY.md#adopt-a-project); [test/config.test.mjs — configuration precedence](../../test/config.test.mjs); [test/verify.test.mjs — nested invocation and legacy reports](../../test/verify.test.mjs) | `tests` | Canonical config wins; nested and `.groundwork/` invocation uses project-root commands; generated legacy reports remain inspectable after migration. |
| External storage and migration | [test/store.test.mjs](../../test/store.test.mjs) | `tests` | Worktree namespace sharing, workspace/project isolation, preserved historical bytes and collision handling. |
| Receipt matching and retained failures | [test/receipts.test.mjs](../../test/receipts.test.mjs) | `tests` | Content-equivalent revisions, declared inputs, evidence changes, fresh execution and latest-attempt precedence. |
| Explicit review obligations | [test/model.test.mjs](../../test/model.test.mjs) | `tests` | Review evidence explicitly covers each requirement; check failures and missing bindings remain visible. |
| Catalogue, changed/named selection, active invariants | [Selection journey](../VERIFY.md#plan-and-select-verification); [test/config.test.mjs — selection and guide-reference assertions](../../test/config.test.mjs); [test/runner.test.mjs, lines 127–175](../../test/runner.test.mjs) | `tests` | Selection unions, scoped/global invariants, unmapped signals, guide search, stale anchors/files, and symlink containment. Link validation does not establish a map's source accuracy. |
| Terminal feature relationships and read-only navigation | [Map journey](../VERIFY.md#inspect-feature-relationships); [test/config.test.mjs — dependency contracts](../../test/config.test.mjs); [test/verify.test.mjs — feature-map scenarios](../../test/verify.test.mjs); [test/package.test.mjs — packaged CLI invocation](../../test/package.test.mjs) | `tests` | Direct edge direction, metadata, queries, cycles, empty/legacy/nested configurations and stale guides; no check execution or run-pointer mutation. Dependencies preserve existing selection semantics. Tests validate rendering of declared relationships, not their accuracy against an arbitrary application's source. |
| Requirement coverage and frozen plans | [test/runner.test.mjs, lines 78–125](../../test/runner.test.mjs) | `tests` | Missing outcomes and partial multi-behaviour coverage remain unverified; a driver cannot shrink the plan; invalid requirements stop execution. |
| Lifecycle, repetition, comparisons, trial evidence isolation | [Driver journey](../VERIFY.md#exercise-a-driver-and-compare-revisions); [test/runner.test.mjs, lines 204–358](../../test/runner.test.mjs) | `tests` | Real local HTTP observation/cleanup, retained mixed outcomes, baseline/candidate targeting, worktree removal, unavailable or nonreproducing baseline, measurement regression/context mismatch, and evidence aliases. No current runtime observation from this task. |
| Saved success cannot conceal missing/stale evidence or interruption | [Evidence journey](../VERIFY.md#verify-a-behaviour-and-review-evidence); [test/verify.test.mjs — persistence, freshness and interruption assertions](../../test/verify.test.mjs); [test/runner.test.mjs, lines 324–371](../../test/runner.test.mjs) | `tests` | Fail/fix evidence retention, source/runtime exclusions, missing or altered evidence, unfinished latest, and version-1 compatibility. The interruption assertion checks latest/report status, not lifecycle cleanup after cancellation. |
| PR consumption of shared config/assessment | [PR journey](../VERIFY.md#final-pr-verification); [pr-verification/test/verification.test.mjs, lines 96–187 and 204–225](../../pr-verification/test/verification.test.mjs) | `tests` | Failed checks survive positive agent reports, incomplete plans remain incomplete, canonical/legacy catalogue input enforces an invariant, nested project output/cwd works, and missing evidence/source changes block success. These fixtures use a fake Copilot executable, not live agent verification. |

The package assertion also discovers bundled skills and reads their direct Markdown references, so the new `explore` skill/template participates when packaged ([test/package.test.mjs, lines 19–36](../../test/package.test.mjs)). It does not assert the factual contents of project maps or recursively validate their links.

## Unknowns and refresh triggers

- **Runtime gap:** full execution, saved-report reassessment, cancellation cleanup, and baseline/PR behaviour remain source-derived here. The table identifies existing verification paths; targeted fixture execution or a real project run would provide new observations. No existing run evidence was reused.
- **Environment gap:** source fingerprints do not establish ignored dependency/data freshness or remote service state. The driver/project must identify relevant context and observations; inspect those before applying a saved passing result to a different environment.
- **Refresh triggers:** recheck discovery on CLI/layout changes; selection on configuration, catalogue paths/bindings, or Git-scope changes; execution/evidence on runner/model or driver-contract changes; and both callers on shared changes. Recheck table claims when assertions change. Guide/map anchors can be validated mechanically, but current source claims and runtime evidence require their own review.
