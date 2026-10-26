# Working on Groundwork

The CLI and PR verification runtime are plain JavaScript. The local portal uses Hono and React/TypeScript with Tailwind; its graph uses React Flow with Dagre layout. Development requires Bun, Git, and Bash. Install build dependencies and use Bun to run the tests:

```sh
bun install
bun test
```

The tests create disposable projects and exercise the real CLI, including a broken-then-fixed persistence scenario, retained evidence, source freshness, and installation that preserves existing instructions. Configuration tests cover selection, catalogue references, and invariant enforcement. Set `VERIFY_TEST_TMPDIR` to an existing directory when fixtures need a specific temporary parent.

For the recorded project check, use `bun skills/verify-work/verify.mjs verify tests`. Finish a coherent implementation batch before running checks, then inspect the resulting evidence and requirement coverage.

For live local development, run `bun link` from this directory, then `groundwork install`. The personal skill and executable point at the working copy.

### Portal development

Edit `portal/`, then run `bun run build:portal`. Run a Groundwork command and follow its portal URL to inspect the result. `bun run check:portal` typechecks the portal and verifies that its generated distribution matches its source.

Commit `portal/dist/` with portal source changes. Its bundled server and browser assets let Git installations start immediately, without an install hook, dependency resolution or a development server at runtime. Build dependencies live in `devDependencies`; the distributed portal includes their license notices. The graph code loads on demand. The CLI loads only its small startup helper in-process.

Legacy CLI test fixtures disable automatic portal startup. Portal-specific tests use isolated cache scopes, exercise shared multi-repository startup, reuse and CI suppression, and clean up their own servers.

## Adding skills

Add `skills/<skill-name>/SKILL.md` with a matching lowercase kebab-case `name` and a description explaining when to use it. Keep its supporting references and scripts inside that directory. The package includes the whole `skills/` directory, and the installer discovers each skill automatically.

Run `groundwork install` to register new skills locally. After the updated package is available, users run `groundwork update` to receive it and register the new skills. A linked development checkout uses its current source; the update command does not pull or replace local work.

Keep the shared code independent of any application's stack. Put application setup, navigation, and assertions in the adopting project. Update the skill and user documentation when the command contract changes.

## Source map

- `skills/explain/`: explanation skill and supporting research.
- `skills/explore/`: investigation workflow and reusable subsystem-map template.
- `skills/verify-work/verify.mjs`: CLI, installation, adoption, guide/map discovery, and saved reports.
- `lib/config.mjs`: configuration validation, catalogue, and check selection.
- `lib/map.mjs`: feature lookup and ASCII rendering of recorded direct relationships.
- `lib/layout.mjs`: project-owned paths, runtime exclusions, and legacy-file migration.
- `lib/model.mjs`: task plans, requirement coverage, observations, evidence, and measurements.
- `lib/runner.mjs`: setup/exercise/cleanup, trials, and baseline worktrees.
- `lib/distribution.mjs`: bundled skill discovery, registration, and package updates.
- `lib/portal.mjs`: lightweight background portal startup and reuse.
- `portal/`: read-only Hono API, report/catalogue adapters, file watching and React UI.
- `portal/projects.ts`: portal-only repository registration and discovery state, stored in the user's cache.
- `test/` and `pr-verification/test/`: project behaviour and integration checks.

Use the [verification reference](skills/verify-work/references/verification.md) for the shared contracts and [`.groundwork/VERIFY.md`](.groundwork/VERIFY.md) for this repository's journeys. Keep plan bindings tied to actual assertions. Exercise failures and unavailable observations that the change can affect; a matching label or artifact is not proof of a requirement.

When changing distribution or skill paths, keep shared modules in the package and skill references inside the skill directory. The installation test exercises an extracted package through its installed skill path.

## PR verification

Validate the reusable workflow with `actionlint .github/workflows/verify.yml` after workflow changes.

The tests in `pr-verification/test/` invoke the runner against disposable Git projects with a controlled Copilot executable. They exercise failure handling, evidence validation, source preservation, and publication against a simulated GitHub client. A live Copilot smoke check and a GitHub-hosted caller run validate the external integrations.

To run locally, point `GITHUB_EVENT_PATH` at a JSON file containing the target `pull_request` payload, set `GITHUB_REPOSITORY` to its `owner/repository`, and set:

- `PR_VERIFY_REPOSITORY`: checkout to verify.
- `PR_VERIFY_CHECKS`: the project's check commands.
- Optionally, `PR_VERIFY_OUTPUT`: a fresh evidence directory. By default each run gets a new `.groundwork/runs/pr-<id>/` directory in the selected project. An explicit directory may be inside that project's `.groundwork/runs/` or outside the checkout.

Then run `bun pr-verification/scripts/verify.mjs`. Local runs use the Copilot CLI's existing authentication. In GitHub Actions, the `COPILOT_TOKEN` secret supplies the credential.

Keep project-specific policy in the calling workflow or project documentation. The runner and reporting code should remain generic.
