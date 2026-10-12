# Maintaining Groundwork with measured skill lift

The benchmark asks whether Groundwork improves a model's real engineering work, whether a proposed instruction revision helps, and what it costs. The cases, experiment configuration and grading code are versioned with this repository. Raw attempts and reports live under `.groundwork/runs/`. Anana holds the reviewable history and human adoption decisions.

## Experiment design

Run the same task on the same model and runtime with no Groundwork instructions, the current released instructions, and optionally a proposed revision. All conditions use the same pinned CLI implementation. `prepare` freezes complete inputs, a randomized schedule, repetitions, model/runtime versions, effort, grader panel and hashes before execution. A new model needs a new experiment; compare instruction lift within each model before interpreting differences across models.

There are separate natural and explicit invocation populations. Natural tasks measure skill discovery and task quality against the no-skill control. Explicit tasks ask for a named skill and run only with available skills; an impossible request to use an absent skill would be a confounded baseline. Compare released and candidate instructions on those tasks.

Three configured model families each receive two judges from the other families. Normal delegated implementers and reviewers are part of the measured workflow. External benchmark judges receive completed work and never feed corrections into the measured attempt. Record the whole workflow's cost where the runtime supplies it; unavailable usage is unknown, not zero.

## Run a comparison

Run from a full Groundwork checkout with Bun, Git, Docker, and `uv` available. Docker must be running. The native runtime integration pins Harbor 0.24.0, Copilot CLI 1.0.95, and OpenCode V2 2.0.26; Python and native CLI dependencies belong to the benchmark environment rather than Groundwork's distributed JavaScript package.

Copilot trials use the current GitHub CLI authentication or an explicitly supplied Copilot token. OpenCode trials use the authenticated `github-copilot` provider through its supported credential export/import. Credentials are relayed privately into disposable environments and excluded from collected evidence. `preflight` checks availability before inference. Anana credentials are reserved for publication.

```sh
bun run eval validate
bun run eval preflight
bun run eval controls
bun run eval prepare --tier smoke --attempts 1
```

Preparation prints a fresh run directory. Substitute that directory below:

```sh
bun run eval run .groundwork/runs/<run>
bun run eval judge .groundwork/runs/<run>
bun run eval report .groundwork/runs/<run>
```

`run` and `judge` call paid models. Configuration in `.groundwork/config/evals.json` sets concurrency, repetitions, timeouts, and a maximum declared trial count. Inspect the prepared count before execution. Timeouts are incomplete work; provider/setup failures are recorded separately. Resuming never discards a failed attempt or silently retries it until it passes. Prepare a new run to repeat an attempt.

`maxJudgePacketBytes` bounds each complete grading packet (300,000 bytes by default). It is a byte limit, not a token estimate; choose a budget that fits the selected judges. Oversized packets remain unscorable rather than being silently truncated. Regrading records its own packet budget. Identical native `content`/`detailedContent` copies are represented once; distinct tool output remains intact.

### Regrade saved attempts

When a judge, rubric, or grading implementation changes, reuse intact actor evidence explicitly:

```sh
bun run eval regrade .groundwork/runs/<actor-run>
```

This creates a new grading revision and prints its directory. It calls judges, not implementation agents. The original experiment, attempts, execution identities, and earlier verdicts remain intact. Case-specific expectations come from the original frozen experiment; the new panel, generic rubric and grading sources receive their own provenance. Missing or changed original evidence remains unscorable.

Use `--config <file>` to select another configured judge panel. Read and publish the printed grading directory with `report` and `publish`. Its report explicitly identifies the original actor run and the new grading context; repeated grades of one attempt are not independent implementation samples. Compare archived submissions under both judge versions before joining historical score trends.

For instruction changes:

```sh
bun run eval prepare --tier full --split development --candidate-ref worktree
bun run eval prepare --tier full --split development --activation explicit --candidate-ref worktree
```

`worktree` snapshots local skill content. The shared CLI stays at `cliRef`; instruction comparisons do not silently compare different verification engines. To measure a CLI/tooling change, name that separate hypothesis and run separate experiments with explicit `--cli-ref` values.

Use `--models gpt,claude`, `--case <id>`, or `--attempts <n>` for a focused investigation. These create their own declared populations; partial runs must not masquerade as the full suite.

## What the score means

Evaluator-owned checks exercise the resulting application's real entry points. They run independently of the agent's claimed test results. Judges assess correctness, completeness, evidence and proportionality on anchored 0–4 scales and retain their evidence references. The displayed quality score normalizes those dimensions to 0–100.

A good average cannot override a failed behaviour, incomplete work, unsupported verification claim, missing judge, missing attempt, or changed evidence. Per-judge scores and disagreement remain visible. Report completeness describes the availability of the declared evidence; it does not mean every task succeeded or that a skill should be adopted.

Incomplete work remains a non-success in the declared task-success denominator. Its unobserved quality stays unavailable, preventing a complete paired quality comparison rather than assigning it an invented judge score. This makes condition-dependent timeouts and missing grading visible.

Activation is a distinct diagnostic. A skill read is evidence of loading, not proof of following it. A successful task without loading can be valid work while revealing a discovery problem. Negative activation cases catch disproportionate workflows on advice and small requests.

