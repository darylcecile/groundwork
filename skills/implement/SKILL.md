---
name: implement
description: Use for implementation tasks, feature development, and project setup.
---

Use applicable skills already available in the session. Personal-skills installation is a best-effort bootstrap, not a session-start prerequisite: skip it when those skills are already available or installed. Do not inventory the user's repository, compare versions, or report setup status on every task.

If bootstrap is needed, make one quiet, noninteractive global install attempt using the environment's package runner (`bunx`, `pnpm dlx`, or `npx --yes`). If none is available, skip bootstrap; do not install a package manager. With the current user's GitHub login known, for example:

```sh
bunx skills add "<github-login>/skills" --global --yes >/dev/null 2>&1 || true
```

Reuse a known login. If unknown, at most one quiet `gh api user --jq .login` lookup may precede the install in the same tool call; skip bootstrap if it fails. Do not infer the user from the current repository's owner. Use a short tool timeout, accept installation failure, and continue the task without retrying, prompting for authentication, or narrating the outcome. Revisit setup only when the user requests it or a missing skill is necessary to the task. Load only applicable installed instructions.

Carry out the requested work as described by the user. Make sure to follow the project's existing design (patterns, conventions, architecture, and guidelines). It is important to maintain consistency and adhere to established practices throughout the implementation, while reducing cyclomatic complexity and avoiding unnecessary deviations from the project's standards.

If the user has provided an issue or reference, make sure to review it thoroughly to understand the context, requirements, and any constraints before starting the implementation. If the provided source is ambiguous or incomplete, seek clarification from the user before proceeding.

For a nontrivial change, use the `explore` skill before deciding the implementation scope and approach. Reuse a relevant exploration from this task when it is still current. Carry its entry points, owning modules, data flow, constraints, affected callers, verification options, and unresolved questions into the task context and any delegated brief. Existing `.groundwork/maps/` documents help navigate; confirm the relevant claims against current source before relying on them.

Load and use `verify-work` for every implementation task, reading the project's `.groundwork/VERIFY.md` and `.groundwork/verify.json` when present. Before executing a known deterministic multi-step browser, device, API, or CLI verification, reuse an existing driver/test or write the smallest script—even for the first run. Use bounded interactive discovery only until the target and flow are known; then batch the known steps, returning to the model only for decisions, failure diagnosis, or evidence review. Do not execute a known journey one action per tool turn.

Preserve real assertions, condition-based waits, and sequential stateful order in the driver; batching does not mean parallel actions against the same browser or device session. Reuse the project runner. Put new reusable journey drivers in `.groundwork/scripts/` and register them in the existing active verification configuration, including legacy root `verify.json`. If none exists, invoke the existing runner or script directly. A tiny one-off may use a single batched tool invocation without adding a framework or integration suite. Keep per-action narration and successful step logs out of model context: retain full diagnostic logs and artifacts, surface concise outcomes, failed assertions, and evidence paths, and inspect the evidence before claiming success.

Create a `.groundwork/tasks/<priority>-<name>.md` file to document the ask and track any progress, decisions, and context. Prioritising tasks helps both the agent and the user to focus on the most important work first. Never have multiple tasks with the same priority. As you complete a task, delete the corresponding file.

Keep Groundwork-owned project files inside `.groundwork/`: reusable helpers in `scripts/`, supporting tool configs in `config/`, plans in `plans/`, and scratch files in `tmp/`. Reuse existing project tools. Keep root `AGENTS.md` as the discoverable entry point to `.groundwork/VERIFY.md` and `.groundwork/verify.json`; use a tool's required discovery path when it cannot load an explicitly located config. Run commands from the project root and pass helper/config paths explicitly. Commit reusable files; keep task notes, plans, scratch files and run evidence ignored through `.groundwork/.gitignore`.

As you form an understanding of the task, continuously update the task files with your findings, decisions, and any clarifications obtained from the user. This ensures that all relevant information is captured and can be referenced throughout the implementation process, even if a context compacting occurs.

The task documentation should be structured in the following manner:

```markdown
# {Task Name}

- **Priority:** <priority of the task>
- **Model:** <model ID to be used for the task>
- **Judge Model:** <model ID to be used for judging the task>

## Task Overview
<brief description of the task; including its use case>

## Context and References
- <links to issues, references, or relevant documentation>

## Decisions (ADRs, Product Requirements, and Decisions)
- <notes on progress, decisions made, and rationale>

## Definition of Done
- <criteria that must be met for the task to be considered complete>

## Implementation Checklist
- <list of items to complete>

## Verification Checklist
- <list of items to verify the implementation>

```

