import { memo, useEffect, useRef, useState } from "react";
import type { EvidenceFile, RunSummary } from "./data";
import { fileURL, responseError } from "./data";
import { Empty, fileSize, Icon, Loading } from "./primitives";
import { StructuredValue } from "./structured";
import { Markdown } from "./markdown";
import { HTMLPreview, SVGPreview } from "./html-preview";

export type OpenFile = (path: string, trigger?: HTMLElement) => void;

export function FileLinks({ paths, onOpen }: { paths: string[]; onOpen: OpenFile }) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return null;
  return <div className="file-links">{unique.map(path => <button key={path} className="file-link" title={path} onClick={event => onOpen(path, event.currentTarget)}>
    <Icon name="file" /><span>{path.split("/").at(-1)}</span>
  </button>)}</div>;
}

export function EvidenceList({ files, onOpen }: { files: EvidenceFile[]; onOpen: OpenFile }) {
  const [search, setSearch] = useState("");
  const filtered = files.filter(file => file.path.toLowerCase().includes(search.toLowerCase()));
  if (!files.length) return <div className="panel"><Empty title="No files saved">This run has no available logs or evidence files yet.</Empty></div>;
  return <>
    <div className="section-heading evidence-toolbar"><h2>Saved files <span className="quiet-count">{files.length}</span></h2>
      <label className="search-field"><Icon name="search" /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a file…" aria-label="Find an evidence file" /></label>
    </div>
    <div className="panel">{filtered.length ? filtered.map(file => <button className="file-row" key={file.path} onClick={event => onOpen(file.path, event.currentTarget)}>
      <Icon name={file.type === "image" ? "image" : file.type === "video" ? "video" : "file"} />
      <span className="file-row-copy"><span className="file-row-name">{file.name}</span><span className="file-row-path">{file.path}</span></span>
      <span className="file-row-size">{fileSize(file.size)}</span><Icon name="chevron" className="disclosure-chevron" />
    </button>) : <Empty title="No matching files">Try a different filename or clear the search.</Empty>}</div>
  </>;
}

const previewLimit = 1024 * 1024;

async function readPreview(response: Response, signal: AbortSignal) {
  if (!response.body) return { content: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let bytes = 0;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return { content: content + decoder.decode(), truncated: false };
      const remaining = previewLimit - bytes;
      content += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += value.byteLength;
      if (bytes > previewLimit) {
        await reader.cancel();
        return { content: content + decoder.decode(), truncated: true };
      }
    }
    return { content, truncated: false };
  } finally { reader.releaseLock(); }
}

function ReadableText({ content, path, truncated }: { content: string; path: string; truncated: boolean }) {
  const json = /\.jsonl?$/i.test(path);
  if (json) {
    if (truncated) return <Empty title="This data file is too large to preview">Download the original file to inspect the complete data. Previews are limited to 1 MB.</Empty>;
    let value: unknown;
    try { value = /\.jsonl$/i.test(path) ? content.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(content); }
    catch { return <Empty title="Data is not readable yet">This file is empty, incomplete, or not valid JSON. It will refresh when a new version is saved. You can also download the original.</Empty>; }
    return <div className="preview-data"><StructuredValue value={value} /></div>;
  }
  if (!content) return <Empty title="This file is empty">No content has been saved to this file.</Empty>;
  if (/\.(md|markdown)$/i.test(path)) return <div className="preview-data"><Markdown content={content} path={path} />{truncated && <p className="preview-note">Showing the first 1 MB. Download the original for the complete file.</p>}</div>;
  return <><pre className="preview-text" tabIndex={0}>{content}</pre>{truncated && <p className="preview-note">Showing the first 1 MB. Download the original for the complete file.</p>}</>;
}