Comparisons match model, case and repetition. Case-level averaging prevents repetitions from being counted as independent tasks. Uncertainty resamples whole problem families, preserving the correlation between tasks that share an application. Reports retain equal-case point estimates and produce diagnostic bootstrap intervals only with complete pairs and at least five independent families. Each initial split has four families, so its intervals remain unavailable until the corpus expands. Small smoke runs validate the machinery and reveal examples; their point estimates cannot establish a stable improvement.

## Inspect evidence

Each run keeps its frozen `experiment.json`, full `schedule.json`, input snapshots, raw runtime output, resulting project, external outcome observations, anonymized judge packets, each judge's raw response and verdict, and JSON/Markdown reports. Model identities and revision labels are removed from packets where identifiable; code and workflow style can still reveal which instructions were used. Benchmark blindness is an isolation and metadata-hygiene property, not a claim that an agent cannot infer evaluation.

Judge packets retain skill names and read events while withholding skill instruction bodies, and record their byte size. An interrupted native judge call is retained rather than silently resubmitted: inspect its `judge-<id>-native/` directory and use an explicit regrade for another grading revision. Completed verdicts are reused only with matching packet and response hashes.

The grading transcript projects observable user/assistant messages, tool calls/results, skill loading and delegation. Native system prompts, hook-context duplicates, encrypted reasoning and accounting internals remain in raw evidence and do not enter the judge packet. This preserves verification output while avoiding instruction leakage and condition-dependent packet inflation.

The evaluator's own observations establish the final project's behaviour. They do not retroactively establish that the agent ran a command or inspected an artifact. Check the original transcript when assessing evidence quality and false verification.

## Keep the suite useful

The initial corpus has 24 authored tasks across eight problem families. It includes exploration, persistence, shared callers, omitted acceptance conditions, scope restraint, blocked observation, proportionality and full workflows. These compact fixtures make failures interpretable. Add reconstructed real corrections and representative repository snapshots as they arise; do not present this initial authored corpus as broad real-world validation.

Give changed task definitions or grading standards a new suite identity for historical reporting. Keep the prior snapshot as an anchor; matching display names do not make different corpus, runtime or rubric hashes comparable.

Families are assigned wholly to development or holdout. `prepare` selects exactly one split. Holdout references are kept out of candidate environments, but remain visible to repository maintainers: this is a reserved evaluation split, not a secret from people editing this repository. Do not inspect or tune against its answers during a development round. Rotate problem families after repeated use and obtain independently authored held-out cases for stronger validation.

The `controls` command verifies known reference changes and checks that original defects are detectable. It runs authored fixtures without models. Review-only cases can succeed by correctly identifying failure or unavailable live evidence; that does not make the reviewed feature ready to ship.

`bun run eval judge-controls` runs the configured judge panel against anonymized authored good/bad submissions, including plausible false-success answers. This spends model budget and retains each packet and verdict. It checks whether the judge distinguishes these controls; it is explicitly not a measurement of agent performance or agreement with human labels.

Use `judge-controls --case <id>` to recheck an updated control and its associated examples without repeating unrelated model calls. The saved result records its selected cases.

Calibrate judges with your own labels before treating their preferences as a release gate:

```sh
bun run eval calibrate human-labels.json judge-decisions.json
```

Both inputs are arrays with `id` and `accepted`. Human values are booleans; judge values may also be `null` for unavailable decisions. `.groundwork/evals/calibration.mjs` supplies clearly labelled authored controls, not human labels. Review disagreements, particularly polished false-success answers. Archive labels with the relevant grader identity. When changing rubrics or judges, score the same archived submissions with both panels before interpreting a trend across grading versions.

## Model-release decision

1. Pin the new model and actual runtime version in configuration, keeping the skill release, suite and grader scale stable where possible.
2. Run natural and explicit populations with repetitions; inspect outcome, false-verification, activation, completion and cost by task family.
3. Form a concrete instruction-change hypothesis from failures. Test it on development cases, including previously supported models.
4. Run the held-out population at the end of the round. Keep infrastructure gaps and small samples visible.
5. Record adopt, reject or investigate in Anana with the reason and relevant report links. Prefer removing instructions that no longer earn their cost when the evidence supports it.

## Anana history

See [Anana setup](ANANA.md). The configured destination is the private [Groundwork Benchmarks database](https://groundwork.useanana.com/p/4c15fb68-bcc5-4fdb-8ea4-03ac192b1151). Supply a personal write token via `ANANA_TOKEN` or `ANANA_TOKEN_FILE` to the publisher only:

```sh
ANANA_TOKEN_FILE=/path/to/private/token bun run eval publish .groundwork/runs/<run>
```

The publisher creates or discovers the benchmark database, writes one immutable run record, and confirms it by reading it back. Local publishers share receipt storage under `.groundwork/runs/anana/`. Retrying a known run preserves human decisions and notes. An uncertain remote creation is recovered through discovery or left unresolved, never blindly duplicated. `--database-id` selects an existing destination, and `--evidence-url` can link a durable externally hosted evidence bundle. Local artifact links alone are not remotely accessible from Anana.
