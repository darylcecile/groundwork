### Plan and select verification

Before changing behaviour, consult relevant decisions, including [local-first verification](../decisions/local-first-verification.md), and record a small plan such as `.groundwork/plans/task.json`, with each requirement bound to the assertions that establish it. `--plan` adds bound checks and checks covering its behaviours to the selection, including named and change-aware runs. Required checks and active invariants remain included. A requirement marked `review: true` also needs an evidence-backed `kind: "review"` observation explicitly covering its requirement ID.

The optional `decisions` field preserves rationale links through invariant expansion. For example, start a plan for this contract with:

```json
{
  "goal": "Keep verification useful before a PR exists",
  "decisions": [".groundwork/decisions/local-first-verification.md"],
  "requirements": [
    {
      "id": "local-record",
      "expect": "Verification retains a readable local record without GitHub access"
    }
  ]
}
```

Bind the requirement after confirming its actual assertion. Decision links are project-relative `.md` paths, without URLs, anchors or traversal; they provide rationale, not coverage or evidence.

Use a disposable project's catalogue to exercise `view guide [query]`, named selection, and `--changed <ref>`. Auto-discovered `.groundwork/verify.d/*.json` fragments compose into one catalogue after preparation. Validate references across files and report duplicate IDs or conflicting context values with their source paths. Changes matching check or catalogue paths select their checks; legacy unscoped checks remain conservative. Unmapped paths and behaviours without checks remain visible planning signals. Guide inspection reports stale references without executing checks.

For opted-in deterministic checks, exercise unchanged-input receipt reuse and `--fresh`. Source content, check/engine/runtime identity, context, plan, declared environment values and explicit input files govern matching. Changed or unavailable evidence prevents reuse; a reused failure stays failed. Repeated trials, baseline comparisons and checks with setup/cleanup execute afresh. Inspect the invocation's own run using `groundwork view report <id>` rather than assuming it is still latest.

Promote meaningful lasting choices from task notes into decision records before final verification. Retain the [local run record](../../skills/verify-work/references/verification.md#local-records-and-pr-publication) and its decision links. Optional PR publication does not turn a remote report into local reuse proof or discharge missing coverage/review obligations.
