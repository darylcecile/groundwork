# Verification records

Start with an adopted project and its real checks. Run `groundwork verify` (with the task's plan when needed), retain that invocation's run ID, and inspect `groundwork view report <id>`. Every initialized local or PR run saves authoritative `result.json` and derived `report.md` in its evidence directory, including incomplete and failed outcomes. Local verification needs no GitHub connection. The Markdown contains a readable account and a versioned JSON payload: source, scope, selection reasons, outcomes, fresh/reused provenance, coverage, review obligations, gaps and decision links.

## Publish and read a PR record

1. For PR delivery, commit and push the verified content, then use `groundwork publish pr [number-or-url] --run <id>`. The run ID is required; omitting the PR selects the current branch's PR. These commands use authenticated GitHub CLI access.
2. Publication reads that saved result and reassesses source, retained evidence and receipt inputs. A passing publication requires matching content in a clean checkout at the pushed PR head. Content verified while dirty can still match after committing it. Missing coverage or required review stays unverified; recorded failures remain failures. The publication assessment is separate from the original run snapshot.
3. Inspect the returned PR artifact or fallback comment. Retrying the same run updates its publisher-owned record; a different run retains prior history. The `groundwork/verification` commit status reports the publication outcome. A full evidence archive is optional; claim-specific observations and evidence remain required.
4. Use `groundwork view pr [number-or-url]` to read published history, tested revisions, current PR head, coverage, gaps and decisions. An explicit URL works outside an adopted project. Current-head and historical records are labelled separately. Read the newest current-head record together with the latest `groundwork/verification` status: pending/error publication returns `2` and failure returns `1` even if that retained record passed. Otherwise the record's verdict gives `0` passed, `1` failed, or `2` inconclusive; no current record returns `2`.

The remote view reads GitHub without running checks, preparing project metadata, starting the portal or importing receipts. It compares published provenance to the current PR head; it does not reassess a reader's local environment. A posted summary is review context, not automatic reuse proof. Local reuse still validates its own inputs and retained evidence.

## Implementation and verification pointers

- [Shared records and reassessment](../../lib/report.mjs), [publication/discovery](../../lib/pr-records.mjs), [GitHub adapter](../../lib/github.mjs), [CLI](../../skills/verify-work/verify.mjs), and [PR report integration](../../pr-verification/scripts/report.mjs) own this flow. See the [subsystem map](../maps/verification.md#saved-records-and-optional-publication) and accepted [local-first decision](../decisions/local-first-verification.md).
- The `tests` check (`bun test`) includes [record round-trips and reassessment](../../test/report.test.mjs), [transport/history/status fixtures](../../test/pr-records.test.mjs), [CLI journeys](../../test/verify.test.mjs), and [PR integration assertions](../../pr-verification/test/verification.test.mjs). These cover failed/incomplete records, explicit-run selection, stale inputs/evidence, required review, optional archives, read-only history and newer publication status over retained records. GitHub transport uses controlled fixtures; a live publication is a separate observation.

These are source-derived verification pointers, not runtime results. No checks were run for this guide refresh.
