### Verify a behaviour and review evidence

The integration test creates a small preferences CLI with broken theme persistence. Its driver sets a theme and reads it in a new process. Verification fails on the original implementation, passes after the fix, and retains both runs. A saved passing result becomes inconclusive when its source or evidence subsequently changes.
