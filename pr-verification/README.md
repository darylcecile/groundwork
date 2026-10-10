# PR verification

A final verification pass for GitHub pull requests. It records the required outcomes, runs project checks and active invariants, then exercises remaining behaviour against that fixed plan. One updated PR comment combines requirement coverage, observations, and links to captured evidence.

The workflow runs and comments in the **repository that imports it**. This first version supports PR branches within that repository.

## Use in a repository

Add this caller workflow as `.github/workflows/verify.yml` in a project. [GitHub Actions requires that discovery location](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows); Groundwork's project configuration and helpers live under `.groundwork/`:

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

- **`checks`** — shell commands for existing project verification. A failed command stops this block and remains a failure in the final result. When omitted, the workflow uses the project's `.groundwork/verify.json` catalogue to select checks for the changed areas, falling back to a legacy root `verify.json`.
- **`plan`** — optional project-relative JSON plan. Otherwise the agent prepares a plan from the PR, project guidance, and available checks before verification begins.
- **`compare-base`** — opt into running source-aware, comparison-enabled drivers against the PR base. Defaults to `false`.
- **`setup`** — optional commands to install dependencies and prepare the project.
- **`artifacts`** — optional newline-separated files or directories relative to the project directory. Paths are copied into the evidence bundle; glob patterns are not used.
- **`working-directory`** — project directory within the importing checkout; defaults to `.`.
- **`verifier-ref`** — Groundwork's ref; defaults to `main`. When pinning the workflow to a tag or SHA, set this input to the same ref so its helper code matches.

Commands run in Bash on an Ubuntu GitHub-hosted runner. Bun and Copilot CLI are installed by the workflow; use `setup` to prepare other toolchains or project dependencies. Setup/check commands should finish; let the test runner or agent manage application startup and cleanup. Commands and the agent receive **`PR_VERIFY_OUTPUT`**, an absolute evidence directory outside the source checkout. The whole job has a 30-minute limit.

For local invocation, the runner defaults to a fresh `.groundwork/runs/pr-<id>/` directory within the selected project, including when `PR_VERIFY_DIRECTORY` selects a nested project. Set `PR_VERIFY_OUTPUT` to use another fresh directory under that project's `.groundwork/runs/` or outside the checkout. The hosted workflow explicitly uses runner temporary storage for its uploaded evidence bundle.

## What it verifies

1. Check out the importing PR's proposed merge revision and capture its context.
2. Load the supplied plan or have the agent identify the required outcomes. The runner freezes the plan and adds active project invariants.
3. Run setup, configured checks, relevant named drivers, and invariant checks, retaining each result. Local and PR verification use the same driver and evidence contract.
4. Have the agent inspect the results and exercise remaining requirements through relevant UI/API/CLI entry points. Observations name the plan requirements they establish.
5. Validate observations and retained evidence, then account for every requirement. An omitted outcome remains unverified. The agent cannot remove requirements by rewriting the plan.
6. Upload the evidence bundle and update one PR comment. A reporting job holds the PR-writing permission. It checks the current PR head, title, and description before publishing so a changed request receives a fresh verification plan.

The result is **passed**, **failed**, or **inconclusive**. Failed configured checks remain failures even if the agent reports positive observations. Missing reports, unavailable observations, missing evidence, and source changes prevent a passing result. The verification job fails for both failed and inconclusive outcomes.

## PR report and assets

The comment includes the PR commit and tested checkout, requirement coverage, setup/check results, behaviour observations, comparison and trial summaries, verification context, gaps, and a **Download evidence** link.

The artifact contains `plan.json`, `result.json`, stage logs, the agent report and transcripts, trial-specific driver evidence, captured agent evidence under `agent/`, and declared project artifacts under `project/`. Screenshots, recordings, traces, and HTML reports are downloadable through that link. Retention follows the importing repository's artifact settings.

The workflow uses the importing project's existing tests and application-control tools, along with project verification guidance when available.

See the [verification reference](../skills/verify-work/references/verification.md) for plans, catalogue metadata, driver results, and comparisons. Bind requirements only to checks that genuinely assert them; a generic build command does not establish an application's user behaviour.

## Development

See [CONTRIBUTING.md](../CONTRIBUTING.md#pr-verification) for tests and local verification.

References: [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Copilot automation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), and [artifact links](https://github.com/actions/upload-artifact#outputs).
