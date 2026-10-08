---
name: verify-work
description: Use for implementation tasks, bug fixes, and project verification setup. Preserve the requested outcome, make a small suitable change, exercise the real behaviour, and return inspectable evidence. Works in ordinary Copilot and OpenCode conversations.
---

# Verify work with Groundwork

Own the task through an evidenced result. Follow the user's existing project rules and permissions. Keep questions and explanations as discussion when implementation has not been requested.

## During ordinary work

1. Read the request, applicable instructions, relevant code, callers, and existing tests. If present, read `VERIFY.md` and the relevant checks in `verify.json`.
2. Identify the intended observable outcome, constraints, and explicit deliverables. Resolve routine details from the project. Ask only about uncertainty that materially changes the work. Briefly state acceptance conditions for substantial tasks; keep small tasks lightweight.
3. Establish how to exercise the behaviour before editing. Reproduce a reported bug when feasible. Use the actual UI, API, or CLI entry point relevant to the request.
4. Make the smallest suitable change using existing patterns. Finish a coherent implementation batch before running checks. Keep working through relevant failures and report material blockers promptly.
5. Run the project's required checks and the checks relevant to this change. With a configured project, use `groundwork verify <check> ...`; checks marked `required` are included automatically. Otherwise use existing project tools directly. Add a regression test only when it catches a realistic failure current coverage misses.
6. Inspect the actual observations and saved evidence. For UI changes, view the rendered result and exercise the interaction; compare against supplied references at relevant viewports. If the required observation is unavailable, leave that acceptance condition unverified and explain the gap.
7. Review the complete diff for intended behaviour, missed requirements, fit with the existing design, unnecessary complexity, and unrelated changes. Fix concrete issues. After further source changes, rerun affected checks. Stop once the outcome and required checks are satisfied.
8. Finish with the result, evidence, remaining gaps, and requested delivery state. For PR work, include relevant outstanding review feedback, base/conflict status, and whether changes were pushed, according to the user's instructions.

Use three claim-level outcomes: **verified** (observed as expected), **failed** (observed otherwise), and **unverified** (necessary observation unavailable). Tie each important claim to the behaviour actually checked. Test output, a screenshot, a diff review, and a performance measurement each establish different things.

The CLI's passing result establishes that its configured commands succeeded and required evidence exists. Read what those commands assert and inspect the evidence before using it to support task completion. Report omitted coverage when it matters to the request.

## When asked to adopt Groundwork in a project

1. Inspect existing instructions, setup commands, CI, tests, and application-control tools.
2. Run `groundwork init` from the intended project root. This preserves existing files. Fill in `VERIFY.md` and `verify.json` using what the project actually supports.
3. Start with one real feature or reported bug. Record its entry point, starting state, actions, expected result, implementation location, check, and evidence.
4. Reuse existing drivers and test runners. If the real interaction cannot yet be exercised, build the smallest project-owned driver needed for that journey. Keep application-specific setup, navigation, and assertions there.
5. Set check commands that make meaningful assertions. Mark checks required on every change with `required: true`. Commands receive `VERIFY_ARTIFACTS`, a fresh directory for their evidence; list required relative artifact paths in the check definition.
6. Run the selected scenario and required checks. Fix setup problems and inspect the evidence. Leave genuine environment blockers explicit. Keep the behaviour guide limited to the behaviours currently needed and maintain it as they change.

## CLI

Use `groundwork` on PATH, or run `bun <this-skill-directory>/verify.mjs` from the project's directory.

```text
groundwork init                Create project verification files
groundwork verify              Run all configured checks
groundwork verify <name> ...   Run named checks plus required checks
groundwork view report          Inspect the latest run and source freshness
```

Read `verify.json` to discover available checks. The CLI streams output and stores each run under `.verify/runs/<id>/`, including `result.json`, logs, and artifacts. A new run becomes the latest immediately, so an interrupted attempt remains incomplete. `groundwork view report` rechecks source and evidence before reporting success.

CLI outcomes and exit codes: passed / `0`, failed / `1`, inconclusive / `2`. Drivers can return `2` for unavailable setup or observations. A failed command needs diagnosis from its log. An empty configuration, interrupted run, missing evidence, or changed source cannot establish a passing result.

Source matching covers the project's Git revision, tracked local changes, and non-ignored untracked files. Record relevant external services, ignored inputs, and environment assumptions in the scenario, and rerun when they change.

## Learn from the pilot

When a concrete failure reveals a recurring problem, prefer a suitable code/data-model improvement or automated check. Improve the behaviour guide or driver when context or control was missing. Change this shared skill when the method itself needs refinement. Keep each change proportional to the evidence.
