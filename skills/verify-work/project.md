# Behaviour guide

Fill this from the real project when adopting Groundwork. Start with one journey and reuse existing tools. The installed `verify-work` skill links to the plan, configuration, and driver reference.

This guide lives at `.groundwork/VERIFY.md`, linked from root `AGENTS.md`. Keep Groundwork-owned scripts and supporting configs in `.groundwork/scripts/` and `.groundwork/config/`. Commands and catalogue paths are project-root-relative; Markdown links in this guide are relative to this file.

## Run and control

- Setup and start commands:
- Required local services and starting data:
- Entry point (URL, API, or CLI):
- Existing test and application-control tools:
- Required checks:

## Behaviours

### First behaviour

- Stable catalogue ID:
- Purpose and implementation location:
- Starting state:
- How the user reaches it:
- Actions:
- Expected result:
- Repeatable check in `.groundwork/verify.json`:
- Evidence to capture and inspect:
- Relevant failure or cancellation cases:

Map this ID in `.groundwork/verify.json` under `behaviours`, with relevant paths, its entry point, and a project-root-relative `guide` link such as `.groundwork/VERIFY.md#first-behaviour`. Link enforcing checks through `covers`. Add entries incrementally; record gaps when a behaviour has no check yet.

## Project invariants

Record actual project constraints and the checks that enforce them. Keep roles, policies, and budgets specific to this project.

- Invariant ID and description:
- Affected paths, or why it applies globally:
- Existing enforcing check IDs:
- Implementation or guide reference:

Declare these under `invariants` in `.groundwork/verify.json`. Active invariant checks run even for named selection. An invariant without paths is always active; without change-aware selection, all invariants are active.

## Task plans and drivers

Before implementation, record the task's goal and observable requirements, for example in `.groundwork/plans/task.json`. Bind requirements to checks or behaviours whose assertions establish them, then pass the plan to verification. Close every requirement with evidence or its remaining gap. Keep task notes in `.groundwork/tasks/` and scratch files in `.groundwork/tmp/`.

Reuse existing drivers. Record any needed setup, cleanup, fixture, mocked-service, and workload context here. Drivers save evidence under `GROUNDWORK_EVIDENCE_DIR` (`VERIFY_ARTIFACTS` also works). Enable baseline comparison only for drivers that target `GROUNDWORK_SOURCE_DIR`.

## Known verification gaps

Record unavailable environments, missing check mappings, and observations still needed for these journeys. Inspect unmapped changed paths and uncovered behaviours when choosing verification; catalogue entries alone do not prove coverage.
