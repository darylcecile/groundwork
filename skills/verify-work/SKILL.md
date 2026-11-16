---
name: verify-work
description: Use for implementation tasks, bug fixes, and project verification setup. Preserve the requested outcome, make a small suitable change, exercise the real behaviour, and return inspectable evidence. Works in ordinary Copilot and OpenCode conversations.
---

# Verify work with Groundwork

Own the task through an evidenced result. Follow the user's existing project rules and permissions. Keep questions and explanations as discussion when implementation has not been requested.

Use the relevant sections of [playbooks.md](playbooks.md) to choose verification cases. Read [references/verification.md](references/verification.md) when writing a plan, project configuration, or driver.

**Script-first execution:** Once a journey's starting state, actions, and expected outcomes are known, run it as one executable check, including on its first verification run. Reuse a project test/driver or write the smallest script using its existing tools. Do not spend an agent turn on each click, keypress, wait, request, or assertion. Use interactive discovery only while the next action genuinely needs a new observation or decision, then return to scripted execution. See [scripted verification](references/verification.md#scripted-verification) for batching, evidence, and failure handling.

## During ordinary work

1. Read the request, project instructions, relevant code, callers and tests. Start with `.groundwork/VERIFY.md`, then use `groundwork view guide` to find project context, feature guides, maps and checks from `.groundwork/verify.d/*.json`. Project commands automatically convert older metadata before reading it. Handle missing setup or metadata repairs through the workflow below as part of the task. Follow relevant links and check their source claims. Use `explore` when entry points, ownership, dependencies or verification paths are unclear; reuse current findings from the task.
2. Identify the intended outcomes, constraints, and deliverables before editing. Save a plan such as `.groundwork/plans/task.json` for multi-part changes or when coverage would otherwise be hard to track. Straightforward tasks can track their outcomes in the conversation. Ask only about uncertainty that materially changes the work.
3. Choose relevant playbook cases and establish how to exercise the behaviour. Reproduce a reported bug when feasible, using the actual UI, API, or CLI entry point. A source-aware regression driver can later use `--base <ref>` to exercise both revisions.
4. Make the smallest suitable change using existing patterns. Finish a coherent implementation batch before running checks. Keep working through relevant failures and report material blockers promptly.
5. When verification is configured, submit selected checks together with one `groundwork verify` invocation; add `--plan` to schedule its check and behaviour bindings. Required and active invariant checks remain included. Eligible checks may reuse matching receipts; use `--fresh` when a new execution is needed. Otherwise invoke the project's existing runner or a script. Add a regression test only for a realistic failure the current tests miss.
6. Inspect the actual observations and saved evidence. For UI changes, inspect captured rendered states and the assertions from the interaction driver; compare against supplied references at relevant viewports. Use targeted interactive inspection when the evidence cannot resolve a visual or behavioural question. If the required observation is unavailable, leave that acceptance condition unverified and explain the gap.
7. Review the complete diff for intended behaviour, missed requirements, fit with the existing design, unnecessary complexity, and unrelated changes. Fix concrete issues, including stale facts and links in affected existing maps. After further source changes, rerun affected checks. Stop once the outcome and required checks are satisfied.
8. Close every original requirement with its result and evidence, or state its remaining gap. Retain the invocation's own run ID; use `groundwork view report <id>` rather than relying on a latest pointer another run may replace. Distinguish newly executed checks from reused receipts. Finish with the requested delivery state. For PR work, include relevant outstanding review feedback, base/conflict status and whether changes were pushed, according to the user's instructions.

Report each outcome as **verified**, **failed**, or **unverified**, with supporting observations. Bind a requirement to a check only after confirming that the check actually asserts it. Inspect images, traces, and other evidence before using them to support a claim.

## Project setup and migration

Own normal setup and migration during implementation or authorized map maintenance; the user need not request `init` or edit metadata. Existing project commands prepare older layouts automatically. If contradictory definitions or project-specific paths need repair, use repository instructions, callers and checks to reconcile them, then retry. Preserve the intended behaviour and ask only when the repository cannot resolve a material choice.

1. Use `explore` to understand the primary user flow, its owning modules and constraints, and the existing setup commands, CI, tests, and application-control tools. Keep these findings for the adoption steps below.
2. When setup is missing, run `groundwork init` from the intended project root. Preparation converts base configuration into `.groundwork/verify.d/` fragments and authored `VERIFY.md` content into active `.groundwork/guides/` documents, preserving IDs, bindings, check order, instructions and links. Shared setup and constraints live in guides; `.groundwork/VERIFY.md` remains a small marked bootstrap. Superseded files are removed after conversion, and generated evidence moves to external storage. Root `AGENTS.md` remains the workflow entry point, with affected references updated.
3. Start with one real feature or reported bug. Record its entry point, starting state, actions, expected result, implementation, check and evidence to inspect in `.groundwork/guides/<feature>.md` or a bounded `.groundwork/maps/<area>.md`, reusing existing documentation. Add its checks/catalogue entries in `.groundwork/verify.d/<feature>.json`, with `guide` pointing to that document. Fragments are discovered automatically and validated together; a new feature requires no central include list or root guide index edit. Keep task, PR and run histories out of guides/maps.
4. Reuse existing drivers and test runners. If the real interaction cannot yet be exercised, build the smallest project-owned driver needed for that journey under `.groundwork/scripts/`. Keep application-specific setup, navigation, and assertions there. Put new Groundwork-specific tool configs in `.groundwork/config/` and pass their paths explicitly; use a tool's required discovery path only when it cannot load an explicitly located config.
5. Use `required: true` for checks needed on every change. Record project invariants with their enforcing checks and path scope. Add lifecycle commands, structured results or measurements when useful. Enable `reuse` only for deterministic checks with complete inputs, declaring relevant environment variables and ignored files. Keep runtime-dependent checks fresh.
6. Run the selected scenario and required checks. Fix setup problems and inspect the evidence. Leave genuine environment blockers explicit. Keep the behaviour guide and maps focused on the explored scope and maintain them as it changes. A source-derived map identifies where to verify; it is not itself a runtime observation.

