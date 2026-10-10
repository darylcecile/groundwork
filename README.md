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

The agent runs `groundwork init` and fills in two files under `.groundwork/`:

- **`.groundwork/VERIFY.md`:** the behaviour guide—how to run the project, reach the feature, and observe the expected result.
- **`.groundwork/verify.json`:** named checks, with optional behaviour mappings and enforced project invariants.

Root **`AGENTS.md`** points agents to these files. Commit the guide, configuration and `.groundwork/.gitignore` with the project when ready. Existing check configurations remain valid; add catalogue entries and richer drivers as they become useful.

For multi-part changes, the agent saves a verification plan, reuses the project's checks and relevant [playbooks](skills/verify-work/playbooks.md), and closes every requirement or explains its gap. Straightforward tasks can track their outcomes in the conversation. Continue giving the agent tasks normally.

### Project layout

```text
AGENTS.md                     Agent-discoverable workflow reference
.groundwork/
  VERIFY.md                   Behaviour guide
  verify.json                 Checks, behaviours and invariants
  .gitignore                  Ignore only local working files and evidence
  scripts/                    Reusable Groundwork-owned drivers and helpers
  config/                     Supporting tool configs, loaded explicitly
  plans/                      Local task plans (ignored)
  tasks/                      Local implementation notes (ignored)
  tmp/                        Scratch files (ignored)
  runs/                       Retained run evidence (ignored)
  latest                      Latest CLI run identifier (ignored)
```

Create supporting directories only when needed. Reuse existing project tools; new Groundwork-owned helpers and configs belong here. Commands still run from the project root, and check path patterns and catalogue guide references are project-root-relative. Tools with mandatory discovery locations, such as [GitHub Actions' `.github/workflows/`](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows), retain those locations.

Keep `.groundwork/` itself tracked: changes to its guide, checks, scripts and configs must participate in source freshness and change-aware selection. Its own `.gitignore` handles generated output without changing the project's root ignore file.

### Existing projects

Run `groundwork init` again to move legacy root `verify.json`, `VERIFY.md` and `.verify/` contents into `.groundwork/`. It preserves existing content, updates catalogue references to the moved guide and refreshes the generated `AGENTS.md` instruction. Conflicting destinations, including names differing only in case or Unicode normalization, stop migration before files are moved. A legacy `.verify/.gitignore` is preserved as the inactive `.groundwork/legacy-verify.gitignore`, so old runtime ignore rules cannot hide reusable inputs. Review custom Markdown links in a moved guide and any references to old paths when relocating your own helper scripts.

The CLI and PR runner prefer `.groundwork/verify.json`, with legacy root configuration supported when that file is absent. New runs always use `.groundwork/runs/`; the CLI can still read legacy evidence until a new run is started or it is migrated. Rerun verification after migration because the source paths have changed.

## Commands

The agent uses these as needed:

```sh
groundwork init                              # Adopt the current project
groundwork view guide theme                  # Discover related behaviours and checks
groundwork verify                            # Run every configured check
groundwork verify theme-persists --plan .groundwork/plans/task.json
groundwork verify --changed main --plan .groundwork/plans/task.json
groundwork view report                       # Inspect the latest result and evidence
```

Named and change-aware runs also include required checks and active invariant checks. Unmapped changes and behaviours without checks help identify planning gaps. The agent can use `--base <ref>` with a source-aware driver to reproduce a regression or compare measurements.

See the [verification reference](skills/verify-work/references/verification.md) for the complete plan/configuration example, driver result format, and comparison contract. The agent can also run `bun <skill-directory>/verify.mjs` from the project when `groundwork` is unavailable on its PATH.

## Reading the result

- **Passed (`0`):** selected checks, planned coverage, and required evidence are complete.
- **Failed (`1`):** an assertion, observation, or measurement failed; inspect the retained result.
- **Inconclusive (`2`):** setup, evidence, coverage, comparison, or source freshness is incomplete.

Individual requirements are **verified**, **failed**, or **unverified**. A passing check supports the assertions it actually makes; attaching a requirement label or an evidence file does not establish arbitrary intent. The agent inspects observations and closes the task against its original requirements.

Runs retain logs, trials, measurements, and artifacts under `.groundwork/runs/`. `groundwork view report` rechecks source freshness and saved evidence without rerunning commands. Record relevant fixtures, services, and workload assumptions as non-secret context, and rerun when those inputs change.

## Refine it through use

For the first project, aim for one complete loop: reproduce a problem, fix it, rerun the same behaviour, and inspect the evidence. Tell the agent where you still had to intervene or could not trust the result. Improve the relevant project pattern, check, driver, or skill from that concrete experience.

See [CONTRIBUTING.md](CONTRIBUTING.md) for working on the toolkit.
