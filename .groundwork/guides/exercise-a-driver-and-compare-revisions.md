### Exercise a driver and compare revisions

Use a project-owned driver with isolated starting state and real assertions. Observe separate setup, exercise, and cleanup outcomes; cleanup is attempted after failures and interruption. Every repeated trial retains its result and evidence, and a later pass cannot erase an earlier failure.

For `--base`, the candidate's driver must target `GROUNDWORK_SOURCE_DIR` for both revisions. A regression comparison needs the intended baseline assertion failure and a passing candidate. A passing or unavailable baseline cannot establish reproduction. Measurement comparisons use matching declared context, configured units and budgets, and median samples from retained trials.

Inspect the saved plan, requirement coverage, trial logs, observations, and artifacts in the run directory. Source changes, missing observations, or unusable evidence must prevent a passing claim.
