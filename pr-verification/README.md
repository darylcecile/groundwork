# PR verification

A final verification pass for GitHub pull requests. Each run records the required outcomes, project checks, observations and remaining gaps. The workflow shares that record as a PR artifact when available, otherwise a comment, preserving per-run history.

The workflow runs and comments in the **repository that imports it**. This first version supports PR branches within that repository.

## Share a local result

Ordinary verification always retains a local record, independently of GitHub. Agents publish it as part of tasks that include PR delivery, following existing permissions and approval rules; local-only tasks stay local. Publication uses a PR artifact when available, otherwise a comment with readable Markdown and hidden, versioned JSON.

```text
groundwork publish pr [number-or-url] --run <id>
groundwork view pr [number-or-url]
```

Publish with the invocation's own explicit run ID; omitting the PR selects the current branch's PR. Publication reassesses the saved run and target source while preserving the original snapshot. A dirty run can support identical content later committed and pushed; coverage and review obligations still apply.

The read-only `view pr` command also accepts a URL outside an adopted project. It shows recorded outcomes and current-head matching, with historical records still visible; it does not reassess the local environment. The latest current-head record determines exit `0` (passed), `1` (failed), or `2` (incomplete or absent).

Published reports provide review context, not automatic local receipt reuse. Full evidence archives are optional attachments; retain the observations and any UI evidence required for the claim. See the [record contract](../skills/verify-work/references/verification.md#local-records-and-pr-publication).

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
  statuses: write

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

Create the repository or organization secret **`COPILOT_TOKEN`** using a fine-grained personal access token with **Copilot Requests** permission and **Contents: read** access to `darylcecile/groundwork`. It authenticates the agent and checks out Groundwork's private helper code. The importing repository's ordinary `GITHUB_TOKEN` handles its checkout, PR comment and verification status; the caller grants `pull-requests: write` and `statuses: write` as shown above. The agent uses the Copilot CLI's default model.

GitHub supports sharing this private personal repository's workflow with other private repositories owned by `darylcecile`. Enable that access in Groundwork's **Settings → Actions → General → Access** when configuring a caller.

### Inputs

- **`checks`** — shell commands overriding ordinary change-based selection. Required, plan-bound and active invariant checks remain included; unrelated path matches do not add checks. A failed command stops this block and remains a failure in the final result. When omitted, the workflow selects changed areas from the merged `.groundwork/verify.d/*.json` catalogue. Older metadata is converted automatically before configuration and source capture.
- **`plan`** — optional project-relative JSON plan. Otherwise the agent prepares a plan from the PR, project guidance and available checks. Plan bindings schedule their checks and behaviour checks. A requirement can set `review: true` to require an evidence-backed `kind: "review"` observation explicitly covering its ID; already-valid review evidence can satisfy it without another agent pass.
- **`compare-base`** — opt into running source-aware, comparison-enabled drivers against the PR base. Defaults to `false`.
- **`setup`** — optional commands to install dependencies and prepare the project.
- **`artifacts`** — optional newline-separated files or directories relative to the project directory. Paths are copied into the evidence bundle; glob patterns are not used.
- **`working-directory`** — project directory within the importing checkout; defaults to `.`.
- **`verifier-ref`** — Groundwork's ref; defaults to `main`. When pinning the workflow to a tag or SHA, set this input to the same ref so its helper code matches.

Commands run in Bash on an Ubuntu GitHub-hosted runner. Bun and Copilot CLI are installed by the workflow; use `setup` to prepare other toolchains or project dependencies. Setup/check commands should finish; let the test runner or agent manage application startup and cleanup. Commands and the agent receive **`PR_VERIFY_OUTPUT`**, an absolute evidence directory outside the source checkout. The whole job has a 30-minute limit.

For local invocation, the runner defaults to a fresh `pr-<id>` run in the external evidence store: `GROUNDWORK_STATE_HOME`, otherwise `$XDG_STATE_HOME/groundwork`, defaulting to `~/.local/state/groundwork`. `PR_VERIFY_DIRECTORY` selects the project, including nested projects. An explicit `PR_VERIFY_OUTPUT` still places the evidence bundle in that fresh directory, either under the selected project's `.groundwork/runs/` or outside the checkout. The hosted workflow continues to use runner temporary storage for its uploaded evidence bundle.

## What it verifies

1. Check out the importing PR's proposed merge revision, prepare project metadata, then capture its context and source. Preparation preserves older configuration and guide content in active fragments and guides before verification begins.
2. Load the supplied plan or have the agent identify the required outcomes. The runner freezes the plan and adds active project invariants.
3. Run setup and selected checks/drivers, reusing eligible deterministic receipts when their inputs and evidence match. Required, plan-bound and active invariant checks remain included. Local and PR verification use the same driver and evidence contract.
4. Assess remaining verification gaps, including unsatisfied review obligations. Skip the verification agent when all requirements already have valid evidence and the assessment passes. Otherwise have it inspect the results and exercise remaining requirements through relevant UI/API/CLI entry points. Observations name the plan requirements they establish.
5. Validate observations and retained evidence, then account for every requirement. An omitted outcome remains unverified. The agent cannot remove requirements by rewriting the plan.
6. Publish the text report and verification status, with an evidence archive when available. A reporting job holds PR-comment and commit-status permissions. It checks the current PR head, title, and description before publishing so a changed request receives a fresh verification plan.

The result is **passed**, **failed**, or **inconclusive**. Failed configured checks remain failures even if the agent reports positive observations. Missing required reports, unavailable observations, missing evidence and source changes prevent a passing result. The verification job fails for both failed and inconclusive outcomes.

## PR report and assets

The comment includes the PR commit and tested checkout, requirement coverage, setup/check results, behaviour observations, comparison and trial summaries, verification context and gaps. A **Download evidence** link appears when an archive is available. Archive availability alone does not determine verification status; the assertions, observations, source match and coverage do.

When uploaded, the archive contains `plan.json`, `result.json`, stage logs, retained driver evidence, any agent report/transcripts and captured evidence under `agent/`, and declared project artifacts under `project/`. A skipped agent phase is recorded without requiring an agent report. Screenshots, recordings, traces and HTML reports are downloadable through that link. Retention follows the importing repository's artifact settings.

The workflow uses the importing project's existing tests and application-control tools, along with project verification guidance when available.

See the [verification reference](../skills/verify-work/references/verification.md) for plans, catalogue metadata, driver results, and comparisons. Bind requirements only to checks that genuinely assert them; a generic build command does not establish an application's user behaviour.

## Development

See [CONTRIBUTING.md](../CONTRIBUTING.md#pr-verification) for tests and local verification.

References: [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Copilot automation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), and [artifact links](https://github.com/actions/upload-artifact#outputs).
