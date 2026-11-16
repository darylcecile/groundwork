# Codebase map reference

Use this shape for a bounded area under `.groundwork/maps/<area>.md`. Adapt headings to the question; omit irrelevant sections and remove prompts/placeholders from a finished map. Prefer a small, cited explanation over a file inventory. Reuse existing journey detail instead of maintaining a second guide or database of tests. Keep task, PR and run histories with their own records, not in the map.

## Map shape

```markdown
# <Area>

## Scope and source basis

- Question and scope: <what this map explains, including important boundaries>.
- Inspected: <date>; revision: <commit, or state that the source is unversioned>.
- Relevant working-tree changes: <paths and changes affecting this map, or none>.
- Source basis: <key repository-relative paths plus symbols/headings and links>.
- Evidence limits: <which claims come from source; any unavailable runtime context>.

## Behaviour and entrypoints

<Brief answer: what this area does and how a user or public caller reaches it.>
<Name relevant inputs, starting state, and observable outputs. Link existing
behaviour-guide journeys and catalogue IDs when present.>

## Code ownership and state

<Identify the modules/symbols that own validation, coordination, state changes,
and output. Name core types, state lifetimes, persistence, and shared config.
Cite explicit human ownership records only if the question needs them.>

## Flow

<Trace the important route from entrypoint through decisions and dependencies
to side effects and output, with source references at each meaningful boundary.
Use a small diagram only if it clarifies the flow. Include relevant callers,
consumers, external boundaries, and failure/cancellation paths.>

## Feature relationships

| Behaviour | Direct dependency | Source or documented reason |
| --- | --- | --- |
| <existing catalogue ID> | <other existing behaviour ID> | <evidence establishing the connection> |

<Record these direct edges in the behaviour's `dependsOn` list. Consumers are
derived from the same links. Shared paths/checks alone are not a dependency.
Omit the table if no relationships have been established and record that gap.>

## Constraints and change impact

<Record relevant invariants with evidence, consumers/shared state affected by a
change, and supported extension points. Distinguish enforced constraints from
conventions or unverified assumptions. Explain where a change would propagate.>

## Verification options and gaps

| Behaviour or constraint | Existing journey / assertion source | Check ID | What it asserts / remaining gap |
| --- | --- | --- | --- |
| <scoped claim> | <link to existing detail> | <real configured ID or `not mapped`> | <assertion boundary and missing observation> |

<Keep this table limited to the mapped claims. Reference the catalogue and
actual assertions; do not copy commands, fixtures, or a complete test list.
A check's presence does not say it ran or passed.>

## Documented rationale

<Only when useful: link the decision record, PR, or commit and explain what it
explicitly documents. Note current divergence. Label interpretation as inference.>

## Unknowns and refresh triggers

<State consequential unknowns and the source, person, or observation needed to
resolve them. Name the entrypoints, state contracts, configuration, dependencies,
or check changes that should trigger reinspection. Keep runtime gaps independent
of source freshness.>
```

## Link conventions

In a map at `.groundwork/maps/catalogue.md`, label source citations with repository-relative paths and symbols; make the Markdown target relative to the map. For example, `[lib/config.mjs — catalogue](../../lib/config.mjs)` points two levels up. Add useful line/revision information in the citation text or a revision permalink.

- Feature journey in `.groundwork/guides/preferences.md`: target `../guides/preferences.md#save-preferences`.
- Sibling map: target `verification.md#selection`.
- Link **from** a feature guide to the map: target `../maps/catalogue.md#discovery`.
- Catalogue `guide` string: `.groundwork/maps/catalogue.md#discovery`.
- Catalogue/check `paths`: repository-root-relative files or globs, such as `lib/config.mjs`.

Use only paths and anchors that exist in the project. Check path patterns against the actual affected files, not just whether the glob looks plausible.

## Connect the existing catalogue

Consult the installed `verify-work` reference before modifying verification files. During authorized map maintenance, project commands automatically convert older configuration and guide sections into active fragments and guides. Preserve existing IDs and bindings in those files. For a new catalogue entry, save a fragment such as `.groundwork/verify.d/catalogue.json`. Fragments are discovered automatically and validated together, including cross-file references and duplicate IDs. If the entry already exists, update it in place instead of adding a second definition. For example, a map's `## Discovery` section could be linked as follows:

```json
{
  "behaviours": {
    "catalogue": {
      "description": "Discover behaviours and enforce applicable project invariants",
      "paths": ["lib/config.mjs", "test/config.test.mjs", ".groundwork/verify.d/*.json"],
      "entry": "groundwork view guide / groundwork verify --changed <ref>",
      "guide": ".groundwork/maps/catalogue.md#discovery"
    }
  }
}
```

This changes navigation, not evidence. The example adds no check binding. Retain the real project's existing bindings; add a check's `covers` only after inspecting its assertions. A behaviour may have no check, shown in the map as `not mapped`. Configured invariants require a nonempty `checks` array of real enforcing check IDs. Keep unsupported constraints and gaps in prose rather than inventing checks or fields.

For a feature that consumes the catalogue, a source-backed relationship could be `"dependsOn": ["catalogue"]` on that feature's behaviour entry. Every target must already be a behaviour in the active configuration; self-links and references to invariants are invalid. Record direct dependencies only, explaining each connection in the map. Leave unknown relationships unrecorded. `groundwork map` displays all recorded edges; `groundwork map <feature>` displays direct dependencies, derived consumers and feature context. Relationships are navigational and do not add verification coverage or select checks automatically.

Link the map from its catalogue entry or feature guide. A new feature needs no root-guide index or central include list update. Keep detailed journeys in their existing home; if an existing catalogue `guide` still points to the best journey, retain it and link to the map there instead of replacing useful detail.

## Refresh a map

Compare the recorded revision and relevant local changes with current source. Reinspect affected claims, callers, shared contracts, and extension points; update stale facts and paths rather than merely changing the date. Recheck Markdown links, heading anchors, path patterns, catalogue IDs, dependency relationships, and check references/assertions. Inspect the ASCII view after updating relationships. Preserve unrelated custom content. Record the scope actually refreshed and any claims still awaiting inspection. Runtime observations retain their own source/context and gaps until exercised again.
