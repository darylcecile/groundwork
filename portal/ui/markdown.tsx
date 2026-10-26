import { createElement, Fragment, useId, useMemo, useRef, type ReactNode } from "react";
import { marked, type MarkedToken, type Token, type Tokens } from "marked";

export interface MarkdownDocument {
  tokens: Token[];
  anchors: Map<Token, string>;
}

export function decodeFragment(fragment: string) {
  try { return decodeURIComponent(fragment); }
  catch { return null; }
}

function headingAnchor(text: string, used: Set<string>) {
  const explicit = text.match(/\s*\{#([^\s{}]+)\}\s*$/)?.[1];
  if (explicit) return explicit;
  const base = text.trim().toLowerCase().replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/\s/g, "-");
  let anchor = base;
  for (let suffix = 1; used.has(anchor); suffix++) anchor = `${base}-${suffix}`;
  used.add(anchor);
  return anchor;
}

function explicitAnchor(html: string) {
  return html.match(/^\s*<a\s+(?:id|name)\s*=\s*["']([^"']+)["']\s*>\s*(?:<\/a>)?\s*$/i)?.[1];
}

export function parseMarkdown(content: string): MarkdownDocument {
  const tokens = marked.lexer(content, { gfm: true });
  const anchors = new Map<Token, string>();
  const used = new Set<string>();
  marked.walkTokens(tokens, value => {
    const token = value as MarkedToken;
    if (token.type === "heading") {
      anchors.set(token, headingAnchor(token.text, used));
      const last = token.tokens.at(-1);
      if (last?.type === "text") last.text = last.text.replace(/\s*\{#[^}]+\}\s*$/, "");
    } else if (token.type === "html") {
      const anchor = explicitAnchor(token.text);
      if (anchor) anchors.set(token, anchor);
    }
  });
  return { tokens, anchors };
}

export function markdownSection(document: MarkdownDocument, anchor: string | null | undefined) {
  if (!anchor) return document.tokens;
  const start = document.tokens.findIndex(token => document.anchors.get(token) === anchor);
  const heading = document.tokens[start];
  if (start < 0 || heading?.type !== "heading") return document.tokens;
  const next = document.tokens.findIndex((token, index) => index > start && token.type === "heading" && token.depth <= heading.depth);
  return document.tokens.slice(start, next < 0 ? undefined : next);
}

function decodeEntities(text: string) {
  if (typeof DOMParser === "undefined") return text;
  // Only individual character references reach the decoder, never HTML markup.
  return text.replace(/&(?:#[0-9]+|#x[\da-f]+|[a-z][\da-z]+);/gi, entity =>
    new DOMParser().parseFromString(entity, "text/html").body.textContent ?? entity);
}

function localReference(href: string, from: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|[/\\])|[\u0000-\u001f\u007f]/i.test(href)) return null;
  try {
    const base = from.split("#")[0]!.split("/").map(encodeURIComponent).join("/");
    const target = new URL(href, `https://groundwork.invalid/${base}`);
    if (target.search) return null;
    return decodeURIComponent(target.pathname.slice(1)) + target.hash;
  } catch { return null; }
}

function externalReference(href: string) {
  try {
    const url = new URL(href);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

interface RenderContext {
  document: MarkdownDocument;
  prefix: string;
  headingOffset: number;
  path?: string;
  onNavigate?: (path: string) => void;
  jump: (anchor: string) => void;
}

function SourceReference({ children, path }: { children: ReactNode; path: string }) {
  return <span className="markdown-source-reference">{children} <code className="markdown-source-path">({path})</code></span>;
}

function MarkdownLink({ token, context }: { token: Tokens.Link; context: RenderContext }) {
  const autolink = token.autolink;
  const href = autolink ? token.href : decodeEntities(token.href);
  const label = autolink ? token.text : <TokenNodes tokens={token.tokens} context={context} />;
  const external = externalReference(href);
  if (external) return <a href={external} title={token.title ?? undefined} target="_blank" rel="noreferrer">{label}</a>;
  const local = context.path ? localReference(href, context.path) : null;
  if (href.startsWith("#")) {
    const anchor = decodeFragment(href.slice(1));
    if (anchor !== null) return <a href={`#${context.prefix}-${encodeURIComponent(anchor)}`} onClick={event => {
      event.preventDefault();
      if (local && context.onNavigate) context.onNavigate(local);
      else context.jump(anchor);
    }}>{label}</a>;
  }
  if (local && /\.(?:md|markdown)(?:#|$)/i.test(local) && context.onNavigate) {
    return <button type="button" className="markdown-link" title={local} onClick={() => context.onNavigate?.(local)}>{label}</button>;
  }
  const source = local ?? href;
  return token.text === source ? <code className="markdown-source-path">{source}</code> : <SourceReference path={source}>{label}</SourceReference>;
}

function MarkdownImage({ token, context }: { token: Tokens.Image; context: RenderContext }) {
  const href = decodeEntities(token.href);
  const external = externalReference(href);
  const alt = decodeEntities(token.text);
  if (external && /^https?:/i.test(external)) return <a href={external} title={token.title ?? undefined} target="_blank" rel="noreferrer">{alt || "External image"} <span>(open image)</span></a>;
  const source = context.path ? localReference(href, context.path) : null;
  return <SourceReference path={source ?? href}>{alt}</SourceReference>;
}

function MarkdownTable({ token, context }: { token: Tokens.Table; context: RenderContext }) {
  return <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Markdown table"><table>
    <thead><tr>{token.header.map((cell, index) => <th key={index} scope="col" style={{ textAlign: cell.align ?? undefined }}><TokenNodes tokens={cell.tokens} context={context} /></th>)}</tr></thead>
    <tbody>{token.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={{ textAlign: cell.align ?? undefined }}><TokenNodes tokens={cell.tokens} context={context} /></td>)}</tr>)}</tbody>
  </table></div>;
}

function renderToken(token: MarkedToken, context: RenderContext): ReactNode {
  const anchor = context.document.anchors.get(token);
  switch (token.type) {
    case "space": case "def": return null;
    case "heading": return createElement(`h${Math.max(3, Math.min(6, token.depth + context.headingOffset))}`, { id: `${context.prefix}-${anchor}`, "data-markdown-anchor": anchor, tabIndex: -1 }, <TokenNodes tokens={token.tokens} context={context} />);
    case "paragraph": return <p><TokenNodes tokens={token.tokens} context={context} /></p>;
    case "text": return token.tokens ? <TokenNodes tokens={token.tokens} context={context} /> : decodeEntities(token.text);
    case "escape": return token.text;
    case "code": return <pre tabIndex={0}><code>{token.text}</code></pre>;
    case "codespan": return <code>{token.text}</code>;
    case "strong": return <strong><TokenNodes tokens={token.tokens} context={context} /></strong>;
    case "em": return <em><TokenNodes tokens={token.tokens} context={context} /></em>;
    case "del": return <del><TokenNodes tokens={token.tokens} context={context} /></del>;
    case "blockquote": return <blockquote><TokenNodes tokens={token.tokens} context={context} /></blockquote>;
    case "br": return <br />;
    case "hr": return <hr />;
    case "list": return token.ordered
      ? <ol start={typeof token.start === "number" ? token.start : undefined}><TokenNodes tokens={token.items} context={context} /></ol>
      : <ul><TokenNodes tokens={token.items} context={context} /></ul>;
    case "list_item": return <li className={token.task ? "markdown-task" : undefined}><TokenNodes tokens={token.tokens} context={context} /></li>;
    case "checkbox": return <><input type="checkbox" checked={token.checked} disabled aria-label={token.checked ? "Completed" : "Not completed"} />{" "}</>;
    case "link": return <MarkdownLink token={token} context={context} />;
    case "image": return <MarkdownImage token={token} context={context} />;
    case "table": return <MarkdownTable token={token} context={context} />;
    case "html": {
      if (anchor) return <span id={`${context.prefix}-${anchor}`} data-markdown-anchor={anchor} tabIndex={-1} />;
      if (/^\s*<!--[\s\S]*-->\s*$/.test(token.text)) return null;
      return token.block ? <pre><code>{token.text}</code></pre> : <code>{token.text}</code>;
    }
  }
}

function TokenNodes({ tokens, context }: { tokens: Token[]; context: RenderContext }) {
  return <>{tokens.map((token, index) => <Fragment key={index}>{renderToken(token as MarkedToken, context)}</Fragment>)}</>;
}

export function Markdown({ content = "", document, tokens, path, onNavigate }: {
  content?: string;
  document?: MarkdownDocument;
  tokens?: Token[];
  path?: string;
  onNavigate?: (path: string) => void;
}) {
  const parsed = useMemo(() => document ?? parseMarkdown(content), [document, content]);
  const visible = tokens ?? parsed.tokens;
  const depths = visible.filter((token): token is Tokens.Heading => token.type === "heading").map(token => token.depth);
  const headingOffset = 3 - (depths.length ? Math.min(...depths) : 1);
  const prefix = useId();
  const root = useRef<HTMLDivElement>(null);
  function jump(anchor: string) {
    const target = root.current?.ownerDocument.getElementById(`${prefix}-${anchor}`);
    if (target && root.current?.contains(target)) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
    }
  }
  return <div className="markdown-prose" ref={root}>
    <TokenNodes tokens={visible} context={{ document: parsed, prefix, headingOffset, path, onNavigate, jump }} />
  </div>;
}
