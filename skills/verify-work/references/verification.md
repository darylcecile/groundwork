# Verification reference

Groundwork connects a task's requirements to project-owned assertions and inspectable evidence. Work through normal chat: identify the intended outcomes, reuse relevant checks and [playbooks](../playbooks.md), finish a coherent change, then verify the result. Save a plan when tracking multiple requirements helps; straightforward tasks can keep their outcomes in the conversation.

## Task plans

A plan has a nonempty `goal` and a nonempty `requirements` array. Every requirement is required and has a unique `id`, a nonempty `expect`, and optional `checks` and `behaviours` arrays. IDs start with a letter or number and can contain letters, numbers, `.`, `_`, `:`, and `-`.

`checks` explicitly names the project assertions that establish the requirement. `behaviours` links catalogue IDs covered by checks or observations. Choose bindings by reading the actual assertions: neither a matching label nor a file's existence proves that an arbitrary expectation was met. Missing required coverage remains **unverified**.

The runner freezes and saves the plan before execution. Active project invariants are added as `invariant:<catalogue-id>` requirements; those IDs are reserved. In the local CLI, a plan describes coverage: select its checks explicitly, through `--changed`, or by running all checks. The PR workflow can also schedule checks bound in its generated plan.

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

`.groundwork/verify.json` requires a `checks` object. `behaviours`, `invariants`, and `context` are optional objects. Existing configurations containing only `command`, `expect`, `required`, and `artifacts` remain valid. Unknown fields and invalid references are rejected. The CLI and PR runner prefer this path and fall back to a legacy root `verify.json` when it is absent.

Keep Groundwork-owned helpers in `.groundwork/scripts/` and supporting configs in `.groundwork/config/`. Reuse the project's existing tools and pass config paths explicitly where supported. Commands, `paths` and catalogue `guide` references remain relative to the project root. Markdown links inside the guide are relative to the guide file.

Continuing the example, the project supplies the following configuration. Replace the commands with real project checks and create the referenced sections in its `.groundwork/VERIFY.md`.

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
      "guide": ".groundwork/VERIFY.md#theme-persistence"
    }
  },
  "invariants": {
    "valid-settings": {
      "description": "Malformed settings cannot overwrite valid preferences",
      "paths": ["src/preferences/**"],
      "checks": ["settings-contract"],
      "guide": ".groundwork/VERIFY.md#valid-settings"
    }
  }
}
```

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

Artifact and result paths must stay relative, with no absolute path, backslash, `.` or `..` segment. A metric definition requires a nonempty `unit`; optional `min` and `max` must be finite, with `min <= max`. Optional `maxRegressionPercent` is finite and nonnegative; `direction` is `lower` (the default comparison direction) or `higher`. Measurement comparison needs at least one metric with `maxRegressionPercent`.

### Catalogue and invariants

Behaviour and invariant IDs use the same characters as requirement IDs and are unique across both maps.

- A **behaviour** has a nonempty `description`, optional `paths`, an optional string `entry`, and an optional `guide`. Checks link to it through `covers`. It may initially have no check; the catalogue shows that gap.
- An **invariant** has a nonempty `description`, optional `paths` and `guide`, and a nonempty `checks` array referencing existing checks. Those checks also cover the invariant automatically.
- `guide` is a safe project-relative `.md` or `.markdown` file, optionally followed by `#anchor`. Headings and explicit anchor IDs are supported; stale files and anchors are reported.

Find entries with `groundwork view guide [query]`. Search matches IDs, descriptions, paths, and entry points without running any check command.

## Selecting checks

```text
groundwork verify [name ...] [--plan file] [--changed ref] [--base ref]
```

- With no names or `--changed`, run all checks.
- Named checks and `required` checks are included. Unknown check names are errors.
- `--changed <ref>` compares the current working tree with that Git ref, including non-ignored untracked files. It selects matching check paths or covered catalogue paths, using `path.matchesGlob`. Checks with no known scope are included conservatively.
- Names and `--changed` combine their selections.
- Unscoped invariants are always active. Scoped invariants are active on matching changes; without `--changed`, all invariants are active, even for a named run. Active invariant checks are always added.
- Reports retain selection reasons, omitted checks, `unmappedPaths`, and `uncoveredBehaviours`. The last two are planning signals, not evidence of coverage; inspect them against the task's requirements.

For the example, `groundwork verify theme-persists --plan .groundwork/plans/task.json` also runs `settings-contract` because its invariant is active. Using `--changed` does not perform a baseline comparison; `--base` is independent.

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

Each run is saved under `.groundwork/runs/<id>/`, including its `result.json`, plan snapshot when present, logs, and trial artifacts. A new attempt becomes the latest immediately, so an interrupted run cannot reuse an earlier success.

`groundwork view report` rechecks the saved source and evidence without rerunning commands. Source matching includes the Git revision, tracked local changes, and non-ignored untracked files. Groundwork's runtime paths (`runs/`, `latest`, `plans/`, `tasks/`, and `tmp/` inside `.groundwork/`) and legacy `.verify/` output are excluded. The guide, check configuration, reusable scripts and supporting configs remain source inputs; editing them invalidates saved results. Relevant ignored inputs and external services need declared context and a new run when they change.

Requirements report **verified**, **failed**, or **unverified**. The overall result is **passed / 0** when checks and required coverage are complete, **failed / 1** when a failure was observed, or **inconclusive / 2** when completion cannot be established. Failures remain visible alongside missing coverage or evidence. Inspect the actual assertions, images, traces, and measurements before closing every requirement or reporting its gap.
