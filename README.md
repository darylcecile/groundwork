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

The agent explores a real journey and handles setup and migration as part of its work. Project-owned verification lives under `.groundwork/`:

- **`VERIFY.md`:** a small bootstrap linking project context and catalogue discovery.
- **`guides/` and `maps/`:** shared setup, constraints, bounded journeys and subsystem explanations.
- **`verify.d/*.json`:** executable checks, context and catalogue entries, discovered automatically.

Root **`AGENTS.md`** points agents to the workflow. Commit reusable guides, configuration and `.groundwork/.gitignore` with the project when ready. Existing metadata is converted automatically. A feature can add its own guide and configuration fragment without editing a central include list or guide index.

Use the [`explain` skill](skills/explain/SKILL.md) for concise, friendly technical explanations that reduce jargon while preserving meaning.

> Use explain to help me understand eventual consistency with a concrete example.

Continue giving the agent tasks normally. For example: **“Make my theme selection survive restarting the application.”** The following concepts connect that request to a reviewable result.

## Behaviour Catalogue

The merged catalogue from `.groundwork/verify.d/*.json` connects stable behaviour IDs to descriptions, source `paths`, entry points (`entry`) and guides (`guide`). Named executable checks link to the behaviours they actually assert through `covers`. For the theme request, a `theme-persistence` behaviour could point to the preferences code and a restart guide, with a `theme-persists` check covering it. References are validated across files; duplicate IDs are errors rather than overrides.

Project invariants record constraints that must keep holding, such as malformed settings never overwriting valid preferences. Each invariant names real enforcing `checks` and can declare a path scope. A behaviour may initially have no mapped check; the catalogue exposes that verification gap.

`groundwork view guide theme` searches catalogue IDs, descriptions, paths and entry points, showing related entries, checks and guide links. Follow those links to read detailed guides and maps.

## Maps

Use the terminal to see where a feature fits:

```sh
groundwork map                    # Overview of recorded features and dependencies
groundwork map theme-persistence  # Focus on one feature and its direct neighbours
```

A feature is a behaviour in the catalogue. The focused ASCII view shows what it depends on, which features use it, and the displayed features' entry points, implementation paths, covering checks and guides. Use an exact behaviour ID or a unique case-insensitive match in an ID or description; ambiguous queries list the matching IDs. The overview includes all recorded feature relationships.

Relationships are stored as an optional `dependsOn` array of behaviour IDs. For example, theme persistence could depend on settings storage. `explore` records direct connections supported by source evidence and keeps the explanation in the narrative map. Consumers are derived from those same links. Missing relationships are shown as unrecorded. The command prepares older metadata when needed, then displays the map without running verification checks.

The catalogue helps locate a behaviour; maps explain how its subsystem fits together. The [`explore` skill](skills/explore/SKILL.md) traces entry points, owning modules, data and state, dependencies, constraints, relevant history and verification paths, citing sources and recording gaps. It uses existing project tools for runtime observations when needed.

For a focused question, ask:

> Use explore to explain how saving preferences works, which modules own it, and what a change could affect.

That answer can stay in chat. Project adoption and explicit mapping requests retain reusable understanding under `.groundwork/maps/<area>.md`:

> Use explore to map preferences under .groundwork/maps/ and connect it to the existing verification guide and checks.

Maps are tracked documents reached through relevant catalogue entries and feature guides. They identify the inspected source and distinguish source findings from runtime evidence, which stays with its run. Keep maps focused on enduring behaviour and ownership, without task, PR or run histories. Revalidate affected claims against current source before reuse. Before a nontrivial change, exploration supplies the context for task planning; current findings can be reused within the task.

## Tasks

The [`implement` skill](skills/implement/SKILL.md) turns that context into `.groundwork/tasks/<priority>-<name>.md`. Each task records its goal and scope, references, decision links, definition of done, implementing and judging model IDs, and implementation and verification checklists. Larger requests can be split into coherent pieces and delegated with the relevant exploration findings. Priorities are unique; notes are ignored local working files, updated during the work and deleted on completion.

Meaningful decisions outlive those notes. The agent consults and maintains the project's existing ADR location, or `.groundwork/decisions/<topic>.md` when none exists. Each bounded record keeps its status, reason and consequences; a later decision links to the one it supersedes. The agent promotes durable choices before final verification and note deletion, without asking users to maintain a decision log for routine edits.

For theme persistence, the definition of done should require a fresh application process to read the saved selection. That gives both the implementer and reviewer an observable outcome to work towards.

