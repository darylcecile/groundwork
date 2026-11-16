# Project verification

Keep this root guide small and stable: setup, shared constraints and catalogue navigation. Fill it from the real project when adopting Groundwork. Root `AGENTS.md` points here; the installed `verify-work` skill provides the plan, configuration and driver reference.

## Run and control

- Setup and start commands:
- Required local services and starting data:
- Entry point (URL, API or CLI):
- Existing test and application-control tools:
- Shared required checks:

## Shared constraints

Record enduring project-wide constraints, required environments and the checks that enforce them. Shared check definitions and context belong in `.groundwork/verify.json`. Use `required: true` for checks needed on every change; active invariant checks are always included.

## Find a feature

Use `groundwork view guide <query>` to find behaviours, checks and their guides. Use `groundwork map [feature]` for source-backed dependencies and consumers. Follow the catalogue's `guide` link and check cited source before relying on a map; discovery is not evidence that a behaviour passed.

Put new journey instructions in `.groundwork/guides/<feature>.md` or a bounded `.groundwork/maps/<area>.md`. Describe the real entry point, starting state, actions, expected outcomes, owning implementation, check and evidence to inspect. Reuse existing documentation. Keep task plans, PR summaries, run histories and artifact inventories in their own records.

Add the feature's checks and catalogue entries in `.groundwork/verify.d/<feature>.json`. Fragments are discovered automatically, with references validated across files. The entry's `guide` points to the feature document; no root index or central include list needs updating. Bind checks only to behaviours they actually assert.

## Verification conventions

- Reuse project tools. Groundwork-owned drivers belong in `.groundwork/scripts/` and supporting tool configs in `.groundwork/config/`.
- Commands, input paths and catalogue references are project-root-relative; Markdown links are relative to their document.
- Plans, task notes and scratch files belong in ignored `.groundwork/plans/`, `tasks/` and `tmp/` directories.
- Drivers write evidence to `GROUNDWORK_EVIDENCE_DIR` (`VERIFY_ARTIFACTS` also works). Generated runs and receipts live in the external state store, not in this guide.
- Enable check `reuse` only for deterministic, input-complete checks; declare relevant ignored files and environment variables. Use `--fresh` when a new execution is needed.
- Inspect the invocation's own run with `groundwork view report <id>`. A receipt or screenshot does not replace the observation needed for the claim.

Keep existing authored guides intact during migration. Move or split their contents only as deliberate documentation work, preserving useful instructions and links.
