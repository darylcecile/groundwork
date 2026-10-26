# Groundwork behaviour guide

## Run and control

- CLI: `bun skills/verify-work/verify.mjs <command>` or the installed `groundwork`.
- Required check: `groundwork verify tests`.
- Implementation: `skills/verify-work/verify.mjs` and shared `lib/config.mjs`, `lib/model.mjs`, and `lib/runner.mjs`.
- Checks: `test/` and `pr-verification/test/`.
- Plan, configuration, and driver reference: [verification reference](../skills/verify-work/references/verification.md).
- After workflow changes: `actionlint .github/workflows/verify.yml`.

## Journeys

### Adopt a project

Start with an existing project that has its own instructions and ignore rules. Run `groundwork init`. It creates `.groundwork/VERIFY.md`, `.groundwork/verify.json` and local ignore rules, with root `AGENTS.md` pointing agents to the guide and checks. Existing content survives, and a second run leaves it intact. Legacy root verification files and `.verify/` evidence migrate into `.groundwork/`; conflicting destinations stop migration without overwrites.

Reusable Groundwork-owned helpers and supporting configs belong in `.groundwork/scripts/` and `.groundwork/config/`. Plans, task notes, scratch files and run output live in ignored subpaths. Commands run from the project root, even when invoked inside `.groundwork/`. Changes to reusable verification inputs invalidate a saved result; runtime files do not.

### Explore a subsystem

Use `explore` to explain a focused question such as how named checks include active invariants. Expect an answer with source references and clear limits on what was observed. For an explicit mapping request, trace the subsystem into a reusable document under `.groundwork/maps/`, with entry points, owning modules, data flow, constraints, change impact, verification options and gaps.

The [verification flow map](maps/verification.md) connects project discovery, configuration, selection, execution, and saved reports. Recheck its source anchors before relying on it. Catalogue guide files and anchors should resolve through `groundwork view guide`; inspect other map links directly. Their factual accuracy needs source review and runtime evidence where claimed. The package test checks that the installed `explore` skill and its template are included and readable.

### Inspect feature relationships

Run `groundwork map` for the catalogue overview, or `groundwork map pr-verification` for its direct dependencies and source/check/guide context. `groundwork map catalogue` shows the feature-map and PR-verification capabilities as consumers. These edges are recorded in `dependsOn` and supported by the [feature relationships](maps/verification.md#feature-relationships); shared checks do not create edges. Existing features without relationships remain visible as unrecorded.

The CLI tests exercise direction, empty metadata, ambiguous and missing queries, cyclic relationships, guide-reference errors, nested/legacy discovery and read-only operation. A map request must leave source and run pointers intact, even when a configured check would write a file if executed.

### Verify a behaviour and review evidence

The integration test creates a small preferences CLI with broken theme persistence. Its driver sets a theme and reads it in a new process. Verification fails on the original implementation, passes after the fix, and retains both runs. A saved passing result becomes inconclusive when its source or evidence subsequently changes.

### Browse the local portal

Run CLI commands in two different repositories outside CI. Both links must use the same loopback origin and server PID, with project-specific URLs. The project selector switches reports, evidence, catalogue and map between registered repositories. Project registration is retained in the user's cache, outside project data. CI skips startup, and `GROUNDWORK_PORTAL=0` disables it locally. Startup failure must preserve the requested command's exit status.

Exercise simultaneous registrations and restart the daemon: both projects should remain available. Use the same run ID in two fixtures to establish that their reports and evidence stay isolated. Changing or registering another project must not switch the current browser view or reset its inspection state. A missing project should leave other projects usable.

Browse reports and inspect check details, requirement coverage, observations and evidence. Outcomes are saved snapshots: an unfinished local run is not labelled as actively running, and saved success does not claim current source or evidence freshness. Empty projects, unreadable reports and missing files need useful UI. File changes refresh the open view while retaining navigation.

Browse the current catalogue and select a behaviour on the React Flow map canvas. Pan, zoom and fit the graph; follow its declared dependencies or derived consumers; inspect its checks, source paths and guide. The map must remain usable with no relationships, cycles or missing check bindings. Viewing these surfaces does not execute checks or modify configuration, reports or evidence.

Evidence opens in a modal with keyboard dismissal and focus restoration. JSON has structured fields, Markdown has readable document formatting, and HTML/SVG renders as an inert saved preview. HTML previews use captured assets when available; absent original assets cannot be recreated from a saved HTML response. An unrelated file update must not reset media playback or expanded evidence fields.

The `tests` check covers the API, file boundaries and daemon lifecycle. `portal-build` typechecks the TypeScript source and checks the committed distribution. For UI changes, also inspect wide and narrow rendered layouts and exercise report selection, evidence previews, catalogue search, node navigation and live updates with the browser. Browser observations are separate from automated API assertions.

### Plan and select verification

Before changing behaviour, record a small plan such as `.groundwork/plans/task.json`, with each requirement bound to the assertions that establish it. Run relevant checks with `--plan`; omitted required coverage must remain unverified.

Use a disposable project's catalogue to exercise `view guide [query]`, named selection, and `--changed <ref>`. Required checks and active invariant checks must run. Changes matching check or catalogue paths select their checks; legacy unscoped checks remain conservative. Unmapped paths and behaviours without checks remain visible planning signals. Guide inspection reports stale references without executing commands.

### Exercise a driver and compare revisions

Use a project-owned driver with isolated starting state and real assertions. Observe separate setup, exercise, and cleanup outcomes; cleanup is attempted after failures and interruption. Every repeated trial retains its result and evidence, and a later pass cannot erase an earlier failure.

For `--base`, the candidate's driver must target `GROUNDWORK_SOURCE_DIR` for both revisions. A regression comparison needs the intended baseline assertion failure and a passing candidate. A passing or unavailable baseline cannot establish reproduction. Measurement comparisons use matching declared context, configured units and budgets, and median samples from retained trials.

Inspect the saved plan, requirement coverage, trial logs, observations, and artifacts in the run directory. Source changes, missing observations, or unusable evidence must prevent a passing claim.

### Install the personal workflow

`groundwork install` discovers the bundled skills and registers them for both products. Installation tests use isolated home directories to check repeated installation, newly added skills, preserved user content, and conflicting registrations.

### Update the installed package

`groundwork update` resolves the repository's default-branch commit, reinstalls that exact revision through Bun, and invokes the updated installer. The distribution test installs one Git revision, adds a skill and changes the installer entry point in a newer revision, and verifies the update. Linked source checkouts refresh their current registrations while preserving local work.

### Final PR verification

The reusable workflow is `.github/workflows/verify.yml`; its runtime and prompt live in `pr-verification/`. It runs the importing project's configured checks and an agent-led pass, captures evidence, and updates the importing PR's verification comment. It discovers `.groundwork/verify.json` (with legacy fallback), and local evidence defaults to the selected project's `.groundwork/runs/pr-<id>/`. The integration tests cover failures, missing evidence, source changes, nested project paths, and comment targeting and updating.

## Environment and evidence

Requires Bun, Git, and Bash. Tests use disposable local projects and controlled integrations without network credentials. `VERIFY_TEST_TMPDIR` selects their temporary parent directory when needed. Test fixtures are removed after use; recorded run evidence remains under `.groundwork/runs/`.

Keep fixture, mocked-service, and workload context non-secret. The runner records source fingerprints and checks evidence freshness; relevant external services and ignored inputs still need explicit observations when they change.
