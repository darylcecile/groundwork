## Environment and evidence

Requires Bun, Git, and Bash. Tests use disposable local projects and controlled integrations without network credentials. `VERIFY_TEST_TMPDIR` selects their temporary parent directory when needed; `GROUNDWORK_STATE_HOME` isolates evidence storage. Test fixtures are removed after use; recorded run evidence remains in the external store.

Keep fixture, mocked-service, and workload context non-secret. The runner records source fingerprints and checks evidence freshness; relevant external services and ignored inputs still need explicit observations when they change.
