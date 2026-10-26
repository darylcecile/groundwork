import { useEffect, useMemo, useRef, useState } from "react";
import type { EvidenceFile, RunSummary } from "./data";
import { fileURL } from "./data";
import { Empty, Loading } from "./primitives";

const previewPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
const fallbackStyles = `@layer groundwork-preview {
  :where(*) { box-sizing: border-box; }
  :where(html) { color-scheme: light; }
  :where(body) { margin: 0; padding: 28px; background: white; color: #202822; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow-wrap: anywhere; }
  :where(h1,h2,h3) { line-height: 1.3; margin: 0 0 16px; font-weight: 600; }
  :where(h1) { font-size: 26px; } :where(h2) { font-size: 21px; } :where(h3) { font-size: 17px; }
  :where(p,ul,ol,dl,table,form) { margin: 0 0 18px; }
  :where(p,form) { max-width: 70ch; }
  :where(label) { display: block; margin: 12px 0 5px; font-weight: 500; }
  :where(input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea) { display: block; width: 100%; max-width: 28rem; padding: 9px 11px; margin: 0 0 14px; border: 1px solid #cbd3cd; border-radius: 6px; background: white; color: inherit; font: inherit; }
  :where(button,input[type=submit],input[type=button]) { padding: 9px 14px; border: 1px solid #cbd3cd; border-radius: 6px; background: #eff3f0; color: #202822; font: inherit; font-weight: 500; }
  :where(a) { color: #247247; text-decoration: underline; text-underline-offset: 3px; }
  :where(img,svg,video) { max-width: 100%; }
  :where(table) { border-collapse: collapse; text-align: left; }
  :where(th,td) { padding: 8px 12px; border: 1px solid #e0e4e1; }
  :where(th) { background: #f6f7f6; font-weight: 600; }
  :where(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
  :where(code,pre) { font-family: ui-monospace, monospace; font-size: 12px; }
  :where(footer) { margin-top: 22px; color: #5b655d; }
  :where([hidden]) { display: none; }
}`;

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
const assetLimit = 2 * 1024 * 1024;
const cssURLs = /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi;

function savedPaths(reference: string, from: string) {
  const raw = reference.trim();
  if (!raw || raw.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(raw)) return [];
  try {
    const base = new URL(from.split("/").map(encodeURIComponent).join("/"), "https://saved.invalid/");
    const resolved = decodeURIComponent(new URL(raw, base).pathname.slice(1));
    return raw.startsWith("/") ? [resolved, `${from.slice(0, from.lastIndexOf("/") + 1)}${resolved}`] : [resolved];
  } catch { return []; }
}

function assetVersion(paths: string[], files: EvidenceFile[]) {
  const byPath = new Map(files.map(file => [file.path, file]));
  return paths.map(path => { const file = byPath.get(path); return `${path}:${file?.modifiedAt}:${file?.size}`; }).join("|");
}

function asDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Saved asset could not be read."));
    reader.readAsDataURL(blob);
  });
}

function assetLoader(run: RunSummary, files: EvidenceFile[], signal: AbortSignal) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const used = new Set<string>();
  const cache = new Map<string, Promise<string | null>>();
  let missing = false;
  async function read(path: string, css: boolean) {
    const file = byPath.get(path)!;
    const mime = imageTypes[path.split(".").at(-1)!.toLowerCase()];
    if (file.size > assetLimit || (!css && !mime)) return null;
    const response = await fetch(fileURL(run, path, `${file.modifiedAt}:${file.size}`), { signal, cache: "no-store" });
    if (!response.ok || Number(response.headers.get("content-length")) > assetLimit) return null;
    const blob = await response.blob();
    if (blob.size > assetLimit) return null;
    return css ? blob.text() : asDataURL(new Blob([blob], { type: mime }));
  }
  async function load(reference: string, from: string, css = false): Promise<{ content: string; path: string } | null> {
    if (!css && /^(data:(?:image|font)\/|#)/i.test(reference)) return { content: reference, path: from };
    const candidates = savedPaths(reference, from);
    candidates.forEach(path => used.add(path));
    const path = candidates.find(path => byPath.has(path));
    if (!path) { missing = true; return null; }
    const key = `${path}:${css}`;
    if (!cache.has(key)) cache.set(key, read(path, css));
    try {
      const content = await cache.get(key)!;
      if (content !== null) return { content, path };
    } catch (error) { if (signal.aborted) throw error; }
    missing = true;
    return null;
  }
  async function styles(css: string, from: string) {
    const withoutImports = css.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/gi, () => { missing = true; return ""; });
    const matches = [...withoutImports.matchAll(cssURLs)];
    const values = await Promise.all(matches.map(match => load((match[2] ?? match[3] ?? "").trim(), from)));
    let index = 0;
    return withoutImports.replace(cssURLs, () => `url("${values[index++]?.content || "data:,"}")`).replace(/<\/style/gi, "<\\/style");
  }
  return { load, styles, used, hasMissing: () => missing };
}