As you progress through a task, make sure to keep the checklist state up to date, marking items as completed or verified as appropriate. This helps maintain a clear view of the task's progress and ensures that all necessary steps are accounted for.

Additionally, regularly review the decisions and context sections to ensure that any changes or new information are accurately reflected. This practice helps maintain alignment with the project's goals and facilitates effective communication among team members.

> [!IMPORTANT]
> When deciding the models, make sure to consider the task requirements, the capabilities of each available models, and the expected outcomes to ensure the most suitable model is chosen for the task. Never choose the same model for implementation and judging; ideally choose models from different families or with complementary strengths. For example, you might choose a model optimized for code generation for implementation (like `gpt-6 astra` using `xhigh`) and a model optimized for reasoning and evaluation for judging (like `claude-opus-5.5` using `xhigh`).

**Order of operation:**
- Review the issue or reference provided by the user.
- Explore the affected behaviour and its boundaries; use the findings to define the task and verification needs.
- Create task files in `.groundwork/tasks/` with the appropriate priority, model, and name.
	- Make sure to slice up the tasks appropriately to ensure manageable and coherent units of work.
	- Defining multiple smaller tasks makes parallel implementation and verification more efficient and manageable.
	- The models should be clearly specified (no vague deferral to "use any model" or similar).
	- The models should be different from the ones used for judging to ensure independent evaluation.
- Continuously update the relevant task files with context, decisions, and progress.
- Once you are confident that the task files are correctly set up, use Groundwork to prepare the tasks for implementation; defining real objectives, goals, and journeys based on the context of the task files themselves.
- For each task, spin up the necessary subagent (based on model specified in the task), and assign it to handle the implementation according to the prepared objectives, goals, and journeys.
  - Include the journey's starting state, expected assertions, and existing checks in the brief; require the completion report to provide the exact reproducible check command and saved evidence paths.
- Follow the implementation checklist to complete the task.
- Refresh affected existing maps and their guide/catalogue links as part of the change. Use `explore` to retrace a changed flow when needed; distinguish source findings from runtime observations.
- Once the implementation checklist is complete, run its scripted verification through `groundwork verify ...` (or the existing project runner if no Groundwork configuration exists), then inspect the observations and evidence. Address relevant failures and keep the task file current until verified.
- When a subagent reports a task as completed, spawn a new judge subagent (based on task judge model specified) to evaluate the implementation and ensure it meets the defined criteria.
  - Judge agents can give feedback and request revisions (which should be outlined in the task file).
  - Revisions should be addressed before the task can be considered complete and verified.
  - The judge should check the definition of done against the implementation, driver assertions, and saved evidence before approving. Rerun affected checks only when changes, failures, stale evidence, or missing evidence/coverage justify another run; use the reproducible command instead of manually replaying a known journey.
  - The judge should provide clear reasoning for any requested revisions to ensure the implementer understands the necessary changes.
  - The judge MUST evaluate the implementation for correctness, completeness, adherence to requirements, and overall quality _INCLUDING_ checking for slop and complexity.
  - The judge's response should cover:
    - Correctness of the implementation.
    - Completeness of the implementation based on the definition of done - as specified in the task file.
    - Adherence to the defined requirements - as specified in the task file.
    - Overall quality, including readability, maintainability, and efficiency.
    - Identification of any slop or unnecessary complexity - based on `dmmulroy/anti-slop` guidelines.
- Delete the task file once the task is fully completed and verified; and the task meets definition of done. 
- Once all tasks are completed and verified - with evidence documented with groundwork, delete the folder `.groundwork/tasks/` when empty.

## Remember

- Avoid over-architecting; it undermines good implementation.
- Complexity reduces value. Keep cyclomatic complexity low and avoid unnecessary complexity.
- Make the output understandable to humans: prefer clear formatting, reviewable implementation, and simple solutions that emphasize readability and maintainability.
- Avoid test-slop; ensure that tests are precise, reliable, and cover the intended functionality without being overly specific.
- Avoid implementation slop; you can use https://github.com/dmmulroy/anti-slop/tree/main for guidance and best practices.
- When delegating, we need to ensure the subagents dont know they are being evaluated by a judge agent. This helps maintain unbiased and accurate assessments of their work.
- NEVER add defensive or negative regression assertions! If I said something shouldn't be there, just remove it - dont add tests to make sure it's not there.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

## Break glass options

- If the user is frustrated about UI implementation, or has shown dislike to the UI you have generated, you may use [Impeccable](https://impeccable.style) to overhaul and redo the UI from scratch. This should improve your output. Do this UNLESS they tell you not to.
