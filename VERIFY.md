# Groundwork behaviour guide

## Run and control

- CLI: `bun skills/verify-work/verify.mjs <command>` or the installed `groundwork`.
- Required check: `groundwork verify tests`.
- Implementation: `skills/verify-work/verify.mjs`.
- Integration tests: `test/verify.test.mjs` and `pr-verification/test/verification.test.mjs`.
- After workflow changes: `actionlint .github/workflows/verify.yml`.

## Journeys

### Adopt a project

Start with an existing project that has its own instructions and ignore rules. Run `groundwork init`. It creates the behaviour guide and check files and appends the workflow reference and evidence ignore rule. Existing content survives, and a second run leaves it intact.

### Verify a behaviour and review evidence

The integration test creates a small preferences CLI with broken theme persistence. Its driver sets a theme and reads it in a new process. Verification fails on the original implementation, passes after the fix, retains both runs, and becomes inconclusive when the source or evidence subsequently changes.

### Install the personal workflow

`groundwork install` registers the skill and adds the instruction to both products. The installation test uses an isolated home directory, including shared instruction symlinks, to verify preservation and repeatability.

### Final PR verification

The reusable workflow is `.github/workflows/verify.yml`; its runtime and prompt live in `pr-verification/`. It runs the importing project's configured checks and an agent-led pass, captures evidence, and updates the importing PR's verification comment. The integration tests cover failures, missing evidence, source changes, and comment targeting and updating.

## Environment and evidence

Requires Bun and Git. Tests run locally in temporary directories and use no network services or credentials. The check log is saved under `.verify/runs/`. The tests' temporary fixtures are removed after the tests finish.
