# Local-first verification records

- **Status:** Accepted
- **Date:** 2026-11-16

## Decision

Every initialized verification run keeps a local record independently of GitHub. `result.json` remains authoritative; each local save derives `report.md` with readable Markdown and hidden, versioned JSON. The record explains what was checked and why, the source revision and dirty state, outcomes and fresh/reused provenance, context and timing, gaps, and relevant decision links.

Agents publish as part of tasks that include PR delivery, under existing permissions and approval rules; local-only tasks stay local. `groundwork publish pr [number-or-url] --run <id>` uses a PR artifact when available, otherwise a comment, retaining per-run history. `groundwork view pr [number-or-url]` reads the published account. Full archives and screenshots are not universal publication requirements; claim-specific evidence and existing UI observation/screenshot expectations still apply.

Keep portable reports separate from local receipts. Remote reports provide context for reviewers and later agents, but do not become automatic reuse proof. Local reuse continues to validate declared inputs and retained evidence. Source/current-PR matching, requirement coverage and explicit review obligations govern status; neither successful publication nor an attached archive can supply missing proof. Recorded failures remain failures.

## Reason

Verification must work before a PR exists and when GitHub is unavailable. A compact, readable report makes the result useful without requiring every reader to download a full run archive. Versioned JSON lets tools read the same account, while existing local receipt validation remains responsible for reuse.

Durable rationale needs a home that survives deletion of ignored task notes. Plain Markdown decision files are reviewable with the project's existing tools and keep the reason close to the affected guidance, without a separate service or central index.

## Consequences

- Agents consult relevant decisions before work and promote meaningful durable choices before final verification and task-note deletion. Reuse a project's ADR location; otherwise use `.groundwork/decisions/<topic>.md`.
- Keep one bounded file per decision, with status, reason and consequences. Retain history by linking superseding decisions; routine edits do not need an ADR. Agents maintain the records as part of their work.
- Local storage remains sufficient for verification. A publication failure is reported separately from the verification outcome, and unavailable claim-specific observations remain visible gaps.
- Publication reassesses the saved run and target source while preserving the original snapshot. Content-equivalent work committed and pushed after a dirty run can match without requiring the original Git SHA. Published accounts retain this provenance and distinguish reused observations from new executions.

## Related guidance

- [Verification record and publication contract](../../skills/verify-work/references/verification.md#local-records-and-pr-publication)
- [Workflow](../../WORKFLOW.md)
