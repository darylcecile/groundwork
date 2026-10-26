import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Behaviour, CatalogueEntry, CatalogueResponse, GuideResponse } from "../types";
import { useResource } from "./data";
import { Icon } from "./primitives";
import { decodeFragment, Markdown, markdownSection, parseMarkdown } from "./markdown";
import type { FocusRequest } from "./flow-map";

const FlowMap = lazy(() => import("./flow-map"));

type Entry = (Behaviour & { type: "behaviour" }) | (CatalogueEntry & { type: "invariant" });
type ConfiguredCheck = CatalogueResponse["checks"][number];
type Navigate = (id: string | null) => void;

function useRetryableResource<T>(url: string, revision: number) {
  const [attempt, setAttempt] = useState(0);
  const state = useResource<T>(url, revision + attempt);
  return { ...state, retry: () => setAttempt(value => value + 1) };
}

function Arrow({ back = false }: { back?: boolean }) {
  return <Icon name="arrow" className={`catalogue-arrow${back ? " catalogue-arrow-back" : ""}`} />;
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`catalogue-notice${error ? " catalogue-notice-error" : ""}`} role={error ? "alert" : "status"}>{children}</div>;
}

function Loading({ label }: { label: string }) {
  return <div className="catalogue-loading" role="status">
    <span>{label}</span>
    <div className="catalogue-skeleton" aria-hidden="true" />
    <div className="catalogue-skeleton" aria-hidden="true" />
    <div className="catalogue-skeleton" aria-hidden="true" />
  </div>;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function entryMatches(entry: Entry, query: string) {
  const fields = [entry.id, entry.description, ...entry.paths, ...entry.checks, entry.guide ?? ""];
  if (entry.type === "behaviour") fields.push(entry.entry ?? "");
  return fields.some(value => value.toLowerCase().includes(query));
}

export function CatalogueView({ mode, revision }: { mode: "catalogue" | "map"; revision: number }) {
  const { data, error, loading, retry } = useRetryableResource<CatalogueResponse>("/api/catalogue", revision);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [removed, setRemoved] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOnNavigation = useRef(false);
  const searchId = useId();
  const entries = useMemo<Entry[]>(() => data ? [
    ...data.behaviours.map(entry => ({ ...entry, type: "behaviour" as const })),
    ...data.invariants.map(entry => ({ ...entry, type: "invariant" as const })),
  ] : [], [data]);
  const byId = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const filtered = entries.filter(entry => entryMatches(entry, query.trim().toLowerCase()));
  const mapMatches = filtered.filter(entry => entry.type === "behaviour");
  const matchedIds = useMemo(() => query.trim() ? entries.filter(entry => entry.type === "behaviour" && entryMatches(entry, query.trim().toLowerCase())).map(entry => entry.id) : [], [entries, query]);
  const availableHistory = history.filter(id => id === null || byId.has(id));

  useEffect(() => setFocusRequest(null), [mode]);

  const navigate = useCallback((id: string | null) => {
    if (id === selectedId) return;
    setHistory(previous => [...previous, selectedId]);
    setSelectedId(id);
    setRemoved(null);
    focusOnNavigation.current = mode === "catalogue";
  }, [selectedId, mode]);

  function selectMatch(id: string) {
    navigate(id);
    setFocusRequest(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 }));
    setQuery("");
    document.getElementById(searchId)?.focus({ preventScroll: true });
  }

  function inspectEntry(id: string | null) {
    if (id === selectedId) return;
    navigate(id);
    focusOnNavigation.current = true;
  }

  function goBack() {
    const previous = availableHistory.at(-1);
    if (previous === undefined) return;
    setHistory(availableHistory.slice(0, -1));
    setSelectedId(previous);
    setRemoved(null);
    focusOnNavigation.current = mode === "catalogue";
  }

  useEffect(() => {
    if (data && selectedId && !byId.has(selectedId)) {
      setRemoved(selectedId);
      setSelectedId(null);
      focusOnNavigation.current = mode === "catalogue";
    }
  }, [data, byId, selectedId, mode]);

  useEffect(() => {
    if (focusOnNavigation.current) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: "nearest" });
      focusOnNavigation.current = false;
    }
  }, [selectedId]);

  return <section className="catalogue-view" aria-label={mode === "map" ? "Feature map" : "Behaviour catalogue"}>
    <header className="catalogue-page-header">
      <div>
        <h1>{mode === "map" ? "Feature map" : "Behaviour catalogue"}</h1>
        <p>{mode === "map" ? "Explore behaviours and their recorded dependencies on an interactive map." : "Browse behaviours, project invariants, and their configured checks."}</p>
      </div>
      {data && <span className="catalogue-total">{countLabel(data.behaviours.length, "behaviour")} · {countLabel(data.invariants.length, "invariant")}</span>}
    </header>

    {error && <Notice error>
      <div><strong>{data ? "The catalogue could not be refreshed." : "The catalogue could not be loaded."}</strong><p>{error}</p></div>
      <button type="button" className="catalogue-button" onClick={retry} disabled={loading}>Try again</button>
    </Notice>}
    {data?.problems.length ? <Notice>
      <div><strong>Catalogue needs attention</strong><ul>{data.problems.map((problem, index) => <li key={`${index}:${problem}`}>{problem}</li>)}</ul></div>
    </Notice> : null}
    {removed && <Notice><span><strong>{removed}</strong> is no longer in the catalogue. Choose another entry below.</span></Notice>}
    {!data && loading && <Loading label="Loading catalogue…" />}

    {data && <>
      <div className="catalogue-toolbar">
        <nav className="catalogue-navigation" aria-label="Catalogue navigation">
          <button type="button" className="catalogue-button" disabled={!availableHistory.length} onClick={goBack}><Arrow back /> Back</button>
          {selected && <button type="button" className="catalogue-button" onClick={() => navigate(null)}>{mode === "map" ? "Clear selection" : "Overview"}</button>}
        </nav>
        <div className="catalogue-search">
          <label className="catalogue-sr-only" htmlFor={searchId}>Search catalogue</label>
          <Icon name="search" />
          <input id={searchId} type="search" value={query} placeholder="Search behaviours, paths, checks…" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (mode !== "map") return;
            if (event.key === "Escape") setQuery("");
            if (event.key === "Enter" && query.trim() && mapMatches[0]) { event.preventDefault(); selectMatch(mapMatches[0].id); }
          }} />
          {mode === "map" && query.trim() && <div className="catalogue-map-search-results">
            <p role="status">{mapMatches.length ? countLabel(mapMatches.length, "matching behaviour") : "No matching behaviours"}</p>
            <ul>{mapMatches.map(entry => <li key={entry.id}><button type="button" onClick={() => selectMatch(entry.id)}><strong>{entry.id}</strong><span>{entry.description}</span></button></li>)}</ul>
            {!mapMatches.length && <button type="button" className="catalogue-text-button" onClick={() => setQuery("")}>Clear search</button>}
          </div>}
        </div>
        <span className="catalogue-refresh" role="status">{loading ? "Refreshing…" : ""}</span>
      </div>

      {mode === "map" ? <div className={`catalogue-flow-workspace${selected ? " has-inspector" : ""}`}>
        {data.behaviours.length ? <Suspense fallback={<Loading label="Loading interactive map…" />}>
          <FlowMap behaviours={data.behaviours} selectedId={selected?.type === "behaviour" ? selected.id : null} matchedIds={matchedIds} focusRequest={focusRequest} onSelect={navigate} />
        </Suspense> : <div className="catalogue-panel catalogue-empty"><h2>No behaviours recorded</h2><p>Add behaviours and their dependencies to your project’s verification configuration to see them on the map.</p></div>}
        {selected && <aside className="catalogue-flow-inspector" key={selected.id} aria-label={`Details for ${selected.id}`}>
          <header className="catalogue-detail-header"><h2 ref={heading} tabIndex={-1}>{selected.id} <span className="catalogue-kind">{selected.type === "behaviour" ? "Behaviour" : "Invariant"}</span></h2><p>{selected.description}</p></header>
          {selected.type === "behaviour" && <Relationships entry={selected} byId={byId} navigate={inspectEntry} />}
          <EntryDetails entry={selected} checks={data.checks} byId={byId} navigate={inspectEntry} revision={revision} />
        </aside>}
        <span className="catalogue-sr-only" role="status">{selected ? `${selected.id} selected. Details panel updated.` : "Select a behaviour to inspect its details."}</span>
      </div> : <div className={selected ? "catalogue-workspace" : undefined}>
        {selected && <CatalogueIndex entries={filtered} selected={selected.id} navigate={navigate} clear={() => setQuery("")} />}
        <div className="catalogue-body">
          {selected ? <>
            <header className="catalogue-detail-header">
              <h2 ref={heading} tabIndex={-1}>{selected.id} <span className="catalogue-kind">{selected.type === "behaviour" ? "Behaviour" : "Invariant"}</span></h2>
              <p>{selected.description}</p>
            </header>
            {selected.type === "behaviour" && <Relationships entry={selected} byId={byId} navigate={navigate} />}
            <EntryDetails entry={selected} checks={data.checks} byId={byId} navigate={navigate} revision={revision} />
          </> : <>
            <h2 className="catalogue-sr-only" ref={heading} tabIndex={-1}>Catalogue overview</h2>
            <CatalogueOverview entries={filtered} byId={byId} navigate={navigate} hasEntries={entries.length > 0} clear={() => setQuery("")} />
          </>}
        </div>
      </div>}
    </>}
  </section>;
}

