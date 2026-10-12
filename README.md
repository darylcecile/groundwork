# Groundwork

A small personal workflow for GitHub Copilot CLI/app and OpenCode 2. Give the agent a task in normal chat. It builds an understanding of the project, records the intended outcome, makes and reviews the change, and brings back evidence for each requirement.

Groundwork's skills guide exploration, explanation, implementation, judgement and verification. The `groundwork` CLI runs project-owned checks, tracks requirement coverage and retains source-aware results. Together they make the work traceable, from the original request to observations you can inspect.

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

For a linked development checkout, the command registers the skills in that checkout; update the source with Git when needed.

## Try it in a project

Open the project in Copilot or OpenCode and say:

> Use verify-work to set this project up. Reuse its existing tools and start with one real user journey. Then help me make a small change and show evidence that it works.

The agent explores a real journey, runs `groundwork init` and fills in two files under `.groundwork/`:

- **`.groundwork/VERIFY.md`:** the behaviour guide—how to run the project, reach the feature, and observe the expected result.
- **`.groundwork/verify.json`:** named executable checks, with optional behaviour catalogue entries and enforced project invariants.

Root **`AGENTS.md`** points agents to these files. Commit the guide, configuration and `.groundwork/.gitignore` with the project when ready. Existing check configurations remain valid; add catalogue entries and richer drivers as they become useful.

Use the [`explain` skill](skills/explain/SKILL.md) for concise, friendly technical explanations that reduce jargon while preserving meaning.

> Use explain to help me understand eventual consistency with a concrete example.

Continue giving the agent tasks normally. For example: **“Make my theme selection survive restarting the application.”** The following concepts connect that request to a reviewable result.

## Behaviour Catalogue

The catalogue in `.groundwork/verify.json` connects stable behaviour IDs to descriptions, source `paths`, entry points (`entry`) and guides (`guide`). Named executable checks link to the behaviours they actually assert through `covers`. For the theme request, a `theme-persistence` behaviour could point to the preferences code and a restart guide, with a `theme-persists` check covering it.

Project invariants record constraints that must keep holding, such as malformed settings never overwriting valid preferences. Each invariant names real enforcing `checks` and can declare a path scope. A behaviour may initially have no mapped check; the catalogue exposes that verification gap.

`groundwork view guide theme` searches catalogue IDs, descriptions, paths and entry points, showing related entries, checks and guide links. Follow those links to read detailed guides and maps.

## Maps

Use the terminal to see where a feature fits:

```sh
groundwork map                    # Overview of recorded features and dependencies
groundwork map theme-persistence  # Focus on one feature and its direct neighbours
```

A feature is a behaviour in the catalogue. The focused ASCII view shows what it depends on, which features use it, and the displayed features' entry points, implementation paths, covering checks and guides. Use an exact behaviour ID or a unique case-insensitive match in an ID or description; ambiguous queries list the matching IDs. The overview includes all recorded feature relationships.

Relationships are stored as an optional `dependsOn` array of behaviour IDs. For example, theme persistence could depend on settings storage. `explore` records direct connections supported by source evidence and keeps the explanation in the narrative map. Consumers are derived from those same links. Missing relationships are shown as unrecorded; viewing a map is read-only and does not run verification checks.

The catalogue helps locate a behaviour; maps explain how its subsystem fits together. The [`explore` skill](skills/explore/SKILL.md) traces entry points, owning modules, data and state, dependencies, constraints, relevant history and verification paths, citing sources and recording gaps. It uses existing project tools for runtime observations when needed.

For a focused question, ask:

> Use explore to explain how saving preferences works, which modules own it, and what a change could affect.

That answer can stay in chat. Project adoption and explicit mapping requests retain reusable understanding under `.groundwork/maps/<area>.md`:

> Use explore to map preferences under .groundwork/maps/ and connect it to the existing verification guide and checks.

Maps are tracked documents linked from `.groundwork/VERIFY.md` and relevant catalogue entries. They identify the inspected source and distinguish source findings from runtime observations. Revalidate affected claims against current source before reuse and refresh them as the implementation changes. Before a nontrivial change, exploration supplies the context for task planning; current findings can be reused within the task.

## Tasks

The [`implement` skill](skills/implement/SKILL.md) turns that context into `.groundwork/tasks/<priority>-<name>.md`. Each task records its goal and scope, references, decisions, definition of done, implementing and judging model IDs, and implementation and verification checklists. Larger requests can be split into coherent pieces and delegated with the relevant exploration findings. Priorities are unique; notes are ignored local working files, updated during the work and deleted on completion.

For theme persistence, the definition of done should require a fresh application process to read the saved selection. That gives both the implementer and reviewer an observable outcome to work towards.

For multi-part changes, save a separate JSON verification plan in `.groundwork/plans/` stating the goal and requirements, with expectations bound to check or behaviour IDs. The runner freezes a plan snapshot into the run before execution. Task Markdown is agent working context, not a CLI-parsed plan. In the local CLI, `--plan` adds required coverage; it does not schedule bound checks by itself. Select checks by name, through `--changed`, or by running all checks. Straightforward changes can track verification requirements in chat.

## Judgement

The implement skill calls for different implementing and judging models, ideally from different families or with complementary strengths. Once a coherent change has been implemented and exercised, an independent review checks correctness, completeness against the definition of done, adherence to requirements, readability, maintainability and efficiency, including slop and unnecessary complexity.

Findings drive fixes and affected re-verification before the task is complete. In the theme example, a judge should question a check that only reads in-memory state: it does not establish persistence across a process restart.

Judgement is an agent/skill workflow. The CLI does not spawn judges, select models or certify their verdicts. Independent review adds another assessment to inspect alongside the evidence; it does not guarantee correctness.

