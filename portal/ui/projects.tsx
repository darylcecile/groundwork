import type { Project, ProjectsResponse } from "../types";
import { Empty, Icon, Loading } from "./primitives";

export function ProjectPicker({ projects, selectedId, loading, onSelect }: {
  projects: Project[]; selectedId: string | null; loading: boolean; onSelect: (id: string) => void;
}) {
  const selected = projects.find(project => project.id === selectedId);
  const placeholder = loading ? "Loading projects…" : selectedId !== null ? "Unknown project" : projects.length ? "Choose a project" : "No projects yet";
  return <label className="project-picker" title={selected?.root}>
    <select aria-label="Project" value={selectedId ?? ""} disabled={!projects.length} onChange={event => onSelect(event.target.value)}>
      {!selected && <option value={selectedId ?? ""} disabled>{placeholder}</option>}
      {projects.map(project => <option key={project.id} value={project.id}>{project.name} — {project.root}{project.available ? "" : " (unavailable)"}</option>)}
    </select>
    <span className="project-picker-copy" aria-hidden="true">
      <span className="project-picker-name">{selected?.name ?? placeholder}</span>
      <span className="project-picker-root">{selected ? <bdi dir="ltr">{selected.root}</bdi> : "Local repositories"}</span>
    </span>
    <Icon name="chevron" className="project-picker-chevron" />
  </label>;
}

export function ProjectState({ selectedId, project, registry, loading, error, refresh }: {
  selectedId: string | null; project?: Project; registry: ProjectsResponse | null;
  loading: boolean; error: string | null; refresh: () => void;
}) {
  if (!registry) return <div className="panel">{loading ? <Loading label="Loading projects…" /> : <Empty heading="h1" title="Projects could not be loaded"><p>{error || "The local portal could not read its registered repositories."}</p><button className="button mt-4" onClick={refresh}>Try again</button></Empty>}</div>;
  if (project) return <div className="panel"><Empty heading="h1" title="Project is unavailable"><p>This registered folder cannot be read. Restore it, or choose another project above.</p><code className="project-state-path">{project.root}</code><p className="mt-3">If it moved, run Groundwork from its new location.</p><button className="button mt-4" onClick={refresh}>Check again</button></Empty></div>;
  if (selectedId !== null) return <div className="panel"><Empty heading="h1" title="Unknown project"><p>This link refers to a project that is not registered with this portal. Choose another project above, or run Groundwork from that repository to register it.</p>{selectedId && <code className="project-state-path">{selectedId}</code>}<button className="button mt-4" onClick={refresh}>Refresh projects</button></Empty></div>;
  if (registry.projects.length) return <div className="panel"><Empty heading="h1" title="Choose a project">Choose a repository above to browse its saved runs, behaviours, and map.</Empty></div>;
  return <div className="panel"><Empty heading="h1" title="No projects yet"><p>Run Groundwork from a repository to add it to this portal. Registered projects will appear in the selector above.</p><code>groundwork verify</code></Empty></div>;
}