function NoMatches({ clear }: { clear: () => void }) {
  return <div className="catalogue-empty"><h2 className="catalogue-no-matches-heading">No matching entries</h2><p>Try a behaviour ID, a source path, or a check name.</p><button type="button" className="catalogue-button" onClick={clear}>Clear search</button></div>;
}

function CatalogueIndex({ entries, selected, navigate, clear }: { entries: Entry[]; selected: string; navigate: Navigate; clear: () => void }) {
  return <nav className="catalogue-index" aria-label="Catalogue entries">
    {!entries.length && <NoMatches clear={clear} />}
    {(["behaviour", "invariant"] as const).map(type => {
      const group = entries.filter(entry => entry.type === type);
      if (!group.length) return null;
      return <section key={type}>
        <h2>{type === "behaviour" ? "Behaviours" : "Invariants"} <span>{group.length}</span></h2>
        <ul>{group.map(entry => <li key={entry.id}><button type="button" className="catalogue-index-entry" aria-current={entry.id === selected ? "true" : undefined} onClick={() => navigate(entry.id)}><strong>{entry.id}</strong><span>{entry.description}</span></button></li>)}</ul>
      </section>;
    })}
  </nav>;
}

function EntryLinks({ ids, byId, navigate, empty = "None recorded" }: { ids: string[]; byId: Map<string, Entry>; navigate: Navigate; empty?: string }) {
  if (!ids.length) return <span className="catalogue-muted">{empty}</span>;
  return <ul className="catalogue-links">{ids.map(id => <li key={id}>{byId.has(id)
    ? <button type="button" onClick={() => navigate(id)} className="catalogue-text-button">{id}</button>
    : <span>{id} <span className="catalogue-muted">(not in catalogue)</span></span>}</li>)}</ul>;
}