## CLI

Use `groundwork` on PATH, or run `bun <this-skill-directory>/verify.mjs` from the project's directory.

```text
groundwork init                 Set up project verification and convert older metadata
groundwork verify [name ...]    Run selected checks and active invariants
  --plan <file>                 Schedule and verify saved task requirements
  --changed <ref>               Select checks using changed paths
  --base <ref>                  Compare source-aware drivers with a baseline
  --fresh                      Execute instead of reusing receipts
groundwork view guide [query]   Discover behaviours, invariants, and checks
groundwork map [feature]        View an ASCII feature overview or direct relationships
groundwork view report [id]     Inspect a specific run, or this workspace's latest
```

Groundwork adds required checks and active invariants. Plans schedule explicitly bound checks and checks covering their behaviours. Use `--changed` to select mapped areas, and inspect unmapped changes for additional verification needs. Without names or `--changed`, it selects all configured checks even with a plan.

`init`, `verify`, `view guide`, `view report` and `map` prepare project metadata automatically; PR verification prepares it before loading configuration and capturing source. Preparation is idempotent. For read-only investigation, use direct file or portal reads, which do not migrate metadata.

Use `groundwork map [feature]` to inspect recorded dependencies, consumers, source paths and verification links. Behaviour `dependsOn` relationships guide investigation; they do not bind checks or expand change-aware selection. Choose additional checks from the actual affected behaviour and assertions.

Runs and receipts live outside the checkout: `GROUNDWORK_STATE_HOME`, otherwise `$XDG_STATE_HOME/groundwork`, defaulting to `~/.local/state/groundwork`. Worktrees share a repository evidence namespace, with separate workspace latest pointers. A new run becomes its workspace's latest immediately; an interrupted attempt remains incomplete. `groundwork view report [id]` rechecks source and evidence, plus current receipt identity for checks with receipt keys, without rerunning commands. Changed declared inputs, engine, runtime or context can invalidate a receipt-backed pass independently of source changes. Checks without receipt keys receive source/evidence reassessment only. Preparation migrates legacy generated runs and pointers, removing originals only after preservation. Historical reports are not upgraded into reusable proofs.

Keep authored Groundwork project files in `.groundwork/`, including ignored task notes in `tasks/` and scratch files in `tmp/`. Guides, maps, check fragments, reusable scripts and supporting configs remain version-controlled. Commands, check path patterns and catalogue guide references are relative to the project root, not `.groundwork/`.

CLI exit codes are `0` for passed, `1` for failed, and `2` for inconclusive. Diagnose failures from their logs and evidence; keep missing requirements and unavailable observations visible.

Receipt matching covers all source content, check/engine/runtime identity, context, plan and declared inputs. The Git revision is retained as provenance and can be required by `reuse.revision`. Declared environment values are digested rather than exposed in receipts; relevant ignored files must be explicit inputs. Reuse is unavailable for repeated trials, baseline comparisons or checks with setup/cleanup. It preserves an earlier observation, not a new live observation. Inspect evidence and obtain fresh observations whenever the claim needs them.

A plan requirement with `review: true` needs an evidence-backed `kind: "review"` observation explicitly covering its requirement ID, in addition to its bindings. The PR agent works on remaining gaps, including unsatisfied review obligations; valid exact-ID review evidence can satisfy the obligation without another agent pass. Failures remain failures even if later agent observations pass.

## Drivers and comparisons

Use the project's existing application-control tools. Write captured evidence to `GROUNDWORK_EVIDENCE_DIR` (also available as `VERIFY_ARTIFACTS`), and use optional setup and cleanup commands around each exercise. Record the fixture, services, and workload used. Follow the reference's structured-result contract when returning observations or measurements.

Enable `compare` only for a driver that targets `GROUNDWORK_SOURCE_DIR`; leave it unset for ordinary commands. Inspect the baseline's failure to confirm it is the intended bug. An unavailable or already-passing baseline does not demonstrate a fix.

Use repeated trials and measurements when the task needs them. Retain every outcome; later success does not erase a failed trial. Measurement comparisons use medians under identical declared workload context. Measure the affected operation, not total command runtime, and use project-owned budgets.

## Learn from the pilot

When a concrete failure reveals a recurring problem, prefer a suitable code/data-model improvement or existing enforceable check. Record enduring project constraints as invariants backed by checks. Improve the behaviour guide or driver when context or control was missing. Change this shared skill when the method itself needs refinement. Keep each change proportional to the evidence.

## When outputting evidence path back to the user in the harness (not PR/Issues/etc)

When reporting evidence locally, link the run in the Groundwork portal when available and include its run ID. In CI, link retained evidence paths or uploaded artifacts. Do not invent a portal URL or use another invocation's latest result.
