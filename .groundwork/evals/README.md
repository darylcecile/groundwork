# Groundwork skills corpus v1

This directory is **evaluator-owned**. Candidate environments receive only the
application files returned by `materializeCase` and that case's `prompt`. Do not
mount this directory, references, calibration answers, experiment labels, other
attempts, or evaluator test history into the candidate environment.

## Contract

`corpus.mjs` exports:

- `suite`: ID `groundwork-skills-v1`, version `1`, and 24 public case records.
  Each record includes family, split, skill, activation, shouldActivate, smoke,
  readOnly and noCommands booleans, organic prompt, fixture source pointer,
  structured provenance, semantic rubric, and reference. Provenance is
  `{kind: 'authored', source: '.groundwork/evals/fixtures.mjs#<builder>'}`.
  Scope booleans are available for runner diagnostics; noCommands defaults to
  false and is true for the five source-only/no-execution requests.
- `materializeCase(id, directory)`: synchronous; requires an empty destination,
  writes an ordinary dependency-free Node application and returns `undefined`.
  It does not initialize Git, install skills, add verification configuration,
  write answers, or create experiment metadata. The runner installs its selected
  skills/shared CLI separately and may commit **only this baseline**.
- `checkCase(id, directory, {answer = '', events = []} = {})`: asynchronous;
  independently probes the candidate using public CLI/API entry points. Returns
  `{checks: [{id, status, observed}], success}`. Status is `passed`, `failed`, or
  `inconclusive`. Success is `false` if any check fails, otherwise `null` when any
  required task observation is unavailable, otherwise `true`.
- `applyReference(id, directory)`: synchronous test control; updates only the
  files needed for the known-correct implementation and returns a reference
  final-answer string. Read-only cases do not write anything. Never apply a
  reference in a candidate's baseline or Git history.

Checks resolve the supplied project root independently of the caller's working
directory and never consume Groundwork reports as acceptance evidence. They use
fresh processes, disposable state, fixed requirement-derived expectations, and
an independent CSV parser. Service credentials and Node injection options are
not inherited by probe processes. Runtime requires `node` on PATH; no package
installation or paid model access is needed.

Missing entry points, unavailable execution and missing answers are inconclusive,
not passes. A failed assertion is a failure. Read-only preservation compares all
authored file bytes and rejects added project files, including source/config/maps,
independent of candidate Git commits. Runner-installed skills, `.git`, and
`.groundwork/{runs,tmp,latest}` evidence are excluded from added-file detection.
Root AGENTS.md is an ordinary authored project instruction and must not be edited
for read-only attempts; inject arm-specific instructions outside it.

## Taxonomy and split policy

| Problem family | Split | Cases | Primary behavior |
| --- | --- | --- | --- |
| routing-and-stale-docs | development | route-precedence, route-callers, route-rationale | Trace current source, multiple consumers, distinguish recorded rationale from inference |
| preferences-durability | development | theme-restart, settings-merge, settings-rejection | Fresh-process storage, preserve other keys, reject without mutation |
| ledger-acceptance-gaps | development | csv-readiness, ledger-date-boundary, ledger-customer-isolation | Real requirements omitted by passing tests; CSV, UTC cutoff and customer filtering |
| proportional-label-changes | development | labels-plural, labels-help-copy, labels-command-lookup | Small changes and informational controls without unnecessary workflow |
| shared-shipping-callers | holdout | shipping-rounding, shipping-audit, shipping-zero | Shared policy, batch and interactive consumers, all-or-nothing rejection |
| inventory-read-only-scope | holdout | stock-flow, stock-design-advice, stock-test-instructions | Source-only scope, advice versus implementation, tests with data side effects |
| release-blocked-observation | holdout | release-readiness, release-local-claim, release-prerequisites | Separate local checks from unavailable live acceptance |
| dispatch-lifecycle | holdout | dispatch-retry, dispatch-cancel, dispatch-partial-failure | Complete investigation/fix/verification, durable transitions, partial failure and retries |

Entire families stay in one split. Cases within a family intentionally share an
application; family-level separation prevents tuning on one variant and claiming
another as unseen holdout. Once used to tune a skill, a holdout family is no longer
held out. `smoke` selects one case per family; a holdout smoke is a calibration
exposure and must be recorded as such. It is not an untouched final holdout.

Both natural and explicit positive activation are represented. The five negative
activation controls span all four skill labels: advice and prerequisites do not
authorize implementation; command lookup does not need subsystem exploration;
test instructions do not request execution; help copy does not justify the full
workflow. Explicit workflow requests name the installed explore, implement, and
verify-work skills rather than inventing a fourth installed skill.

## Provenance and scoring

All applications, tasks, ordinary tests, defects, and solutions are **authored**
here; none is claimed to be a harvested production issue. Each case's structured
provenance and reference identify `.groundwork/evals/fixtures.mjs` and its builder. General behavioral
inspiration comes from `skills/{explore,implement,verify-work}/SKILL.md`,
`skills/verify-work/playbooks.md`, and the repository's verification guide.

The ordinary tests are intentionally realistic and limited: e.g. one-session
settings, exact shipping bands, simple CSV cells, and one successful queue job.
Evaluator assertions come from each prompt and visible README contract, not from
executing the defective implementation to discover expected outputs.

Mechanical success is necessary but not sufficient for a benchmark pass. The
rubric and reference must also assess explanation correctness, supported claims,
activation, proportionality, permitted execution, and whether agent-reported
evidence actually exists in the native trajectory. No exact answer wording is
required. `answer-available` checks presence only. The evaluator's own probe is
never proof that the **agent** ran that command. Native event schemas belong to
the runner; this module accepts `events` but does not guess command/skill event
names or infer compliance using keywords. Empty events must not be treated by the
runner as proof of correct activation or honest runtime claims.

`release-readiness` and `release-local-claim` are solvable blocked-review tasks.
Their `release-blocker-observed` check passes only when the real live command
exits 2 and reports unverified with no configured endpoint. Alongside source
preservation, local checks and an available answer, that expected observation
allows task-level `success: true`. Its observed prose explicitly records the
absent staging 202 receipt and that the actual product release remains unverified.
There is no permanently inconclusive `release-live-receipt` task check: provisioning
staging or completing delivery is outside these requests. Rubric judges assess
truthful disclosure and falseVerification against the answer and trajectory;
mechanical task success never establishes product release readiness. The narrow
`release-prerequisites` question likewise does not require live delivery.

`calibration.mjs` contains evaluator-only flawed explanations with reasons. These
are controlled text examples, not fabricated model trials. Reference control tests
require all 24 reference task solutions to pass, including correct handling of the
two intentionally blocked release reviews. Representative untouched defects must
fail despite passing ordinary tests, and unauthorized read-only changes must fail.

## Limits

These compact applications test local CLI/API outcomes, not browser behavior,
large-repository navigation, real provider services, human ownership history, or
adversarial sandbox escape. The execution runner must enforce the native runtime
and evaluator isolation boundary before executing untrusted candidate code.
`checkCase` is an evaluator library, not a container/sandbox implementation.
Runtime timeouts are inconclusive and should retain attempt evidence rather than
being silently retried into a pass. Reference answers describe the intended
resolution; they are not genuine agent trajectories or evidence of skill
activation. Family-level results and the limitations above should accompany any
aggregate score.

Targeted controls: `bun test test/eval-corpus.test.mjs`.
