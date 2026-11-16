# Verification reference

Groundwork connects a task's requirements to project-owned assertions and inspectable evidence. Work through normal chat: identify the intended outcomes, reuse relevant checks and [playbooks](../playbooks.md), finish a coherent change, then verify the result. Save a plan when tracking multiple requirements helps; straightforward tasks can keep their outcomes in the conversation.

## Task plans

A plan has a nonempty `goal` and a nonempty `requirements` array. Every requirement is required and has a unique `id`, a nonempty `expect`, optional `checks` and `behaviours` arrays, and optional `review`. IDs start with a letter or number and can contain letters, numbers, `.`, `_`, `:`, and `-`.

`checks` explicitly names the project assertions that establish the requirement. `behaviours` links catalogue IDs covered by checks or observations. Choose bindings by reading the actual assertions: neither a matching label nor a file's existence proves that an arbitrary expectation was met. Missing required coverage remains **unverified**.

`review` is a boolean, default `false`. Set it to `true` when the requirement also needs an evidence-backed observation with `kind: "review"`, such as inspection of a rendered screen. The observation's `covers` must explicitly include that requirement ID; a shared behaviour ID is not enough. A passing command alone cannot discharge the obligation; existing check and behaviour bindings still apply.

The runner freezes and saves the plan before execution. Both local and PR verification schedule explicitly bound checks and checks covering the plan's behaviours. Required checks and active project invariants remain included. Active invariants add `invariant:<catalogue-id>` requirements; those IDs are reserved. The PR agent works on remaining verification gaps, including unsatisfied review obligations. Valid review evidence explicitly covering the requirement can satisfy `review: true` without a new agent pass. Failures remain recorded.

For example, an agent fixing preference persistence saves `.groundwork/plans/task.json` before editing:

```json
{
  "goal": "Keep the user's theme selection after restarting the application",
  "requirements": [
    {
      "id": "persist-theme",
      "expect": "Selecting dark theme is reflected in a fresh application process",
      "checks": ["theme-persists"],
      "behaviours": ["theme-persistence"]
    }
  ]
}
```

## Project configuration

Project configuration lives in `.groundwork/verify.d/*.json`. The CLI and PR runner discover fragments automatically, merge their checks and catalogue entries, and validate cross-file references. Duplicate IDs are errors, not overrides. No include list or central index edit is needed for a new feature. Each fragment may contain `checks`, `behaviours`, `invariants` and `context` objects. Existing check definitions containing only `command`, `expect`, `required` and `artifacts` remain valid. Unknown fields and invalid references are rejected.

Shared project context can live in its own fragment. Fragments can add context keys; repeated keys must have identical values. Conflicting values and duplicate entries report both source paths. Put feature-specific overrides in the check's `context` instead. Catalogue entries retain their defining file for discovery.

Keep `.groundwork/VERIFY.md` as the small bootstrap to project context and catalogue discovery. Put shared setup, constraints and journeys in `.groundwork/guides/` or a bounded subsystem map, with configuration in `.groundwork/verify.d/*.json`. Guides and maps describe enduring behaviour, not task plans, PR summaries, run histories or artifact inventories.

Keep Groundwork-owned helpers in `.groundwork/scripts/` and supporting tool configs in `.groundwork/config/`. Reuse the project's existing tools and pass config paths explicitly where supported. Commands, `paths`, reuse input files and catalogue `guide` references remain relative to the project root, even in a fragment. Markdown links inside a guide are relative to that guide file.

Continuing the example, the project supplies the following feature configuration. Replace the commands with real project checks and create the referenced sections in `.groundwork/guides/preferences.md`.