function removeActiveContent(document: Document) {
  document.querySelectorAll("script,iframe,frame,frameset,object,embed,base,meta[http-equiv],template").forEach(node => node.remove());
  document.querySelectorAll("*").forEach(element => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ["srcdoc", "autofocus", "ping", "action", "formaction", "target", "nonce"].includes(attribute.name)) element.removeAttribute(attribute.name);
    }
    if (element.matches("a,area")) { element.removeAttribute("href"); element.setAttribute("aria-disabled", "true"); }
    if (element.matches("button")) element.setAttribute("type", "button");
    if (element.matches("input,textarea,form")) element.setAttribute("autocomplete", "off");
    if (element.matches("video,audio,source,track")) element.removeAttribute("src");
  });
}

async function renderDocument(content: string, path: string, run: RunSummary, files: EvidenceFile[], signal: AbortSignal) {
  // The first policy also blocks resource loads while the detached document is being parsed.
  const document = new DOMParser().parseFromString(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'">${content}`, "text/html");
  removeActiveContent(document);
  const assets = assetLoader(run, files, signal);
  const styleJobs = [...document.querySelectorAll("style")].map(async element => { element.textContent = await assets.styles(element.textContent || "", path); });
  const inlineJobs = [...document.querySelectorAll("[style]")].map(async element => { element.setAttribute("style", await assets.styles(element.getAttribute("style")!, path)); });
  const linkJobs = [...document.querySelectorAll("link")].map(async link => {
    if (!link.relList.contains("stylesheet")) { link.remove(); return; }
    const saved = await assets.load(link.getAttribute("href") || "", path, true);
    if (!saved) { link.remove(); return; }
    const style = document.createElement("style");
    style.textContent = await assets.styles(saved.content, saved.path);
    if (link.media) style.setAttribute("media", link.media);
    link.replaceWith(style);
  });
  const imageJobs = [...document.querySelectorAll("img,input[type=image],image,video[poster]")].map(async element => {
    const attribute = element.matches("image") ? (element.hasAttribute("href") ? "href" : "xlink:href") : element.matches("video") ? "poster" : "src";
    const reference = element.getAttribute(attribute) || element.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
    element.removeAttribute("srcset");
    if (!reference) return;
    element.removeAttribute(attribute);
    const saved = await assets.load(reference, path);
    if (saved) element.setAttribute(attribute, saved.content);
    else if (element.matches("img")) element.replaceWith(document.createTextNode(element.getAttribute("alt") || ""));
  });
  document.querySelectorAll("[srcset]").forEach(element => element.removeAttribute("srcset"));
  await Promise.all([...styleJobs, ...inlineJobs, ...linkJobs, ...imageJobs]);
  const fallback = document.createElement("style");
  fallback.textContent = fallbackStyles;
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = previewPolicy;
  document.head.prepend(policy, fallback);
  return { html: `<!doctype html>${document.documentElement.outerHTML}`, missing: assets.hasMissing(), assets: [...assets.used] };
}

export function HTMLPreview({ content, path, run, files }: { content: string; path: string; run: RunSummary; files: EvidenceFile[] }) {
  const [state, setState] = useState<{ html: string; missing: boolean; error?: string } | null>(null);
  const [usedAssets, setUsedAssets] = useState<string[]>([]);
  const version = assetVersion(usedAssets, files);
  const identity = `${run.projectId}:${run.storage}:${run.id}:${path}`;
  const rendered = useRef<{ content: string; identity: string; version: string } | null>(null);
  useEffect(() => {
    const previous = rendered.current;
    if (previous?.content === content && previous.identity === identity && previous.version === version) return;
    const controller = new AbortController();
    setState(null);
    async function load() {
      try {
        const result = await renderDocument(content, path, run, files, controller.signal);
        if (controller.signal.aborted) return;
        rendered.current = { content, identity, version: assetVersion(result.assets, files) };
        setUsedAssets(result.assets);
        setState(result);
      } catch (error) {
        if (!controller.signal.aborted) setState({ html: "", missing: false, error: error instanceof Error ? error.message : "The saved HTML could not be displayed." });
      }
    }
    void load();
    return () => controller.abort();
    // Track only assets actually used by this document, so unrelated writes do not reload its frame.
  }, [content, identity, version]);
  if (!state) return <Loading label="Preparing saved HTML…" />;
  if (state.error) return <Empty title="HTML preview unavailable">{state.error} Download the source to inspect the original file.</Empty>;
  return <>
    <p className="preview-note preview-html-note">Rendered saved HTML · scripts and form submissions are disabled.{state.missing && <span>Some referenced assets were not saved with this file or could not be loaded. Layout and images may differ.</span>}</p>
    <iframe className="preview-html" sandbox="" srcDoc={state.html} title={`Rendered HTML: ${path.split("/").at(-1)}`} referrerPolicy="no-referrer" />
  </>;
}

export function SVGPreview({ content, name }: { content: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`, [content]);
  if (failed) return <Empty title="SVG preview unavailable">The saved SVG could not be displayed. Download the source to inspect the original file.</Empty>;
  return <div className="preview-media"><img src={source} alt={name} onError={() => setFailed(true)} /></div>;
}
