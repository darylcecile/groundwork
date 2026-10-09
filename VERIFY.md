# Groundwork behaviour guide

## Run and control

- CLI: `bun skills/verify-work/verify.mjs <command>` or the installed `groundwork`.
- Required check: `groundwork verify tests`.
- Implementation: `skills/verify-work/verify.mjs` and shared `lib/config.mjs`, `lib/model.mjs`, and `lib/runner.mjs`.
- Checks: `test/` and `pr-verification/test/`.
- Plan, configuration, and driver reference: [verification reference](skills/verify-work/references/verification.md).
- After workflow changes: `actionlint .github/workflows/verify.yml`.

## Journeys

### Adopt a project

Start with an existing project that has its own instructions and ignore rules. Run `groundwork init`. It creates the behaviour guide and check files and appends the workflow reference and evidence ignore rule. Existing content survives, and a second run leaves it intact.

### Verify a behaviour and review evidence

The integration test creates a small preferences CLI with broken theme persistence. Its driver sets a theme and reads it in a new process. Verification fails on the original implementation, passes after the fix, and retains both runs. A saved passing result becomes inconclusive when its source or evidence subsequently changes.

### Plan and select verification

Before changing behaviour, record a small plan such as `.verify/plan.json`, with each requirement bound to the assertions that establish it. Run relevant checks with `--plan`; omitted required coverage must remain unverified.

Use a disposable project's catalogue to exercise `view guide [query]`, named selection, and `--changed <ref>`. Required checks and active invariant checks must run. Changes matching check or catalogue paths select their checks; legacy unscoped checks remain conservative. Unmapped paths and behaviours without checks remain visible planning signals. Guide inspection reports stale references without executing commands.

### Exercise a driver and compare revisions

Use a project-owned driver with isolated starting state and real assertions. Observe separate setup, exercise, and cleanup outcomes; cleanup is attempted after failures and interruption. Every repeated trial retains its result and evidence, and a later pass cannot erase an earlier failure.

For `--base`, the candidate's driver must target `GROUNDWORK_SOURCE_DIR` for both revisions. A regression comparison needs the intended baseline assertion failure and a passing candidate. A passing or unavailable baseline cannot establish reproduction. Measurement comparisons use matching declared context, configured units and budgets, and median samples from retained trials.

Inspect the saved plan, requirement coverage, trial logs, observations, and artifacts in the run directory. Source changes, missing observations, or unusable evidence must prevent a passing claim.

### Install the personal workflow

`groundwork install` discovers the bundled skills and registers them for both products. Installation tests use isolated home directories to check repeated installation, newly added skills, preserved user content, and conflicting registrations.

### Update the installed package

`groundwork update` refreshes the Bun-managed package and invokes the updated installer. The distribution test installs one Git revision, adds a skill in a newer revision, and verifies that an update registers it. Linked source checkouts refresh their current registrations while preserving local work.

### Final PR verification

The reusable workflow is `.github/workflows/verify.yml`; its runtime and prompt live in `pr-verification/`. It runs the importing project's configured checks and an agent-led pass, captures evidence, and updates the importing PR's verification comment. The integration tests cover failures, missing evidence, source changes, and comment targeting and updating.

## Environment and evidence

Requires Bun, Git, and Bash. Tests use disposable local projects and controlled integrations without network credentials. `VERIFY_TEST_TMPDIR` selects their temporary parent directory when needed. Test fixtures are removed after use; recorded run evidence remains under `.verify/runs/`.

Keep fixture, mocked-service, and workload context non-secret. The runner records source fingerprints and checks evidence freshness; relevant external services and ignored inputs still need explicit observations when they change.