```json
{
  "context": { "fixture": "isolated-preferences", "storage": "local-file" },
  "checks": {
    "settings-contract": {
      "command": "bun test test/settings.test.mjs",
      "expect": "Malformed settings cannot overwrite valid preferences",
      "kind": "constraint",
      "paths": ["test/settings.test.mjs"]
    },
    "theme-persists": {
      "command": "bun .groundwork/scripts/theme.mjs",
      "expect": "Dark theme survives a fresh application process",
      "kind": "workflow",
      "paths": [".groundwork/scripts/theme.mjs"],
      "covers": ["theme-persistence"],
      "artifacts": ["after-restart.json"],
      "result": "result.json",
      "repeat": 2,
      "compare": "regression"
    }
  },
  "behaviours": {
    "theme-persistence": {
      "description": "Theme selection survives restarting the application",
      "paths": ["src/preferences/**"],
      "entry": "Preferences CLI: set a theme, then read it in a new process",
      "guide": ".groundwork/guides/preferences.md#theme-persistence"
    }
  },
  "invariants": {
    "valid-settings": {
      "description": "Malformed settings cannot overwrite valid preferences",
      "paths": ["src/preferences/**"],
      "checks": ["settings-contract"],
      "guide": ".groundwork/guides/preferences.md#valid-settings"
    }
  }
}
```

### Automatic preparation

`init`, `verify`, `view guide`, `view report` and `map` prepare the project before loading its configuration and guides. The PR runner does the same before source capture. Old base configurations and authored `VERIFY.md` sections normally partition into active fragments and guides, preserving IDs, bindings, check order and instructions. A guide or base configuration consumed as a whole-document command input moves intact into one active guide or fragment, with exact declared paths rewritten. A small marked bootstrap links project context. Preparation updates references and removes superseded files and obsolete ignore archives.

Supplied `--plan` and `PR_VERIFY_PLAN` contents are captured before preparation, so plans remain available when their legacy paths move.

The agent owns setup and repairs during ordinary implementation: run `init` when setup is missing, resolve contradictory definitions using repository context, and update consumers of moved input paths when needed to preserve behaviour. Preparation is idempotent. The configuration loader and portal remain read-only and can inspect older layouts without converting them.

### Check fields

Check IDs match `^[a-z0-9][a-z0-9._-]*$`.

