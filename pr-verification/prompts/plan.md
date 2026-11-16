# Plan final verification

Read the supplied PR context, project instructions, relevant decisions, diff, behaviour guide, catalogue, and existing checks. Use the project's ADR location, falling back to `.groundwork/decisions/`. Produce a verification plan before the checks and behaviour-verification pass run.

The runner has prepared project metadata before capturing source. Root `AGENTS.md` remains the instruction entry point; `.groundwork/VERIFY.md` is a small bootstrap to project context, with active guides under `.groundwork/guides/` and merged configuration in `.groundwork/verify.d/*.json`. Follow the converted guide links and use the supplied catalogue.

Follow relevant subsystem-map links from the guide or catalogue and confirm their claims against the current source. Use them to identify entry points, affected callers, constraints, and verification gaps. A map's source findings are planning context, not runtime proof.

Published verification accounts can provide prior context and decision links. They do not automatically establish current source matching, receipt eligibility, requirement coverage or completed review obligations.

Identify the requested outcomes and important behaviour the change promises to preserve. Keep each requirement specific enough to observe. Use stable lowercase IDs. Select relevant cases from the available project tools and the verification playbooks; keep roles, policy, and budgets grounded in the project and request.

Write the designated plan file as JSON:

```json
{
  "goal": "The intended outcome of this PR",
  "decisions": [],
  "requirements": [
    {
      "id": "requested-outcome",
      "expect": "The concrete result that must be observed",
      "checks": [],
      "behaviours": []
    }
  ]
}
```

- Every requested outcome needs a requirement. Preserve meaningful constraints and relevant existing behaviour; do not expand the task into unrelated work.
- Optional `decisions` links relevant durable rationale using project-relative `.md` file paths. Use the project's ADR location or `.groundwork/decisions/`; omit URLs, anchors and path traversal. These links survive invariant expansion but do not count as requirements or evidence.
- `checks` and `behaviours` are optional bindings to IDs in the supplied context. Bind a check only if it actually asserts that requirement. A generic build or lint pass does not establish an application's user behaviour.
- Unbound requirements will need evidence-backed observations from the verification agent. Set `"review": true` only when the requirement needs an explicit evidence-backed review in addition to its check bindings, such as a visual inspection or design judgment that automated assertions do not establish.
- The runner schedules plan-bound checks and covering behaviour checks. When their evidence completes every requirement, including any required review, it skips the verification agent. Bind existing assertions accurately so completed work can be reused.
- Project invariants are added by the runner. Reserve IDs beginning with `invariant:` for it.
- If an outcome needs unavailable information or services, retain it in the plan so the final report can identify it as unverified.
- Write only the plan file. This phase reads and plans; it does not run checks or change the proposed implementation.
