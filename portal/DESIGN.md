# Groundwork portal

## Purpose

An inspection surface for a developer reviewing verification work. Reports answer what was checked, what happened, and which evidence supports the outcome. The catalogue explains the configured behaviours; the map makes their recorded dependencies navigable.

## Visual language

The supplied references set the direction: light surfaces, compact status rows, quiet borders, generous separation between sections, and restrained semantic green/amber/red. System typography keeps the portal quick and familiar. Source identifiers, commands and measurements use monospace only where it helps reading.

`ui/styles.css` owns shared tokens, typography and report components. `ui/catalogue.css` extends them for catalogue and graph surfaces. Status always has a text label or icon as well as colour. Do not add fictional risk, coverage or confidence metrics.

## Interaction

- A persistent top bar selects the current project and separates Reports, Behaviours and Map. Project names include path context so repositories with the same basename are distinguishable. The report history becomes a disclosure on narrow screens.
- Report checks expand progressively. Outcomes distinguish requirement coverage from individual observations.
- Evidence opens in a modal with a persistent filename, Download and Close controls. Closing returns focus and preserves the report's scroll position.
- JSON uses structured fields; Markdown uses document typography; HTML is a rendered saved-page preview. Missing captured page assets are made explicit. Logs retain readable text formatting.
- The React Flow map supports spatial navigation, zoom and fit-to-view. Nodes and arrows represent existing behaviours and `dependsOn` edges. Selecting a node reveals its configuration; graph manipulation is view-only.
- Live updates refresh saved content while preserving the selected history entry, open details and unchanged media playback. Reconnection is shown in the top bar; replacing the background server with a new build reloads the portal assets.
- Switching projects clears the previous project's view and cancels its requests. Project identity stays in the URL; new registrations appear in the selector without changing the current selection.

## Semantics

Saved report status is historical. It does not imply current source/evidence freshness, and an unfinished run does not imply an active process. A passing set of checks without a plan does not imply complete requirement coverage. Catalogue check bindings are configuration, not observed verification success.

## Craft checks

Exercise desktop and 390px layouts, keyboard focus, modal dismissal, long report goals, graph selection, empty and error states, and updates during inspection. Inspect actual rendered HTML, images and PDFs rather than assuming a successful file fetch establishes a working preview.
