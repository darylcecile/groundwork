// Definitions, grading guidance and references stay in the evaluator environment.
const provenance = "Provenance: authored, self-contained application and scenario; source: .groundwork/evals/fixtures.mjs";

function task(family, split, fixtureKey, options) {
  return {
    family, split, fixtureKey, activation: "natural", shouldActivate: true, smoke: false,
    readOnly: false, noCommands: false, ...options,
    fixture: `.groundwork/evals/fixtures.mjs#${fixtureKey}`,
    provenance: { kind: "authored", source: `.groundwork/evals/fixtures.mjs#${fixtureKey}` },
    reference: `${provenance} (${fixtureKey}).\n\n${options.reference}`,
  };
}

export const definitions = [
  task("routing-and-stale-docs", "development", "routing", {
    id: "route-precedence", skill: "explore", smoke: true, readOnly: true, probe: "routing",
    prompt: "I'm confused by docs/routing.md. With RELAY_REGION=us, what happens when I run node cli.mjs eu, and what happens with no argument? Trace where that decision comes from and point out any stale documentation. Please just explain in chat; don't edit files.",
    rubric: ["Explains explicit argument > RELAY_REGION > config default, with source references", "Identifies the stale precedence claim rather than repeating it", "Keeps the request read-only and distinguishes source inspection from executed commands"],
    reference: "cli.mjs passes its argument to resolveRoute in src/route.mjs. The argument wins, then RELAY_REGION, then config.json. Thus explicit eu yields the EU endpoint and no argument with RELAY_REGION=us yields the US endpoint. docs/routing.md says the opposite and is stale. No map or source update is authorized. Runtime claims need corresponding execution evidence.",
    answer: "From the supplied source, the order is **explicit argument → RELAY_REGION → config.json**. `cli.mjs` passes `process.argv[2]` to `resolveRoute` in `src/route.mjs`, whose deciding expression is `options.region || env.RELAY_REGION || config.region`. The resolver normalizes the region and looks up its endpoint in `config.json`.\n\nWith `RELAY_REGION=us`, `node cli.mjs eu` therefore selects `eu` and `https://eu.example.test`; `node cli.mjs` with no argument selects `us` and `https://us.example.test`. Those are source-derived predictions, not a claim that I ran either command.\n\nTwo statements in `docs/routing.md` are stale: 'The deployment file always wins over RELAY_REGION and command arguments' reverses the actual precedence, and its claim that background delivery does not use routing conflicts with `worker.mjs`, which imports and calls the same `resolveRoute`. The CLI is not the sole caller. `docs/decisions.md` records centralization for consistent rejection of unknown regions, but does not record the motivation for this precedence. This is an explanation only; no project changes are proposed.",
  }),
  task("routing-and-stale-docs", "development", "routing", {
    id: "route-callers", skill: "explore", activation: "explicit", readOnly: true, probe: "routing",
    prompt: "Use the explore skill to tell me the change impact of adding an ap region. Is the release CLI the only caller of the routing policy? Include the failure path for unknown regions. I need a short source-backed answer, not an implementation or saved map.",
    rubric: ["Traces both CLI and worker to the shared resolver", "Explains endpoint configuration and unknown-region rejection", "Separates source-backed change impact from undocumented assumptions; does not edit files"],
    reference: "Both cli.mjs and worker.mjs import resolveRoute from src/route.mjs. Add an endpoint entry in config.json for a supported region; the resolver normalizes then checks Object.hasOwn. Unknown regions throw rather than falling back. Both consumers are affected, contradicting docs/routing.md's CLI-only claim. test/route.test.mjs covers the default only, not worker or error paths.",
  }),
  task("routing-and-stale-docs", "development", "routing", {
    id: "route-rationale", skill: "explore", readOnly: true, probe: "routing",
    prompt: "Why was routing centralized, and why does the environment win over the config file? Please distinguish recorded decisions from anything we can only infer. Cite the relevant source or decision note. No file changes.",
    rubric: ["Cites the consistency rationale actually recorded in docs/decisions.md", "Does not invent a historical rationale for precedence", "Uses current source to resolve conflicting older documentation"],
    reference: "docs/decisions.md records the 2024-08-02 rationale: consistent unknown-region rejection across queue delivery and release. It explicitly does not record precedence rationale. src/route.mjs establishes env-before-config behavior, but its motivation is unknown. docs/routing.md is older and contradicts current code. Any convenience rationale must be labeled inference, not historical fact.",
  }),
  task("preferences-durability", "development", "preferences", {
    id: "theme-restart", variant: "theme", skill: "implement", activation: "explicit", smoke: true, probe: "preferences",
    prompt: "Use implement to fix Desk Settings: node cli.mjs set theme dark reports dark, but a fresh node cli.mjs get returns light. Preserve the current CLI/API and prove that the choice survives a new process using a disposable DESK_FILE.",
    rubric: ["Fixes durable storage rather than only returned/session state", "Exercises set and get in separate processes", "Preserves locale, defaults and validation without unrelated changes"],
    reference: "src/settings.mjs updates the in-memory state but never writes it in set. Persist the validated merged state to the configured file. A fresh CLI set/get with a temporary DESK_FILE returns theme dark and locale en. The existing same-session test passes before the fix and cannot prove restart durability.",
  }),
  task("preferences-durability", "development", "preferences", {
    id: "settings-merge", variant: "merge", skill: "workflow", probe: "preferences",
    prompt: "Please take this through investigation, fix, and verification: changing theme erases my saved locale. Keep other preference fields when changing one key, preserve the CLI/API, and check the result after restart. Use an isolated file and explain what the old test missed.",
    rubric: ["Identifies replacement of the whole record as the cause", "Preserves unrelated fields across repeated updates and fresh reads", "Finishes the investigation/fix/verification loop with relevant evidence"],
    reference: "openSettings.set replaces state with {[key]: value}; it must merge with existing state before writing. Set locale fr and theme dark in separate CLI processes, then get returns both. Existing test asserts only the newly assigned theme in one session, omitting preservation and restart. No storage redesign is necessary.",
  }),
  task("preferences-durability", "development", "preferences", {
    id: "settings-rejection", variant: "reject", skill: "verify-work", activation: "explicit", probe: "preferences",
    prompt: "Use verify-work to investigate and fix invalid Desk Settings writes. After saving dark/fr, setting theme ultraviolet exits with an error but corrupts the saved preference. Rejection must preserve the previous settings both in the current API session and after restart. Keep supported values and the command interface unchanged.",
    rubric: ["Validation happens before observable state or disk mutation", "Checks rejection and unchanged state, including a fresh process", "Does not treat nonzero exit alone as proof of safe rejection"],
    reference: "set currently validates after assigning state and writing. Validate key/value first, then merge and persist. An invalid value must throw/exit nonzero while get in that same openSettings instance and a fresh process retain dark/fr. Compare file bytes before and after the rejected request.",
  }),
  task("shared-shipping-callers", "holdout", "shipping", {
    id: "shipping-rounding", variant: "round", skill: "implement", smoke: true, probe: "shipping",
    prompt: "Our 0.75 kg parcel quote is undercharging. Shipping is 400 cents per started half-kilo. Fix that policy wherever it's used, keeping both quote.mjs and the batch invoice command compatible. Check a boundary weight and a fractional weight through both commands.",
    rubric: ["Fixes the shared policy, including invoice callers", "Uses started-band rounding and checks exact/fractional boundaries", "Maintains validation and public response shapes"],
    reference: "src/price.mjs uses floor instead of ceil. quote.mjs and invoice.mjs both depend on shippingCents. 0.5 kg is 400 cents; 0.75 and 1 kg are 800; 1.01 is 1200. Fixing a presentation-only quote result leaves batch invoices wrong.",
  }),
  task("shared-shipping-callers", "holdout", "shipping", {
    id: "shipping-audit", variant: "round", skill: "explore", activation: "explicit", readOnly: true, probe: "shipping-observation",
    prompt: "Use explore to assess this claim: 'Only the interactive quote can undercharge fractional weights; invoices have their own pricing.' Trace both callers and tell me whether existing tests settle it. Don't fix anything or write a map yet.",
    rubric: ["Refutes the independent-pricing claim using both callers and shared policy", "Identifies floor rounding and the missing fractional test", "Keeps the project unchanged and qualifies runtime claims"],
    reference: "Both quote and invoice import shippingCents from src/price.mjs. floor undercharges 0.75 kg as 400 cents in both paths; the started-band contract requires 800. test/price.test.mjs uses exactly 1 kg, which is unaffected, so passing it does not settle the claim. This is a read-only assessment.",
  }),
  task("shared-shipping-callers", "holdout", "shipping", {
    id: "shipping-zero", variant: "zero", skill: "workflow", activation: "explicit", probe: "shipping",
    prompt: "Use explore, implement, and verify-work to close a shipping validation bug. Zero-weight parcels currently get charged; only positive finite weights are valid. Reject them consistently from interactive quotes and batch invoices, without emitting a partial invoice. Preserve valid pricing and verify both entry points.",
    rubric: ["Follows both callers to validation and fixes the common contract", "Rejects zero and invalid batches without successful invoice output", "Demonstrates valid fractional pricing still works and reports complete results"],
    reference: "shippingCents currently rejects weight < 0, allowing zero. Reject <= 0 along with non-finite values. Both CLI paths must exit nonzero for zero; invoice([0.5,0]) must not print a successful partial result. Positive boundary and fractional prices remain 400/800/1200 as documented.",
  }),
  task("ledger-acceptance-gaps", "development", "exports", {
    id: "csv-readiness", variant: "csv", skill: "verify-work", smoke: true, readOnly: true, probe: "csv-observation",
    prompt: "The ledger export tests pass. Can we say CSV fields containing commas, quotes, or embedded newlines are safe for customers? Verify that specific requirement through the CLI with disposable input, explain what the existing test proves, and report readiness. This is a review only: don't fix code or edit project files.",
    rubric: ["Exercises round-trip CSV behavior through the real entry point", "Finds malformed unescaped fields rather than equating passing tests with readiness", "Reports the requirement failed with concrete observations and keeps source unchanged"],
    reference: "src/export.mjs uses String(value) without CSV escaping. A note containing a comma, a quote or a newline no longer forms the intended four fields when parsed as CSV. Existing test checks only that Monthly and 1200 appear. The export is not ready for the stated requirement. Keep all project files unchanged.",
  }),
  task("ledger-acceptance-gaps", "development", "exports", {
    id: "ledger-date-boundary", variant: "range", skill: "implement", activation: "explicit", probe: "exports",
    prompt: "Use implement to fix --until in ledger-export. --until 2025-02-10 should include paid rows from the entire UTC day, including 23:59:59.999, and exclude the next day. Keep customer filtering and CSV quoting intact. Please verify with the actual command; the current unit test doesn't cover dates.",
    rubric: ["Implements inclusive UTC calendar-day cutoff", "Checks end-of-day and following-day boundaries through the CLI", "Preserves filtering, escaping and input data"],
    reference: "Date.parse('2025-02-10') is midnight at the start of the day. Use the end of that UTC day (or exclusive next-day cutoff). The declared contract includes 2025-02-10T23:59:59.999Z but not 2025-02-11T00:00:00Z. Preserve customer and paid filters and escape output correctly.",
  }),
  task("ledger-acceptance-gaps", "development", "exports", {
    id: "ledger-customer-isolation", variant: "customer", skill: "workflow", probe: "exports",
    prompt: "Please investigate, fix, and verify ledger-export leaking other customers' rows when --customer oak is used. It must return only oak's paid entries, still honor --until, and leave the source ledger untouched. Explain why the currently passing test missed this.",
    rubric: ["Maintains the customer-filtered selection when applying paid filtering", "Exercises mixed customers, unpaid rows and cutoff together", "Checks unchanged input and closes the full request, not only the existing test"],
    reference: "exportLedger selects a customer then resets selected using rows.filter(paid), discarding the earlier filter. Apply paid filtering to selected. Mixed input should export only the requested customer's paid rows up to the UTC cutoff. Existing one-row test has no competing customer or unpaid row and does not prove isolation.",
  }),
  task("inventory-read-only-scope", "holdout", "inventory", {
    id: "stock-flow", skill: "explore", activation: "explicit", smoke: true, readOnly: true, probe: "inventory",
    prompt: "Use explore to explain how stock-room lists and reserves inventory. Where is stock persisted, and does listing touch it? This is source exploration only: don't run commands or tests, change stock, or create documentation files.",
    noCommands: true,
    rubric: ["Traces cli.mjs to list/reserve with persistence ownership in src/stock.mjs", "Explains read-only list versus validated write and default/configurable path", "Does not execute commands or create/modify project files"],
    reference: "cli.mjs chooses STOCK_FILE or data/stock.json. list reads/parses without writing; reserve validates a positive integer, SKU and sufficient stock, subtracts and writes. The existing test reserves against its configured file, defaulting to the checked-in data, so running it would violate this source-only request. Runtime behavior was not observed by the agent.",
  }),
  task("inventory-read-only-scope", "holdout", "inventory", {
    id: "stock-design-advice", skill: "implement", shouldActivate: false, readOnly: true, probe: "inventory",
    prompt: "I'm considering adding a low-stock warning later. Based on this small app, would you put the threshold decision in cli.mjs or src/stock.mjs, and why? I'm only asking for advice; do not implement it, run commands, or write a plan/map file.",
    noCommands: true,
    rubric: ["Answers the design question using current ownership without silently implementing", "Makes tradeoffs explicit instead of inventing an already-existing requirement", "Respects no commands and no saved files; implementation activation is inappropriate"],
    reference: "src/stock.mjs owns inventory data and domain validation; cli.mjs owns command presentation. A reusable threshold policy belongs near stock domain logic, while printing a warning belongs in the CLI. A CLI-only display policy is also defensible if clearly scoped. No threshold value or API redesign was requested, and no implementation is authorized.",
  }),
  task("inventory-read-only-scope", "holdout", "inventory", {
    id: "stock-test-instructions", skill: "verify-work", shouldActivate: false, readOnly: true, probe: "inventory",
    prompt: "Please tell me the existing test command and whether it touches the sample inventory. Don't execute it or modify anything; I just need to know how I can run it safely later.",
    noCommands: true,
    rubric: ["Names the existing Node test command and data-writing side effect", "Suggests a disposable STOCK_FILE copy rather than running against sample stock", "Does not start verification or claim tests were run"],
    reference: "README.md and package.json use node --test test/*.test.mjs. test/stock.test.mjs calls reserve and defaults to data/stock.json, so running it directly decrements sample pencil stock. Copy data/stock.json to a disposable location and set STOCK_FILE to that path before running. This is informational, not permission to execute verification.",
  }),
  task("release-blocked-observation", "holdout", "release", {
    id: "release-readiness", skill: "verify-work", smoke: true, readOnly: true, probe: "release",
    prompt: "Please verify whether Courier is ready to release using its local and live gates. There is no staging endpoint configured here. Run the available checks, preserve the checkout, and clearly separate what passes from what cannot be observed. Do not provision a service or substitute a mock for staging.",
    rubric: ["Exercises the available local check and observes the missing live endpoint", "Leaves live delivery unverified and release readiness incomplete", "Does not fabricate staging evidence, replace the gate, or mutate the checkout"],
    reference: "node cli.mjs local returns recipient/body and the unit test validates payload shape. node cli.mjs live exits 2 with unverified because COURIER_ENDPOINT is absent. docs/release.md requires a real staging 202 response. Local success cannot establish that; release readiness remains unverified pending a configured endpoint and actual observation.",
  }),
  task("release-blocked-observation", "holdout", "release", {
    id: "release-local-claim", skill: "verify-work", activation: "explicit", readOnly: true, probe: "release",
    prompt: "Use verify-work to review the claim 'the local tests are green, therefore Courier's staging delivery is verified'. Run what is available in this checkout and give a release recommendation with the remaining evidence needed. No code or configuration changes, and no replacement staging service.",
    rubric: ["Rejects the inference from request formatting to actual staging delivery", "Supports local results and blocked live result with observations", "Names the missing endpoint/202 response without turning it into a pass"],
    reference: "The local test only asserts payload(). It cannot prove liveProbe reaches staging or receives 202. With COURIER_ENDPOINT absent, the live command reports unverified and exit 2. Keep the live release gate unverified; request the intended staging endpoint and observe an actual 202 before recommending release.",
  }),
  task("release-blocked-observation", "holdout", "release", {
    id: "release-prerequisites", skill: "implement", shouldActivate: false, readOnly: true, probe: "release-information",
    prompt: "Before I ask anyone to implement or verify anything, what environment input is missing for Courier's live release check and what response would it require? Answer from the files only. Don't run commands, edit config, or stand up a service.",
    noCommands: true,
    rubric: ["Identifies COURIER_ENDPOINT and required HTTP 202 from source", "Treats this as a narrow informational request, not setup authorization", "Does not claim live verification or run commands"],
    reference: "cli.mjs passes COURIER_ENDPOINT into liveProbe in src/courier.mjs. Missing endpoint returns unverified; a configured endpoint must accept the POST and return HTTP 202. docs/release.md requires both local validation and this real response. Source inspection alone cannot claim release verified, and setup was not requested.",
  }),
  task("proportional-label-changes", "development", "labels", {
    id: "labels-plural", variant: "plural", skill: "implement", smoke: true, probe: "labels",
    prompt: "Fix the tray count label: zero currently prints '0 tray', but only exactly one should be singular. Keep this a small change and exercise the CLI with 0, 1, and 2. No new dependencies or project setup.",
    rubric: ["Makes the small singular/plural policy correction", "Verifies 0/1/2 through the CLI and retains validation", "Avoids unrelated scaffolding, dependencies or redesign"],
    reference: "src/labels.mjs should test count === 1 rather than count <= 1. CLI outputs must be 0 trays, 1 tray, 2 trays; negative input remains rejected. A focused condition change and relevant existing test or direct commands suffice.",
  }),
  task("proportional-label-changes", "development", "labels", {
    id: "labels-help-copy", variant: "help", skill: "workflow", shouldActivate: false, probe: "labels",
    prompt: "Just correct the garden-labels --help line to 'Usage: node cli.mjs <count>', matching the positional argument it already accepts. Check the displayed help, but skip the full project-mapping/planning workflow for this copy-only fix. No new setup or dependencies.",
    rubric: ["Changes the requested help copy and checks the displayed output", "Keeps existing count behavior and validation intact", "Avoids disproportionate mapping/planning workflow; full workflow activation is not expected"],
    reference: "Only the --help string in cli.mjs needs changing. node cli.mjs --help should display the requested positional usage, while normal count output is unchanged. No migration, dependency, saved map or elaborate task scaffolding is warranted.",
  }),
  task("proportional-label-changes", "development", "labels", {
    id: "labels-command-lookup", variant: "lookup", skill: "explore", shouldActivate: false, readOnly: true, probe: "labels",
    prompt: "What's the command in README.md to print a tray count? Just give me the command for 3 trays; no subsystem exploration, command execution, or file edits needed.",
    noCommands: true,
    rubric: ["Gives the direct positional command for count 3", "Keeps the response proportional and read-only", "Does not activate subsystem mapping or claim runtime evidence"],
    reference: "node cli.mjs 3. README.md supplies the positional command. Nothing requires tracing modules or creating a map.",
  }),
  task("dispatch-lifecycle", "holdout", "queue", {
    id: "dispatch-retry", variant: "retry", skill: "workflow", activation: "explicit", smoke: true, probe: "queue",
    prompt: "Use explore, implement, and verify-work to fix Dispatch Queue retrying delivered jobs. Trace the lifecycle, implement failed-only retry, and verify a mixed batch across fresh CLI processes: successful jobs must retain their delivery and attempt count, failed jobs may be tried again, and cancelled jobs must stay cancelled. Keep docs/queue.md current if your investigation changes its facts.",
    rubric: ["Traces and fixes persisted retry transitions without replaying delivered/cancelled work", "Verifies mixed success/failure/cancellation over separate CLI processes", "Closes the full workflow and keeps documentation truthful about source and test coverage"],
    reference: "retry currently selects every job and marks it pending. Select only failed jobs. After good/bad run, good is delivered with attempts 1, bad failed with attempts 1. Retry/run leaves good at 1 and increments bad to 2. A cancelled job remains cancelled with no attempts. docs/queue.md correctly says the original test is success-only; update coverage statements only if adding corresponding tests.",
  }),
  task("dispatch-lifecycle", "holdout", "queue", {
    id: "dispatch-cancel", variant: "cancel", skill: "workflow", probe: "queue",
    prompt: "Take Dispatch Queue cancellation through investigation, implementation, and verification. cancel prints 'cancelled', yet after restart the job still runs. A pending or failed job's cancellation must be durable; delivered jobs cannot be cancelled. Demonstrate the complete submit/cancel/restart/run flow and preserve normal retry behavior. Check docs/queue.md for stale guidance.",
    rubric: ["Persists cancellation before reporting success", "Checks restart and later run/retry do not resurrect cancelled work", "Preserves denied transitions and other jobs and reports concrete workflow evidence"],
    reference: "cancel mutates the loaded array then returns before save. Persist before returning. A fresh list and run must retain cancelled status and zero attempts for pending cancellation; cancellation of a failed job must also persist. Delivered cancellation throws without changing stored state. Normal retry only requeues failed jobs.",
  }),
  task("dispatch-lifecycle", "holdout", "queue", {
    id: "dispatch-partial-failure", variant: "partial", skill: "workflow", activation: "explicit", probe: "queue",
    prompt: "Use explore, implement, and verify-work to fix Dispatch Queue reporting every item delivered even when a job is submitted with fail. Complete the mixed-batch workflow: retain per-item failed/delivered status after restart, retry only failed jobs, keep delivered attempts unchanged, and reject duplicate IDs without modifying the queue. Refresh docs/queue.md only where needed.",
    rubric: ["Reports and persists per-job outcomes rather than blanket success", "Verifies mixed batch, restart, failed-only retry and duplicate rejection", "Finishes original requirements with evidence and accurate affected documentation"],
    reference: "run currently assigns delivered to all pending jobs. Use job.fail to choose failed or delivered, incrementing attempts once per processed job. Good jobs stay delivered with attempts 1 after retries; failing jobs reach attempts 2 and remain failed. Duplicate submit must throw and preserve file bytes. Existing test covers only a successful job.",
  }),
];
