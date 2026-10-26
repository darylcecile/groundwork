import { Component, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CatalogueView } from "./catalogue";
import type { ProjectsResponse } from "../types";
import type { RunDetail, RunList, RunSummary } from "./data";
import { ProjectContext, runKey, runStatus, runTitle, runURL, useLiveUpdates, useResource } from "./data";
import { portalURL, useNavigation, type Navigate, type Navigation } from "./navigation";
import { Empty, formatDate, Icon, Loading, Problems, StatusIcon, statusLabel } from "./primitives";
import { ProjectPicker, ProjectState } from "./projects";
import { RunView } from "./report";

function History({ projectId, runs, selected, latest, open, onSelect, refresh }: {
  projectId: string;
  runs: RunSummary[]; selected: string | null; latest: string | null; open: boolean;
  onSelect: (key: string) => void; refresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = runs.filter(run => `${runTitle(run)} ${run.id}`.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || runStatus(run) === filter));
  return <aside className={`history-rail${open ? " is-open" : ""}`} id="run-history" aria-label="Saved run history">
    <div className="history-heading"><h2>Run history</h2><span className="quiet-count">{runs.length}</span><button className="icon-button" aria-label="Refresh saved runs" title="Refresh saved runs" onClick={refresh}><Icon name="refresh" /></button></div>
    <label className="search-field"><Icon name="search" /><input aria-label="Search run history" type="search" placeholder="Find a run…" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <select className="history-filter" aria-label="Filter run history by status" value={filter} onChange={event => setFilter(event.target.value)}>
      <option value="all">All saved results</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="inconclusive">Inconclusive</option><option value="unfinished">Unfinished</option><option value="unavailable">Unavailable</option>
    </select>
    <ol className="run-list">{filtered.map(run => <li key={runKey(run)}><a className="run-link" href={portalURL(projectId, encodeURIComponent(runKey(run)))} aria-current={selected === runKey(run) ? "true" : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onSelect(runKey(run)); }}>
      <StatusIcon status={runStatus(run)} /><span className="run-link-body"><span className="run-link-title" title={runTitle(run)}>{runTitle(run)}</span>
        <span className="run-link-meta"><time dateTime={run.startedAt || undefined}>{formatDate(run.startedAt, true)}</time>{runKey(run) === latest && <span className="latest-label">Latest</span>}</span>
        <span className="run-link-meta"><span>{statusLabel(runStatus(run))}</span><span>{run.checks.total} {run.checks.total === 1 ? "check" : "checks"}</span>{run.kind === "pr" && <span>PR</span>}</span>
      </span>
    </a></li>)}</ol>
    {!filtered.length && <p className="history-note">{runs.length ? "No matching runs. Try another search or status." : "Saved verification runs will appear here."}</p>}
  </aside>;
}

function ProjectView({ projectId, navigation, navigate, revision, refresh }: {
  projectId: string; navigation: Navigation; navigate: Navigate; revision: number; refresh: () => void;
}) {
  const list = useResource<RunList>("/api/runs", revision);
  const { page } = navigation;
  const [historyOpen, setHistoryOpen] = useState(false);
  const runs = list.data?.runs || [];
  const latest = list.data?.latest || null;
  const defaultRun = latest || (!list.data?.problems.length && runs[0] ? runKey(runs[0]) : null);
  const selected = navigation.run || defaultRun;
  const detail = useResource<RunDetail>(selected ? runURL(selected) : null, revision);
  useEffect(() => {
    if (!navigation.run && defaultRun) navigate({ ...navigation, run: defaultRun }, true);
  }, [navigation, defaultRun, navigate]);
  useEffect(() => setHistoryOpen(false), [navigation]);
  function selectRun(key: string) {
    navigate({ ...navigation, page: "reports", run: key });
    setHistoryOpen(false);
  }
  const waiting = (list.loading && !list.data) || detail.loading;
  return page !== "reports" ? <main id="main-content" className="catalogue-content" tabIndex={-1}><CatalogueView mode={page} revision={revision} /></main> : <div className="workspace">
      <button className="history-toggle" aria-controls="run-history" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><Icon name="history" />Run history<span className="quiet-count">{runs.length}</span><Icon name="chevron" /></button>
      <History projectId={projectId} runs={runs} selected={selected} latest={latest} open={historyOpen} onSelect={selectRun} refresh={refresh} />
      <main className="main-content" id="main-content" tabIndex={-1}>
        {!detail.data && (waiting || list.error || detail.error) && <h1 className="sr-only">Saved verification runs</h1>}
        {list.error && <section className="notice" role="alert"><h3>Run history could not refresh</h3><p>{list.error}</p><button className="button" onClick={refresh}>Try again</button></section>}
        <Problems problems={list.data?.problems || []} title="Run history notes" />
        {detail.error && <section className="notice" role="alert"><h3>Selected run could not refresh</h3><p>{detail.error}{detail.data ? " Showing the last loaded snapshot." : ""}</p><button className="button" onClick={refresh}>Try again</button>{latest && selected !== latest && <button className="button ml-2" onClick={() => selectRun(latest)}>Open latest run</button>}</section>}
        {detail.data ? <RunView key={selected} detail={detail.data} revision={revision} />
          : waiting ? <div className="report-content panel"><Loading /></div>
          : !selected && !runs.length && !list.error ? <div className="report-content panel"><Empty heading="h1" title="No verification runs yet"><p>Run your project’s checks from the terminal. Their saved results, outcomes, and evidence will appear here.</p><code>groundwork verify</code></Empty></div>
          : !detail.error && !list.error ? <div className="report-content panel"><Empty heading="h1" title="Select a saved run">Choose a run from the history to inspect its results and evidence.</Empty></div> : null}
      </main>
    </div>;
}

