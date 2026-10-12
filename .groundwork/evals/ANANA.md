# Anana benchmark history

The publisher stores one immutable record per benchmark run in **Groundwork Benchmarks**. Human decisions and reviewer notes belong to reviewers. Repeating publication reads the existing record without updating its content or properties.

**Connection status:** The coordinating agent authenticated Anana MCP at `https://groundwork.useanana.com/mcp` and discovered the empty workspace `7d841ac6-69bd-41f0-add5-bb5dd3a70417`. Live report publication and read-back are pending the real smoke report. The HTTP-boundary tests use a fake service; they do not establish live write compatibility.

## Connect the workspace

Use the requested Anana MCP connection for workspace access and inspection. The [official MCP guide](https://useanana.com/docs/mcp) documents Streamable HTTP at:

```text
https://YOUR_WORKSPACE.useanana.com/mcp
Authorization: Bearer YOUR_ANANA_TOKEN
```

Configure the client to resolve the token from its environment rather than committing a literal token. The JSON wrapper is client-specific. Once connected, inspect the workspace and any existing benchmark database with `list_pages`, `read_page`, or `query_database` before selecting a destination.

Create a **personal read & write token** under **Settings → API & connections**. Personal tokens inherit your page permissions, belong to one workspace, and expire after 90 days by default. Read-only tokens cannot publish. No credential-store discovery is performed.

The repeatable publisher uses the documented REST API, independently of the MCP transport. Supply credentials only through environment variables:

```sh
export ANANA_ORIGIN='https://YOUR_WORKSPACE.useanana.com'
export ANANA_TOKEN='YOUR_PERSONAL_READ_WRITE_TOKEN'
export ANANA_WORKSPACE_ID='WORKSPACE_ID'
# Optional: select an existing destination explicitly.
export ANANA_DATABASE_ID='DATABASE_PAGE_ID'
```

These are placeholders; do not commit real tokens, put them in a report, or put them in command arguments. `ANANA_WORKSPACE_ID` can be omitted: `GET /api/bootstrap` discovers it. When supplied, it must match both the token workspace and workspace-origin slug. The module accepts only HTTPS `SLUG.useanana.com` origins without credentials, ports, paths, or query parameters. Redirects are rejected rather than forwarding the bearer token.

Sources: [API guide](https://useanana.com/docs/api), [OpenAPI](https://useanana.com/api/openapi.json), and [MCP setup](https://useanana.com/docs/mcp), read during implementation on 2026-10-11.

## Module contract

```js
import { publishReport } from "./.groundwork/scripts/evals/anana.mjs";

const publication = await publishReport({
  origin: process.env.ANANA_ORIGIN,
  token: process.env.ANANA_TOKEN,
  workspaceId: process.env.ANANA_WORKSPACE_ID,
  databaseId: process.env.ANANA_DATABASE_ID,
  report,
  markdown,
  evidenceUrl: "https://YOUR_EVIDENCE_HOST/RUN_PATH", // optional
  receiptPath: ".groundwork/runs/anana/RUN_ID.json",
});
// { databaseId, pageId, url, created }
```

`fetchImpl` is an optional injected HTTP boundary for tests; it does not relax origin validation. The caller loads reports and Markdown. This module does not read credentials or report files, invoke MCP tools, or expose a CLI.

`url` opens the page in the workspace UI: `https://SLUG.useanana.com/p/PAGE_ID`. It requires the viewer's existing access and does not enable public sharing. The public frontend [router bundle](https://useanana.com/assets/index-D20zxc8G.js), read on 2026-10-11, registers `id: "/p/$pageId", path: "/p/$pageId"` under its pathless `_app` route. Its page-create handler navigates with `to: "/p/$pageId", params: { pageId: i.id }` after `POST /pages`. This establishes the human-facing route independently of the JSON page-detail endpoint.

`created` means this call sent the row create and confirmed its result, including a recovered response; finding a row from an earlier attempt returns `false`.

The report contract is:

```text
version: 1
id: stable immutable run ID
createdAt: ISO date/time
experiment: { digest, suite, split }
groups: [{ runtime, model, family, condition, attempts, completed,
           passed, failed, inconclusive, qualityScore, judgeScores }]
comparisons: [...]
trials: [...]
```

The report hash covers the full report with object keys sorted. The content hash covers the supplied Markdown and normalized evidence URL. Keep a run's report, Markdown, and evidence URL immutable; changed inputs require a new run ID. The caller must include raw judge verdicts, per-model metrics, disagreements, and evidence details in `markdown`.

Completion counts sum across groups **only when every group supplies that count**. Missing values and empty groups become `null`, never zero. Counts must be nonnegative safe integers; scores must be finite numbers. The score column is populated only for a single group with a supplied quality score. Multiple models or conditions are not collapsed into a misleading average; their metrics stay in the Markdown.

## Destination and schema

- An explicit `databaseId` takes priority and must resolve to an editable database in the verified workspace.
- Otherwise a prior receipt binds the destination. With no binding, discover an unambiguous database owned by the current user with Groundwork's property IDs/types or publisher marker. Titles alone are not identity. Ambiguous matches stop publication.
- If none exists, create a private root database named **Groundwork Benchmarks** and confirm its privacy before adding the run. Children inherit access. Existing destinations retain their visibility.
- Benchmark property IDs use `gw_` prefixes. Schema includes run identity, experiment digest, suite/split/date, completion counts, optional quality score, evidence URL, report/content hashes, and human decision (`pending`, `adopt`, `reject`, `investigate`). Select values use option IDs.
- Schema setup reads existing metadata, appends missing fields, and preserves every existing field, option, view, and human-authored document. Incompatible reserved property types or missing decision option IDs stop publication. Human field names can be customized without changing reserved IDs.
- Anana replaces whole schema arrays and documents no conditional schema revision check. Serialize schema administration with initial publication; the local publisher lock cannot prevent a human or another host from editing schema concurrently. Once required fields exist, publication does not patch schema.

## Receipts, recovery, and failures

Keep all publication receipts for this workspace in **one durable local directory**: `.groundwork/runs/anana/<runId>.json`. The directory-wide `.anana-publisher.lock` excludes concurrent local publishers, including different run receipts. The lock fails closed and is released after the call finishes. After a crash, confirm no publisher is running before removing that directory's stale lock. Separate directories or hosts do not share this lock; coordinate them externally. The API documents neither an idempotency key nor a run-ID uniqueness constraint.

Receipts are atomically renamed, flushed to disk, and written with mode `0600`. They contain destination IDs, run identity, hashes, create intent, and confirmation state; they never contain bearer tokens or supplied Markdown. A receipt is not successful until GET read-back confirms the row's workspace, parent database, run ID, report hash, and content hash.

For newly created rows, including recovery of a pending create, the publisher also reads `GET /api/pages/{id}/content`. The documented endpoint reads the live Yjs document used by editors. Confirmation requires nonempty live Markdown and document blocks; a missing/empty document or failed read leaves the receipt pending. The receipt records the observed live Markdown hash, document version, and confirmation time. This checks that live content exists alongside matching input metadata; it deliberately does not assert byte equality or semantic equivalence with the input because editor Markdown serialization can normalize formatting. A later retry can confirm the same row without rewriting it. Already confirmed or independently rediscovered existing rows retain their human-edited documents: repeated publication validates immutable metadata and does not revalidate or replace those notes.

Before each non-idempotent POST, persist create intent. If its response is lost, search the complete accessible-page list by database marker or dedicated run-ID property. The list has no pagination; `removed=true` includes archived and trashed records so these do not silently become new rows. Multiple matching run rows, removed pages, or changed hashes fail rather than being overwritten.

If a POST might have committed but its result remains invisible, preserve the pending receipt. A later invocation tries discovery again, **without resending that create**. An unresolved request can stay blocked indefinitely, including a crash after intent was saved but before the request was sent. Investigate remotely before changing its receipt. Do not delete pending receipts to “retry”: a late commit could then duplicate a run. Successful POST IDs are also persisted before read-back, allowing a later retry to finish confirmation after a read failure.

Requests have a 30-second timeout and reject redirects. There are no automatic HTTP retries. Errors expose method/status and a parsed `retryAfterSeconds` where available, without response bodies or credentials. Definite POST rejections (400/401/403/404/409/429) permit a later explicit attempt; other failures retain ambiguous create intent. A POST `Retry-After` deadline is persisted and enforced across invocations. For errors on reads or schema patches, the caller must also honor the returned delay before retrying. Fix authentication/permission errors before retrying. Schema patches can be reconciled by reading again on the next invocation.

## Verification handoff

The focused boundary tests are in `test/eval-anana.test.mjs`: private create/read-back, human-facing URLs, live-content confirmation, empty-document recovery with normalized Markdown, missing metrics, human-edit preservation, local and remote immutable-content rejection, lost database/row responses, durable recovery after an outage, ambiguous-create suppression, authorization/workspace failures, read-back failure, and concurrent publication exclusion.

The implementation agent intentionally has not run tests; the coordinating agent owns the complete-batch verification run. Suggested focused command: `bun test test/eval-anana.test.mjs`. Required project verification remains `groundwork verify tests`.

The coordinating agent will use the connected Anana MCP workspace and environment token for live acceptance: inspect the destination, publish the real smoke report, inspect the row and raw judge results through MCP and its `/p/PAGE_ID` UI link, change the human decision/add a note, repeat publication, and confirm the same page ID and preserved edits. No live page mutations were performed while implementing this module.
