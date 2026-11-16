### Inspect feature relationships

Run `groundwork map` for the catalogue overview, or `groundwork map pr-verification` for its direct dependencies and source/check/guide context. `groundwork map catalogue` shows the feature-map and PR-verification capabilities as consumers. These edges are recorded in `dependsOn` and supported by the [feature relationships](../maps/verification.md#feature-relationships); shared checks do not create edges. Existing features without relationships remain visible as unrecorded.

The CLI tests exercise direction, empty metadata, ambiguous and missing queries, cyclic relationships, guide-reference errors and nested/legacy discovery. The first map request can convert older metadata and move legacy evidence; subsequent navigation leaves source and run pointers intact. No map request executes a configured check.
