# PR verification

A final verification pass for GitHub pull requests. It runs the project's configured checks, then a Copilot agent assesses the PR's intended outcome and exercises relevant behaviour. One updated PR comment combines the results with links to logs and captured assets.

The workflow runs and comments in the **repository that imports it**. This first version supports PR branches within that repository.

## Use in a repository

Add this caller workflow as `.github/workflows/verify.yml` in a project:

```yaml
name: Final verification

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: final-verification-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  verify:
    uses: darylcecile/groundwork/.github/workflows/verify.yml@main
    with:
      setup: bun install --frozen-lockfile
      checks: |
        bun run lint
        bun test
        bun run build
      artifacts: |
        test-results
    secrets:
      COPILOT_TOKEN: ${{ secrets.COPILOT_TOKEN }}
```

Replace the setup/check commands with the project's real commands. Include only artifact paths those commands or the agent will actually produce; omit `artifacts` for projects that need only command logs and agent-captured evidence.

Create the repository or organization secret **`COPILOT_TOKEN`** using a fine-grained personal access token with **Copilot Requests** permission and **Contents: read** access to `darylcecile/groundwork`. It authenticates the agent and checks out Groundwork's private helper code. The importing repository's ordinary `GITHUB_TOKEN` handles its checkout and PR comment. The agent uses the Copilot CLI's default model.

GitHub supports sharing this private personal repository's workflow with other private repositories owned by `darylcecile`. Enable that access in Groundwork's **Settings → Actions → General → Access** when configuring a caller.

### Inputs

- **`checks`** — required shell commands for existing project verification. A failed command stops this block and remains a failure in the final result.
- **`setup`** — optional commands to install dependencies and prepare the project.
- **`artifacts`** — optional newline-separated files or directories relative to the project directory. Paths are copied into the evidence bundle; glob patterns are not used.
- **`working-directory`** — project directory within the importing checkout; defaults to `.`.
- **`verifier-ref`** — Groundwork's ref; defaults to `main`. When pinning the workflow to a tag or SHA, set this input to the same ref so its helper code matches.

Commands run in Bash on an Ubuntu GitHub-hosted runner. Bun and Copilot CLI are installed by the workflow; use `setup` to prepare other toolchains or project dependencies. Setup/check commands should finish; let the test runner or agent manage application startup and cleanup. Commands and the agent receive **`PR_VERIFY_OUTPUT`**, an absolute evidence directory outside the source checkout. The whole job has a 30-minute limit.

## What it verifies

1. Check out the importing PR's proposed merge revision.
2. Run setup and the configured project checks, retaining their logs.
3. Give the agent the PR description, checked source, comparison revision, project tools, and check results.
4. Have the agent exercise acceptance conditions, inspect relevant UI/API/CLI behaviour, capture evidence, and report gaps. It assesses the change rather than fixing it.
5. Validate the agent's structured claims and referenced evidence. A successful agent process by itself is insufficient for a passing result.
6. Upload the evidence bundle and update one PR comment. A reporting job holds the PR-writing permission. It checks the current PR head before publishing and skips results for an older commit.

The result is **passed**, **failed**, or **inconclusive**. Failed configured checks remain failures even if the agent reports positive observations. Missing reports, unavailable observations, missing evidence, and source changes prevent a passing result. The verification job fails for both failed and inconclusive outcomes.

## PR report and assets

The comment includes the PR commit and tested checkout, setup/check results, behaviour observations, gaps, workflow logs, and a **Download evidence** link.

The artifact contains `result.json`, stage logs, the agent report and transcript, captured evidence under `agent/`, and declared project artifacts under `project/`. Screenshots, recordings, traces, and HTML reports are downloadable through that link. Retention follows the importing repository's artifact settings.

The workflow uses the importing project's existing tests and application-control tools, along with project verification guidance when available.

## Development

See [CONTRIBUTING.md](../CONTRIBUTING.md#pr-verification) for tests and local verification.

References: [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Copilot automation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), and [artifact links](https://github.com/actions/upload-artifact#outputs).
