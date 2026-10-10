---
name: implement
description: Use for implementation tasks, feature development, and project setup.
---

> [!IMPORTANT]
> Required pre-work: Before implementation, check whether the current user has a GitHub skills repository. If one exists, ensure its skills are installed and load applicable instructions. Report the outcome before proceeding. E.g. `<github_user_login>/skills` repo. You may find the current user using `git` or `gh`.

Carry out the requested work as described by the user. Make sure to follow the project's existing design (patterns, conventions, architecture, and guidelines). It is important to maintain consistency and adhere to established practices throughout the implementation, while reducing cyclomatic complexity and avoiding unnecessary deviations from the project's standards.

If the user has provided an issue or reference, make sure to review it thoroughly to understand the context, requirements, and any constraints before starting the implementation. If the provided source is ambiguous or incomplete, seek clarification from the user before proceeding.

Create a `.groundwork/tasks/<priority>-<name>.md` file to document the ask and track any progress, decisions, and context. Prioritising tasks helps both the agent and the user to focus on the most important work first. Never have multiple tasks with the same priority. As you complete a task, delete the corresponding file.

Keep Groundwork-owned project files inside `.groundwork/`: reusable helpers in `scripts/`, supporting tool configs in `config/`, plans in `plans/`, and scratch files in `tmp/`. Reuse existing project tools. Keep root `AGENTS.md` as the discoverable entry point to `.groundwork/VERIFY.md` and `.groundwork/verify.json`; use a tool's required discovery path when it cannot load an explicitly located config. Run commands from the project root and pass helper/config paths explicitly. Commit reusable files; keep task notes, plans, scratch files and run evidence ignored through `.groundwork/.gitignore`.

As you form an understanding of the task, continuously update the task files with your findings, decisions, and any clarifications obtained from the user. This ensures that all relevant information is captured and can be referenced throughout the implementation process, even if a context compacting occurs.

The task documentation should be structured in the following manner:

```markdown
# {Task Name}

- **Priority:** <priority of the task>
- **Model:** <model to be used for the task>
- **Judge Model:** <model to be used for judging the task>

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
> When deciding the models, make sure to consider the task requirements, the capabilities of each available models, and the expected outcomes to ensure the most suitable model is chosen for the task. Never choose the same model for implementation and judging; ideally choose models from different families or with complementary strengths.

Order of operation:
- Review the issue or reference provided by the user.
- Create a task file in `.groundwork/tasks/` with the appropriate priority, model, and name.
- Continuously update the task files with context, decisions, and progress.
- Once you are confident that the task files are correctly set up, use Groundwork to prepare the tasks for implementation; defining real objectives, goals, and journeys based on the context of the task files themselves.
- For each task, spin up the necessary subagent (based on model specified in the task), and assign it to handle the implementation according to the prepared objectives, goals, and journeys.
- Follow the implementation checklist to complete the task.
- Only when the implementation checklist is complete, go through the verification checklist and verify all items.
- Keep the task file up to date until the task is completed and verified.
- When a subagent reports a task as completed, spawn a new judge subagent (based on task judge model specified) to evaluate the implementation and ensure it meets the defined criteria.
  - Judge agents can give feedback and request revisions (which should be outlined in the task file).
  - Revisions should be addressed before the task can be considered complete and verified.
  - The judge should check that the definition of done has been met before approving the task as complete.
- Delete the task file once the task is fully completed and verified; and the task meets definition of done. Then make sure to run `groundwork verify ...` to run the checks for that task. If anything needs attention, address it accordingly.
- Once all tasks are completed and verified - with evidence documented with groundwork, delete the folder `.groundwork/tasks/` when empty.