function CatalogueOverview({ entries, byId, navigate, hasEntries, clear }: { entries: Entry[]; byId: Map<string, Entry>; navigate: Navigate; hasEntries: boolean; clear: () => void }) {
  if (!hasEntries) return <div className="catalogue-panel catalogue-empty"><h2>No behaviours or invariants recorded</h2><p>Add entries to your project’s verification configuration to browse their source paths, guides, and check bindings here.</p></div>;
  if (!entries.length) return <div className="catalogue-panel"><NoMatches clear={clear} /></div>;
  const behaviours = entries.filter(entry => entry.type === "behaviour");
  const invariants = entries.filter(entry => entry.type === "invariant");
  return <>
    {behaviours.length > 0 && <section className="catalogue-panel">
      <div className="catalogue-section-heading"><h2>Behaviours <span className="catalogue-count">{behaviours.length}</span></h2><p>Select a behaviour to inspect its implementation and checks.</p></div>
      <div className="catalogue-overview-labels" aria-hidden="true"><span>Behaviour</span><span>Checks</span><span>Depends on</span><span>Used by</span></div>
      <ul className="catalogue-overview-list">{behaviours.map(entry => <li className="catalogue-overview-row" key={entry.id}>
        <button type="button" className="catalogue-entry-button" onClick={() => navigate(entry.id)}><span><strong>{entry.id}</strong><span>{entry.description}</span></span><Arrow /></button>
        <div className="catalogue-overview-cell"><span className="catalogue-mobile-label">Checks</span><span className={entry.checks.length ? "" : "catalogue-unmapped"}>{entry.checks.length || "Not mapped"}</span></div>
        <div className="catalogue-overview-cell"><span className="catalogue-mobile-label">Depends on</span><EntryLinks ids={entry.dependsOn} byId={byId} navigate={navigate} /></div>
        <div className="catalogue-overview-cell"><span className="catalogue-mobile-label">Used by</span><span className="catalogue-muted">{entry.consumers.length ? countLabel(entry.consumers.length, "behaviour") : "None recorded"}</span></div>
      </li>)}</ul>
    </section>}
    {invariants.length > 0 && <section className="catalogue-panel">
      <div className="catalogue-section-heading"><h2>Project invariants <span className="catalogue-count">{invariants.length}</span></h2><p>Constraints enforced by their configured checks.</p></div>
      <ul className="catalogue-overview-list">{invariants.map(entry => <li className="catalogue-invariant-row" key={entry.id}>
        <button type="button" className="catalogue-entry-button" onClick={() => navigate(entry.id)}><span><strong>{entry.id}</strong><span>{entry.description}</span></span><Arrow /></button>
        <span className="catalogue-muted">{countLabel(entry.checks.length, "check")}</span>
      </li>)}</ul>
    </section>}
  </>;
}