- `command`, `expect`: required nonempty strings. The command performs the exercise and makes its assertions.
- `required`: boolean, default `false`; include this check in every run.
- `artifacts`: required evidence files, relative to the fresh evidence directory; default `[]`.
- `paths`: project-relative glob strings used for change selection; default `[]`.
- `covers`: existing behaviour or invariant IDs this check actually asserts; default `[]`.
- `kind`: `command` (default), `ui`, `api`, `workflow`, `agent`, `performance`, or `constraint`. It describes the check; the project still owns its implementation.
- `setup`, `cleanup`: optional nonempty command strings, run separately around each exercise.
- `result`: optional relative path to a structured driver result in the evidence directory.
- `repeat`: positive safe integer, default `1`.
- `metrics`: named measurement definitions; requires `result` when nonempty.
- `compare`: `regression` or `measurement`; opts a source-aware driver into `--base`.
- `context`: declared non-secret scalar metadata for this check; default `{}`.
- `reuse`: boolean or input declaration object, default `false`; opt a deterministic, input-complete check into receipt reuse. See [Reusable check receipts](#reusable-check-receipts) for fields and eligibility.

Artifact and result paths must stay relative, with no absolute path, backslash, `.` or `..` segment. A metric definition requires a nonempty `unit`; optional `min` and `max` must be finite, with `min <= max`. Optional `maxRegressionPercent` is finite and nonnegative; `direction` is `lower` (the default comparison direction) or `higher`. Measurement comparison needs at least one metric with `maxRegressionPercent`.

### Catalogue and invariants

Behaviour and invariant IDs use the same characters as requirement IDs and are unique across both maps.

- A **behaviour** has a nonempty `description`, optional `paths`, an optional string `entry`, an optional `guide`, and optional `dependsOn`. Checks link to it through `covers`. It may initially have no check; the catalogue shows that gap.
- An **invariant** has a nonempty `description`, optional `paths` and `guide`, and a nonempty `checks` array referencing existing checks. Those checks also cover the invariant automatically.
- `guide` is a safe project-relative `.md` or `.markdown` file, optionally followed by `#anchor`. Headings and explicit anchor IDs are supported; stale files and anchors are reported.

Use the `explore` skill to establish the entry points, ownership, affected paths and verification options behind these entries. Durable maps live at `.groundwork/maps/<area>.md`; a catalogue `guide` can point to a section such as `.groundwork/maps/preferences.md#save-preferences`. Discover it through the feature's catalogue entry or guide, without adding a root index entry. Preserve existing check bindings, and add `covers` only when the check actually asserts that behaviour. A map may identify a gap without inventing a check to fill it.

Map Markdown links are relative to the map file; catalogue paths remain project-root-relative. Recheck affected map claims against current source when using or updating them. The CLI validates linked files and anchors, not the factual accuracy of the map's contents.

Find entries with `groundwork view guide [query]`. Search matches IDs, descriptions, paths, and entry points without running any check command.

### Terminal feature maps

`dependsOn` is an array of other existing behaviour IDs, recording direct feature dependencies. It defaults to `[]`; duplicates are removed. Unknown references, invariant IDs and self-links are rejected. Multi-feature cycles are allowed. Record only connections supported by source or documented contracts, with their evidence in the narrative map. Shared paths or covering checks alone do not establish a dependency.

```text
groundwork map             # All features and recorded direct dependencies
groundwork map <feature>   # Direct dependencies, consumers and feature context
```

An exact behaviour ID wins; otherwise the query must uniquely match an ID or description case-insensitively. Multiple words can be quoted or passed as separate arguments. Ambiguous or unknown queries and unsupported flags return exit `2`. An empty catalogue without a query prints setup guidance and returns `0`.

The focused view includes the displayed features' descriptions, entry points, implementation paths, covering checks and guides. Reverse consumers come from other behaviours' `dependsOn` lists. The diagram shows direct relationships, so cycles remain finite. Missing metadata is reported as not recorded or not mapped. After automatic preparation, these commands display the catalogue without executing checks or creating a verification run. Guide references for displayed behaviours are validated; stale links retain the diagram and return exit `2`.

Dependency metadata does not change check selection, invariant activation, requirement coverage, or local plan scheduling. Use the map to investigate impact, then select checks whose actual assertions establish the affected requirements.

## Selecting checks

```text
groundwork verify [name ...] [--plan file] [--changed ref] [--base ref] [--fresh]
```

- With no names or `--changed`, select all checks, including when a plan is supplied.
- Named checks and `required` checks are included. Unknown check names are errors.
- A plan adds every explicitly bound check and checks covering its bound behaviours to the selection. Unknown planned check IDs are errors.
- `--changed <ref>` compares the current working tree with that Git ref, including non-ignored untracked files. It selects matching check paths or covered catalogue paths, using `path.matchesGlob`. Checks with no known scope are included conservatively.
- Names and `--changed` combine their selections.
- Unscoped invariants are always active. Scoped invariants are active on matching changes; without `--changed`, all invariants are active, even for a named run. Active invariant checks are always added.
- Reports retain selection reasons, omitted checks, `unmappedPaths`, and `uncoveredBehaviours`. The last two are planning signals, not evidence of coverage; inspect them against the task's requirements.
- `--fresh` bypasses receipt reuse and executes selected checks.

For the example, `groundwork verify theme-persists --plan .groundwork/plans/task.json` also runs `settings-contract` because its invariant is active. Using `--changed` does not perform a baseline comparison; `--base` is independent.

In PR verification, `PR_VERIFY_CHECKS` overrides ordinary change-based check selection. Required, plan-bound and active invariant checks are still added; unrelated path matches do not add extra checks to that override.

## Reusable check receipts

A receipt retains an executed check's result and evidence so a later run can reuse it when its inputs match. Checks execute by default. Set `reuse: true` only when project source, check definition, declared context, engine, runtime and plan fully determine the check's outcome. Use an object to declare additional inputs:

```json
"reuse": {
  "env": ["TZ", "FEATURE_MODE"],
  "files": [".local-fixture.json"],
  "revision": true
}
```

- `env`: environment-variable names affecting the result; default `[]`. Their values are digested for matching, not saved as plain text in the receipt. Commands still own any values they print to logs.
- `files`: explicit project-relative input file paths, including relevant ignored files; default `[]`. Globs are not supported. These supplement whole-source content matching. They are not a narrower cache scope.
- `revision`: boolean, default `false`; require the Git revision to match when the check depends on it. Content-based matching otherwise permits identical source content across revisions.

The reuse identity includes all tracked and non-ignored untracked source content, the normalized check definition, verification engine and runtime identity, declared context, frozen plan and additional inputs. `paths` controls check selection only; it does not limit receipt invalidation. Retained evidence must remain intact. A completed failure can also be reused and remains failed; missing, changed or incomplete evidence cannot provide a reusable success. The latest attempt for matching inputs governs reuse, so an incomplete attempt cannot silently fall back to an older pass.

Only single-trial candidate checks without setup or cleanup are eligible. `repeat > 1`, baseline comparisons and lifecycle checks execute afresh. Use `--fresh` for a new observation or whenever undeclared state could matter. Do not opt in a live-service check unless its relevant external state is represented completely by the declared inputs.

Reports identify executed and reused receipts with their provenance. A reused receipt supports the original assertion under matching inputs; it is not a new execution or a substitute for inspecting screenshots, traces or review evidence. Legacy reports stay historical and are not converted into reusable proofs.

## Scripted verification

The execution unit is a known journey or a batch of selected checks. The agent chooses what to verify, resolves genuine unknowns, and reviews results; a script performs the mechanical steps. This applies to browser, device, API, and CLI verification, including the first run of a newly understood journey.

1. **Discover only what is missing.** Inspect enough to establish the starting state, targets, actions, and expected outcomes. Once those are known, script the sequence before executing it. Dynamic values that can be read and passed between steps belong in the script. A new agent turn is warranted when an observation requires a decision the script cannot make, or a failure needs diagnosis.
2. **Reuse the execution path.** Prefer an existing test or driver. Otherwise use the project's existing tools in a small script; a new integration-test framework is unnecessary. Keep reusable journeys in `.groundwork/scripts/`, register new feature checks in `.groundwork/verify.d/<feature>.json`, and run them through `groundwork verify`. Preserve existing bindings through automatic preparation; set up missing configuration with the existing runner. A short one-off can use one batched tool call or a scratch script under `.groundwork/tmp/`. Do not add permanent scaffolding for an isolated check.
3. **Keep the sequence reliable.** Put setup, ordered actions, condition-based waits, assertions, and cleanup in the driver or its runner lifecycle. Use stable semantic locators, test IDs, or known selectors; do not replay snapshot refs after the page changes. Drive actual user-facing controls rather than mutating UI state to make an assertion pass. Batching removes model round trips, not ordering: never parallelize dependent actions in the same browser or device session. Isolate sessions and fixtures for independent scenarios.
4. **Return results, not a conversation per step.** Assert observable outcomes; a successful click or a printed value is not an assertion. Save diagnostic logs and relevant screenshots/traces in `GROUNDWORK_EVIDENCE_DIR`. Return a compact per-scenario summary, failed step and evidence paths instead of narrating every successful action or dumping every snapshot. Preserve failures, stop dependent steps when their prerequisites fail, and collect results from independent scenarios where the runner supports it. Do not hide failures with blanket error suppression or retry until green.
5. **Review and reuse.** Invoke selected checks together, inspect the saved evidence, and diagnose failures from that run. Update the driver when a missing step or assertion is discovered. Reviewers receive the command, assertions, fixture context, and evidence; they reuse a current result and rerun affected checks only for source/environment changes, failures, or missing coverage. Visual judgement still requires inspecting the captured screen or a targeted live observation.

For the guide-opening journey, a driver would select the checkout node, focus the guide summary, press Enter, wait for the guide to open, assert the expected guide content, and capture the rendered result. Those actions are sequential statements in a script, not separate agent tool calls. After creating the driver and its assertions, a project could register:

```json
{
  "checks": {
    "checkout-guide": {
      "command": "bash .groundwork/scripts/checkout-guide.sh",
      "expect": "Opening the checkout guide with the keyboard reveals the expected content",
      "kind": "ui",
      "artifacts": ["guide.png", "browser.log"]
    }
  }
}
```

The script must write those evidence files and fail when its assertions fail. Save this entry in the feature's configuration fragment, then invoke `groundwork verify checkout-guide` once. Inspect `guide.png` and the reported assertions after the run. Declaring this check or capturing a screenshot alone does not establish the behaviour. Use the lifecycle and result contract below when implementing the driver.

## Driver lifecycle and evidence

Each trial runs optional setup, the existing `command` as the exercise, then optional cleanup. Commands run in separate Bash processes from the candidate project directory with `-e` and `pipefail`. Setup shell exports do not carry into later commands. Cleanup is attempted when an exercise finishes or fails; an abruptly terminated process may be unable to complete it.

Drivers receive:

- `GROUNDWORK_EVIDENCE_DIR`: absolute path to this trial's fresh evidence directory.
- `VERIFY_ARTIFACTS`: the same path, retained for existing drivers.
- `GROUNDWORK_SOURCE_DIR`: the source under verification: candidate project or baseline checkout.
- `GROUNDWORK_PROJECT_DIR`: the candidate project containing the driver and configuration.
- `GROUNDWORK_PHASE`: `baseline` or `candidate`.
- `GROUNDWORK_TRIAL`: the one-based trial number.
- `GROUNDWORK_PLAN`: path to the saved plan snapshot, or an empty string when there is no plan.

For the example, `.groundwork/scripts/theme.mjs` creates isolated preferences under the evidence directory, sets the theme, starts a fresh process, and reads the result. It invokes the application entry under `GROUNDWORK_SOURCE_DIR`, such as `src/preferences/cli.mjs`, and writes the expected and observed values to `after-restart.json`. It then writes the configured `result.json`:

```json
{
  "observations": [
    {
      "id": "theme-after-restart",
      "status": "passed",
      "observed": "A fresh application process read theme=dark",
      "evidence": ["after-restart.json"]
    }
  ],
  "context": { "fixture": "isolated-preferences", "storage": "local-file" }
}
```

The observation inherits `covers: ["theme-persistence"]` from its check. Record `failed` and the actual value if the assertion fails; record `inconclusive` when the necessary observation is unavailable.

### Structured result fields

A result contains `observations`, `measurements`, and/or `context`, with at least one observation or measurement. Unknown fields are rejected.

- An observation requires `status` (`passed`, `failed`, or `inconclusive`), nonempty `observed` text, and an `evidence` array. Optional `id` identifies it within the trial; optional `covers` lists requirement or catalogue IDs and defaults to the check's `covers`. Optional `kind` is `assertion` (default), `review`, or `measurement`.
- A measurement is `{ "name": "restart-read", "value": 4.2, "unit": "ms" }`. Names are unique within the result, values are finite, and names/units must match configured metrics to satisfy their budgets. Measure the operation of interest; command duration is not a metric.
- Context values are strings, finite numbers, booleans, or `null`. Use named metadata for fixtures, mocked services, and workload. Top-level configuration provides defaults, check context can override them, and result context can add metadata but cannot contradict a declared value. The CLI also records platform and architecture. Do not dump environment variables or credentials into context.

Evidence paths are relative to the trial's evidence directory. Files must be nonempty and stay inside that directory, including through symlinks. An observation cannot cite its own result file as evidence. Passed or failed observations need evidence; an unavailable observation may use `inconclusive` with an empty evidence array. Declared artifacts and observation evidence are retained and checked for changes.

Exercise commands should exit `0` when assertions pass, `1` for an observed assertion failure, and `2` for unavailable setup or observations. Missing commands, interrupted work, setup failures, and cleanup failures are inconclusive. A known assertion failure remains failed even when another part of verification is incomplete.

## Repetition and baseline comparison

`repeat` runs every configured trial unless interrupted and retains every outcome. A later pass never erases an earlier candidate failure. Use repetition when behaviour varies, rather than as a retry-until-green mechanism.

`groundwork verify theme-persists --plan .groundwork/plans/task.json --base <ref>` exercises the example driver against both revisions. At least one selected check must declare `compare`; other checks run against the candidate only.

**Both phases execute the candidate's driver command from the candidate project. The driver must target `GROUNDWORK_SOURCE_DIR`.** This lets a newly written regression driver exercise old code. An ordinary command that ignores the target should remain a candidate-only check. Setup and cleanup receive the same target and phase variables.

The baseline is a temporary detached Git worktree, removed after the run. The driver owns any target-specific setup. An unavailable checkout, missing dependency, or missing observation is inconclusive, not a reproduced bug.

- `compare: "regression"` requires a real baseline assertion failure and candidate success under the same declared context. If the baseline passes, the comparison is inconclusive: the alleged failure was not reproduced.
- `compare: "measurement"` requires usable baseline and candidate measurements with identical declared workload context. It compares medians, retaining individual samples. `maxRegressionPercent` applies in the configured direction; candidate `min`/`max` budgets still apply to each trial. Baseline absolute budgets are not enforced during a measurement comparison.

Inspect baseline logs and observations to confirm the intended failure, and inspect workload context before making a performance claim. The comparison establishes only the behaviour or operation actually exercised.

## Results and freshness

Each run saves `result.json`, its plan snapshot when present, logs and trial artifacts in the external evidence store. The state root is `GROUNDWORK_STATE_HOME` when set, otherwise `$XDG_STATE_HOME/groundwork`, defaulting to `~/.local/state/groundwork`. Repository worktrees share an evidence namespace, with a separate latest-run pointer for each workspace. A new attempt becomes its workspace's latest immediately; each invocation assesses its own run ID, avoiding another invocation's latest pointer.

`groundwork view report [id]` rechecks saved source and evidence without rerunning commands; omit the ID for this workspace's latest. For checks with receipt keys, it also recomputes the current receipt identity. Changes to declared environment values, ignored input files, engine, runtime or context make a previously passing receipt-backed report inconclusive even without source changes. Checks without receipt keys retain source/evidence reassessment only.

Source matching uses tracked and non-ignored untracked content. The Git revision remains provenance and can be part of a check's reuse identity. Groundwork's runtime paths (`runs/`, `latest`, `plans/`, `tasks/` and `tmp/` inside `.groundwork/`) and legacy `.verify/` output are excluded. Guides, maps, configuration, reusable scripts and supporting configs remain source inputs. Declare relevant ignored files and environment variables for reuse, and obtain fresh observations for changing external state.

Project preparation automatically migrates `.groundwork/runs`, `.verify/runs` and latest pointers to external storage. Generated originals are removed only after preservation. Malformed or orphaned old latest pointers are retained in the external store rather than blocking a fresh run. The store must not overlap legacy runtime directories. Historical reports retain their original source identity and evidence; migration does not make them current receipts.

The portal reads both external and legacy reports, including saved receipts. Its snapshots do not perform the freshness reassessment of `view report` and do not establish that an unfinished run is still executing.

Requirements report **verified**, **failed**, or **unverified**. The overall result is **passed / 0** when checks and required coverage are complete, **failed / 1** when a failure was observed, or **inconclusive / 2** when completion cannot be established. Failures remain visible alongside missing coverage or evidence. Inspect the actual assertions, images, traces, and measurements before closing every requirement or reporting its gap.
