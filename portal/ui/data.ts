import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RunSummary } from "../types";
export type { Artifact, Check, Coverage, EvidenceFile, Measurement, Observation, Report, RunSummary, Source, Stage, Trial } from "../types";
export type { RunsResponse as RunList, RunResponse as RunDetail } from "../types";

export const ProjectContext = createContext<string | null>(null);

export function projectAPI(projectId: string | null | undefined, path: string) {
  if (!projectId) throw new Error("A project is required to load saved project data.");
  return `/api/projects/${encodeURIComponent(projectId)}${path.slice("/api".length)}`;
}

export const runKey = (run: RunSummary) => `${run.storage}:${run.id}`;
export const runTitle = (run: RunSummary) => run.goal || (run.kind === "pr" ? "PR verification" : "Verification run");
export const runStatus = (run: RunSummary) => run.error ? "unavailable" : run.kind === "local" && !run.finishedAt ? "unfinished" : run.status;

export function runURL(key: string) {
  const separator = key.indexOf(":");
  return `/api/runs/${encodeURIComponent(key.slice(0, separator))}/${encodeURIComponent(key.slice(separator + 1))}`;
}

export function fileURL(run: RunSummary, path: string, revision?: number | string, download = false) {
  const params = new URLSearchParams({ path });
  if (revision !== undefined) params.set("v", String(revision));
  if (download) params.set("download", "1");
  return projectAPI(run.projectId, `/api/files/${run.storage}/${encodeURIComponent(run.id)}?${params}`);
}

export function readHash() {
  try {
    const key = decodeURIComponent(location.hash.slice(1));
    return /^(groundwork|verify):.+$/.test(key) ? key : null;
  } catch { return null; }
}

export async function responseError(response: Response) {
  const body = await response.text();
  try {
    const data = JSON.parse(body);
    if (typeof data.error === "string") return data.error;
  } catch { /* A proxy or unavailable server may return a non-JSON response. */ }
  return `Request failed (${response.status} ${response.statusText}).`;
}

export function useResource<T>(resource: string | null, revision: number) {
  const projectId = useContext(ProjectContext);
  // Only the registry is global. Every project resource inherits an explicit scope.
  const url = resource === null || resource === "/api/projects" ? resource : projectAPI(projectId, resource);
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null; loading: boolean }>({
    url: null, data: null, error: null, loading: Boolean(url),
  });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState(previous => ({ url, data: previous.url === url ? previous.data : null, error: null, loading: true }));
    async function load() {
      try {
        const response = await fetch(url!, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(await responseError(response));
        const data = await response.json() as T;
        if (!controller.signal.aborted) setState({ url, data, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({
          url, data: previous.url === url ? previous.data : null,
          error: error instanceof Error ? error.message : "The portal could not load this result.", loading: false,
        }));
      }
    }
    void load();
    return () => controller.abort();
  }, [url, revision]);
  if (!url) return { url: null, data: null, error: null, loading: false };
  return state.url === url ? state : { url, data: null, error: null, loading: Boolean(url) };
}

export function useLiveUpdates(projectId: string | null) {
  const build = useRef<string | null>(null);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [revision, setRevision] = useState(0);
  const [projectRevision, setProjectRevision] = useState(0);
  const refresh = useCallback(() => {
    setRevision(value => value + 1);
    setProjectRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const events = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const change = (event: MessageEvent) => {
      const changedProject = JSON.parse(event.data).projectId as string | undefined;
      if (!changedProject || changedProject !== activeProject.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (changedProject === activeProject.current) setRevision(value => value + 1);
      }, 120);
    };
    events.addEventListener("ready", event => {
      const current = JSON.parse(event.data).build as string | undefined;
      if (current && build.current && current !== build.current) { location.reload(); return; }
      if (current) build.current = current;
      setConnection("connected");
      refresh();
    });
    events.addEventListener("change", change);
    events.addEventListener("projects", () => setProjectRevision(value => value + 1));
    events.onerror = () => setConnection("reconnecting");
    return () => { clearTimeout(timer); events.close(); };
  }, [refresh]);
  return { connection, revision, projectRevision, refresh };
}