const TextPreview = memo(function TextPreview({ url, path, run, files }: { url: string; path: string; run?: RunSummary; files?: EvidenceFile[] }) {
  const [state, setState] = useState<{ url: string; path: string; content: string; truncated: boolean; error: string | null; loading: boolean }>({
    url, path, content: "", truncated: false, error: null, loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(await responseError(response));
        const preview = await readPreview(response, controller.signal);
        if (!controller.signal.aborted) setState({ url, path, ...preview, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, url, path,
          content: previous.path === path ? previous.content : "",
          error: error instanceof Error ? error.message : "Could not load this file.", loading: false }));
      }
    }
    void load();
    return () => controller.abort();
  }, [url, path]);
  if (state.path !== path || state.loading) return <Loading label="Loading saved file…" />;
  if (state.error) return <Empty title="File could not be opened">{state.error} It will refresh when the saved files change.</Empty>;
  if (/\.(html?|svg)$/i.test(path)) {
    if (state.truncated) return <Empty title="This file is too large to preview">Rendered previews are limited to 1 MB. Download the source to inspect the complete file.</Empty>;
    if (!state.content) return <Empty title="This file is empty">No content has been saved to this file.</Empty>;
    if (/\.svg$/i.test(path)) return <SVGPreview content={state.content} name={path.split("/").at(-1)!} />;
    if (run && files) return <HTMLPreview content={state.content} path={path} run={run} files={files} />;
    return <Empty title="HTML preview unavailable">The run’s saved assets could not be located. Download the source to inspect the original file.</Empty>;
  }
  return <ReadableText content={state.content} path={path} truncated={state.truncated} />;
});

function MediaPreview({ file, url }: { file: EvidenceFile; url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Empty title="Preview unavailable">The file is missing, incomplete, or not supported by this browser. Download the original to inspect it.</Empty>;
  if (file.type === "pdf") return <>
    <iframe className="preview-pdf" src={url} title={`PDF preview: ${file.name}`} />
    <p className="preview-note">If your browser cannot display this PDF, use Download to open the original.</p>
  </>;
  return <div className="preview-media">
    {file.type === "image" && <img src={url} alt={file.name} onError={() => setFailed(true)} />}
    {file.type === "video" && <video src={url} controls preload="metadata" aria-label={`Video evidence: ${file.name}`} onError={() => setFailed(true)}>Your browser cannot display this video.</video>}
    {file.type === "audio" && <audio src={url} controls preload="metadata" onError={() => setFailed(true)} />}
  </div>;
}

export function FileInspector({ run, path, files, onClose }: {
  run: RunSummary; path: string; files: EvidenceFile[]; revision: number; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closing = useRef(false);
  const file = files.find(item => item.path === path);
  const version = file ? `${file.modifiedAt}:${file.size}` : undefined;
  const url = fileURL(run, path, version);
  const html = /\.html?$/i.test(path);
  const markup = html || /\.svg$/i.test(path);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closing.current = false;
    element.showModal();
    return () => {
      closing.current = true;
      if (element.open) element.close();
      document.body.style.overflow = overflow;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [path]);
  function close() {
    if (closing.current) return;
    closing.current = true;
    if (dialog.current?.open) dialog.current.close();
    onClose();
  }
  return <dialog ref={dialog} className="panel inspector" aria-labelledby="file-inspector-title" aria-describedby="file-inspector-path"
    onCancel={event => { event.preventDefault(); close(); }} onClose={() => { if (!dialog.current?.open) close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <div className="inspector-header">
      <div className="inspector-heading"><h2 id="file-inspector-title" ref={heading} tabIndex={-1}>{file?.name || path.split("/").at(-1)}</h2>
        <p className="inspector-path" id="file-inspector-path">{path}{file ? ` · ${fileSize(file.size)}` : ""}</p>
      </div>
      <a className="button" href={fileURL(run, path, undefined, true)} download><Icon name="download" />{markup ? "Download source" : "Download"}</a>
      <button className="icon-button" onClick={close} aria-label="Close file preview"><Icon name="cross" /></button>
    </div>
    <div className="inspector-body">
    {!file ? <Empty title="File is unavailable">This saved evidence reference is not in the run’s files. It may have been removed or not saved yet.</Empty>
      : file.type === "text" || markup ? <TextPreview url={url} path={path} run={html ? run : undefined} files={html ? files : undefined} />
      : file.type === "file" ? <Empty title="Download to inspect this file">This format has no browser preview. The original file is available above.</Empty>
      : <MediaPreview key={url} file={file} url={url} />}
    </div>
  </dialog>;
}
