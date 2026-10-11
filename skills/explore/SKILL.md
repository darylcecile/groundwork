---
name: explore
description: Use for evidence-backed codebase, subsystem, and feature exploration. Explain how it works, where behaviour lives, and why decisions were made; investigate code ownership and change impact; support onboarding; and create, reuse, or update Groundwork maps under .groundwork/maps/.
---

# Explore a codebase with Groundwork

Build an explanation that another person can follow back to evidence. Match the depth to the question and follow the project's instructions and permissions.

## Scope the work

1. Identify the question, area, and requested deliverable before exploring. Resolve ambiguity only when it materially changes the investigation. Answer narrow questions directly. For project-wide mapping, cover the requested areas and important cross-area flows; report partial coverage explicitly.
2. Read relevant project instructions, existing maps and architecture docs, `.groundwork/VERIFY.md`, and `.groundwork/verify.json` when present; older projects may have root verification files. Use `groundwork view guide [query]` and `groundwork map [feature]`, when available, for navigation. Spot-check current source before relying on any documented claim or relationship.
3. An ordinary how/where/why question produces a concise explanation in chat. It does not authorize saved maps, project setup, or source/configuration edits.
4. An explicit mapping or map-maintenance request, or project adoption, authorizes stable documentation under `.groundwork/maps/<area>.md` and relevant guide/catalogue updates. Reuse or update the closest existing map and project documentation. Keep product source unchanged; implementation is a separate requested task.

## Trace the behaviour

1. Start at real user or public entrypoints: a screen action, route, API, command, exported interface, or job trigger. Establish inputs and starting state, then follow the actual execution and data flow through decisions, dependencies, side effects, and observable outputs.
2. Follow relevant callers and consumers, shared types/state/configuration, persistence, asynchronous boundaries, and external services. Include error and cancellation paths when they affect the question. Identify relevant invariants and supported extension points rather than stopping at the first matching symbol.
3. Identify code ownership: the modules that validate inputs, own state transitions, coordinate work, and expose results. Do not invent human owners from names or commit frequency; cite explicit ownership records only when relevant.
4. When rationale matters, inspect focused history, PRs, design docs, or decision records and cite what they actually say. Code reveals an implementation, not its author's motivation. Keep undocumented reasons as inference or unknown.
5. Work directly for narrow questions. Use bounded independent subagents only when useful and permitted, with distinct questions and explicit scope. Require cited findings and gaps; consolidate them, resolve disagreements against evidence, and remove duplication.
6. Probe runtime only when the answer needs an observation unavailable from source. Use existing project tools and isolated fixtures, record the entrypoint and environment, and inspect the result. Put scratch work under `.groundwork/tmp/` and evidence in the supplied evidence directory or `.groundwork/runs/`. Clean up your own processes and temporary state on success or failure while preserving useful evidence and other people's state.

Stop when the scoped explanation is supported and remaining uncertainty is explicit. Expand only to resolve a dependency or contradiction that affects the answer.

## Make evidence legible

Cite consequential claims using repository-relative paths and symbols or document headings. Add line ranges and revision references when they help locate or disambiguate the evidence. Keep citations close to the claims they support.

Distinguish these evidence types in prose or labels:

- **Source read:** what the inspected implementation or assertion encodes.
- **Runtime observed:** what an executed interaction showed, with command/action, fixture, source version, result, and evidence location.
- **Historically documented:** a reason explicitly recorded in a cited commit, PR, or document; note when the current implementation differs.
- **Inference:** a conclusion drawn from named evidence, with its uncertainty.
- **Unknown:** a missing fact or observation and how it could be resolved.

Scanning source or tests does not establish runtime behaviour or exercised coverage. A map or catalogue link is not a passed observation. Reusing saved runtime evidence requires checking its source and environment context; a source refresh alone cannot refresh that observation.

For read-only questions, lead with the answer and scope. Include a short flow, key paths, change constraints/impact, existing verification options, and gaps only as relevant. Link existing journey detail rather than copying it. Do not turn a small answer into a generic checklist.

## Create or maintain a map

Use [the map template](references/map-template.md) for authorized mapping or adoption work. Omit irrelevant sections and remove all unfinished placeholders.

1. Choose a stable, bounded area and update its existing map where possible. Record the scope, inspection date and revision, and relevant working-tree changes/paths so readers can identify the source actually inspected.
2. Capture the supported explanation with source references, code ownership, important flow/state, invariants, change impact, extension points, and remaining gaps. Include actual runtime observations only when available, with their own context. Link existing guides for detailed journeys and checks.
3. Before changing the verification guide or configuration, consult the installed `verify-work` skill's `references/verification.md`. Make these updates only for authorized mapping/adoption work. Use the project's active verification files, including legacy root files until adoption migrates them; do not introduce a second configuration that shadows existing checks. If the reference is unavailable, keep configuration changes as a proposal and report the gap.
4. Link the map from the relevant guide section and catalogue entries when it improves discovery. Behaviour entries support `description`, `paths`, `entry`, `guide`, and optional `dependsOn`; a guide may be `.groundwork/maps/<area>.md#anchor`. Record direct dependencies on other existing behaviour IDs only when source or documented contracts establish them, and cite the reason in the narrative map. Consumers are derived automatically. Shared paths or test suites alone are not dependency evidence. Use supported check `covers` and invariant `checks` bindings; relationship metadata does not change check selection.
5. Preserve custom content, catalogue IDs, and existing check bindings. Confirm actual assertions before adding a binding. A behaviour can remain without a mapped check; an invariant in configuration needs real enforcing checks. Document an unenforced constraint and its gap in the map instead of inventing enforcement.
6. Keep Markdown links relative to the map file, two directory levels below the project root. Configuration `paths` and `guide` strings stay project-root-relative. See the reference for examples.
7. Before reusing a map, recheck affected source claims and callers against current code, including relevant local changes. Check file links, path patterns, heading anchors, check references, and `dependsOn` relationships; correct stale paths and facts during authorized maintenance. Inspect `groundwork map <feature>` after updating relationships. For a read-only question, report staleness in chat instead of editing.
8. Update inspection metadata only for the scope actually rechecked. Preserve or qualify older runtime observations and keep independent runtime gaps explicit. Finish with a concise summary of what was mapped/refreshed, evidence used, and what remains unknown.
