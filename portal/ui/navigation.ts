import { useCallback, useEffect, useState } from "react";
import { readHash } from "./data";

export type Page = "reports" | "catalogue" | "map";
export interface Navigation { projectId: string | null; page: Page; run: string | null }
export type Navigate = (next: Navigation, replace?: boolean) => void;

function readNavigation(): Navigation {
  return {
    projectId: new URLSearchParams(location.search).get("project"),
    page: location.hash === "#catalogue" ? "catalogue" : location.hash === "#map" ? "map" : "reports",
    run: readHash(),
  };
}

export function portalURL(projectId: string | null, hash: string) {
  const url = new URL(location.href);
  if (projectId === null) url.searchParams.delete("project");
  else url.searchParams.set("project", projectId);
  url.hash = hash;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useNavigation() {
  const [navigation, setNavigation] = useState(readNavigation);
  const navigate = useCallback<Navigate>((next, replace = false) => {
    const hash = next.page === "reports" ? next.run ? encodeURIComponent(next.run) : "" : next.page;
    history[replace ? "replaceState" : "pushState"](null, "", portalURL(next.projectId, hash));
    setNavigation(next);
  }, []);
  useEffect(() => {
    const followLocation = () => setNavigation(readNavigation());
    window.addEventListener("popstate", followLocation);
    window.addEventListener("hashchange", followLocation);
    return () => {
      window.removeEventListener("popstate", followLocation);
      window.removeEventListener("hashchange", followLocation);
    };
  }, []);
  return { navigation, navigate };
}
