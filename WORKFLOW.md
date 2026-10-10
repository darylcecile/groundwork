# Groundwork: workflow and confidence framework

**The goal:** give an agent a task in normal chat and receive a small, suitable change with enough evidence to judge whether it meets the request.

## The working loop

1. **Understand the outcome.** Read the request, project rules, relevant code, callers, and tests. Identify the observable result and the important constraints. Ask about ambiguity only when it changes the work. For a substantial task, briefly state the acceptance conditions before editing; small tasks can keep this lightweight.
2. **Choose how to prove it.** Find the real path through the feature and the existing checks. For a bug, reproduce the reported failure when possible. Decide which observations would establish success before changing the implementation.
3. **Make the smallest suitable change.** Follow the project's established patterns. Complete a coherent batch, then check it. Resolve relevant failures autonomously and give brief updates at meaningful milestones or blockers.
4. **Verify and review.** Exercise the changed behaviour, run the project's required checks, and inspect the complete diff for missed requirements, regressions, unnecessary complexity, and unrelated changes. Rerun affected checks after subsequent code changes. Stop when the requested outcome and required checks are satisfied.
5. **Hand back the result.** State what works, the evidence, and any remaining gaps. Include requested delivery state: commits, pushes, PRs, or releases. Resolve every explicit deliverable or explain its blocker.

## What confidence means

Confidence belongs to a **specific claim**, supported by an observation on identified source and relevant starting state.

> **Claim:** the selected theme survives restarting the app.
>
> **Observed:** selected dark theme, restarted, and read dark as the saved and rendered selection.
>
> **Evidence:** assertion output and an inspected screenshot from this run.
>
> **Source:** checked revision and local changes.
>
> **Gap:** browser coverage is limited to the browser actually exercised.

Use three outcomes:

- **Verified:** the relevant observations support the claim.
- **Failed:** an observation contradicts the expected outcome.
- **Unverified:** the necessary observation is missing or the environment blocked it.

The CLI reports execution outcomes as passed, failed, or inconclusive. The agent connects those results to the task's acceptance conditions. Keep gaps visible; an unverified requirement remains open.

### Match evidence to the claim

- **Behaviour:** exercise the user flow, API, or CLI through its real entry point and check the result. For a bug, use the same reproduction before and after the fix where feasible.
- **UI:** view the rendered screen at the relevant viewport and inspect interaction and states. Check supplied references for hierarchy, alignment, spacing, and content.
- **Code quality:** inspect how the diff fits the existing design, interfaces, ownership, and data flow. Use existing lint, types, and architectural checks for their enforced constraints.
- **Performance:** measure the relevant workload before and after only when performance is part of the task or an observed concern.

Choose evidence proportional to the actual change. Reuse existing coverage. Add a regression test when it catches a realistic failure the current tests miss. A fresh review pass can help; a separate agent is useful only when the task warrants delegation and it is permitted.

## The project contribution

Each adopted project supplies a small behaviour guide in `.groundwork/VERIFY.md` and repeatable checks in `.groundwork/verify.json`, linked from root `AGENTS.md`. Start with one journey:

1. What does this feature do, and where is its implementation?
2. What starting state and running services does it need?
3. How does a user reach and exercise it?
4. What must happen?
5. Which command or direct observation checks that, and where is the evidence?

Reuse the project's existing browser tooling, test runner, API client, and development commands. When a recurring interaction needs automation, make one small project-owned driver under `.groundwork/scripts/`; put its supporting configs in `.groundwork/config/`. Keep task plans, notes, scratch files and evidence under `.groundwork/` as well. Update the behaviour guide when the feature's entry point or behaviour changes.

## The handoff

Keep the final response short, for example:

> Theme selection now survives restart. The persistence scenario and required checks passed; the restarted screen was inspected. Evidence: `.groundwork/runs/<run>/`. Firefox was not exercised. Changes are local; not pushed.

## Improving the framework

After a concrete failure or repeated correction, put the lesson where it will be most effective:

1. Improve the code or data model when that naturally prevents the mistake.
2. Add an appropriate automated constraint or regression check.
3. Update the behaviour guide or driver when the agent lacked context or control.
4. Update the shared skill when the working method needs to change.

Keep improvements proportional to the problem. Judge the pilot by whether the agent met the outcome, demonstrated it, and reduced your interventions.

## Integration references

[OpenCode 2 skills](https://opencode.ai/v2/docs/skills), [OpenCode 2 instructions](https://opencode.ai/v2/docs/instructions), [Copilot CLI skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), and [Copilot app customization](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app).
