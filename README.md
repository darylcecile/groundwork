# Groundwork

A small personal workflow for GitHub Copilot CLI/app and OpenCode 2. Give the agent a task in normal chat. It records the intended outcome, makes the change, exercises the relevant behaviour, and brings back evidence for each requirement.

- **[Workflow and confidence framework](WORKFLOW.md):** what the agent does and what counts as verified.
- **`verify-work` skill:** the same workflow in both products.
- **[Verification reference](skills/verify-work/references/verification.md):** plans, behaviour catalogues, project invariants, drivers, and comparisons.
- **`groundwork` CLI:** repeatable checks, requirement coverage, retained evidence, and source-aware reports.
- **[PR verification workflow](pr-verification/README.md):** a final CI pass with project checks, agent-led verification, and a PR comment linking the results and evidence.

## Install

Requires Bun, Git, and Bash. The projects being checked can use any language or toolchain.

Install from GitHub using Bun, with SSH access to the private repository:

```sh
bun add --global git@github.com:darylcecile/groundwork.git
groundwork install
```

`groundwork install` registers every bundled skill under `~/.agents/skills/` and adds a short instruction to Copilot and OpenCode's existing global instructions. Start a new Copilot session and reload OpenCode after installing.

## Update

```sh
groundwork update
```

This resolves the latest commit on Groundwork's repository default branch, installs that revision through Bun, then runs the updated installer to register new skills and refresh Groundwork's existing skill links. Refresh your agent session afterward to pick up the changes.

For an older installation without this command, remove its global package with `bun remove --global @darylcecile/groundwork`, then follow the installation steps above once.

For a linked development checkout, the command registers the skills in that checkout; update the source with Git when needed.

## Try it in a project

Open the project in Copilot or OpenCode and say:

> Use verify-work to set this project up. Reuse its existing tools and start with one real user journey. Then help me make a small change and show evidence that it works.

The agent runs `groundwork init` and fills in two project files:

- **`VERIFY.md`:** the behaviour guide—how to run the project, reach the feature, and observe the expected result.
- **`verify.json`:** named checks, with optional behaviour mappings and enforced project invariants.

Commit those files with the project when ready. Existing check configurations remain valid; add catalogue entries and richer drivers as they become useful.

For multi-part changes, the agent saves a verification plan, reuses the project's checks and relevant [playbooks](skills/verify-work/playbooks.md), and closes every requirement or explains its gap. Straightforward tasks can track their outcomes in the conversation. Plans such as `.verify/plan.json` and run evidence stay in the ignored `.verify/` directory. Continue giving the agent tasks normally.

## Commands

The agent uses these as needed:

```sh
groundwork init                              # Adopt the current project
groundwork view guide theme                  # Discover related behaviours and checks
groundwork verify                            # Run every configured check
groundwork verify theme-persists --plan .verify/plan.json
groundwork verify --changed main --plan .verify/plan.json
groundwork view report                       # Inspect the latest result and evidence
```

Named and change-aware runs also include required checks and active invariant checks. Unmapped changes and behaviours without checks help identify planning gaps. The agent can use `--base <ref>` with a source-aware driver to reproduce a regression or compare measurements.

See the [verification reference](skills/verify-work/references/verification.md) for the complete plan/configuration example, driver result format, and comparison contract. The agent can also run `bun <skill-directory>/verify.mjs` from the project when `groundwork` is unavailable on its PATH.

## Reading the result

- **Passed (`0`):** selected checks, planned coverage, and required evidence are complete.
- **Failed (`1`):** an assertion, observation, or measurement failed; inspect the retained result.
- **Inconclusive (`2`):** setup, evidence, coverage, comparison, or source freshness is incomplete.

Individual requirements are **verified**, **failed**, or **unverified**. A passing check supports the assertions it actually makes; attaching a requirement label or an evidence file does not establish arbitrary intent. The agent inspects observations and closes the task against its original requirements.

Runs retain logs, trials, measurements, and artifacts under `.verify/runs/`. `groundwork view report` rechecks source freshness and saved evidence without rerunning commands. Record relevant fixtures, services, and workload assumptions as non-secret context, and rerun when those inputs change.

## Refine it through use

For the first project, aim for one complete loop: reproduce a problem, fix it, rerun the same behaviour, and inspect the evidence. Tell the agent where you still had to intervene or could not trust the result. Improve the relevant project pattern, check, driver, or skill from that concrete experience.

See [CONTRIBUTING.md](CONTRIBUTING.md) for working on the toolkit.