## Verification

The [`verify-work` skill](skills/verify-work/SKILL.md) reuses the project's actual tools to exercise intended behaviour through its UI, API or CLI. For theme persistence, set a theme, stop the process, start a fresh one and assert the saved selection. Retain the observed value and relevant logs or artifacts. A claim about the rendered theme also needs an observation of the rendered result.

The agent uses these commands as needed:

```sh
groundwork init                              # Adopt the current project
groundwork view guide theme                  # Discover related behaviours and checks
groundwork map theme-persistence              # View feature relationships and context
groundwork verify                            # Run every configured check
groundwork verify theme-persists --plan .groundwork/plans/task.json
groundwork verify --changed main --plan .groundwork/plans/task.json
groundwork view report                       # Inspect the latest result and evidence
```

Named and change-aware runs include required checks and active invariant checks. With `--changed`, scoped invariants follow matching paths and unscoped invariants always apply; otherwise all invariants are active. Without names or `--changed`, every configured check runs. Inspect unmapped changes and behaviours without checks for planning gaps.

Use `--base <ref>` for real baseline comparisons with drivers explicitly opted into `compare` and targeting `GROUNDWORK_SOURCE_DIR`. A regression comparison needs the intended baseline assertion failure and candidate success under the same declared context; measurement comparisons need matching workloads. Ordinary checks run against the candidate only. `--changed` selects checks; it does not perform a baseline comparison.

Runs retain any plan snapshot, results, logs, observations, measurements and trial artifacts under `.groundwork/runs/<id>/`. An initialized run becomes the latest before checks execute, so an interrupted run cannot reuse an earlier success. CLI execution outcomes are:

- **Passed (`0`):** selected checks, planned coverage, and required evidence are complete.
- **Failed (`1`):** an assertion, observation, or measurement failed; inspect the retained result.
- **Inconclusive (`2`):** setup, evidence, coverage, comparison, or source freshness is incomplete.

The agent can also run `bun <skill-directory>/verify.mjs` from the project when `groundwork` is unavailable on its PATH. See the [verification reference](skills/verify-work/references/verification.md) for plan/configuration examples, driver results and the comparison contract, and the [playbooks](skills/verify-work/playbooks.md) for choosing relevant cases.

## Trust

Confidence belongs to a specific claim with a traceable chain: **requirement → assertion or observation → evidence → identified source and context**. A map, check name or attached artifact alone is not proof. Inspect the actual assertions and observations, including images or traces, and close each original requirement against what they establish.

Requirement outcomes are distinct from CLI execution status: **verified** means observations support the requirement, **failed** means an observation contradicts it, and **unverified** means the necessary observation is missing or blocked. A passing persistence check supports the process and storage scenario actually exercised; it does not establish every platform or rendering path. Keep those limits visible in the handoff.

The source fingerprint covers Git `HEAD`, tracked local changes and non-ignored untracked inputs, excluding Groundwork's local runtime files. `groundwork view report` rechecks source freshness and saved evidence separately without rerunning commands. Changed source or missing or changed evidence prevents reusing prior success. Relevant ignored inputs, external services and fixture/workload assumptions need declared, non-secret context and fresh observations when they change.

Start with one complete loop: reproduce a problem, fix it, rerun the same behaviour and inspect the evidence. Tell the agent where you still had to intervene or could not trust the result; improve the relevant project pattern, check, driver or skill from that concrete experience.

## Project layout

```text
AGENTS.md                     Agent-discoverable workflow reference
.groundwork/
  VERIFY.md                   Behaviour guide
  verify.json                 Checks, behaviours and invariants
  .gitignore                  Ignore only local working files and evidence
  scripts/                    Reusable Groundwork-owned drivers and helpers
  config/                     Supporting tool configs, loaded explicitly
  maps/                       Reusable subsystem and feature maps
  plans/                      Local JSON verification plans (ignored)
  tasks/                      Local Markdown implementation notes (ignored)
  tmp/                        Scratch files (ignored)
  runs/                       Retained run evidence (ignored)
  latest                      Latest CLI run identifier (ignored)
```

Create supporting directories only when needed. Reuse existing project tools; new Groundwork-owned helpers and configs belong here. Commands still run from the project root, and check path patterns and catalogue guide references are project-root-relative. Tools with mandatory discovery locations, such as [GitHub Actions' `.github/workflows/`](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows), retain those locations.

Keep `.groundwork/` itself tracked: changes to its guide, checks, scripts and configs must participate in source freshness and change-aware selection. Its own `.gitignore` handles generated output without changing the project's root ignore file.

### Existing projects

Run `groundwork init` again to move legacy root `verify.json`, `VERIFY.md` and `.verify/` contents into `.groundwork/`. It preserves existing content, updates catalogue references to the moved guide and refreshes the generated `AGENTS.md` instruction. Conflicting destinations, including names differing only in case or Unicode normalisation, stop migration before files are moved. A legacy `.verify/.gitignore` is preserved as the inactive `.groundwork/legacy-verify.gitignore`, so old runtime ignore rules cannot hide reusable inputs. Review custom Markdown links in a moved guide and any references to old paths when relocating your own helper scripts.

The CLI and PR runner prefer `.groundwork/verify.json`, with legacy root configuration supported when that file is absent. New runs always use `.groundwork/runs/`; the CLI can still read legacy evidence until a new run is started or it is migrated. Rerun verification after migration because the source paths have changed.

## Further reading

- [Workflow and confidence framework](WORKFLOW.md): the working loop, evidence standards and handoff.
- [PR verification workflow](pr-verification/README.md): a final CI pass with project checks, agent-led verification and a PR comment linking results and evidence.
- [CONTRIBUTING.md](CONTRIBUTING.md): working on the toolkit.
