# Working on Groundwork

The CLI and PR verification runtime are plain JavaScript with no package dependencies or build step. Development requires Bun, Git, and Bash. Use Bun to run the tests:

```sh
bun test
```

The tests create disposable projects and exercise the real CLI, including a broken-then-fixed persistence scenario, retained evidence, source freshness, and installation that preserves existing instructions. Configuration tests cover selection, catalogue references, and invariant enforcement. Set `VERIFY_TEST_TMPDIR` to an existing directory when fixtures need a specific temporary parent.

For the recorded project check, use `bun skills/verify-work/verify.mjs verify tests`. Finish a coherent implementation batch before running checks, then inspect the resulting evidence and requirement coverage.

For live local development, run `bun link` from this directory, then `groundwork install`. The personal skill and executable point at the working copy.

## Adding skills

Add `skills/<skill-name>/SKILL.md` with a matching lowercase kebab-case `name` and a description explaining when to use it. Keep its supporting references and scripts inside that directory. The package includes the whole `skills/` directory, and the installer discovers each skill automatically.

Run `groundwork install` to register new skills locally. After the updated package is available, users run `groundwork update` to receive it and register the new skills. A linked development checkout uses its current source; the update command does not pull or replace local work.

Keep the shared code independent of any application's stack. Put application setup, navigation, and assertions in the adopting project. Update the skill and user documentation when the command contract changes.

## Source map

- `skills/verify-work/verify.mjs`: CLI, installation, adoption, guide discovery, and saved reports.
- `lib/config.mjs`: configuration validation, catalogue, and check selection.
- `lib/model.mjs`: task plans, requirement coverage, observations, evidence, and measurements.
- `lib/runner.mjs`: setup/exercise/cleanup, trials, and baseline worktrees.
- `lib/distribution.mjs`: bundled skill discovery, registration, and package updates.
- `test/` and `pr-verification/test/`: project behaviour and integration checks.

Use the [verification reference](skills/verify-work/references/verification.md) for the shared contracts and `VERIFY.md` for this repository's journeys. Keep plan bindings tied to actual assertions. Exercise failures and unavailable observations that the change can affect; a matching label or artifact is not proof of a requirement.

When changing distribution or skill paths, keep shared modules in the package and skill references inside the skill directory. The installation test exercises an extracted package through its installed skill path.

## PR verification

Validate the reusable workflow with `actionlint .github/workflows/verify.yml` after workflow changes.

The tests in `pr-verification/test/` invoke the runner against disposable Git projects with a controlled Copilot executable. They exercise failure handling, evidence validation, source preservation, and publication against a simulated GitHub client. A live Copilot smoke check and a GitHub-hosted caller run validate the external integrations.

To run locally, point `GITHUB_EVENT_PATH` at a JSON file containing the target `pull_request` payload, set `GITHUB_REPOSITORY` to its `owner/repository`, and set:

- `PR_VERIFY_REPOSITORY`: checkout to verify.
- `PR_VERIFY_CHECKS`: the project's check commands.
- `PR_VERIFY_OUTPUT`: a fresh evidence directory outside that checkout.

Then run `bun pr-verification/scripts/verify.mjs`. Local runs use the Copilot CLI's existing authentication. In GitHub Actions, the `COPILOT_TOKEN` secret supplies the credential.

Keep project-specific policy in the calling workflow or project documentation. The runner and reporting code should remain generic.