function App() {
  const { navigation, navigate } = useNavigation();
  const { projectId, page } = navigation;
  const initialProject = useRef(projectId === null);
  const { connection, revision, projectRevision, refresh } = useLiveUpdates(projectId);
  const registry = useResource<ProjectsResponse>("/api/projects", projectRevision);
  const projects = registry.data?.projects || [];
  const project = projects.find(candidate => candidate.id === projectId);

  useEffect(() => {
    if (projectId !== null) initialProject.current = false;
    if (!initialProject.current || !projects[0]) return;
    initialProject.current = false;
    navigate({ ...navigation, projectId: projects[0].id }, true);
  }, [projects, projectId, navigation, navigate]);
  useEffect(() => { document.title = project ? `${project.name} · Groundwork` : "Groundwork"; }, [project?.name]);

  return <>
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="check" /></span>Groundwork</div>
      <ProjectPicker projects={projects} selectedId={projectId} loading={registry.loading && !registry.data} onSelect={id => navigate({ projectId: id, page, run: null })} />
      <nav className="primary-nav" aria-label="Portal">{([['reports', 'Reports'], ['catalogue', 'Behaviours'], ['map', 'Map']] as const).map(([id, label]) => <button key={id} aria-current={page === id ? "page" : undefined} onClick={() => navigate({ ...navigation, page: id })}>{label}</button>)}</nav>
      <div className="connection" data-state={connection} role="status" title={connection === "connected" ? "Connected to the local file watcher. Saved file changes refresh this view." : "The portal will reconnect automatically."}>
        <span className="connection-dot" /><span className="connection-label">{connection === "connected" ? "Live updates" : connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        {connection === "reconnecting" && <button className="icon-button" aria-label="Refresh portal data" onClick={refresh}><Icon name="refresh" /></button>}
      </div>
    </header>
    {(registry.error && registry.data || registry.data?.problems.length) ? <div className="project-notices">
      {registry.error && <section className="notice" role="alert"><h3>Projects could not refresh</h3><p>{registry.error} Showing the last loaded project list.</p><button className="button" onClick={refresh}>Try again</button></section>}
      <Problems problems={registry.data?.problems || []} title="Project registry notes" />
    </div> : null}
    {project?.available ? <ProjectContext.Provider value={project.id}>
      <PortalBoundary key={project.id}><ProjectView key={project.id} projectId={project.id} navigation={navigation} navigate={navigate} revision={revision} refresh={refresh} /></PortalBoundary>
    </ProjectContext.Provider> : <main className="main-content project-state" id="main-content" tabIndex={-1}><ProjectState selectedId={projectId} project={project} registry={registry.data} loading={registry.loading} error={registry.error} refresh={refresh} /></main>}
  </>;
}

class PortalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="main-content"><div className="panel"><Empty heading="h1" title="This view could not be displayed"><p>Reload the portal to try reading the saved data again.</p><button className="button mt-4" onClick={() => location.reload()}>Reload portal</button></Empty></div></main>;
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Groundwork root element is missing.");
createRoot(root).render(<PortalBoundary><App /></PortalBoundary>);