function Relationships({ entry, byId, navigate }: { entry: Behaviour; byId: Map<string, Entry>; navigate: Navigate }) {
  return <section className="catalogue-panel catalogue-relationships" aria-label="Recorded direct relationships">
    <div><h3>Depends on</h3><EntryLinks ids={entry.dependsOn} byId={byId} navigate={navigate} /></div>
    <div><h3>Used by</h3><EntryLinks ids={entry.consumers} byId={byId} navigate={navigate} /></div>
  </section>;
}

function EntryDetails({ entry, checks, byId, navigate, revision }: { entry: Entry; checks: ConfiguredCheck[]; byId: Map<string, Entry>; navigate: Navigate; revision: number }) {
  return <>
    <section className="catalogue-panel catalogue-metadata">
      <h3>{entry.type === "behaviour" ? "Implementation" : "Scope"}</h3>
      <dl>
        {entry.type === "behaviour" && <div><dt>Entry point</dt><dd>{entry.entry ? <code>{entry.entry}</code> : <span className="catalogue-muted">Not recorded</span>}</dd></div>}
        <div><dt>Source paths</dt><dd>{entry.paths.length ? <ul className="catalogue-paths">{entry.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <span className="catalogue-muted">{entry.type === "invariant" ? "Project-wide · no path restriction" : "Not mapped"}</span>}</dd></div>
      </dl>
    </section>
    <section className="catalogue-panel">
      <div className="catalogue-section-heading"><h3>{entry.type === "invariant" ? "Enforcing checks" : "Configured checks"} <span className="catalogue-count">{entry.checks.length}</span></h3></div>
      {!entry.checks.length && <p className="catalogue-panel-note">No checks are mapped to this behaviour.</p>}
      <div className="catalogue-checks">{entry.checks.map(id => {
        const check = checks.find(candidate => candidate.id === id);
        if (!check) return <p className="catalogue-panel-note" key={id}>{id}: check configuration unavailable.</p>;
        return <details className="catalogue-check" key={`${entry.id}:${id}`}>
          <summary><Icon name="chevron" className="catalogue-disclosure" /><span className="catalogue-check-summary"><span className="catalogue-check-name"><strong>{id}</strong><span className="catalogue-kind">{check.kind}</span>{check.required && <span className="catalogue-kind">Required</span>}</span><span className="catalogue-check-expect">{check.expect}</span></span></summary>
          <div className="catalogue-check-body"><dl><div><dt>Command</dt><dd><code>{check.command}</code></dd></div><div><dt>Covers</dt><dd><EntryLinks ids={check.covers} byId={byId} navigate={navigate} empty="No catalogue bindings" /></dd></div></dl>{check.required && <p className="catalogue-muted">Included in every verification run.</p>}</div>
        </details>;
      })}</div>
    </section>
    {entry.guide ? <GuidePanel key={entry.guide} path={entry.guide} revision={revision} /> : <section className="catalogue-panel catalogue-metadata"><h3>Guide</h3><p className="catalogue-muted">No narrative guide recorded.</p></section>}
  </>;
}

function GuidePanel({ path, revision }: { path: string; revision: number }) {
  const [open, setOpen] = useState(false);
  return <details className="catalogue-panel catalogue-guide" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="chevron" className="catalogue-disclosure" /><span><strong>Read guide</strong><span className="catalogue-guide-path">{path}</span></span></summary>
    {open && <GuideDocument path={path} revision={revision} />}
  </details>;
}

type GuideLocation = { path: string; full: boolean };

function GuideDocument({ path, revision }: { path: string; revision: number }) {
  const [location, setLocation] = useState<GuideLocation>({ path, full: false });
  const [history, setHistory] = useState<GuideLocation[]>([]);
  const file = location.path.split("#")[0]!;
  const { data, error, loading, retry } = useRetryableResource<GuideResponse>(`/api/guide?path=${encodeURIComponent(file)}`, revision);
  const document = useMemo(() => parseMarkdown(data?.content ?? ""), [data?.content]);
  const fragment = location.path.split("#")[1];
  const anchor = fragment ? decodeFragment(fragment) : undefined;
  const found = anchor !== undefined && anchor !== null && [...document.anchors.values()].includes(anchor);
  const section = markdownSection(document, anchor);
  const hasSection = found && section.length < document.tokens.length;
  const visible = hasSection && !location.full ? section : document.tokens;
  const preview = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(Boolean(fragment));

  function navigate(next: string) {
    setHistory(previous => [...previous, location]);
    setLocation({ path: next, full: next.split("#")[0] === file && location.full });
    pendingFocus.current = true;
  }

  function back() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setLocation(previous);
    pendingFocus.current = true;
  }

  useEffect(() => {
    if (!pendingFocus.current || (!data && !error)) return;
    const target = [...preview.current?.querySelectorAll<HTMLElement>("[data-markdown-anchor]") ?? []].find(element => element.dataset.markdownAnchor === anchor) ?? preview.current;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: target.closest(".catalogue-flow-inspector") ? "nearest" : "start" });
    }
    pendingFocus.current = false;
  }, [location, data, error, anchor]);

  return <div className="catalogue-guide-body">
    <div className="catalogue-guide-tools">
      {history.length > 0 && <button type="button" className="catalogue-button" onClick={back} aria-label="Back in guide"><Arrow back /> Back</button>}
      <span className="catalogue-guide-location">{location.path}</span>
      {data && hasSection && <button type="button" className="catalogue-text-button" onClick={() => {
        setLocation(current => ({ ...current, full: !current.full }));
        pendingFocus.current = true;
      }}>{location.full ? "Show linked section" : "Read full guide"}</button>}
    </div>
    <div ref={preview} tabIndex={-1} className="catalogue-guide-preview">
      {error && <Notice error><div><strong>Guide could not be loaded.</strong><p>{error}</p></div><button type="button" className="catalogue-button" onClick={retry} disabled={loading}>Try again</button></Notice>}
      {loading && !data && <Loading label="Loading guide…" />}
      {data && <>
        {anchor === null && <Notice>The guide link has an invalid section anchor. Showing the full guide.</Notice>}
        {anchor && !found && <Notice>The linked section could not be located. Showing the full guide.</Notice>}
        {document.tokens.length ? <Markdown document={document} tokens={visible} path={file} onNavigate={navigate} /> : <p className="catalogue-muted">This guide is empty.</p>}
      </>}
    </div>
  </div>;
}
