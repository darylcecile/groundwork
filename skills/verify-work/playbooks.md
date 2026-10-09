# Selective verification playbooks

Choose recipes that exercise the behaviour changed by the task.
Use the project's catalogue, behaviour guide, invariants, and existing drivers.
Select relevant cases; a small change does not require every recipe below.
Keep actual roles, permissions, policies, thresholds, and budgets in the project.

## Plan a focused check

- State the starting state, real entry point, action, and observable expectation.
- Find existing coverage before adding a driver, dependency, or test fixture.
- Include required checks and the invariants active for the affected paths.
- Inspect unmapped changes and decide which existing journey covers them.
- Choose the failures that could realistically break this change's contract.
- Keep fixtures repeatable and use project-owned setup and cleanup commands.
- Record unavailable runtime context as unverified, with the missing observation.
- Save evidence that supports the claim: observations, assertions, traces, or images.
- Inspect the evidence before describing a command's success as verified behaviour.

## UI and batch interactions

Use when a changed screen, control, or batch operation affects user actions.
Drive the real UI with the project's existing browser or application tools.

Relevant cases:
- Exercise the normal journey from its visible entry point to its final state.
- Check empty, loading, error, and completed states that this change can affect.
- For batches, include mixed success and failure when partial results are possible.
- Cancel while work is pending; observe which actions completed and which stopped.
- Change filters or navigate back while preserving the intended selection.
- Preserve original inputs after failure, cancellation, or an abandoned edit.
- Use the supplied visual reference and relevant viewport sizes when present.

Expectations and evidence:
- Show per-item outcomes and an accurate overall result after partial failure.
- Retrying eligible failures must preserve successful work under the project contract.
- Confirm cancellation leaves a usable UI and does not claim unfinished work succeeded.
- Assert selection and input values directly; screenshots alone cannot prove persistence.
- View rendered spacing, hierarchy, focus, and enabled states alongside interaction results.
- Save screenshots of relevant states and the trace or assertions proving the journey.

## Stateful workflows

Use when a change affects persistence, transitions, recovery, or multi-step work.
Start from explicit state and drive the same entry points used in production.

Relevant cases:
- Complete the normal transition and observe the resulting persisted state.
- Reload or start a new process when persistence is part of the promise.
- Interrupt at a meaningful boundary and resume through the supported workflow.
- Exercise partial completion and cancellation if the workflow exposes them.
- Repeat an action only when duplicate submission or retry is relevant to the change.
- Verify a denied or failed transition leaves the appropriate prior state intact.

Expectations and evidence:
- Compare state before and after, including identifiers and retained user choices.
- Distinguish completed, failed, cancelled, and pending work using project semantics.
- Check that recovery uses the original inputs rather than silently replacing them.
- Observe durable effects through a fresh reader, not only in-memory state.
- Save transition observations or stored-state snapshots with secrets removed.
- Use cleanup that preserves the observations needed to diagnose a failed run.

## API boundaries

Use when request parsing, response handling, or integration errors change.
Exercise the project's boundary code with its existing API tests or client driver.

Relevant cases:
- Send a valid request and inspect the status, response, and intended side effects.
- Try the malformed or missing fields relevant to the changed contract.
- Handle null, empty, or malformed error envelopes without hiding the original failure.
- Exercise a relevant non-success status with retry metadata, if the API exposes it.
- Check partial responses or cancellation where the integration supports them.

Expectations and evidence:
- Preserve HTTP status and applicable retry metadata when error bodies cannot be parsed.
- Keep useful error context without exposing credentials or full private payloads.
- Do not turn parse failures into a success, an unrelated exception, or lost status.
- Assert unchanged state after rejected input where the contract requires it.
- Capture representative request/response observations and boundary assertions.
- Use controlled upstream fixtures for failure cases; retain a real boundary exercise.

## Agent and prompt behaviour

Use when instructions, prompt transformations, runtime context, or tools change.
Reuse the project's evaluation fixtures and tool-call recording facilities.

Relevant cases:
- Use realistic user requests, including a good input that needs no transformation.
- Check ambiguous input against the project's intended assistance, without adding new intent.
- Observe tool-call routing, tool arguments, and the order of required actions.
- Include a relevant forbidden call and assert that it does not occur.
- Remove required runtime context and observe how the agent communicates the gap.
- Exercise tool failure, partial work, or cancellation where the changed flow supports it.

Expectations and evidence:
- Preserve the original goal, constraints, and meaningful user inputs.
- Assert the allowed action and resulting state, not just plausible response wording.
- Check missing context produces the project's blocked or clarification outcome.
- Compare recorded tool calls with project-owned permissions and routing rules.
- Keep original and transformed inputs when assessing whether a rewrite helped.
- Save redacted transcripts, tool traces, and claim-level evaluation outcomes.
- Scope repeated trials to variable behaviour and report their observed distribution.

## Permissions and configuration

Use when access decisions, ownership, settings, or configuration parsing change.
Take roles and policy from the project and reuse its enforceable boundary checks.

Relevant cases:
- Exercise the affected allowed action and a corresponding denied action.
- Check ownership or resource scope when those rules apply to the changed flow.
- Test missing, malformed, and unsupported configuration at its input boundary.
- Check settings survive reload or restart if persistence is part of the change.

Expectations and evidence:
- Denied actions leave protected state unchanged and return the expected outcome.
- UI availability agrees with the project's actual enforcement boundary.
- Invalid settings produce a useful error without silently changing policy.
- Record the role, resource relationship, configuration, and observed decision safely.
- Prefer code or data-model prevention for recurring mistakes, then existing automated checks.

## Performance and measurements

Use when latency, throughput, resource usage, or a performance claim is in scope.
Measure the affected operation with the project's benchmark or runtime instrumentation.

- Declare the workload, sample size, units, direction, and project-owned budget.
- Record non-secret context that affects comparison: fixture, runtime, or machine class.
- Separate setup from the measured operation and keep candidate and baseline comparable.
- Repeat variable measurements enough to assess the claim; retain individual observations.
- Distinguish an absolute limit from an allowed regression against the baseline.
- Include correctness assertions so a faster but incomplete operation cannot pass.
- Report only what was measured; one scoped benchmark does not establish whole-system speed.
- Preserve structured measurements and traces, and explain unavailable or noisy comparisons.
