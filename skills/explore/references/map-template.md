# Codebase map reference

Use this shape for a bounded area under `.groundwork/maps/<area>.md`. Adapt headings to the question; omit irrelevant sections and remove prompts/placeholders from a finished map. Prefer a small, cited explanation over a file inventory. Reuse existing journey detail instead of maintaining a second guide or database of tests.

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

## Runtime observations

<Only if observed: date, inspected source version and relevant local changes,
entrypoint/action or command, fixture/environment, actual result, and retained
evidence link. State exactly what was and was not exercised. Keep historical
runs tied to their own source/context, not the map's newest inspection date.>

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

- Existing journey in `.groundwork/VERIFY.md`: target `../VERIFY.md#plan-and-select-verification`.
- Sibling map: target `verification.md#selection`.
- Link **from** `.groundwork/VERIFY.md` to the map: target `maps/catalogue.md#discovery`.
- Catalogue `guide` string: `.groundwork/maps/catalogue.md#discovery`.
- Catalogue/check `paths`: repository-root-relative files or globs, such as `lib/config.mjs`.

Use only paths and anchors that exist in the project. Check path patterns against the actual affected files, not just whether the glob looks plausible.

## Connect the existing catalogue

Consult the installed `verify-work` reference before modifying verification files. Use the active configuration; a legacy root `verify.json` remains active until adoption migrates it. For example, if a Groundwork map has a `## Discovery` section, its existing catalogue entry could use the following fragment. Merge it into the active configuration (normally `.groundwork/verify.json`), preserving the project's `checks` and all other entries/custom content; this is not a replacement configuration.

```json
{
  "behaviours": {
    "catalogue": {
      "description": "Discover behaviours and enforce applicable project invariants",
      "paths": ["lib/config.mjs", "test/config.test.mjs", ".groundwork/verify.json"],
      "entry": "groundwork view guide / groundwork verify --changed <ref>",
      "guide": ".groundwork/maps/catalogue.md#discovery"
    }
  }
}
```

This changes navigation, not evidence. The example adds no check binding. Retain the real project's existing bindings; add a check's `covers` only after inspecting its assertions. A behaviour may have no check, shown in the map as `not mapped`. Configured invariants require a nonempty `checks` array of real enforcing check IDs. Keep unsupported constraints and gaps in prose rather than inventing checks or fields.

Link the map from the relevant `.groundwork/VERIFY.md` section when useful. Keep detailed journeys in their existing home; if an existing catalogue `guide` still points to the best journey, retain it and link to the map there instead of replacing useful detail.

## Refresh a map

Compare the recorded revision and relevant local changes with current source. Reinspect affected claims, callers, shared contracts, and extension points; update stale facts and paths rather than merely changing the date. Recheck Markdown links, heading anchors, path patterns, catalogue IDs, and check references/assertions. Preserve unrelated custom content. Record the scope actually refreshed and any claims still awaiting inspection. Runtime observations retain their own source/context and gaps until exercised again.