For multi-part changes, save a separate JSON verification plan in `.groundwork/plans/` stating the goal and requirements, with expectations bound to check or behaviour IDs. Optional `decisions` lists project-relative `.md` decision files. The runner freezes the plan and schedules its bound checks, including checks covering its behaviours, alongside required and active invariant checks. Task Markdown is agent working context, not a CLI-parsed plan. Add `review: true` to a requirement that also needs an evidence-backed review observation. Straightforward changes can track verification requirements in chat.

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
groundwork verify theme-persists --fresh      # Execute even if a reusable receipt exists
groundwork view report                       # Inspect this workspace's latest result
groundwork view report <id>                  # Inspect a specific run
groundwork publish pr [number-or-url] --run <id> # Share this invocation's run
groundwork view pr [number-or-url]            # Read verification published on a PR
```

Named, plan-based and change-aware runs include required checks and active invariant checks. With `--changed`, scoped invariants follow matching paths and unscoped invariants always apply; otherwise all invariants are active. Without names or `--changed`, every configured check is selected, including when a plan is supplied. Inspect unmapped changes and behaviours without checks for planning gaps.

Use `--base <ref>` for real baseline comparisons with drivers explicitly opted into `compare` and targeting `GROUNDWORK_SOURCE_DIR`. A regression comparison needs the intended baseline assertion failure and candidate success under the same declared context; measurement comparisons need matching workloads. Ordinary checks run against the candidate only. `--changed` selects checks; it does not perform a baseline comparison.

Runs retain the plan, results, logs, observations, measurements and trial artifacts in the [external evidence store](#evidence-storage). An initialized run becomes this workspace's latest before checks execute, so an interrupted attempt remains incomplete. Each invocation reports its own run ID even when another run starts concurrently. CLI execution outcomes are:

- **Passed (`0`):** selected checks, planned coverage, and required evidence are complete.
- **Failed (`1`):** an assertion, observation, or measurement failed; inspect the retained result.
- **Inconclusive (`2`):** setup, evidence, coverage, comparison, or input freshness is incomplete.

The agent can also run `bun <skill-directory>/verify.mjs` from the project when `groundwork` is unavailable on its PATH. See the [verification reference](skills/verify-work/references/verification.md) for plan/configuration examples, driver results and the comparison contract, and the [playbooks](skills/verify-work/playbooks.md) for choosing relevant cases.

### Incremental evidence

Checks execute by default. A deterministic check can opt into reusable receipts with `reuse: true`, or declare extra inputs with `reuse: { "env": ["TZ"], "files": [".local-fixture.json"], "revision": true }`. A receipt records an executed check and its retained evidence. Reuse requires matching source content, check definition, engine, runtime, context, plan and declared inputs, with intact evidence. Environment values are digested rather than included in the receipt as plain text.

Opt in only when those inputs fully determine the result. Declare relevant ignored files explicitly; live services and changing external state usually need fresh execution. Source matching covers all project source inputs, not just the check's `paths`. Repeated trials, baseline comparisons and checks with setup or cleanup execute afresh. `--fresh` bypasses reuse for the selected run.

Reports show whether each check executed or reused a receipt. Reuse preserves the original observation; it does not create a new live or visual observation. Review the evidence before claiming it establishes the current requirement.

### Local records and PR sharing

Verification always keeps a local record, whether or not a PR or GitHub access exists. Each local save retains authoritative `result.json` and derives `report.md` with readable Markdown and hidden, versioned JSON. It describes what was checked and why, the source revision and local changes, outcomes, fresh or reused results, context and timing, remaining gaps, and relevant decision links. Generated records belong with the run in the external evidence store.

For tasks that include PR delivery, the agent shares the record as part of delivery under existing permissions and approval rules; local-only tasks stay local. Use `groundwork publish pr [number-or-url] --run <id>` with the invocation's own required run ID; omitting the PR selects the current branch's PR. Publication uses a PR artifact when available, otherwise a comment, and reassesses the run and target source while retaining the original snapshot. A dirty run can support a PR once identical source content is committed and pushed; coverage and review obligations still apply.

`groundwork view pr [number-or-url]` shows recorded outcomes and whether they match the current PR head, with historical records still visible. It does not reassess the local environment; a URL also works outside an adopted project. Published reports provide review context, not automatically reusable receipts.

A full evidence archive is optional; its absence alone does not invalidate a result. Retain the observations and evidence the claim actually needs, including visual inspection and screenshots required for UI work. Publishing a summary does not replace that work. See the [verification reference](skills/verify-work/references/verification.md#local-records-and-pr-publication) for the contract.

## Local portal

Run a local project command such as `groundwork verify`, `view report`, `view guide` or `map` outside CI to register its project with the local portal. One small background server handles all your repositories and listens on `127.0.0.1`. Registration is silent. Set `GROUNDWORK_PORTAL=0` to disable automatic startup.

Use the project selector in the top bar to switch repositories. The portal remembers registered project paths under `$XDG_CACHE_HOME/groundwork/portal` (default `~/.cache/groundwork/portal`), separately from verification data. Read the listening port from the `port` file in that directory and open `http://127.0.0.1:<port>`. Project-specific URLs can be bookmarked.

The server exits after 30 minutes without an open portal or recent requests. The next local project command starts it again with the registered projects available; an updated server build replaces the shared daemon automatically.

