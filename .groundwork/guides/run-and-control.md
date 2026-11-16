## Run and control

- CLI: `bun skills/verify-work/verify.mjs <command>` or the installed `groundwork`.
- Required check: `groundwork verify tests`.
- Implementation: `skills/verify-work/verify.mjs` and shared `lib/migration.mjs`, `lib/config.mjs`, `lib/model.mjs`, and `lib/runner.mjs`.
- Checks: `test/` and `pr-verification/test/`.
- Plan, configuration, and driver reference: [verification reference](../../skills/verify-work/references/verification.md).
- After workflow changes: `actionlint .github/workflows/verify.yml`.
