# Plan final verification

Read the supplied PR context, project instructions, relevant diff, behaviour guide, catalogue, and existing checks. Produce a verification plan before the checks and behaviour-verification pass run.

Identify the requested outcomes and important behaviour the change promises to preserve. Keep each requirement specific enough to observe. Use stable lowercase IDs. Select relevant cases from the available project tools and the verification playbooks; keep roles, policy, and budgets grounded in the project and request.

Write the designated plan file as JSON:

```json
{
  "goal": "The intended outcome of this PR",
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
- `checks` and `behaviours` are optional bindings to IDs in the supplied context. Bind a check only if it actually asserts that requirement. A generic build or lint pass does not establish an application's user behaviour.
- Unbound requirements will need evidence-backed observations from the verification agent.
- Project invariants are added by the runner. Reserve IDs beginning with `invariant:` for it.
- If an outcome needs unavailable information or services, retain it in the plan so the final report can identify it as unverified.
- Write only the plan file. This phase reads and plans; it does not run checks or change the proposed implementation.
