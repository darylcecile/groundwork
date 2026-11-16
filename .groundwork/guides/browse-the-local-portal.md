### Browse the local portal

Run CLI commands in two different repositories outside CI. Both projects must register with the same loopback origin and server PID, with project-specific URLs derived from their registered IDs. Commands must not print a portal banner. The project selector switches reports, evidence, catalogue and map between registered repositories. Project registration is retained in the user's cache, outside project data. CI skips startup, and `GROUNDWORK_PORTAL=0` disables it locally. Startup failure must preserve the requested command's exit status.

Exercise simultaneous registrations and restart the daemon: both projects should remain available. Use the same run ID in two fixtures to establish that their reports and evidence stay isolated. Changing or registering another project must not switch the current browser view or reset its inspection state. A missing project should leave other projects usable.

Browse reports and inspect check details, requirement coverage, observations and evidence. Outcomes are saved snapshots: an unfinished local run is not labelled as actively running, and saved success does not claim current source, evidence or receipt-input freshness. Empty projects, unreadable reports and missing files need useful UI. File changes refresh the open view while retaining navigation.

Inspect executed and reused receipt details, including the original run metadata. A reused result is labelled as an earlier result, not a new execution. Both external and legacy storage remain readable; viewing a saved receipt does not reassess its current applicability.

Browse the current catalogue and select a behaviour on the React Flow map canvas. Pan, zoom and fit the graph; follow its declared dependencies or derived consumers; inspect its checks, source paths and guide. The map must remain usable with no relationships, cycles or missing check bindings. Viewing these surfaces does not execute checks or modify configuration, reports or evidence.

Evidence opens in a modal with keyboard dismissal and focus restoration. JSON has structured fields, Markdown has readable document formatting, and HTML/SVG renders as an inert saved preview. HTML previews use captured assets when available; absent original assets cannot be recreated from a saved HTML response. An unrelated file update must not reset media playback or expanded evidence fields.

The `tests` check covers the API, file boundaries and daemon lifecycle. `portal-build` typechecks the TypeScript source and checks the committed distribution. For UI changes, also inspect wide and narrow rendered layouts and exercise report selection, evidence previews, catalogue search, node navigation and live updates with the browser. Browser observations are separate from automated API assertions.