The portal reads saved evidence and the project's catalogue:

- **Reports:** browse run history, check results, saved receipts, requirement outcomes, observations, trials and comparisons.
- **Evidence:** open logs, images, recordings and structured evidence in a preview modal without losing your place. HTML renders as a saved-page preview; originals remain downloadable.
- **Catalogue:** explore behaviours, enforcing invariants, check bindings, implementation paths and guides.
- **Map:** explore connected behaviours on a React Flow canvas with pan, zoom and fit-to-view controls. Select a node to inspect its dependencies, consumers and verification pointers.

File changes update the open portal automatically. Results are labelled as **saved snapshots**: browsing does not rerun verification or reassess source, evidence or receipt inputs. An unfinished report stays unfinished; it is not assumed to be an active process. Use `groundwork view report` for freshness reassessment.

The portal supports local and PR reports in the external store and legacy repository-local storage. Browsing preserves report and evidence files. Map relationships come from the merged catalogue's `dependsOn` metadata; unrecorded relationships stay unrecorded.

## Trust

Confidence belongs to a specific claim with a traceable chain: **requirement → assertion or observation → evidence → identified source and context**. A map, check name or attached artifact alone is not proof. Inspect the actual assertions and observations, including images or traces, and close each original requirement against what they establish.

Requirement outcomes are distinct from CLI execution status: **verified** means observations support the requirement, **failed** means an observation contradicts it, and **unverified** means the necessary observation is missing or blocked. A passing persistence check supports the process and storage scenario actually exercised; it does not establish every platform or rendering path. Keep those limits visible in the handoff.

Source matching covers tracked and non-ignored untracked content, excluding Groundwork's runtime files. The Git revision is retained for provenance; revision-sensitive reusable checks can require it with `reuse.revision`. `groundwork view report [id]` rechecks source and saved evidence without rerunning commands. For checks with receipt keys, it also recomputes the receipt identity: changed declared environment values, ignored files, engine, runtime or context can make a prior pass inconclusive even when source is unchanged. Checks without receipt keys receive source/evidence reassessment only. External services and fixture/workload assumptions still need appropriate observations.

Start with one complete loop: reproduce a problem, fix it, rerun the same behaviour and inspect the evidence. Tell the agent where you still had to intervene or could not trust the result; improve the relevant project pattern, check, driver or skill from that concrete experience.

## Project layout

```text
AGENTS.md                     Agent-discoverable workflow reference
.groundwork/
  VERIFY.md                   Bootstrap to project context and catalogue discovery
  verify.d/                   Auto-discovered checks, context and catalogue entries
  guides/                     Project context and bounded feature journeys
  .gitignore                  Ignore local working files
  scripts/                    Reusable Groundwork-owned drivers and helpers
  config/                     Supporting tool configs, loaded explicitly
  maps/                       Reusable subsystem and feature maps
  decisions/                  Durable decisions, when the project has no ADR location
  plans/                      Local JSON verification plans (ignored)
  tasks/                      Local Markdown implementation notes (ignored)
  tmp/                        Scratch files (ignored)
```

Create supporting directories only when needed. Reuse existing project tools; new Groundwork-owned helpers and configs belong here. Commands still run from the project root, and check path patterns and catalogue guide references are project-root-relative. Tools with mandatory discovery locations, such as [GitHub Actions' `.github/workflows/`](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows), retain those locations.

Keep `.groundwork/` itself tracked: changes to its guides, checks, scripts and configs must participate in source freshness and change-aware selection. Its own `.gitignore` handles local working files.

### Evidence storage

Generated runs and reusable receipts live outside the checkout. The storage root is `GROUNDWORK_STATE_HOME` when set, otherwise `$XDG_STATE_HOME/groundwork`, defaulting to `~/.local/state/groundwork`. Worktrees of the same repository share an evidence namespace; each workspace has its own latest-run pointer. Use the run ID and evidence paths returned by the command for a precise handoff.

### Existing projects

Normal project commands (`init`, `verify`, `view guide`, `view report` and `map`) automatically prepare older metadata. PR verification does the same before loading configuration and capturing source. Configuration and authored guidance move into active `verify.d/` fragments and guides, preserving IDs, bindings, check order and instructions. Whole-document command inputs stay together in one active file. Guide and instruction references are updated and superseded files are removed. The agent handles project-specific repairs from repository context.

Legacy runs and latest pointers move to the external evidence store before their originals are removed. Historical reports retain their original identity. Preparation is idempotent; subsequent reads leave the converted metadata unchanged. Portal browsing and configuration reads do not perform migration.

## Further reading

- [Workflow and confidence framework](WORKFLOW.md): the working loop, evidence standards and handoff.
- [PR verification workflow](pr-verification/README.md): a final CI pass with project checks, agent verification for remaining gaps and a PR comment linking results and evidence.
- [CONTRIBUTING.md](CONTRIBUTING.md): working on the toolkit.
