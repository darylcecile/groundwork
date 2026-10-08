# Groundwork

A small personal workflow for GitHub Copilot CLI/app and OpenCode 2. Keep working through normal chat. The agent preserves the intended outcome, makes the change, exercises it, and brings back evidence you can review.

- **[Workflow and confidence framework](WORKFLOW.md):** what the agent does and what counts as verified.
- **`verify-work` skill:** the same workflow in both products.
- **`groundwork` CLI:** repeatable project checks, logs, artifacts, and source-aware reports.
- **[PR verification workflow](pr-verification/README.md):** a final CI pass with project checks, agent-led verification, and a PR comment linking the results and evidence.

## Install

Requires Bun and Git. The projects being checked can use any language or toolchain.

Install from GitHub using Bun, with SSH access to the private repository:

```sh
bun add --global git@github.com:darylcecile/groundwork.git
groundwork install
```

`groundwork install` registers the personal skill at `~/.agents/skills/verify-work` and adds a short instruction to Copilot and OpenCode's existing global instructions. Start a new Copilot session. For already-open OpenCode projects, run `opencode2 reload` once to refresh skill discovery.

## Try it in a project

Open the project in Copilot or OpenCode and say:

> Use verify-work to set this project up. Reuse its existing tools and start with one real user journey. Then help me make a small change and show evidence that it works.

The agent runs `groundwork init` and fills in two project files:

- **`VERIFY.md`:** the behaviour guide—how to run the project, reach the feature, and observe the expected result.
- **`verify.json`:** named commands that check concrete expectations.

Commit those files with the project when ready. Run evidence stays locally in the ignored `.verify/` directory. After setup, give the agent tasks normally.

## Commands

```sh
groundwork init                   # Set up the current project, preserving existing files
groundwork verify                 # Run every configured check
groundwork verify theme-persists  # Run this check plus checks marked required
groundwork view report            # Show the latest run and whether its source is still current
```

The agent can also run `bun <skill-directory>/verify.mjs` if `groundwork` is unavailable on its PATH.

Example `verify.json` (replace these commands with ones that actually exist):

```json
{
  "checks": {
    "types": {
      "command": "bun run typecheck",
      "expect": "The project's type checks pass",
      "required": true
    },
    "theme-persists": {
      "command": "bun run test:e2e --grep theme-persists",
      "expect": "Dark theme remains selected after restarting the application",
      "artifacts": ["after-restart.png"]
    }
  }
}
```

Commands run from the directory containing `verify.json`, using the system shell. They should finish after making their assertions. The project's test runner or driver owns any application startup and cleanup. Use `required` for checks the project requires on every change; choose other checks according to the task.

Each command receives **`VERIFY_ARTIFACTS`**, an absolute path to a fresh evidence directory. A driver writes its screenshots, traces, or response captures there. Declare files that must exist in `artifacts`; paths are relative to that directory. Expected evidence must be nonempty. The agent still inspects images and traces before drawing conclusions from them.

The CLI streams output, saves logs, and records the command, expectation, exit code, duration, Git revision, and local-change fingerprint. Each run has its own `result.json`. `groundwork view report` also identifies omitted checks, changed source, and missing or altered evidence.

### Reading the result

- **Passed:** the selected commands succeeded and their declared evidence was captured.
- **Failed:** a command returned a failure; inspect its log to distinguish a broken expectation from a setup problem.
- **Inconclusive:** verification is incomplete, source has changed, or evidence is unavailable.

Exit codes are `0`, `1`, and `2`, respectively. Drivers can exit `2` when setup or an observation is unavailable. A successful run supports the assertions those commands actually make. The agent's task handoff also covers requirement coverage, code review, and any manual observations.

Source matching covers Git revision, local tracked changes, and non-ignored untracked files within the project directory. Record relevant environment, external-service, and ignored-file assumptions in the scenario. Run the application check again when those inputs change.

## Refine it through use

For the first project, aim for one complete loop: reproduce a problem, fix it, rerun the same behaviour, and inspect the evidence. Tell the agent where you still had to intervene or could not trust the result. Improve the relevant project pattern, check, driver, or skill from that concrete experience.

See [CONTRIBUTING.md](CONTRIBUTING.md) for working on the toolkit.
