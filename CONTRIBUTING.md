# Working on Groundwork

The CLI and PR verification runtime are plain JavaScript with no package dependencies or build step. Use Bun to run their integration tests:

```sh
bun test
```

The tests create disposable projects and exercise the real CLI, including a broken-then-fixed persistence scenario, retained evidence, source freshness, and installation that preserves existing instructions.

For live local development, run `bun link` from this directory, then `verify install`. The personal skill and executable point at the working copy.

Keep the shared code independent of any application's stack. Put application setup, navigation, and assertions in the adopting project. Update the skill and user documentation when the command contract changes.

## PR verification

Validate the reusable workflow with `actionlint .github/workflows/verify.yml` after workflow changes.

The tests in `pr-verification/test/` invoke the runner against disposable Git projects with a controlled Copilot executable. They exercise failure handling, evidence validation, source preservation, and publication against a simulated GitHub client. A live Copilot smoke check and a GitHub-hosted caller run validate the external integrations.

To run locally, point `GITHUB_EVENT_PATH` at a JSON file containing the target `pull_request` payload, set `GITHUB_REPOSITORY` to its `owner/repository`, and set:

- `PR_VERIFY_REPOSITORY`: checkout to verify.
- `PR_VERIFY_CHECKS`: the project's check commands.
- `PR_VERIFY_OUTPUT`: a fresh evidence directory outside that checkout.

Then run `bun pr-verification/scripts/verify.mjs`. Local runs use the Copilot CLI's existing authentication. In GitHub Actions, the `COPILOT_TOKEN` secret supplies the credential.

Keep project-specific policy in the calling workflow or project documentation. The runner and reporting code should remain generic.
