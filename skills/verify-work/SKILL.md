---
name: verify-work
description: Use for implementation tasks, bug fixes, and project verification setup. Preserve the requested outcome, make a small suitable change, exercise the real behaviour, and return inspectable evidence. Works in ordinary Copilot and OpenCode conversations.
---

# Verify work with Groundwork

Own the task through an evidenced result. Follow the user's existing project rules and permissions. Keep questions and explanations as discussion when implementation has not been requested.

Use the relevant sections of [playbooks.md](playbooks.md) to choose verification cases. Read [references/verification.md](references/verification.md) when writing a plan, project configuration, or driver.

## During ordinary work

1. Read the request, project instructions, relevant code, callers, and tests. If present, read `VERIFY.md` and `verify.json`; use `groundwork view guide` to find relevant behaviours and checks.
2. Identify the intended outcomes, constraints, and deliverables before editing. Save a plan such as `.verify/plan.json` for multi-part changes or when coverage would otherwise be hard to track. Straightforward tasks can track their outcomes in the conversation. Ask only about uncertainty that materially changes the work.
3. Choose relevant playbook cases and establish how to exercise the behaviour. Reproduce a reported bug when feasible, using the actual UI, API, or CLI entry point. A source-aware regression driver can later use `--base <ref>` to exercise both revisions.
4. Make the smallest suitable change using existing patterns. Finish a coherent implementation batch before running checks. Keep working through relevant failures and report material blockers promptly.
5. When `verify.json` exists, run relevant checks with `groundwork verify`; add `--plan` when using a saved plan. Otherwise run the project's existing verification commands directly. Reuse coverage and add a regression test only for a realistic failure the current tests miss.
6. Inspect the actual observations and saved evidence. For UI changes, view the rendered result and exercise the interaction; compare against supplied references at relevant viewports. If the required observation is unavailable, leave that acceptance condition unverified and explain the gap.
7. Review the complete diff for intended behaviour, missed requirements, fit with the existing design, unnecessary complexity, and unrelated changes. Fix concrete issues. After further source changes, rerun affected checks. Stop once the outcome and required checks are satisfied.
8. Close every original requirement with its result and evidence, or state its remaining gap. Finish with the requested delivery state. For PR work, include relevant outstanding review feedback, base/conflict status, and whether changes were pushed, according to the user's instructions.

Report each outcome as **verified**, **failed**, or **unverified**, with supporting observations. Bind a requirement to a check only after confirming that the check actually asserts it. Inspect images, traces, and other evidence before using them to support a claim.

## When asked to adopt Groundwork in a project

1. Inspect existing instructions, setup commands, CI, tests, and application-control tools.
2. Run `groundwork init` from the intended project root. This preserves existing files. Fill in `VERIFY.md` and `verify.json` using what the project actually supports.
3. Start with one real feature or reported bug. Record its entry point, starting state, actions, expected result, implementation location, check, and evidence. Add catalogue entries and path mappings incrementally.
4. Reuse existing drivers and test runners. If the real interaction cannot yet be exercised, build the smallest project-owned driver needed for that journey. Keep application-specific setup, navigation, and assertions there.
5. Use `required: true` for checks needed on every change. Record project invariants with their enforcing checks and path scope. Add lifecycle commands, structured results, or measurements when useful.
6. Run the selected scenario and required checks. Fix setup problems and inspect the evidence. Leave genuine environment blockers explicit. Keep the behaviour guide limited to the behaviours currently needed and maintain it as they change.

## CLI

Use `groundwork` on PATH, or run `bun <this-skill-directory>/verify.mjs` from the project's directory.

```text
groundwork init                  Create project verification files
groundwork verify [name ...]    Run selected checks and active invariants
  --plan <file>                  Verify the saved task requirements
  --changed <ref>                Select checks using changed paths
  --base <ref>                   Compare source-aware drivers with a baseline
groundwork view guide [query]   Discover behaviours, invariants, and checks
groundwork view report           Inspect coverage, results, and freshness
```

Groundwork adds required checks and active invariants. Use `--changed` to select mapped areas, and inspect unmapped changes for additional verification needs. Without names or `--changed`, it runs all configured checks.

The CLI stores each run under `.verify/runs/<id>/`, including the plan, results, logs, and trial artifacts. A new run becomes the latest immediately, so an interrupted attempt remains incomplete. `groundwork view report` rechecks source and evidence without rerunning commands.

CLI exit codes are `0` for passed, `1` for failed, and `2` for inconclusive. Diagnose failures from their logs and evidence; keep missing requirements and unavailable observations visible.

Source matching covers the project's Git revision, tracked local changes, and non-ignored untracked files. Record relevant external services, ignored inputs, and environment assumptions in the scenario, and rerun when they change.

## Drivers and comparisons

Use the project's existing application-control tools. Write captured evidence to `GROUNDWORK_EVIDENCE_DIR` (also available as `VERIFY_ARTIFACTS`), and use optional setup and cleanup commands around each exercise. Record the fixture, services, and workload used. Follow the reference's structured-result contract when returning observations or measurements.

Enable `compare` only for a driver that targets `GROUNDWORK_SOURCE_DIR`; leave it unset for ordinary commands. Inspect the baseline's failure to confirm it is the intended bug. An unavailable or already-passing baseline does not demonstrate a fix.

Use repeated trials and measurements when the task needs them. Retain every outcome; later success does not erase a failed trial. Measurement comparisons use medians under identical declared workload context. Measure the affected operation, not total command runtime, and use project-owned budgets.

## Learn from the pilot

When a concrete failure reveals a recurring problem, prefer a suitable code/data-model improvement or existing enforceable check. Record enduring project constraints as invariants backed by checks. Improve the behaviour guide or driver when context or control was missing. Change this shared skill when the method itself needs refinement. Keep each change proportional to the evidence.
